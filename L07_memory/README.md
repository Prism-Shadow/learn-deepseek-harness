# L7 · 跨 session 记忆 (P2 + P3)

## 相比上一课（L6 → L7）

- 新增 `memory` 插件：`remember` 工具（写入磁盘）+ 会话开始召回。
- 为聚焦记忆，本课未叠加压缩。

---

## 这一课要说什么

前几课的对话随进程结束而消失。这一课让 agent 具备**跨会话记忆**：

- **写入**：模型调用 `remember` 工具，把关于用户/项目的事实存入磁盘文件 `agent-memory.json`。
- **召回**：新会话开始时读回这些事实，注入对话。

```
   会话 1                          会话 2（重跑程序）
   你: 记住我叫 Alex，用 pnpm
   模型: remember(fact="用户叫Alex")  →  agent-memory.json
         remember(fact="用户用pnpm")               │
   (退出)                                          ▼
                                    启动即召回："关于用户的既有事实：1. 用户叫Alex 2. 用户用pnpm"
                                    你: 帮我装个依赖
                                    模型: (已知用 pnpm) pnpm add ...
```

## 核心：一个记忆插件

```ts
function memoryPlugin(ctx) {
  const memories = existsSync(FILE) ? JSON.parse(readFileSync(FILE)) : []   // 启动读回

  // 写入：remember 工具，持久化到磁盘
  ctx.services.tools.register("remember", { ... }, (args) => {
    memories.push({ text: args.fact, ts: ... }); writeFileSync(FILE, JSON.stringify(memories))
    return `已记住：${args.fact}`
  })

  // 召回：本会话首次 agent/pre-step，把事实作为一条事件写入 surface（仅一次）
  ctx.on("agent/pre-step", async ({ session }, next) => {
    if (!recalled && memories.length) {
      recalled = true
      session.append("user/message", { content: `[记忆] 既有事实：\n${list}` }, true)
    }
    return next()
  })
}
```

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 P1 一切皆插件 | 保持：记忆是一个插件（一个 `remember` 工具 + 一个 `agent/pre-step` 召回监听）。 |
| 📜 **P2 Session Log** | ✅ 写入是持久化追加（与事件日志同理：只增）；召回把事实作为一条事件进入 surface。 |
| ⚡ **P3 KV Cache** | ✅ 召回的事实作为**较早且稳定**的一条注入一次，保持前缀稳定、缓存友好。 |

> **一个关键权衡（连接真实系统）**：这里注入的是全部记忆、且只在会话开始注入一次，所以它是稳定前缀、缓存友好。但真实记忆系统会**按相关性检索**，每轮浮现的记忆可能不同——若把不同内容注入到较早位置，就会每轮改变前缀、破坏缓存。这正是需要**位置无关缓存（PIC）**的场景：让每个记忆块的缓存不绑定其绝对位置。这也是 DeepSeek Harness 这类系统在记忆方向上的前沿难点。

> **对照真实 harness**：真实系统有独立的记忆能力接缝（写入/召回），召回通常在 `agent/pre-step` 注入，存储在独立后端。

## 试一下

```bash
cp .env.example .env
npm install
npm run dev
```

1. 第一次运行：`记住我叫 Alex，我的项目用 pnpm` —— 模型会调用 `remember`，可见 `agent-memory.json` 被创建。
2. 输入 `q` 退出。
3. **再次** `npm run dev`：启动即打印 `[memory] 已召回 N 条记忆`。此时问 `帮我加一个依赖`，模型应基于「用 pnpm」作答，尽管这是一个全新会话。

## 接下来

L8 把前面各课的插件（工具管线、权限、压缩、记忆…）**组装成一个完整的小 harness**，展示三根支柱的合力：加任意能力只需在组装处加一行。
