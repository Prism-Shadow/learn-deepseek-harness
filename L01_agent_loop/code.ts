/**
 * L1 · 最裸的循环
 *
 * 一个 AI coding agent 的核心：把工具结果反复喂回给模型，直到模型不再请求工具。
 *
 *     用户提问 ──> 模型 ──> 请求工具? ──是──> 执行工具 ──> 结果写回对话
 *                   ^                                            |
 *                   └────────────────────────────────────────────┘
 *
 * 这一课刻意从简，留下三处局限；后面三根支柱(L2 插件 / L3 事件日志 / L4 KV缓存)逐一解决：
 *   ❶ 能力与循环耦合：bash 直接写在循环旁    → L2 拆成插件
 *   ❷ 对话是可变数组 history，可被任意修改   → L3 换成 append-only 事件日志
 *   ❸ 每步都重发整个 history                 → L4 从 KV 缓存角度审视
 */

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import * as readline from "node:readline/promises"
import "dotenv/config"

// DeepSeek API 与 OpenAI 兼容，故用 openai SDK 指向 DeepSeek 地址
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
})
const MODEL = process.env.MODEL_ID ?? "deepseek-chat"

const SYSTEM = `You are a coding agent working in ${process.cwd()}. Use the bash tool to accomplish tasks. Act, don't over-explain.`

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

function runBash(command: string): string {
  // 最小安全护栏，L5 升级为完整权限管线
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
  if (dangerous.some((d) => command.includes(d))) return "Error: 危险命令已拦截"

  try {
    const out = execSync(command, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] })
    return out.trim().slice(0, 50_000) || "(无输出)"
  } catch (e: any) {
    // 命令退出码非 0 时 execSync 抛异常，但 stdout/stderr 仍需返回给模型
    const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim()
    return out ? out.slice(0, 50_000) : `Error: ${e.message}`
  }
}

async function agentLoop(history: ChatCompletionMessageParam[]) {
  while (true) {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: history,
      tools: TOOLS,
      max_tokens: 4000,
    })

    const msg = res.choices[0].message
    history.push(msg)

    // 模型未请求工具，本轮结束
    if (!msg.tool_calls || msg.tool_calls.length === 0) return

    for (const call of msg.tool_calls) {
      // arguments 是模型生成的 JSON 字符串，形状运行时才定：这是类型系统管不到的边界
      const args = JSON.parse(call.function.arguments) as { command: string }
      console.log(`\x1b[33m$ ${args.command}\x1b[0m`)
      const output = runBash(args.command)
      console.log(output.slice(0, 300))
      history.push({ role: "tool", tool_call_id: call.id, content: output })
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }]

console.log("L1 · 最裸的循环")
console.log("输入问题回车发送；输入 q 退出。\n")

while (true) {
  const q = await rl.question("\x1b[36mL1 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break

  history.push({ role: "user", content: q })
  await agentLoop(history)

  const last = history[history.length - 1]
  if (last.role === "assistant" && typeof last.content === "string") console.log(last.content)
  console.log()
}
rl.close()
