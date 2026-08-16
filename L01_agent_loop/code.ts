/**
 * L1 · 最裸的循环 —— 一个 AI coding agent 的全部秘密
 *
 * 一句话：不停地把「工具结果」喂回给模型，直到模型说"我不调工具了"。
 *
 *     用户提问 ──> 模型 ──> 要调工具? ──是──> 执行工具 ──> 把结果塞回对话
 *                   ^                                              |
 *                   └──────────────────────────────────────────────┘
 *                                （循环，直到模型不再调工具）
 *
 * 这一课刻意写得"朴素而有病"。请你边跑边留意这三个病根，
 * 后面三根支柱(L2 插件 / L3 事件日志 / L4 KV缓存)正是来治它们的：
 *   ❶ 所有能力都焊死在循环里(bash 就写在 loop 旁边) → L2 要把它拆成插件
 *   ❷ 对话就是一个可变数组 history，谁都能随便改 → L3 要换成只增不改的事件日志
 *   ❸ 每一步都把整个 history 重新发一遍给模型 → L4 要从 KV 缓存角度审视它
 */

import OpenAI from "openai"
// 这几个类型来自 openai SDK，直接拿来用，帮我们在编辑器里自动补全、防手滑：
//   ChatCompletionMessageParam —— 一条对话消息（要发给模型的）
//   ChatCompletionTool         —— 一个工具的定义
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import * as readline from "node:readline/promises"
import "dotenv/config"

// ── 连上 DeepSeek（它的 API 和 OpenAI 兼容，所以直接用 openai 这个 SDK）──
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
})
const MODEL = process.env.MODEL_ID ?? "deepseek-chat"

const SYSTEM = `You are a coding agent working in ${process.cwd()}. Use the bash tool to accomplish tasks. Act, don't over-explain.`

// ── 工具定义：就一个 bash ────────────────────────────────
// 这是「告诉模型你有哪些工具」的 schema（OpenAI/DeepSeek 的 function calling 格式）
// 标上 ChatCompletionTool[]：写错字段名编辑器会立刻标红
const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "the shell command" } },
        required: ["command"],
      },
    },
  },
]

// ── 工具执行：真正去跑 shell 命令 ─────────────────────────
function runBash(command: string): string {
  // 最朴素的安全护栏（L5 会把它升级成真正的权限管线）
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
  if (dangerous.some((d) => command.includes(d))) return "Error: 危险命令已拦截"

  try {
    const out = execSync(command, {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return out.trim().slice(0, 50_000) || "(无输出)"
  } catch (e: any) {
    // 命令返回非 0 时 execSync 会抛异常，但 stdout/stderr 仍有内容
    const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim()
    return out ? out.slice(0, 50_000) : `Error: ${e.message}`
  }
}

// ── 核心：一个 while 循环，调工具直到模型停下 ──────────────
// history 现在有类型了：一个「消息数组」。（它仍是可变的 —— 病根 ❷ 还在，L3 治）
async function agentLoop(history: ChatCompletionMessageParam[]) {
  while (true) {
    // 病根 ❸：每转一圈，都把「整个 history」重新发给模型
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: history, // ← 不用再写 `as any` 了，类型对得上
      tools: TOOLS,
      max_tokens: 4000,
    })

    const msg = res.choices[0].message
    history.push(msg) // 把模型这一轮的回复追加进对话

    // 模型没调工具 → 它说完了，收工
    if (!msg.tool_calls || msg.tool_calls.length === 0) return

    // 模型要调工具 → 逐个执行，把结果塞回对话
    for (const call of msg.tool_calls) {
      // call.function.arguments 是一个 JSON 字符串，parse 出来的形状要到运行时才知道，
      // 所以这里用 `as { command: string }` 声明我们期望的形状。
      // 👉 这是个真实的边界：类型系统管不到「模型吐出来的 JSON」，真 harness 在这里做运行时校验。
      const args = JSON.parse(call.function.arguments) as { command: string }
      console.log(`\x1b[33m$ ${args.command}\x1b[0m`) // 黄色打印将要执行的命令
      const output = runBash(args.command)
      console.log(output.slice(0, 300))
      history.push({
        role: "tool",
        tool_call_id: call.id, // 用 id 把「结果」对回「哪次调用」
        content: output,
      })
    }
    // 循环继续 → 带着工具结果，再问一次模型
  }
}

// ── 入口：一个简单的命令行对话框 ──────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }]

console.log("L1 · 最裸的循环")
console.log("输入问题回车发送；输入 q 退出。\n")

while (true) {
  const q = await rl.question("\x1b[36mL1 >> \x1b[0m") // 青色提示符
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break

  history.push({ role: "user", content: q })
  await agentLoop(history)

  // 打印模型最后那句话
  const last = history[history.length - 1]
  if (last.role === "assistant" && typeof last.content === "string") {
    console.log(last.content)
  }
  console.log()
}
rl.close()
