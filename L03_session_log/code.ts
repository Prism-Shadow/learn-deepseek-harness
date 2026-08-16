/**
 * L3 · Session Log 是永远的唯一真相 (支柱 P2)
 *
 * L2 的病根 ❷：对话就是一个可变数组 history，谁都能随便 push、随便改。
 * 崩了就全没，也没法确定性重放，更没法优雅地压缩。
 *
 * 这一课上第二根支柱，也是后面压缩(L6)、记忆(L7)、崩溃恢复的共同地基：
 *
 *   把「可变消息数组」换成「只增不改(append-only)的事件日志」。
 *   模型看到的对话，不再是存着的数组，而是每次从日志「派生」出来的。
 *
 * 两个新概念（都在下面的 Session 类里）：
 *   • 事件日志 events[]：记录一切——用户消息、模型回复、工具结果，连 turn 边界都记。只增不改。
 *   • surface（名单）：一个「有序的 seq 数组」，记录"当前对话里应该包含哪些事件"。
 *     deriveMessages() 就是照着这份名单，去日志里点名、投影成模型消息。
 *
 * 一句话：日志是仓库(记一切、不删)，surface 是购物清单(决定端哪些给模型)。
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
//  迷你框架：ctx(插座板) + 事件总线   （和 L2 一样，原样复制）
//  框架内部故意用 any（B 档取舍）：services/payload 是运行期由插件决定的，
//  上泛型会盖过主题。真实 harness 用泛型换完整类型安全，那是它的取舍。
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
//  ★ 本课主角：Session —— 一条 append-only 的事件日志
// ═══════════════════════════════════════════════════════════════

// 能进对话的三种事件（会进 surface 名单）
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
// 一条日志事件。data 各事件形状不同，B 档从简用 any。
interface SessionEvent {
  seq: number // 单调递增的序号，是每条事件的唯一身份
  type: SurfaceType | "turn/start" | "turn/end" // 后两个是"只记账、不进对话"的边界
  data: any
}

class Session {
  events: SessionEvent[] = [] // 日志：记录一切，只增不改
  surface: number[] = [] // 名单：当前对话里按顺序包含哪些 seq
  private seqCounter = 0

  /**
   * 往日志末尾追加一条事件。
   * onSurface=true 的（用户/模型/工具消息）会把自己的 seq 加进名单；
   * turn 边界这类 onSurface=false 的只进日志、不进名单。
   */
  append(type: SessionEvent["type"], data: any, onSurface = false): SessionEvent {
    const event: SessionEvent = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (onSurface) this.surface.push(event.seq) // L3 只做 append；L6 压缩会引入 replace
    return event
  }

  /**
   * 从日志「派生」出模型看到的对话：照着 surface 名单，逐个点名、投影成消息。
   * 注意：turn/start、turn/end 不在名单里，所以自然就不进对话。
   */
  deriveMessages(): ChatCompletionMessageParam[] {
    const bySeq = new Map(this.events.map((e) => [e.seq, e]))
    return this.surface.map((seq) => {
      const e = bySeq.get(seq)!
      switch (e.type) {
        case "user/message":
          return { role: "user", content: e.data.content }
        case "assistant/message":
          return e.data.message // 存的就是模型返回的完整消息（含 content 和 tool_calls）
        case "tool/result":
          return { role: "tool", tool_call_id: e.data.tool_call_id, content: e.data.content }
        default:
          throw new Error(`非 surface 事件不该出现在名单里: ${e.type}`)
      }
    })
  }
}

// ═══════════════════════════════════════════════════════════════
//  service：工具注册表（和 L2 一样）
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
//  插件（和 L2 一样）：bash + log
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
    (args: { command: string }) => runBash(args.command),
  )
}

function logPlugin(ctx: Ctx) {
  ctx.on("tool:executed", ({ name }) => {
    console.log(`\x1b[90m  [log 插件] 工具 "${name}" 执行完毕\x1b[0m`)
  })
}

// ═══════════════════════════════════════════════════════════════
//  瘦循环：现在它对着 Session 追加事件，不再直接改一个数组
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  // pre-step 瀑布：base 现在返回 [系统提示 + 从日志派生的对话]。
  // 注意 SYSTEM 不进日志——它是每次"组装"出来的，不是对话历史的一部分。
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(), // ← 历史 = 每次从日志现场派生
  ])

  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: ctx.services.tools.schemas(),
    max_tokens: 4000,
  })
  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, true) // 模型回复 → 进日志 + 进名单
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments) as { command: string }
    console.log(`\x1b[33m$ ${args.command ?? JSON.stringify(args)}\x1b[0m`)
    const output: string = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 300))
    session.append("tool/result", { tool_call_id: call.id, content: output }, true) // 工具结果 → 进日志 + 名单
    await ctx.emit("tool:executed", { name: call.function.name, args, output })
  }
  return true
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText }) // 边界事件：进日志，不进名单
  session.append("user/message", { content: userText }, true) // 用户消息：进日志 + 名单
  while (await step(ctx, session)) {}
  session.append("turn/end", {}) // 边界事件：进日志，不进名单
}

// ═══════════════════════════════════════════════════════════════
//  组装
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
logPlugin(ctx)

const session = new Session() // ← 现在整场对话的真相就是这一条日志

// ── 入口 ──────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L3 · Session Log 是唯一真相")
console.log("输入问题回车发送。特殊命令：")
console.log("  /log      —— 打印原始事件日志（看它记了一切，包括 turn 边界）")
console.log("  /surface  —— 打印 surface 名单（模型实际看到哪些）")
console.log("  q         —— 退出\n")

while (true) {
  const q = await rl.question("\x1b[36mL3 >> \x1b[0m")
  const cmd = q.trim().toLowerCase()
  if (["q", "exit", ""].includes(cmd)) break

  // /log：把日志和名单摊开给你看——这就是「log vs surface」的直观演示
  if (cmd === "/log") {
    console.log("\x1b[90m── 事件日志（真相源，记录一切）──\x1b[0m")
    for (const e of session.events) {
      const onSurface = session.surface.includes(e.seq) ? "\x1b[32m[在名单]\x1b[0m" : "\x1b[90m[仅日志]\x1b[0m"
      console.log(`  seq ${String(e.seq).padStart(2)} ${e.type.padEnd(18)} ${onSurface}`)
    }
    console.log()
    continue
  }
  if (cmd === "/surface") {
    console.log(`\x1b[90m── surface 名单（模型实际看到的 seq 顺序）──\x1b[0m\n  [${session.surface.join(", ")}]\n`)
    continue
  }

  await runTurn(ctx, session, q)

  // 打印模型最后那句话（从日志里找最后一条 assistant 文本）
  const last = session.events[session.events.length - 2] // -1 是 turn/end，-2 才是最后的 assistant
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") {
    console.log(last.data.message.content)
  }
  console.log()
}
rl.close()
