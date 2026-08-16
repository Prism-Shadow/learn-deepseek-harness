# L4 · 对 KV Cache 敏感 (支柱 P3 ⚡)

## 这一课要说什么

L3 让对话从日志派生出来。现在问一个致命问题：**这一大串 token 发给 DeepSeek，服务端怎么缓存它？我们的每个动作又怎么影响缓存？**

服务端前缀缓存的铁律只有一条：

> **从第一个 token 起「逐字节一致」的那段前缀，才能命中缓存、不必重算。一旦某个位置变了，从那往后全部作废。**

由此推出 DeepSeek Harness 所有上下文设计背后的纪律：

> **往对话里加东西，一律 append-only —— 只往末尾加，绝不动中间。**

这一课你会**亲手实测**这条纪律：挂一个上下文注入插件，打印真实的缓存命中数，再用一个开关对比"加末尾"和"加开头"的天壤之别。

## 核心：第一个上下文注入插件

这就是真实 harness 里 `time-context` 的最小版——在 `pre-step` 瀑布里，先拿到下游要发的消息，再把上下文加进去：

```ts
function timeContextPlugin(ctx) {
  ctx.on("pre-step", async (_payload, next) => {
    const messages = await next()                       // 下游要发的 [system, ...历史]
    const ctxMsg = { role: "user", content: `[上下文] 当前时间：${new Date()}` }  // ← 每次都变的值

    if (injectMode === "append")
      return [...messages, ctxMsg]                       // ✅ 加末尾：前缀没变 → 命中
    else
      return [messages[0], ctxMsg, ...messages.slice(1)] // ❌ 加开头：前缀变了 → 全废
  })
}
```

关键在于注入的是一个**每次都变的值**（当前时间）：
- 放**末尾**：前面的 `[system + 整段对话]` 一个字节没变，是稳定前缀 → **缓存命中**，只有末尾那句新的要算。
- 放**开头**（system 之后、对话之前）：这条一变，它后面的整段对话全部"错位" → **从这条起缓存全废**，整段对话每轮都要重算。

## 看得见的缓存

循环里多了一步：读出 DeepSeek 在 `usage` 里返回的缓存命中数并打印。

```ts
const usage = res.usage as any   // prompt_cache_hit_tokens 不在 openai 标准类型里，用 as any 取(外部边界)
const hit = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
console.log(`[KV] 输入 ${total} tokens：缓存命中 ${hit} / 未命中 ${miss}`)
```

> **B 档小注**：这里的 `as any` 是"外部边界"上合理的一处——DeepSeek 的返回体比 openai 标准类型多了缓存字段，类型系统管不到外部 API 的私有字段。

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 P1 一切皆插件 | 保持：上下文注入是**又一个插件**，挂在 `pre-step`，循环没动。 |
| 📜 P2 Session Log | 保持：对话仍从日志派生。（注意：本课注入是"仅本次请求"的，没写进日志——真实 harness 会把它也记进日志，我们为聚焦 KV 而从简。） |
| ⚡ **P3 KV Cache** | ✅ **本课主角**。第一个注入插件 + 实测缓存命中 + append vs prepend 对比。 |

## 试一下（这一课一定要动手玩）

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
npm install
npm run dev
```

**实验步骤：**

1. 默认是 `/append` 模式。连问几句普通问题（`你好` → `讲个冷笑话` → `再讲一个`）。
   看每次回复后那行紫色 `[KV]`：随着对话变长，**缓存命中 token 数越来越高**——因为前面整段都是稳定前缀，被复用了。

2. 输入 `/prepend` 切到"加开头"模式，再连问几句。
   你会看到**缓存命中率暴跌到接近 0%**——因为每轮开头那条"当前时间"都在变，把它后面的整段对话全顶得对不上，只能重算。

3. 切回 `/append`，命中率立刻回升。

```
   append 模式（正确）              prepend 模式（错误）
   ┌─────────────────┐            ┌─────────────────┐
   │ system          │◄─缓存      │ system          │◄─缓存
   │ ...整段对话...   │◄─命中      │ [时间 每轮都变]  │◄─变了！
   │ [时间]  ← 只这条新│            │ ...整段对话...   │◄─全部错位，重算
   └─────────────────┘            └─────────────────┘
        命中率高                       命中率≈0
```

**这就是为什么真实 harness 的所有上下文注入器都 append-only。** 你亲手把这条铁律看见了。

## 接下来

三根支柱到这就全立起来了：**L2 一切皆插件 · L3 Session Log 唯一真相 · L4 KV Cache 敏感**。

后面的课全是"在这套地基上挂真本事的插件"，而且每一课都同时体现三根支柱。**L5** 先做**工具管线 + 权限**：把"执行一个工具"从裸函数升级成 `pre-execute → guard → execute → post-execute → result` 的分层管线，权限做成插件挂在闸门上。（这也是你复盘完 L1–L4 后我们再往下推进的地方。）
