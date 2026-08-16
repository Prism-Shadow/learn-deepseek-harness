/**
 * L10 · 自我修改 (P1 的终极形态)
 *
 * 让模型在运行时编写一个新工具并挂载进当前运行的 agent，随即就能调用它。
 * 这是「一切皆插件」的终点：连"扩展自己"本身也是一个工具。
 *
 * 之所以成立，靠两点：
 *   · 工具清单在每一步都从注册表重新生成——运行时新增的工具下一步即对模型可见
 *   · 注册表允许随时 register——新增无需重启
 *
 * 局限与边界（与真实 harness 一致）：
 *   · 临时性：挂载的工具只存于内存，进程结束即失，无自动持久化/晋升路径
 *   · 信任级别等同 bash：这里用 new Function 直接执行模型代码，不是安全边界
 *   · 「能改自己」是自我修改；要成为自我进化，还需评估→晋升→持久化的闭环——本课不含
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
const SYSTEM =
  `You are a coding agent working in ${process.cwd()}. ` +
  `If a small pure transformation would help, you may create a tool for it via define_tool ` +
  `(the tool body reads a variable 'input' and returns a value), then call the newly created tool. ` +
  `Act, don't over-explain.`

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
//  工具注册表（execute 异步；支持运行时随时 register）
// ═══════════════════════════════════════════════════════════════
function createToolRegistry() {
  const tools: Record<string, { schema: any; run: (args: any) => string | Promise<string> }> = {}
  return {
    register(name: string, schema: any, run: (args: any) => string | Promise<string>) {
      tools[name] = { schema, run }
    },
    // 每次请求都重新调用它生成工具清单——因此运行时新增的工具下一步即可见
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, ...t.schema } }))
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
//  ★ 本课主角：自我修改工具 define_tool
// ═══════════════════════════════════════════════════════════════
function selfModificationPlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "define_tool",
    {
      description:
        "Create and mount a new tool at runtime for this session. The body reads a string variable `input` and returns a value. " +
        "After creation, call the new tool by its name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "new tool name (letters/underscore)" },
          description: { type: "string" },
          code: { type: "string", description: "JS function body; reads `input`, uses `return`" },
        },
        required: ["name", "description", "code"],
      },
    },
    (args: { name: string; description: string; code: string }) => {
      let fn: (input: string) => unknown
      try {
        // 直接执行模型编写的代码：信任级别等同 bash，非安全边界
        fn = new Function("input", args.code) as (input: string) => unknown
      } catch (e: any) {
        return `Error: 代码解析失败 —— ${e.message}`
      }
      ctx.services.tools.register(
        args.name,
        { description: args.description, parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } },
        (a: { input: string }) => {
          try {
            return String(fn(a.input))
          } catch (e: any) {
            return `Error: ${e.message}`
          }
        },
      )
      console.log(`\x1b[35m[self-mod] 已挂载新工具 "${args.name}"\x1b[0m`)
      return `已挂载工具 "${args.name}"，本会话内可直接调用（临时，进程结束即失）。`
    },
  )
}

// ═══════════════════════════════════════════════════════════════
//  循环
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])
  const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 4000 })
  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, true)
  if (!msg.tool_calls?.length) return false
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    console.log(`\x1b[33m$ ${call.function.name} ${JSON.stringify(args).slice(0, 200)}\x1b[0m`)
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
selfModificationPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L10 · 自我修改")
console.log("可要求它先给自己造一个工具，再用这个工具。输入 q 退出。\n")

while (true) {
  const q = await rl.question("\x1b[36mL10 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") console.log(last.data.message.content)
  console.log()
}
rl.close()
