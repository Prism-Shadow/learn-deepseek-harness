/**
 * L4 · 对 KV Cache 敏感 (支柱 P3)
 *
 * 服务端前缀缓存的规则：从首个 token 起逐字节一致的前缀才能命中、免于重算；
 * 一旦某位置改变，其后全部失效。
 *
 * 由此得出上下文注入的纪律：一律追加到末尾(append-only)，不修改中间。
 *
 * 本课：
 *   1) 接入第一个上下文注入插件（在 agent/pre-step 向请求注入「当前时间」）
 *   2) 打印 DeepSeek 返回的缓存命中 token 数
 *   3) 用 /append 与 /prepend 对比同一注入放在末尾与开头对缓存命中的影响
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

// 系统提示写长一些，使前缀稳定超过 DeepSeek 缓存的最小块(约 64 tokens)，便于观察缓存
const SYSTEM =
  `You are a meticulous coding agent working in ${process.cwd()}. ` +
  `Use the available tools to accomplish tasks. When asked to look something up, ` +
  `call a tool and wait for its result before answering. Never invent tool output. ` +
  `Answer concisely in the user's language. Act, don't over-explain.`

// ═══════════════════════════════════════════════════════════════
//  迷你框架（同 L2/L3）
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
//  工具注册表 + bash/log 插件（同 L3）
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

// ═══════════════════════════════════════════════════════════════
//  ★ 本课新增：上下文注入插件（time-context 的最小形态）
//  注入的是每轮都不同的值（当前时间），因此注入位置直接决定缓存命中：
//    append  放末尾——其前的 [system + 对话] 前缀不变，命中
//    prepend 放开头——改变前缀，其后全部失效
// ═══════════════════════════════════════════════════════════════
let injectMode: "append" | "prepend" = "append"

function timeContextPlugin(ctx: Ctx) {
  ctx.on("agent/pre-step", async (_payload, next) => {
    const messages: ChatCompletionMessageParam[] = await next()
    const ctxMsg: ChatCompletionMessageParam = {
      role: "user",
      content: `[上下文] 当前时间：${new Date().toISOString()}`,
    }
    return injectMode === "append"
      ? [...messages, ctxMsg]
      : [messages[0], ctxMsg, ...messages.slice(1)] // system 之后、对话之前
  })
}

function logPlugin(ctx: Ctx) {
  ctx.on("tools/result", ({ exec }) => {
    console.log(`\x1b[90m  [log] 工具 "${exec.name}" 执行完毕\x1b[0m`)
  })
}

// ═══════════════════════════════════════════════════════════════
//  循环：新增读取并打印缓存命中数
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

  // DeepSeek 在 usage 附带 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
  // 不在 openai 标准类型中，经 as any 读取（外部 API 字段的合理边界）
  const usage = res.usage as any
  const hit = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
  const total = usage?.prompt_tokens ?? 0
  const miss = usage?.prompt_cache_miss_tokens ?? total - hit
  const pct = total ? Math.round((hit / total) * 100) : 0
  console.log(`\x1b[35m[KV] 输入 ${total} tokens：命中 ${hit} (${pct}%) / 未命中 ${miss}  [注入模式: ${injectMode}]\x1b[0m`)

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
  session.append("turn/start", { text: userText })
  session.append("user/message", { content: userText }, true)
  while (await step(ctx, session)) {}
  session.append("turn/end", {})
}

// ═══════════════════════════════════════════════════════════════
//  组装：新增 timeContextPlugin
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
timeContextPlugin(ctx)
logPlugin(ctx)

const session = new Session()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L4 · 对 KV Cache 敏感")
console.log("每次回复后打印 [KV] 缓存命中。命令：")
console.log("  /append  上下文注入到末尾（append-only，正确）")
console.log("  /prepend 上下文注入到开头（对照，观察缓存失效）")
console.log("  /log /surface | q 退出")
console.log("对比：/append 连续提问观察命中率上升；切 /prepend 观察命中率下降。\n")

while (true) {
  const q = await rl.question("\x1b[36mL4 >> \x1b[0m")
  const cmd = q.trim().toLowerCase()
  if (["q", "exit", ""].includes(cmd)) break

  if (cmd === "/append" || cmd === "/prepend") {
    injectMode = cmd.slice(1) as "append" | "prepend"
    console.log(`\x1b[35m注入模式: ${injectMode}\x1b[0m\n`)
    continue
  }
  if (cmd === "/log") {
    console.log("\x1b[90m── 事件日志 ──\x1b[0m")
    for (const e of session.events) {
      const on = session.surface.includes(e.seq) ? "\x1b[32m[在 surface]\x1b[0m" : "\x1b[90m[仅日志]\x1b[0m"
      console.log(`  seq ${String(e.seq).padStart(2)} ${e.type.padEnd(18)} ${on}`)
    }
    console.log()
    continue
  }
  if (cmd === "/surface") {
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
