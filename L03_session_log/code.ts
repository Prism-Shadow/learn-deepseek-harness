/**
 * L3 · Session Log 是唯一真相 (支柱 P2)
 *
 * 解决 L1 局限 ❷：对话是可变数组，可被任意修改、进程结束即丢失、无法确定性重放。
 * 做法：用一条 append-only 事件日志承载对话，模型看到的消息由日志派生。
 *
 *   • 事件日志 events[]：记录全部事件——用户消息、模型回复、工具结果，以及 turn 边界。仅追加，不修改。
 *   • surface：日志中「进入对话」的事件子集，是一个有序的 seq 列表。turn 边界这类事件不进入 surface。
 *
 * deriveMessages() 按 surface 列出的 seq 依次取出对应事件、投影为模型消息。
 * 这一分离是后续能力的地基：压缩(L6)只需追加一条 replace 事件改写 surface，原始日志不删；
 * 崩溃恢复只需重放日志即可精确重建。
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
//  迷你框架（同 L2）
// ═══════════════════════════════════════════════════════════════
type NextFn = () => Promise<any>
type Listener = (payload: any, next: NextFn) => Promise<any> | any

class Ctx {
  services: Record<string, any> = {}
  private listeners: Record<string, Listener[]> = {}
  provide(name: string, service: any) {
    this.services[name] = service
  }
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
  async waterfall(event: string, payload: any, base: NextFn): Promise<any> {
    const chain = this.listeners[event] ?? []
    let i = 0
    const next: NextFn = () =>
      i < chain.length ? Promise.resolve(chain[i++](payload, next)) : base()
    return next()
  }
}

// ═══════════════════════════════════════════════════════════════
//  ★ 本课主角：Session —— append-only 事件日志
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
interface SessionEvent {
  seq: number
  type: SurfaceType | "turn/start" | "turn/end"
  data: any
}

class Session {
  events: SessionEvent[] = []
  surface: number[] = [] // 进入对话的事件 seq，有序
  private seqCounter = 0

  // onSurface 决定该事件是否进入对话。L3 仅支持追加；replace 在 L6 引入
  append(type: SessionEvent["type"], data: any, onSurface = false): SessionEvent {
    const event: SessionEvent = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (onSurface) this.surface.push(event.seq)
    return event
  }

  deriveMessages(): ChatCompletionMessageParam[] {
    // seq 等于事件在 events 中的下标（events 只增，seq 与 push 同步自增），故可直接索引
    return this.surface.map((seq) => {
      const e = this.events[seq]
      switch (e.type) {
        case "user/message":
          return { role: "user", content: e.data.content }
        case "assistant/message":
          return e.data.message // 存入的是模型返回的完整消息，含 content 与 tool_calls
        case "tool/result":
          return { role: "tool", tool_call_id: e.data.tool_call_id, content: e.data.content }
        default:
          throw new Error(`非 surface 事件不应出现在 surface 列表中: ${e.type}`)
      }
    })
  }
}

// ═══════════════════════════════════════════════════════════════
//  工具注册表 + bash/log 插件（同 L2）
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
    (args: { command: string }) => runBash(args.command),
  )
}

function logPlugin(ctx: Ctx) {
  ctx.on("tools/result", ({ exec }) => {
    console.log(`\x1b[90m  [log] 工具 "${exec.name}" 执行完毕\x1b[0m`)
  })
}

// ═══════════════════════════════════════════════════════════════
//  循环：改为向 Session 追加事件，不再直接改数组
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  // SYSTEM 每次组装、不写入日志：它属于请求信封，不属于对话历史
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])

  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: ctx.services.tools.schemas(),
    max_tokens: 4000,
  })
  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, true)
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments) as { command: string }
    console.log(`\x1b[33m$ ${args.command ?? JSON.stringify(args)}\x1b[0m`)
    const output: string = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 300))
    session.append("tool/result", { tool_call_id: call.id, content: output }, true)
    await ctx.emit("tools/result", { exec: { name: call.function.name, args }, result: { content: output } })
  }
  return true
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText }) // 边界事件，不进入 surface
  session.append("user/message", { content: userText }, true)
  while (await step(ctx, session)) {}
  session.append("turn/end", {})
}

// ═══════════════════════════════════════════════════════════════
//  组装
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
logPlugin(ctx)

const session = new Session()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L3 · Session Log 是唯一真相")
console.log("命令：/log 打印事件日志 | /surface 打印 surface | q 退出\n")

while (true) {
  const q = await rl.question("\x1b[36mL3 >> \x1b[0m")
  const cmd = q.trim().toLowerCase()
  if (["q", "exit", ""].includes(cmd)) break

  if (cmd === "/log") {
    console.log("\x1b[90m── 事件日志（记录全部事件）──\x1b[0m")
    for (const e of session.events) {
      const on = session.surface.includes(e.seq) ? "\x1b[32m[在 surface]\x1b[0m" : "\x1b[90m[仅日志]\x1b[0m"
      console.log(`  seq ${String(e.seq).padStart(2)} ${e.type.padEnd(18)} ${on}`)
    }
    console.log()
    continue
  }
  if (cmd === "/surface") {
    console.log(`\x1b[90msurface（模型看到的 seq 顺序）:\x1b[0m [${session.surface.join(", ")}]\n`)
    continue
  }

  await runTurn(ctx, session, q)
  // 末尾是 turn/end，其前一条为本轮最后的 assistant 消息
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") {
    console.log(last.data.message.content)
  }
  console.log()
}
rl.close()
