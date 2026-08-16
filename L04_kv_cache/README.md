# L4 · 对 KV Cache 敏感 (支柱 P3 ⚡)

## 这一课要说什么

对话每步都发给 DeepSeek 一大串 token。服务端如何缓存它，我们的每个动作又如何影响缓存？

服务端前缀缓存的规则：

> **从首个 token 起逐字节一致的前缀才能命中缓存、免于重算；一旦某位置改变，其后全部失效。**

由此得出所有上下文设计背后的纪律：

> **上下文注入一律追加到末尾（append-only），不修改中间。**

本课通过实测验证：接入一个上下文注入插件，打印真实缓存命中数，并用一个开关对比「追加末尾」与「插入开头」的差异。

## 核心：第一个上下文注入插件

对应真实 harness 的 `time-context`：在 `pre-step` 瀑布中取到下游消息后，注入上下文。

```ts
function timeContextPlugin(ctx) {
  ctx.on("pre-step", async (_payload, next) => {
    const messages = await next()                          // [system, ...历史]
    const ctxMsg = { role: "user", content: `[上下文] 当前时间：${new Date()}` }  // 每轮不同的值
    return injectMode === "append"
      ? [...messages, ctxMsg]                              // 末尾：前缀不变，命中
      : [messages[0], ctxMsg, ...messages.slice(1)]        // 开头：改变前缀，其后失效
  })
}
```

注入值每轮不同（当前时间），因此位置直接决定缓存：
- **末尾**：其前的 `[system + 对话]` 前缀不变，命中，仅末尾新内容需计算。
- **开头**（system 之后、对话之前）：改变前缀，其后整段对话失效，每轮重算。

## 缓存命中的观测

循环新增一步：读取并打印 DeepSeek 在 `usage` 中返回的缓存命中数。

```ts
const usage = res.usage as any   // prompt_cache_hit_tokens 不在 openai 标准类型中，as any 读取（外部边界）
const hit = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
console.log(`[KV] 输入 ${total} tokens：命中 ${hit} / 未命中 ${miss}`)
```

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 P1 一切皆插件 | 保持：上下文注入是又一个插件，挂在 `pre-step`，循环不变。 |
| 📜 P2 Session Log | 保持：对话仍从日志派生。（本课注入仅作用于当次请求、未写入日志；真实 harness 会一并记入日志，此处为聚焦 KV 而从简。） |
| ⚡ **P3 KV Cache** | ✅ 本课主题。注入插件 + 实测缓存命中 + append/prepend 对比。 |

## 试一下

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
npm install
npm run dev
```

1. 默认 `/append`。连续提问（`你好` → `讲个笑话` → `再讲一个`）。观察紫色 `[KV]`：对话变长时命中 token 数上升，因前段为稳定前缀被复用。
2. 输入 `/prepend` 后再连续提问：命中率降至接近 0%，因每轮开头的时间变化使其后整段对话失效、需重算。
3. 切回 `/append`，命中率回升。

```
   append（正确）                  prepend（对照）
   ┌─────────────────┐            ┌─────────────────┐
   │ system          │ 命中       │ system          │ 命中
   │ ...对话...       │ 命中       │ [时间, 每轮变]   │ 改变
   │ [时间]  仅此为新 │            │ ...对话...       │ 其后失效, 重算
   └─────────────────┘            └─────────────────┘
        命中率高                       命中率≈0
```

这解释了真实 harness 的上下文注入器为何一律 append-only。

## 接下来

三根支柱到此建立：**L2 一切皆插件 · L3 Session Log · L4 KV Cache**。后续每课都在此地基上接入具体能力，并同时体现三根支柱。L5 做**工具管线 + 权限**：将「执行工具」从单函数升级为 `pre-execute → guard → execute → post-execute → result` 的分层管线，权限作为插件接入闸门。
