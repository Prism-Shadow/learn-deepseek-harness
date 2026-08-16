/**
 * L2 · 一切皆插件 (支柱 P1)
 *
 * 解决 L1 局限 ❶：能力与循环耦合。做法是把循环收缩到最小——只负责驱动流程并在
 * 固定扩展点触发事件；工具等能力全部外置为插件，通过共享上下文与事件系统接入。
 *
 * 两个基础设施：
 *   1) 共享上下文 ctx —— 服务(能力)注册于此，插件间通过它互相获取
 *   2) 事件系统    —— 循环在固定点触发事件，插件监听并介入
 *
 * 事件分两类：
 *   emit      通知型：仅广播，监听者无法改变主流程（如「工具已执行」）
 *   waterfall 瀑布型：依次传递，每个监听器可改写内容后再传给下一个（如「请求前修改消息」）
 */

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import * as readline from "node:readline/promises"
import "dotenv/config"

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
})
const MODEL = process.env.MODEL_ID ?? "deepseek-chat"
const SYSTEM = `You are a coding agent working in ${process.cwd()}. Use tools to accomplish tasks. Act, don't over-explain.`

// ═══════════════════════════════════════════════════════════════
//  迷你框架：共享上下文 + 事件系统（后续每课原样复制）
//
//  框架内部使用 any 类型是刻意的取舍。若要精确类型需为 Ctx 引入泛型与事件映射表，
//  会偏离本课主题。真实 DeepSeek Harness 用泛型换取了完整类型安全。
// ═══════════════════════════════════════════════════════════════
type NextFn = () => Promise<any>
type Listener = (payload: any, next: NextFn) => Promise<any> | any

class Ctx {
  services: Record<string, any> = {}
  private listeners: Record<string, Listener[]> = {}

  provide(name: string, service: any) {
    this.services[name] = service
  }

  // 返回注销函数，便于插件卸载时清理自身监听
  on(event: string, fn: Listener): () => void {
    ;(this.listeners[event] ??= []).push(fn)
    return () => {
      const arr = this.listeners[event]!
      arr.splice(arr.indexOf(fn), 1)
    }
  }

  async emit(event: string, payload: any): Promise<void> {
    for (const fn of this.listeners[event] ?? []) await fn(payload, async () => {})
  }

  // base 是链条走到末端时的默认返回值；每个监听器调用 next() 取得下游结果后可再加工
  async waterfall(event: string, payload: any, base: NextFn): Promise<any> {
    const chain = this.listeners[event] ?? []
    let i = 0
    const next: NextFn = () =>
      i < chain.length ? Promise.resolve(chain[i++](payload, next)) : base()
    return next()
  }
}

// ═══════════════════════════════════════════════════════════════
//  服务：工具注册表（工具改为注册接入，不再内联于循环）
// ═══════════════════════════════════════════════════════════════
function createToolRegistry() {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  return {
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({
        type: "function",
        function: { name, ...t.schema },
      }))
    },
    execute(name: string, args: any): string {
      const t = tools[name]
      if (!t) return `Error: 未知工具 ${name}`
      return t.run(args)
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  插件 ①：bash —— 将 bash 注册为工具
// ═══════════════════════════════════════════════════════════════
function bashPlugin(ctx: Ctx) {
  function runBash(command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if (dangerous.some((d) => command.includes(d))) return "Error: 危险命令已拦截"
    try {
      const out = execSync(command, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] })
      return out.trim().slice(0, 50_000) || "(无输出)"
    } catch (e: any) {
      const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim()
      return out ? out.slice(0, 50_000) : `Error: ${e.message}`
    }
  }
  ctx.services.tools.register(
    "bash",
    {
      description: "Run a shell command and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "the shell command" } },
        required: ["command"],
      },
    },
    // 显式标注参数类型：经由 any 的 ctx.services 取到的 register 无上下文类型，strict 下需自行标注
    (args: { command: string }) => runBash(args.command),
  )
}

// ═══════════════════════════════════════════════════════════════
//  插件 ②：log —— 纯观察者，仅监听「工具已执行」，不介入主流程
//  它不改动循环与 bash，证明新增能力无需修改主干
// ═══════════════════════════════════════════════════════════════
function logPlugin(ctx: Ctx) {
  ctx.on("tools/result", ({ exec }) => {
    console.log(`\x1b[90m  [log] 工具 "${exec.name}" 执行完毕\x1b[0m`)
  })
}

// ═══════════════════════════════════════════════════════════════
//  精简循环：只触发事件、调用服务，不含任何具体能力
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, history: ChatCompletionMessageParam[]): Promise<boolean> {
  // agent/pre-step 瀑布：请求前的统一介入点。当前无监听器，base 原样返回 history；L4 起在此注入上下文
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { history }, async () => history)

  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: ctx.services.tools.schemas(),
    max_tokens: 4000,
  })
  const msg = res.choices[0].message
  history.push(msg)
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments) as { command: string }
    console.log(`\x1b[33m$ ${args.command ?? JSON.stringify(args)}\x1b[0m`)
    const output: string = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 300))
    history.push({ role: "tool", tool_call_id: call.id, content: output })
    await ctx.emit("tools/result", { exec: { name: call.function.name, args }, result: { content: output } })
  }
  return true
}

async function runAgent(ctx: Ctx, history: ChatCompletionMessageParam[]) {
  while (await step(ctx, history)) {}
}

// ═══════════════════════════════════════════════════════════════
//  组装：新增/移除能力只改动这几行，循环不动
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
logPlugin(ctx) // 注释掉此行可验证：移除能力无需改动循环

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }]

console.log("L2 · 一切皆插件")
console.log("输入问题回车发送；输入 q 退出。\n")

while (true) {
  const q = await rl.question("\x1b[36mL2 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  history.push({ role: "user", content: q })
  await runAgent(ctx, history)
  const last = history[history.length - 1]
  if (last.role === "assistant" && typeof last.content === "string") console.log(last.content)
  console.log()
}
rl.close()
