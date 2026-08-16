/**
 * L4 · 对 KV Cache 敏感 (支柱 P3)
 *
 * 前情：L3 里模型看到的对话是每次从日志「派生」出来的。这一课要问一个致命问题：
 *   这一大串 token 发给 DeepSeek，服务端是怎么「缓存」它的？我们的每个动作又如何影响缓存？
 *
 * 服务端前缀缓存的铁律只有一条：
 *   ▶ 从第一个 token 开始「逐字节一致」的那段前缀，才能命中缓存、不必重算。
 *     一旦某个位置变了，从那个位置往后全部作废，要重新做一遍 prompt processing。
 *
 * 由此推出 DeepSeek Harness 所有上下文设计背后的那条纪律：
 *   ▶ 往对话里加东西，一律「append-only」——只往末尾加，绝不动中间。
 *
 * 这一课我们：
 *   1) 挂上第一个「上下文注入插件」(在 pre-step 往请求里塞"当前时间")
 *   2) 打印 DeepSeek 真实返回的缓存命中 token 数，让你亲眼看到缓存在工作
 *   3) 提供 /append 和 /prepend 两个开关：把注入放"末尾"还是"开头"，
 *      对比同一个动作对缓存命中的天壤之别 —— 这就是"append-only"的意义
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

// 系统提示写得稍长一点，让"前缀"稳稳超过 DeepSeek 缓存的最小块(64 tokens)，缓存才好观察。
const SYSTEM =
  `You are a meticulous coding agent working in ${process.cwd()}. ` +
  `Use the available tools to accomplish tasks. When asked to look something up, ` +
  `call a tool and wait for its result before answering. Never invent tool output. ` +
  `Answer concisely in the user's language. Act, don't over-explain.`

// ═══════════════════════════════════════════════════════════════
//  迷你框架（和 L2/L3 一样）
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
//  Session：append-only 事件日志（和 L3 一样）
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
          throw new Error(`非 surface 事件不该出现在名单里: ${e.type}`)
      }
    })
  }
}

// ═══════════════════════════════════════════════════════════════
//  工具注册表 + bash/log 插件（和 L3 一样）
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
//  ★ 本课新增插件：上下文注入（time-context 的最小版）
//  每次发请求前，往消息里塞一条"当前时间"上下文。
//  injectMode 决定塞在末尾(append) 还是开头(prepend) —— 用来对比 KV 缓存效果。
// ═══════════════════════════════════════════════════════════════
let injectMode: "append" | "prepend" = "append" // 默认 append（正确做法）

function timeContextPlugin(ctx: Ctx) {
  // 监听 pre-step 瀑布：先拿到下游要发的消息，再把上下文加进去。
  // 这就是真实 harness 里 time-context 的写法：const msgs = await next(); return [...msgs, ctxMsg]
  ctx.on("pre-step", async (_payload, next) => {
    const messages: ChatCompletionMessageParam[] = await next()
    const ctxMsg: ChatCompletionMessageParam = {
      role: "user",
      content: `[上下文] 当前时间：${new Date().toISOString()}`, // ← 这是个每次都变的值！
    }
    if (injectMode === "append") {
      // ✅ 加在末尾：前面的 [system + 整段对话] 前缀一个字节没变 → 缓存命中
      return [...messages, ctxMsg]
    } else {
      // ❌ 加在 system 之后、对话之前：改动了前缀，从这条往后全部错位 → 缓存全废
      return [messages[0], ctxMsg, ...messages.slice(1)]
    }
  })
}

function logPlugin(ctx: Ctx) {
  ctx.on("tool:executed", ({ name }) => {
    console.log(`\x1b[90m  [log 插件] 工具 "${name}" 执行完毕\x1b[0m`)
  })
}

// ═══════════════════════════════════════════════════════════════
//  瘦循环：多了一步——读出 DeepSeek 返回的缓存命中数并打印
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])

  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: ctx.services.tools.schemas(),
    max_tokens: 4000,
  })

  // ── KV 缓存观测 ──
  // DeepSeek 在 usage 里额外返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens。
  // 这两个字段不在 openai 的标准类型里，所以用 `as any` 取（外部边界，合理的一处 any）。
  const usage = res.usage as any
  const hit = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
  const total = usage?.prompt_tokens ?? 0
  const miss = usage?.prompt_cache_miss_tokens ?? total - hit
  const pct = total ? Math.round((hit / total) * 100) : 0
  console.log(
    `\x1b[35m[KV] 输入 ${total} tokens：缓存命中 ${hit} (${pct}%) / 未命中 ${miss}  ` +
      `[注入模式: ${injectMode}]\x1b[0m`,
  )

  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, true)
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments) as { command: string }
    console.log(`\x1b[33m$ ${args.command ?? JSON.stringify(args)}\x1b[0m`)
    const output: string = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 300))
    session.append("tool/result", { tool_call_id: call.id, content: output }, true)
    await ctx.emit("tool:executed", { name: call.function.name, args, output })
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
//  组装：多挂一个 timeContextPlugin
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
timeContextPlugin(ctx) // ← 本课新增：上下文注入插件
logPlugin(ctx)

const session = new Session()

// ── 入口 ──────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L4 · 对 KV Cache 敏感")
console.log("每次回复后会打印一行紫色 [KV] 缓存命中情况。特殊命令：")
console.log("  /append   —— 上下文注入到「末尾」(append-only，正确做法)")
console.log("  /prepend  —— 上下文注入到「开头」(错误做法，看缓存怎么崩)")
console.log("  /log /surface —— 同 L3")
console.log("  q         —— 退出")
console.log("\n玩法：先在 /append 模式连问几句，看缓存命中越来越高；")
console.log("再切 /prepend 连问几句，看命中率暴跌到几乎为 0。\n")

while (true) {
  const q = await rl.question("\x1b[36mL4 >> \x1b[0m")
  const cmd = q.trim().toLowerCase()
  if (["q", "exit", ""].includes(cmd)) break

  if (cmd === "/append" || cmd === "/prepend") {
    injectMode = cmd.slice(1) as "append" | "prepend"
    console.log(`\x1b[35m已切换注入模式为: ${injectMode}\x1b[0m\n`)
    continue
  }
  if (cmd === "/log") {
    console.log("\x1b[90m── 事件日志 ──\x1b[0m")
    for (const e of session.events) {
      const on = session.surface.includes(e.seq) ? "\x1b[32m[在名单]\x1b[0m" : "\x1b[90m[仅日志]\x1b[0m"
      console.log(`  seq ${String(e.seq).padStart(2)} ${e.type.padEnd(18)} ${on}`)
    }
    console.log()
    continue
  }
  if (cmd === "/surface") {
    console.log(`\x1b[90msurface 名单:\x1b[0m [${session.surface.join(", ")}]\n`)
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
