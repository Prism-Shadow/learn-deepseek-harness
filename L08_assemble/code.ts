/**
 * L8 · 组装成小 harness (三支柱合力)
 *
 * 前面各课分别做出了插件：工具管线与权限(L5)、压缩(L6)、记忆(L7)、上下文注入(L4)。
 * 这一课把它们组装到一起，得到一个完整可用的小 harness。
 *
 * 全课的收束点在文件末尾的「组装」段——新增任意能力只需加一行，循环与其它插件都不动。
 * 这就是「一切皆插件」的复利：能力正交、可自由增删。
 */

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as readline from "node:readline/promises"
import "dotenv/config"

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
})
const MODEL = process.env.MODEL_ID ?? "deepseek-chat"
const SYSTEM = `You are a coding agent working in ${process.cwd()}. Use tools to accomplish tasks. When the user states a durable fact about themselves or the project, call remember. Act, don't over-explain.`

// ═══════════════════════════════════════════════════════════════
//  迷你框架
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
//  Session（含 replace，来自 L6）
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
type SurfaceOp = "append" | { op: "replace"; start: number; end: number }
interface SessionEvent {
  seq: number
  type: SurfaceType | "turn/start" | "turn/end" | "tool/call" | "compact/start" | "compact/summary" | "compact/end"
  data: any
}

class Session {
  events: SessionEvent[] = []
  surface: number[] = []
  private seqCounter = 0
  append(type: SessionEvent["type"], data: any, op?: SurfaceOp): SessionEvent {
    const event: SessionEvent = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (op === "append") this.surface.push(event.seq)
    else if (op && op.op === "replace") {
      const i = this.surface.indexOf(op.start)
      const j = this.surface.indexOf(op.end)
      this.surface.splice(i, j - i + 1, event.seq)
    }
    return event
  }
  typeOfSeq(seq: number): string {
    return this.events.find((e) => e.seq === seq)!.type
  }
  deriveMessages(seqs: number[] = this.surface): ChatCompletionMessageParam[] {
    const bySeq = new Map(this.events.map((e) => [e.seq, e]))
    return seqs.map((seq) => {
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
//  带管线的工具注册表（来自 L5）
// ═══════════════════════════════════════════════════════════════
interface ToolExec {
  callId: string
  name: string
  args: any
}
interface ToolResult {
  content: string
  isError: boolean
}
type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string }

function createToolRegistry(ctx: Ctx) {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  const guards: Array<(exec: ToolExec) => string | undefined> = []
  return {
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    guard(fn: (exec: ToolExec) => string | undefined) {
      guards.push(fn)
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, ...t.schema } }))
    },
    async execute(exec: ToolExec): Promise<ToolResult> {
      let decision: PreToolDecision = await ctx.waterfall("tools/pre-execute", { exec }, async () => ({ kind: "allow" }))
      for (const g of guards) {
        const r = g(exec)
        if (r) decision = { kind: "deny", reason: r }
      }
      if (decision.kind === "ask") {
        const confirm = ctx.services.confirm as undefined | ((e: ToolExec, r: string) => Promise<boolean>)
        decision = confirm && (await confirm(exec, decision.reason)) ? { kind: "allow" } : { kind: "deny", reason: "用户未批准" }
      }
      if (decision.kind === "deny") return { content: `Error: 工具调用被拒绝 —— ${decision.reason}`, isError: true }
      const t = tools[exec.name]
      let result: ToolResult = t ? { content: t.run(exec.args), isError: false } : { content: `Error: 未知工具 ${exec.name}`, isError: true }
      result = await ctx.waterfall("tools/post-execute", { exec, result }, async () => result)
      await ctx.emit("tools/result", { exec, result })
      return result
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  插件们（各自独立，均来自前面的课）
// ═══════════════════════════════════════════════════════════════
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

function readFilePlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "read_file",
    { description: "Read a UTF-8 text file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    (args: { path: string }) => {
      try {
        return readFileSync(args.path, "utf8").slice(0, 50_000)
      } catch (e: any) {
        return `Error: ${e.message}`
      }
    },
  )
}

function permissionPlugin(ctx: Ctx) {
  ctx.services.tools.guard((exec: ToolExec) =>
    exec.name === "bash" && /rm\s+-rf\s+\/(?!\w)|shutdown|reboot/.test(exec.args.command ?? "") ? "命中不可执行的危险模式" : undefined,
  )
  ctx.on("tools/pre-execute", ({ exec }: { exec: ToolExec }): PreToolDecision => {
    if (exec.name === "bash" && /\b(rm|mv|cp|chmod|git\s+push|>|>>|tee|mkdir|touch|npm\s+i)/.test(exec.args.command ?? "")) {
      return { kind: "ask", reason: `即将执行可能修改系统的命令：${exec.args.command}` }
    }
    return { kind: "allow" }
  })
}

function timeContextPlugin(ctx: Ctx) {
  // 追加到末尾，保持前缀稳定（P3）
  ctx.on("agent/pre-step", async (_p: unknown, next: NextFn) => {
    const messages: ChatCompletionMessageParam[] = await next()
    return [...messages, { role: "user", content: `[上下文] 当前时间：${new Date().toISOString()}` }]
  })
}

const MEMORY_FILE = "agent-memory.json"
function memoryPlugin(ctx: Ctx) {
  type Memory = { text: string; ts: string }
  const memories: Memory[] = existsSync(MEMORY_FILE) ? JSON.parse(readFileSync(MEMORY_FILE, "utf8")) : []
  let recalled = false
  ctx.services.tools.register(
    "remember",
    { description: "Save a durable fact for future sessions.", parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } },
    (args: { fact: string }) => {
      memories.push({ text: args.fact, ts: new Date().toISOString() })
      writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2))
      return `已记住：${args.fact}`
    },
  )
  ctx.on("agent/pre-step", async ({ session }: { session: Session }, next: NextFn) => {
    if (!recalled && memories.length) {
      recalled = true
      session.append("user/message", { content: `[记忆] 既有事实：\n${memories.map((m, i) => `${i + 1}. ${m.text}`).join("\n")}` }, "append")
    }
    return next()
  })
}

const COMPACT_INSTRUCTION = "你现在是压缩引擎。请将上面的对话浓缩为一段简洁检查点，保留目标、关键步骤、结论与未决事项。只输出正文，不要调用工具，不要提及本次压缩。"
function compactionPlugin(ctx: Ctx, threshold = 10, retain = 4) {
  async function summarize(rangeMsgs: ChatCompletionMessageParam[]): Promise<string> {
    // 复用对话前缀 + 指令后置，最大化缓存命中（P3）
    const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }, ...rangeMsgs, { role: "user", content: COMPACT_INSTRUCTION }]
    const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 1024 })
    return res.choices[0].message.content ?? "(摘要为空)"
  }
  ctx.on("agent/pre-step", async ({ session }: { session: Session }, next: NextFn) => {
    if (session.surface.length > threshold && session.surface.length > retain) {
      let cut = session.surface.length - retain
      while (cut < session.surface.length && session.typeOfSeq(session.surface[cut]) === "tool/result") cut++
      if (cut >= 2) {
        const range = session.surface.slice(0, cut)
        const start = range[0]
        const end = range[range.length - 1]
        session.append("compact/start", { start, end })
        const summary = await summarize(session.deriveMessages(range))
        session.append("compact/summary", { summary, shadowed: range })
        session.append("user/message", { content: `<compacted-summary>\n${summary}\n</compacted-summary>` }, { op: "replace", start, end })
        session.append("compact/end", {})
        console.log(`\x1b[35m[compaction] 已压缩 surface[${start}..${end}]\x1b[0m`)
      }
    }
    return next()
  })
}

// ═══════════════════════════════════════════════════════════════
//  循环
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])
  const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 4000 })
  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, "append")
  if (!msg.tool_calls?.length) return false
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    const exec: ToolExec = { callId: call.id, name: call.function.name, args }
    session.append("tool/call", { callId: exec.callId, name: exec.name, args })
    console.log(`\x1b[33m$ ${exec.name} ${JSON.stringify(args)}\x1b[0m`)
    const result = await ctx.services.tools.execute(exec)
    console.log((result.isError ? "\x1b[31m" : "") + result.content.slice(0, 200) + "\x1b[0m")
    session.append("tool/result", { tool_call_id: call.id, content: result.content }, "append")
  }
  return true
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText })
  session.append("user/message", { content: userText }, "append")
  while (await step(ctx, session)) {}
  session.append("turn/end", {})
}

// ═══════════════════════════════════════════════════════════════
//  组装：一个完整 harness。增删能力只改这一段
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry(ctx))
bashPlugin(ctx)
readFilePlugin(ctx)
permissionPlugin(ctx)
memoryPlugin(ctx)
timeContextPlugin(ctx)
compactionPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
ctx.provide("confirm", async (_e: ToolExec, reason: string) => (await rl.question(`\x1b[31m[确认] ${reason}\n  允许? (y/N) \x1b[0m`)).trim().toLowerCase() === "y")

console.log("L8 · 组装成小 harness")
console.log("已装载：bash + read_file + 权限 + 记忆 + 时间上下文 + 压缩。输入 q 退出。\n")

while (true) {
  const q = await rl.question("\x1b[36mL8 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") console.log(last.data.message.content)
  console.log()
}
rl.close()
