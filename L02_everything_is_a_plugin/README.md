# L2 · 一切皆插件 (支柱 P1 🧩)

## 这一课要解决的问题

L1 里，bash 工具、安全检查、循环逻辑**全焊死在一起**（局限 ❶）。想加一个 `read_file` 工具？得改 `agentLoop`。想加个日志？还得改 `agentLoop`。循环越长越乱，谁都不敢碰。

DeepSeek Harness 的答案，也是它整个架构的灵魂：

> **把循环做到极瘦——它只负责「跑 + 到点喊人」。所有真正的能力都是外挂的「插件」。**

## 靠两样东西实现

```
        ┌─────────────── ctx（插座板）───────────────┐
        │  services: { tools: 工具注册表, ... }        │   ← 能力挂这
        │  事件总线: on() 举手 / emit() 喊一嗓子        │   ← 插件在这接头
        └────────────────────────────────────────────┘
                 ▲              ▲               ▲
          bash 插件       log 插件      (以后)上下文/压缩/记忆插件
         (登记工具)      (监听事件)          全都往这挂

        瘦循环: 只做两件事 —— 到点 emit 喊人、用 ctx.services.tools 干活
```

**① ctx（插座板）**：一块共享的板子。能力（service）挂上去，谁都能 `ctx.services.xxx` 取用。
**② 事件总线**：循环跑到某个时刻 `emit`（喊一嗓子），插件用 `on` 举手接住。

事件有两种，这门课反复用：

| 类型 | 像什么 | 能干嘛 | 例子 |
|------|--------|--------|------|
| `emit` **通知型** | 广播 | 只通知，**改不了主干** | "某工具执行完了" |
| `waterfall` **瀑布型** | 中间件链 | 一个个传，**每个都能改了再往下交** | "发请求前，往消息里加东西" |

## 核心：循环瘦成什么样

```ts
async function step(ctx, history) {
  // 「发请求前」这一刻——插件可以在这往消息里加东西（现在还没人挂，L4 会来）
  const messages = await ctx.waterfall("pre-step", { history }, async () => history)

  const res = await client.chat.completions.create({
    messages, tools: ctx.services.tools.schemas(),  // ← 工具清单来自注册表，不写死
  })
  history.push(res.choices[0].message)
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const output = ctx.services.tools.execute(...)   // ← 执行也走注册表
    history.push({ role: "tool", ... })
    await ctx.emit("tool:executed", { name, args, output })  // ← 喊一嗓子
  }
  return true
}
```

循环里**没有任何一个具体工具的名字**，也不知道有没有日志。它只是：到点喊人、问注册表要工具、让注册表执行。

## bash 现在是一个插件

```ts
function bashPlugin(ctx) {
  ctx.services.tools.register("bash", { ...schema }, (args) => runBash(args.command))
}
```

组装时才把它挂上：

```ts
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())  // 提供「工具注册表」
bashPlugin(ctx)   // 挂 bash
logPlugin(ctx)    // 挂 log（纯观察者，只监听 tool:executed）
```

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 **P1 一切皆插件** | ✅ **本课主角**。循环极瘦，bash / log 都是插件，通过 ctx + 事件总线挂上。 |
| 📜 P2 Session Log | 还没上。`history` 仍是可变数组（局限 ❷ 还在）——由 L3 解决。 |
| ⚡ P3 KV Cache | 还没上。但注意 `pre-step` 瀑布已经埋好——它就是 L4 做上下文注入、L3 之后所有"往对话加东西"的统一入口。 |

> **对照真实的 DeepSeek Harness**：真源码里 `ctx` 就是 Cordis 的 Context，`on/waterfall` 就是它的事件系统，`agent/pre-step` 就是我们这个 `pre-step` 瀑布。我们这 30 行迷你框架，是它那套东西的"最小可运行内核"。

## 试一下

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
npm install
npm run dev
```

问它 `列一下当前目录的文件`，你会看到：
- 黄色 `$ ls` 是模型要跑的命令；
- 灰色 `[log 插件] 观察到工具 "bash" 执行完毕` 是 **log 插件**在旁边偷偷记的。

**亲手验证「加功能不改主干」**：把 `code.ts` 结尾的 `logPlugin(ctx)` 那行注释掉，重跑——灰色日志消失了，**而循环代码一个字都没动**。这就是插件架构的全部意义。想再体会，可以照着 `bashPlugin` 的样子写一个 `read_file` 插件，只在组装处加一行 `readFilePlugin(ctx)`。

## 接下来

插件框架有了，但对话状态还是那个"谁都能乱改、崩了就没"的可变数组 `history`（局限 ❷）。**L3** 上第二根支柱——把 `history` 换成 **append-only 的事件日志**，让「Session Log 成为永远的唯一真相」，模型看到的对话从日志**派生**出来。这是压缩、记忆、崩溃恢复的共同地基。
