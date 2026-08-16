# L1 · 最裸的循环

## 这一课要说什么

一个 AI coding agent 的核心是一个循环：

> 把用户输入发给模型 → 模型请求工具就执行 → 工具结果写回对话 → 再发给模型 → 直到模型不再请求工具。

这一课用约 100 行 TypeScript 把它运行起来，与真实 DeepSeek 模型对话，让它用 `bash` 工具完成任务。

```
   用户提问 ──> 模型 ──> 请求工具? ──是──> 执行 bash ──> 结果写回对话
                 ^                                          │
                 └──────────────────────────────────────────┘
```

## 核心代码

```ts
async function agentLoop(history) {
  while (true) {
    const res = await client.chat.completions.create({ messages: history, tools: TOOLS })
    const msg = res.choices[0].message
    history.push(msg)
    if (!msg.tool_calls?.length) return              // 模型未请求工具，结束
    for (const call of msg.tool_calls) {
      const output = runBash(JSON.parse(call.function.arguments).command)
      history.push({ role: "tool", tool_call_id: call.id, content: output })
    }
  }
}
```

## 工作原理

以 `当前目录有几个 .ts 文件` 为例：

```
用户输入
  → 模型请求 bash{ command: "ls *.ts | wc -l" }        history 追加 assistant(tool_call)
  → 执行得到 "3"                                        history 追加 tool(result)
  → 模型回复 "当前目录有 3 个 .ts 文件。"（不再请求工具） history 追加 assistant(text)
  → 循环结束
```

模型通过是否返回 `tool_calls` 自行决定循环何时结束；工具结果通过 `tool_call_id` 与对应调用关联。

## 三根支柱在本课的体现

这一课刻意保持粗糙，先呈现三处局限，后面三课逐一解决：

| 支柱 | 本课的局限 | 由哪一课解决 |
|------|-----------|-----------|
| 🧩 P1 一切皆插件 | ❶ bash、安全检查、循环逻辑耦合在一起，加一个工具就得改 `agentLoop`。 | **L2** 拆成插件 |
| 📜 P2 Session Log | ❷ 对话是可变数组 `history`，可被任意修改，进程结束即丢失，无法确定性重放。 | **L3** 换成 append-only 事件日志 |
| ⚡ P3 KV Cache | ❸ 每轮重发整个 `history`，其缓存代价本课未处理。 | **L4** 从 KV 缓存视角审视 |

## 试一下

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
npm install
npm run dev
```

可尝试：`当前目录有哪些文件？`、`新建一个 hello.txt 并写入一句话`、`code.ts 有多少行？`

黄色 `$ 命令` 是模型请求执行的 shell，其下为执行结果。

## 接下来

L2 引入这门课最核心的改造——**一切皆插件**：一个精简循环加一条事件系统，`bash` 从内联函数变为可插拔插件。
