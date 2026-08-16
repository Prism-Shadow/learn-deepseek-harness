# L6 · 上下文压缩 (P1 + P2 + P3 三支柱合流)

## 这一课要说什么

对话变长后需要压缩：把较旧的一段替换为一条摘要，缩短后续请求。这一课是三根支柱的合流点——同一个功能同时用到全部三者。

```
压缩前 surface: [u1, a2, u3, a4, u5, a6, u7, a8, u9, a10]   （太长）
                └──────── 压缩这段 ────────┘ └─ 保留 ─┘
压缩后 surface: [S,  u9, a10]     S = 一条 <compacted-summary> 摘要
```

## 三根支柱如何同时发挥作用

**P1（插件）**：压缩是一个挂在 `pre-step` 的插件，循环不变。它在请求前先执行，再由 base 从压缩后的 surface 派生消息：

```ts
ctx.on("pre-step", async ({ session }, next) => {
  await maybeCompact(...)   // 可能改写 surface
  return next()             // base 从压缩后的 surface 派生
})
```

**P2（Session Log）**：压缩不删任何东西。它只向日志追加事件，并用一条带 `replace` 的消息改写 surface：

```
compact/start        (log-only) 记录压缩区间
compact/summary      (log-only) 保留摘要正文与被遮蔽的 seq 列表
user/message + replace{start,end}   唯一的 surface 变更：摘要替换旧区间
compact/end          (log-only)
```

被替换的原始事件仍在 `events[]` 中——可 `/log` 查看。这就是「遮蔽而非删除」，也是崩溃可重放的前提。

**P3（KV Cache）** 有两个要点：

1. **摘要请求复用前缀**：摘要也需调一次模型。请求构造为 `[system, ...待压缩段, {压缩指令}]`——前半部分正是刚发出的对话请求的前缀，压缩指令放末尾。因此服务端命中已有缓存，无需为摘要重算整段。程序会打印这一命中数。
2. **压缩使缓存失效**：替换了 surface 中间一段，服务端缓存从该位置起失效，后续对话需重新计算。这是压缩省下上下文窗口的**固有代价**——用一次重算换取此后每轮更短的输入。

```ts
const messages = [{ role: "system", content: SYSTEM }, ...rangeMsgs, { role: "user", content: COMPACT_INSTRUCTION }]
//                └──────────── 复用对话请求的前缀 ────────────┘  └── 指令放末尾 ──┘
```

## 边界处理

选择压缩区间时，若保留段以孤立的 `tool/result` 开头（其对应的 assistant 调用落在压缩段），会把这些 `tool/result` 一并并入压缩段，避免保留段出现无主的工具结果导致 API 报错。

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 P1 | ✅ 压缩是插件，挂 `pre-step`，循环不变。 |
| 📜 P2 | ✅ 压缩=追加 `compact/*` + 一条 replace 消息；原事件保留，可重放。 |
| ⚡ P3 | ✅ 摘要请求复用前缀（打印命中数）；压缩替换导致其后缓存失效（固有代价）。 |

> **对照真实 harness**：对应 `compact` 能力接缝、`surfaceOp:{op:'replace'}`，以及「摘要请求复用暖前缀 + 指令后置」这一优化。

## 试一下

```bash
cp .env.example .env
npm install
npm run dev
```

1. 连续多问几轮（让 surface 超过 8 条），会自动触发压缩，可见紫色 `[compaction]` 两行：一行报告摘要请求的缓存命中，一行说明替换使缓存失效。
2. 也可随时输入 `/compact` 手动压缩。
3. 输入 `/log`：被压缩的原始事件仍标 `[仅日志]` 保留在日志中，而 surface 已被摘要替换。压缩后模型仍能连贯作答，说明摘要有效承接了上下文。

## 接下来

L7 做**跨 session 记忆**：把重要事实写入外部存储，并在新会话开始时召回注入——涉及写入（P2）与召回注入的缓存权衡（P3）。
