/**
 * L6 · 上下文压缩 (P1 + P2 + P3 三支柱合流)
 *
 * 对话变长后需要压缩：把较旧的一段替换为一条摘要，缩短后续请求。
 * 这一课让三根支柱同时发挥作用：
 *   P1 压缩是一个插件，挂在 pre-step，循环不改
 *   P2 压缩不删日志——仅向日志追加 compact/* 与一条带 replace 的消息，改写 surface；原始事件保留
 *   P3 两处缓存要点：
 *      · 摘要请求复用当前对话前缀(把压缩指令放末尾)，避免为摘要重算整段
 *      · 压缩替换了 surface 中间一段，会使服务端缓存从该位置起失效——这是压缩的固有代价
 *
 * 为聚焦压缩，本课仅保留 bash 工具。
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
//  Session：新增 replace 语义
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
// append：进入 surface 末尾；replace：用本事件替换 surface 上 [start,end] 一段
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
    if (op === "append") {
      this.surface.push(event.seq)
    } else if (op && op.op === "replace") {
      // 用新事件替换 surface 上 [start,end] 覆盖的连续区段；被替换的原事件仍留在日志中
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
//  工具注册表 + bash（简化版）
// ═══════════════════════════════════════════════════════════════
function createToolRegistry() {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  return {
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, ...t.schema } }))
    },
    execute(name: string, args: any): string {
      const t = tools[name]
      return t ? t.run(args) : `Error: 未知工具 ${name}`
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
//  ★ 本课主角：压缩插件
// ═══════════════════════════════════════════════════════════════
const COMPACT_INSTRUCTION =
  "你现在是压缩引擎。请将上面的对话浓缩为一段简洁的检查点，保留目标、已完成的关键步骤、" +
  "重要结论与未决事项。只输出检查点正文，不要调用工具，不要提及本次压缩请求。"

// 摘要请求复用当前对话前缀：把 [system + 待压缩段] 作为前缀(它是刚发出的对话请求的前缀)，
// 压缩指令放在末尾。因此服务端可命中已有缓存，无需为摘要重算整段。
async function summarize(ctx: Ctx, rangeMsgs: ChatCompletionMessageParam[]): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    ...rangeMsgs,
    { role: "user", content: COMPACT_INSTRUCTION },
  ]
  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: ctx.services.tools.schemas(), // 保持前缀与对话请求一致，最大化缓存复用
    max_tokens: 1024,
  })
  const hit = (res.usage as any)?.prompt_cache_hit_tokens ?? 0
  console.log(`\x1b[35m[compaction] 摘要请求复用对话前缀，缓存命中 ${hit} tokens\x1b[0m`)
  return res.choices[0].message.content ?? "(摘要为空)"
}

async function maybeCompact(ctx: Ctx, session: Session, threshold: number, retain: number, force = false) {
  if (!force && session.surface.length <= threshold) return
  if (session.surface.length <= retain) return

  let cut = session.surface.length - retain
  // 避免保留段以孤立的 tool/result 开头(其对应的 assistant 调用在被压缩段)：把这些 tool/result 并入压缩段
  while (cut < session.surface.length && session.typeOfSeq(session.surface[cut]) === "tool/result") cut++
  if (cut < 2) return

  const rangeSeqs = session.surface.slice(0, cut)
  const start = rangeSeqs[0]
  const end = rangeSeqs[rangeSeqs.length - 1]

  session.append("compact/start", { start, end }) // log-only：记录压缩区间
  const summary = await summarize(ctx, session.deriveMessages(rangeSeqs))
  session.append("compact/summary", { summary, shadowed: rangeSeqs }) // log-only：保留摘要与被遮蔽的 seq
  // 唯一的 surface 变更：用一条摘要消息替换被压缩区间；原事件仍在日志
  session.append("user/message", { content: `<compacted-summary>\n${summary}\n</compacted-summary>` }, { op: "replace", start, end })
  session.append("compact/end", {})

  console.log(`\x1b[35m[compaction] 已将 surface[${start}..${end}] 替换为一条摘要；该位置起的服务端缓存将失效(压缩的固有代价)\x1b[0m`)
}

// ═══════════════════════════════════════════════════════════════
//  循环
// ═══════════════════════════════════════════════════════════════
const THRESHOLD = 8 // surface 超过这么多条即自动压缩
const RETAIN = 4 // 保留最近这么多条不压缩

async function step(ctx: Ctx, session: Session): Promise<boolean> {
  // 压缩挂在 pre-step 最前：先(可能)压缩，再由 base 从压缩后的 surface 派生消息
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])

  const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 4000 })
  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, "append")
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    console.log(`\x1b[33m$ ${call.function.name} ${JSON.stringify(args)}\x1b[0m`)
    const output = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 200))
    session.append("tool/result", { tool_call_id: call.id, content: output }, "append")
  }
  return true
}

function compactionPlugin(ctx: Ctx) {
  ctx.on("pre-step", async ({ session }: { session: Session }, next: NextFn) => {
    await maybeCompact(ctx, session, THRESHOLD, RETAIN)
    return next()
  })
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText })
  session.append("user/message", { content: userText }, "append")
  while (await step(ctx, session)) {}
  session.append("turn/end", {})
}

// ═══════════════════════════════════════════════════════════════
//  组装
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
compactionPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L6 · 上下文压缩")
console.log(`surface 超过 ${THRESHOLD} 条自动压缩，保留最近 ${RETAIN} 条。命令：`)
console.log("  /compact 立即压缩 | /log 查看日志与 surface | q 退出\n")

while (true) {
  const q = await rl.question("\x1b[36mL6 >> \x1b[0m")
  const cmd = q.trim().toLowerCase()
  if (["q", "exit", ""].includes(cmd)) break

  if (cmd === "/compact") {
    await maybeCompact(ctx, session, THRESHOLD, RETAIN, true)
    console.log()
    continue
  }
  if (cmd === "/log") {
    console.log("\x1b[90m── 事件日志（含被压缩遮蔽的原始事件，均保留）──\x1b[0m")
    for (const e of session.events) {
      const on = session.surface.includes(e.seq) ? "\x1b[32m[在 surface]\x1b[0m" : "\x1b[90m[仅日志]\x1b[0m"
      console.log(`  seq ${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${on}`)
    }
    console.log(`\x1b[90msurface:\x1b[0m [${session.surface.join(", ")}]\n`)
    continue
  }

  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") {
    console.log(last.data.message.content)
  }
  console.log()
}
rl.close()
