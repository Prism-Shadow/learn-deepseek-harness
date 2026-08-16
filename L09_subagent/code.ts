/**
 * L9 · 子 agent (P1)
 *
 * 把「派生一个带独立上下文的子循环」做成一个工具：spawn_subagent(task)。
 * 子 agent 有自己独立的 Session，完成任务后只把最终结果回传给父 agent。
 *
 * 关键价值是上下文隔离：子 agent 探索过程中的大量工具调用与中间输出留在它自己的
 * Session 里，不进入父 agent 的上下文。父 agent 只收到一段结论，上下文因而保持精简
 * （也利于缓存与成本，呼应 P3）。子 agent 本身就是同一套循环——「一切皆插件」下，
 * 它只是又一个被工具触发的循环实例。
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
const SYSTEM = `You are a coding agent working in ${process.cwd()}. For a self-contained sub-task that would involve many exploratory steps, delegate it via spawn_subagent to keep your own context clean. Act, don't over-explain.`
const CHILD_SYSTEM = `You are a sub-agent with an isolated context. Complete the delegated task using bash, then report a concise final result. You cannot delegate further.`

// ═══════════════════════════════════════════════════════════════
//  迷你框架（同前）
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
//  Session（同 L3）
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
interface SessionEvent {
  seq: number
  type: SurfaceType | "turn/start" | "turn/end"
  data: any
}

class Session {
  events: SessionEvent[] = []
  surface: number[] = []
  private seqCounter = 0
  append(type: SessionEvent["type"], data: any, onSurface = false): SessionEvent {
    const event: SessionEvent = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (onSurface) this.surface.push(event.seq)
    return event
  }
  deriveMessages(): ChatCompletionMessageParam[] {
    const bySeq = new Map(this.events.map((e) => [e.seq, e]))
    return this.surface.map((seq) => {
      const e = bySeq.get(seq)!
      switch (e.type) {
        case "user/message":
          return { role: "user", content: e.data.content }
        case "assistant/message":
          return e.data.message
        case "tool/result":
          return { role: "tool", tool_call_id: e.data.tool_call_id, content: e.data.content }
        default:
          throw new Error(`非 surface 事件不应出现在 surface 列表中: ${e.type}`)
      }
    })
  }
}

// ═══════════════════════════════════════════════════════════════
//  工具注册表：execute 改为异步（子 agent 的执行是异步的）
// ═══════════════════════════════════════════════════════════════
function createToolRegistry() {
  const tools: Record<string, { schema: any; run: (args: any) => string | Promise<string> }> = {}
  return {
    register(name: string, schema: any, run: (args: any) => string | Promise<string>) {
      tools[name] = { schema, run }
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, ...t.schema } }))
    },
    // 仅暴露指定名字的工具 schema，用于给子 agent 一个受限工具集（防止无限委派）
    schemasFor(names: string[]): ChatCompletionTool[] {
      return this.schemas().filter((t) => names.includes(t.function.name))
    },
    async execute(name: string, args: any): Promise<string> {
      const t = tools[name]
      return t ? await t.run(args) : `Error: 未知工具 ${name}`
    },
  }
}

function bashPlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "bash",
    { description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    (args: { command: string }) => {
      try {
        return execSync(args.command, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim().slice(0, 50_000) || "(无输出)"
      } catch (e: any) {
        return (((e.stdout ?? "") + (e.stderr ?? "")).trim() || `Error: ${e.message}`).slice(0, 50_000)
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════
//  ★ 本课主角：子 agent
// ═══════════════════════════════════════════════════════════════

// 运行一个拥有独立 Session、受限工具集(仅 bash)的子循环，直至其不再调用工具，返回最终文本
async function runSubagent(ctx: Ctx, task: string): Promise<string> {
  const child = new Session()
  child.append("user/message", { content: task }, true)
  const childTools = ctx.services.tools.schemasFor(["bash"]) // 不含 spawn_subagent，避免无限委派

  for (let guard = 0; guard < 20; guard++) {
    const messages: ChatCompletionMessageParam[] = [{ role: "system", content: CHILD_SYSTEM }, ...child.deriveMessages()]
    const res = await client.chat.completions.create({ model: MODEL, messages, tools: childTools, max_tokens: 2000 })
    const msg = res.choices[0].message
    child.append("assistant/message", { message: msg }, true)
    if (!msg.tool_calls?.length) return typeof msg.content === "string" ? msg.content : "(子 agent 无输出)"
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments)
      console.log(`\x1b[90m    [子 agent] $ ${args.command}\x1b[0m`)
      const output = await ctx.services.tools.execute(call.function.name, args)
      child.append("tool/result", { tool_call_id: call.id, content: output }, true)
    }
  }
  return "(子 agent 超出步数上限)"
}

function subagentPlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "spawn_subagent",
    {
      description: "Delegate a self-contained sub-task to a fresh sub-agent with its own isolated context. Returns only its final result.",
      parameters: { type: "object", properties: { task: { type: "string", description: "the self-contained task description" } }, required: ["task"] },
    },
    async (args: { task: string }) => {
      console.log(`\x1b[90m  [派生子 agent] ${args.task}\x1b[0m`)
      return await runSubagent(ctx, args.task) // 只有这段返回值进入父 agent 的上下文
    },
  )
}

// ═══════════════════════════════════════════════════════════════
//  父循环（execute 现为异步）
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])
  const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 4000 })
  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, true)
  if (!msg.tool_calls?.length) return false
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    console.log(`\x1b[33m$ ${call.function.name} ${JSON.stringify(args)}\x1b[0m`)
    const output = await ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 200))
    session.append("tool/result", { tool_call_id: call.id, content: output }, true)
  }
  return true
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText })
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
subagentPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L9 · 子 agent")
console.log("给它一个需要多步探索的任务，它会派生子 agent 处理并只回传结论。输入 q 退出。\n")

while (true) {
  const q = await rl.question("\x1b[36mL9 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") console.log(last.data.message.content)
  console.log()
}
rl.close()
