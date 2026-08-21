/**
 * L5 · 工具管线 + 权限 (P1 + P2)
 *
 * 前几课工具执行是一次直接的函数调用。真实 harness 把它升级为一条分层管线，
 * 让权限、审计、结果改写各自作为独立环节接入：
 *
 *   pre-execute(瀑布: 允许/拒绝/询问) → guard(单调否决) → 执行 → post-execute(瀑布: 改写结果) → result(通知)
 *
 * 每一环都是一个扩展点，分别承载安全策略(权限)、不可绕过的硬规则(guard)、结果加工、观察。
 * 本课新增 read_file 作为第二个工具，并接入一个 permission 插件，对写/删类命令要求用户确认。
 *
 * 为聚焦管线，本课未叠加 L4 的上下文注入等插件；L8 会将各能力组装到一起。
 */

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
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
//  Session（同 L3）
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
interface SessionEvent {
  seq: number
  type: SurfaceType | "turn/start" | "turn/end" | "tool/call"
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
    // seq 等于事件在 events 中的下标（events 只增，seq 与 push 同步自增），故可直接索引
    return this.surface.map((seq) => {
      const e = this.events[seq]
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
//  ★ 本课主角：带分层管线的工具注册表
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
// 允许 / 拒绝 / 询问用户
type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string }

function createToolRegistry(ctx: Ctx) {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  const guards: Array<(exec: ToolExec) => string | undefined> = []

  return {
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    // 单调 guard：一旦某个 guard 拒绝，后续环节无法翻转（不可绕过的硬规则）
    guard(fn: (exec: ToolExec) => string | undefined) {
      guards.push(fn)
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({
        type: "function",
        function: { name, ...t.schema },
      }))
    },

    async execute(exec: ToolExec): Promise<ToolResult> {
      // 1) pre-execute 瀑布：插件给出 allow/deny/ask，默认 allow
      let decision: PreToolDecision = await ctx.waterfall(
        "tools/pre-execute",
        { exec },
        async () => ({ kind: "allow" }),
      )

      // 2) guard：单调否决，位于 pre-execute 之后，任何 ask 都无法翻转它
      for (const g of guards) {
        const reason = g(exec)
        if (reason) decision = { kind: "deny", reason }
      }

      // 3) ask：交由确认服务询问用户；无确认服务时降级为拒绝
      if (decision.kind === "ask") {
        const confirm = ctx.services.confirm as undefined | ((e: ToolExec, r: string) => Promise<boolean>)
        const ok = confirm ? await confirm(exec, decision.reason) : false
        decision = ok ? { kind: "allow" } : { kind: "deny", reason: "用户未批准" }
      }

      if (decision.kind === "deny") {
        return { content: `Error: 工具调用被拒绝 —— ${decision.reason}`, isError: true }
      }

      // 4) 执行
      const t = tools[exec.name]
      let result: ToolResult = t
        ? { content: t.run(exec.args), isError: false }
        : { content: `Error: 未知工具 ${exec.name}`, isError: true }

      // 5) post-execute 瀑布：插件可改写结果内容
      result = await ctx.waterfall("tools/post-execute", { exec, result }, async () => result)

      // 6) result 通知：仅供观察，不能改变结果
      await ctx.emit("tools/result", { exec, result })
      return result
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  工具插件
// ═══════════════════════════════════════════════════════════════
function bashPlugin(ctx: Ctx) {
  function runBash(command: string): string {
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
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    (args: { command: string }) => runBash(args.command),
  )
}

function readFilePlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "read_file",
    {
      description: "Read a UTF-8 text file and return its content.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    (args: { path: string }) => {
      try {
        return readFileSync(args.path, "utf8").slice(0, 50_000)
      } catch (e: any) {
        return `Error: ${e.message}`
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════
//  ★ 权限插件：策略与硬规则分离
//    · 硬规则用 guard：命中即拒绝，任何询问都无法翻转（如 rm -rf /）
//    · 一般写/删操作用 pre-execute 返回 ask，交由用户确认
// ═══════════════════════════════════════════════════════════════
function permissionPlugin(ctx: Ctx) {
  const registry = ctx.services.tools

  registry.guard((exec: ToolExec) => {
    if (exec.name === "bash" && /rm\s+-rf\s+\/(?!\w)|shutdown|reboot|:\(\)\s*\{/.test(exec.args.command ?? "")) {
      return "命中不可执行的危险模式"
    }
    return undefined
  })

  ctx.on("tools/pre-execute", ({ exec }: { exec: ToolExec }): PreToolDecision => {
    if (exec.name === "bash") {
      const cmd: string = exec.args.command ?? ""
      const mutating = /\b(rm|mv|cp|chmod|chown|git\s+push|>|>>|tee|mkdir|touch|npm\s+i)/.test(cmd)
      if (mutating) return { kind: "ask", reason: `即将执行可能修改系统的命令：${cmd}` }
    }
    return { kind: "allow" } // read_file 及只读命令直接放行
  })
}

// ═══════════════════════════════════════════════════════════════
//  循环：先记录 tool/call(审计意图)，再执行管线，最后记录 tool/result
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
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
    const args = JSON.parse(call.function.arguments)
    const exec: ToolExec = { callId: call.id, name: call.function.name, args }
    // 先记录调用意图（log-only），再执行：崩溃时可判断某调用是否已发起
    session.append("tool/call", { callId: exec.callId, name: exec.name, args })
    console.log(`\x1b[33m$ ${exec.name} ${JSON.stringify(args)}\x1b[0m`)
    const result = await ctx.services.tools.execute(exec)
    console.log((result.isError ? "\x1b[31m" : "") + result.content.slice(0, 300) + "\x1b[0m")
    session.append("tool/result", { tool_call_id: call.id, content: result.content }, true)
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
ctx.provide("tools", createToolRegistry(ctx))
bashPlugin(ctx)
readFilePlugin(ctx)
permissionPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

// 确认服务：管线遇到 ask 时调用它询问用户。策略(问什么)在 permission 插件，机制(如何问)在这里
ctx.provide("confirm", async (_exec: ToolExec, reason: string): Promise<boolean> => {
  const a = await rl.question(`\x1b[31m[需要确认] ${reason}\n  允许执行? (y/N) \x1b[0m`)
  return a.trim().toLowerCase() === "y"
})

console.log("L5 · 工具管线 + 权限")
console.log("只读命令直接执行；写/删类命令会要求确认。输入 q 退出。\n")

while (true) {
  const q = await rl.question("\x1b[36mL5 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") {
    console.log(last.data.message.content)
  }
  console.log()
}
rl.close()
