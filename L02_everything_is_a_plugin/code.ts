/**
 * L2 · 一切皆插件 (支柱 P1)
 *
 * L1 的病根 ❶：bash 工具、循环逻辑全焊死在一起，加个能力就得改循环。
 *
 * 这一课动第一刀，也是 DeepSeek Harness 最重要的思想：
 *   把循环做到极瘦——它只负责「跑 + 到点喊人」；
 *   真正的能力(工具、以后的上下文/压缩/记忆)全是外挂的「插件」。
 *
 * 靠两样东西实现：
 *   1) 一个共享的 ctx —— 一块"插座板"，能力挂上去，大家互相取用
 *   2) 一条事件总线 —— 循环跑到某个时刻就 emit("喊一嗓子")，插件用 on() 举手接住
 *
 * 加功能 = 加一个插件；循环本身一个字都不用改。本课末尾你会亲手验证这点。
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
//  迷你框架：ctx(插座板) + 事件总线      —— 这就是「一切皆插件」的底座
//  (后面每一课都会原样复制这一段，然后往上挂更多插件)
//
//  ⚖️ 关于类型的取舍(B 档)：这个框架内部我们故意用 `any` —— services 里放什么、
//     每个事件的 payload 长什么样，是「运行期」由挂上来的插件决定的。想让它们全都
//     有精确类型，得给 Ctx 加泛型 + 事件映射表(keyof/映射类型)，那是中级 TS，会
//     盖过"一切皆插件"这个主题。真实的 DeepSeek Harness 确实那么做了(用泛型换来完整
//     类型安全)，这是个真实的工程取舍。我们这门课在"框架内部"选可读性，在"外围
//     (消息、工具)"选类型安全 —— 下面你会看到外围都标了类型。
// ═══════════════════════════════════════════════════════════════
type NextFn = () => Promise<any>
type Listener = (payload: any, next: NextFn) => Promise<any> | any

class Ctx {
  // 所有能力(service)都挂在这，用 ctx.services.xxx 取用
  services: Record<string, any> = {}
  private listeners: Record<string, Listener[]> = {}

  /** 提供一个能力：把一个对象挂到插座板上 */
  provide(name: string, service: any) {
    this.services[name] = service
  }

  /** 举手：监听某个时刻。返回一个"卸载函数"（拔插头） */
  on(event: string, fn: Listener): () => void {
    ;(this.listeners[event] ??= []).push(fn)
    return () => {
      const arr = this.listeners[event]!
      arr.splice(arr.indexOf(fn), 1)
    }
  }

  /**
   * 通知型事件：喊一嗓子，所有监听者各跑一遍。
   * 谁爱听谁听，改不了主干（比如"某个工具执行完了"）。
   */
  async emit(event: string, payload: any): Promise<void> {
    for (const fn of this.listeners[event] ?? []) await fn(payload, async () => {})
  }

  /**
   * 瀑布型事件：像一条中间件链，一个个往下传，每个插件都能"改了再往下交"。
   * base 是链条走到底时的默认值。（比如"发请求前，往消息里加东西"）
   */
  async waterfall(event: string, payload: any, base: NextFn): Promise<any> {
    const chain = this.listeners[event] ?? []
    let i = 0
    const next: NextFn = () =>
      i < chain.length ? Promise.resolve(chain[i++](payload, next)) : base()
    return next()
  }
}

// ═══════════════════════════════════════════════════════════════
//  一个 service：工具注册表（工具不再写死，而是被"登记"进来）
// ═══════════════════════════════════════════════════════════════
function createToolRegistry() {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  return {
    /** 登记一个工具 */
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    /** 拼成 DeepSeek/OpenAI 要的 tools 数组（发给模型看它有哪些工具） */
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({
        type: "function",
        function: { name, ...t.schema },
      }))
    },
    /** 执行一个工具 */
    execute(name: string, args: any): string {
      const t = tools[name]
      if (!t) return `Error: 未知工具 ${name}`
      return t.run(args)
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  插件 ①：bash —— 现在 bash 是一个插件，自己把工具登记进注册表
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
    // 注意这个 `: { command: string }`：因为 ctx.services 是 any 类型(框架从简的代价)，
    // 通过它拿到的 register 也是 any，回调参数就失去了上下文类型 —— strict 模式下必须自己标一下。
    // 我们顺手标成 bash 真正的参数形状。这就是 B 档"偶尔手动补一下类型"的全部成本。
    (args: { command: string }) => runBash(args.command),
  )
}

// ═══════════════════════════════════════════════════════════════
//  插件 ②：log —— 纯观察者。它只监听"工具执行完"这个通知，打条日志。
//  注意它完全不碰循环、不碰 bash —— 这就是"加功能不改主干"的证据。
// ═══════════════════════════════════════════════════════════════
function logPlugin(ctx: Ctx) {
  ctx.on("tool:executed", ({ name }) => {
    console.log(`\x1b[90m  [log 插件] 观察到工具 "${name}" 执行完毕\x1b[0m`)
  })
}

// ═══════════════════════════════════════════════════════════════
//  瘦循环：它只知道"喊人"，不知道任何具体能力
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, history: ChatCompletionMessageParam[]): Promise<boolean> {
  // 「发请求前」这一刻——pre-step 瀑布。插件可以在这往即将发送的消息里加东西。
  // 现在还没人监听，base 直接返回 history 原样。L4 会来挂上第一个上下文注入插件。
  // waterfall 返回的是 any(框架内部从简)，这里用一个类型标注把它"接"成消息数组。
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall(
    "pre-step",
    { history },
    async () => history,
  )

  const res = await client.chat.completions.create({
    model: MODEL,
    messages, // ← 不用再 `as any` 了
    tools: ctx.services.tools.schemas(), // ← 工具清单来自注册表，不再写死
    max_tokens: 4000,
  })
  const msg = res.choices[0].message
  history.push(msg)
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    // 同 L1：模型吐的 JSON 形状是运行期才知道的边界，用 as 声明期望形状
    const args = JSON.parse(call.function.arguments) as { command: string }
    console.log(`\x1b[33m$ ${args.command ?? JSON.stringify(args)}\x1b[0m`)
    const output: string = ctx.services.tools.execute(call.function.name, args) // ← 执行也走注册表
    console.log(output.slice(0, 300))
    history.push({ role: "tool", tool_call_id: call.id, content: output })
    await ctx.emit("tool:executed", { name: call.function.name, args, output }) // ← 喊一嗓子
  }
  return true
}

async function runAgent(ctx: Ctx, history: ChatCompletionMessageParam[]) {
  while (await step(ctx, history)) {}
}

// ═══════════════════════════════════════════════════════════════
//  组装：这才是「一切皆插件」真正的样子
//  —— 建一块插座板，提供能力，挂上插件。想加/减功能，只改这几行。
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry()) // 提供「工具注册表」这个能力
bashPlugin(ctx) // 挂上 bash 插件
logPlugin(ctx) // 挂上 log 插件（纯观察，不碰主干）
// ⬆️ 试试把 logPlugin(ctx) 这行注释掉 —— 循环代码一个字都不用动，日志就没了。

// ── 入口 ──────────────────────────────────────────────────
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
