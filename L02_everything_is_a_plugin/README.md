# L2 · 一切皆插件 (支柱 P1 🧩)

## 这一课要解决的问题

L1 里 bash、安全检查、循环逻辑耦合在一起（局限 ❶）：新增一个工具或一条日志，都得修改 `agentLoop`。循环随功能增长而膨胀。

DeepSeek Harness 的核心思路：

> **将循环收缩到最小——只负责驱动流程并在固定点触发事件；所有能力外置为插件。**

## 两个基础设施

```
        ┌──────────────── 共享上下文 ctx ────────────────┐
        │  services: { tools: 工具注册表, ... }            │  服务注册于此
        │  事件系统: on 注册监听 / emit 广播 / waterfall   │  插件在此接入
        └─────────────────────────────────────────────────┘
                 ▲              ▲               ▲
            bash 插件       log 插件      后续：上下文/压缩/记忆插件
          (注册工具)     (监听事件)

        精简循环：仅触发事件 + 经由 ctx.services 调用能力
```

- **共享上下文 ctx**：服务（能力）注册于此，插件间通过 `ctx.services.xxx` 获取。
- **事件系统**：循环在固定点触发事件，插件监听并介入。

事件分两类，全课反复使用：

| 类型 | 语义 | 能否改变主流程 | 用途 |
|------|------|----------------|------|
| `emit` 通知型 | 广播 | 否 | 「工具已执行」 |
| `waterfall` 瀑布型 | 依次传递，可改写后再传 | 是 | 「请求前修改消息」 |

## 核心：循环的精简形态

```ts
async function step(ctx, history) {
  const messages = await ctx.waterfall("pre-step", { history }, async () => history)  // 请求前统一介入点
  const res = await client.chat.completions.create({
    messages, tools: ctx.services.tools.schemas(),   // 工具清单来自注册表
  })
  history.push(res.choices[0].message)
  if (!msg.tool_calls?.length) return false
  for (const call of msg.tool_calls) {
    const output = ctx.services.tools.execute(...)    // 执行也经由注册表
    history.push({ role: "tool", ... })
    await ctx.emit("tool:executed", { name, args, output })
  }
  return true
}
```

循环内不含任何具体工具名，也不知道是否存在日志。它只做三件事：触发 `pre-step`、向注册表取工具清单、请注册表执行。

## bash 成为插件

```ts
function bashPlugin(ctx) {
  ctx.services.tools.register("bash", { ...schema }, (args) => runBash(args.command))
}
```

组装时接入：

```ts
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
logPlugin(ctx)   // 纯观察者，仅监听 tool:executed
```

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 **P1 一切皆插件** | ✅ 本课主题。循环精简，bash / log 均为插件，经 ctx + 事件系统接入。 |
| 📜 P2 Session Log | 未引入。`history` 仍是可变数组（局限 ❷）——由 L3 解决。 |
| ⚡ P3 KV Cache | 未引入。但 `pre-step` 瀑布已就位——它是 L4 注入上下文、以及后续所有「请求前修改消息」的统一入口。 |

> **对照真实 DeepSeek Harness**：`ctx` 对应 Cordis 的 Context，`on` / `waterfall` 对应其事件系统，`pre-step` 对应 `agent/pre-step`。这约 30 行是其最小可运行内核。

## 试一下

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
npm install
npm run dev
```

输入 `列出当前目录的文件`，可见：
- 黄色 `$ ls` 为模型请求执行的命令；
- 灰色 `[log] 工具 "bash" 执行完毕` 来自 log 插件。

**验证「新增能力不改主干」**：注释掉 `code.ts` 末尾的 `logPlugin(ctx)` 后重跑，灰色日志消失，而循环代码未变。可仿照 `bashPlugin` 写一个 `read_file` 插件，仅在组装处新增一行。

## 接下来

对话状态仍是可被任意修改、进程结束即丢失的数组 `history`（局限 ❷）。L3 引入第二根支柱——将其换成 **append-only 事件日志**，模型看到的对话由日志**派生**。这是压缩、记忆、崩溃恢复的共同地基。
