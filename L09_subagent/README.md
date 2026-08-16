# L9 · 子 agent (P1)

## 这一课要说什么

把「派生一个带独立上下文的子循环」做成一个工具 `spawn_subagent(task)`。子 agent 拥有自己独立的 Session，完成任务后**只把最终结果回传**给父 agent。

```
父 agent (session A)
  │ 调 spawn_subagent(task="统计 src 下每种语言的文件数")
  ▼
子 agent (session B, 独立上下文, 仅 bash)
  │ $ find ...   →  大量中间输出
  │ $ ...        →  更多探索
  │ 得出结论
  ▼
只把「结论」这一段字符串回传给父 agent
（子 agent 的所有中间工具调用与输出留在 session B，不进入 session A）
```

## 核心价值：上下文隔离

子 agent 探索时可能产生大量工具调用和冗长输出。若这些都进入父 agent 的上下文，父的对话会迅速膨胀。委派把这些**隔离在子 agent 自己的 Session 里**，父 agent 只收到一段结论。

这带来两个收益：
- 父 agent 上下文保持精简、聚焦。
- 更少的上下文也意味着更低的成本与更好的缓存表现（呼应 P3）。

```ts
async (args) => {
  return await runSubagent(ctx, args.task)   // 仅此返回值进入父 agent 上下文
}
```

子 agent 使用**受限工具集**（仅 `bash`，不含 `spawn_subagent`），避免无限委派：

```ts
const childTools = ctx.services.tools.schemasFor(["bash"])
```

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 **P1 一切皆插件** | ✅ 子 agent 就是同一套循环的又一个实例，由一个工具触发；委派本身是一个插件。 |
| 📜 P2 Session Log | ✅ 父与子各有独立 Session；隔离正是「每个对话是一条独立日志」的自然结果。 |
| ⚡ P3 KV Cache | ✅ 隔离使父上下文更小——更省、更利于缓存。 |

> **对照真实 harness**：对应 subagent 能力接缝（`spawn` / `fork` 等多种后端）与「委派是工具，不是循环内建」的设计。

## 试一下

```bash
cp .env.example .env
npm install
npm run dev
```

给一个需要多步探索、但你只关心结论的任务，例如：

- `用子 agent 统计当前目录下 .ts / .json / .md 各有多少个文件`
- `派一个子 agent 去看看 package.json 里声明了哪些依赖，只告诉我结论`

灰色 `[子 agent] $ ...` 是子 agent 内部的探索步骤；父 agent 最终只基于回传的结论作答。

## 接下来

L10 是**一切皆插件**的终极形态——**自我修改**：让模型在运行时编写一个新插件并挂载进当前运行的 agent。
