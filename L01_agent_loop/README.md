# L1 · 最裸的循环 —— 一个循环就够了

## 这一课要说什么

一个 AI coding agent，剥到只剩骨头，就是**一个 while 循环**：

> 把用户的话发给模型 → 模型要调工具就执行 → 把工具结果塞回对话 → 再发给模型 → 直到模型不再调工具。

就这么点东西。这一课我们用 ~110 行 TypeScript 把它跑起来，跟真实的 DeepSeek 模型对话，让它用 `bash` 工具帮你干活。

```
   用户提问 ──> 模型 ──> 要调工具? ──是──> 执行 bash ──> 把结果塞回对话
                 ^                                            │
                 └────────────────────────────────────────────┘
                         （循环，直到模型说"我不调工具了"）
```

## 核心代码就这一段

```ts
async function agentLoop(history) {
  while (true) {
    const res = await client.chat.completions.create({    // ① 把整个对话发给模型
      model: MODEL, messages: history, tools: TOOLS,
    })
    const msg = res.choices[0].message
    history.push(msg)                                     // ② 追加模型回复
    if (!msg.tool_calls?.length) return                   // ③ 没调工具 → 收工
    for (const call of msg.tool_calls) {                  // ④ 执行工具
      const output = runBash(JSON.parse(call.function.arguments).command)
      history.push({ role: "tool", tool_call_id: call.id, content: output }) // ⑤ 结果塞回
    }
    // 循环 → 回到 ①
  }
}
```

## 工作原理

一次 `帮我看看当前目录有几个 .ts 文件` 的完整过程：

```
你:    帮我看看当前目录有几个 .ts 文件
  │
  ├─> 模型: (要调工具) bash{ command: "ls *.ts | wc -l" }
  │        history 追加: assistant(tool_call)
  │
  ├─> 执行: runBash("ls *.ts | wc -l") -> "3"
  │        history 追加: tool(result="3")
  │
  ├─> 模型: (这次不调工具了) "当前目录有 3 个 .ts 文件。"
  │        history 追加: assistant(text)
  │
  └─> 循环结束（因为没有 tool_calls）
```

关键点：**模型自己决定循环什么时候停**——它只要不再返回 `tool_calls`，循环就结束。工具结果通过 `tool_call_id` 和「哪一次调用」对上号。

## 三根支柱在本课的体现

这一课**故意还没有**三根支柱——它是"病人"，让你先看清病根，后面三课对症下药：

| 支柱 | 本课的"病" | 哪一课来治 |
|------|-----------|-----------|
| 🧩 P1 一切皆插件 | ❶ bash 工具、安全检查、循环逻辑**全焊死在一起**。想加个工具就得改 `agentLoop`。 | **L2** 把能力拆成插件 |
| 📜 P2 Session Log | ❷ 对话就是一个可变数组 `history`，谁都能 `push`、能改。崩了就全没了，也没法确定性重放。 | **L3** 换成只增不改的事件日志 |
| ⚡ P3 KV Cache | ❸ 每转一圈都把**整个 history** 重发给模型。这背后有巨大的缓存学问，本课完全没管。 | **L4** 从 KV 缓存视角审视 |

> 记住这三个病根 ❶❷❸。后面每一课解决一个，你就会真正体会到 DeepSeek Harness 那套架构"贵"在哪、"值"在哪。

## 试一下

```bash
cp .env.example .env      # 填入你的 DEEPSEEK_API_KEY
npm install
npm run dev
```

试试这些：
- `你好，你现在在哪个目录？`
- `这个文件夹里有哪些文件？`
- `新建一个 hello.txt，里面写一句话`
- `code.ts 有多少行？`

你会看到黄色的 `$ 命令` 是模型决定要跑的 shell，下面是执行结果。

## 接下来

L1 能跑，但它是一坨"什么都焊在一起"的代码。**L2** 我们就动第一刀，也是这门课最重要的一刀——把它改造成「**一切皆插件**」：一个极瘦的循环 + 一条事件总线，bash 从"焊死的函数"变成"一个可插拔的插件"。这是 DeepSeek Harness 的灵魂。
