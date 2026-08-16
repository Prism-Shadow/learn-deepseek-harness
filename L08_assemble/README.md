# L8 · 组装成小 harness (三支柱合力)

## 这一课要说什么

前面各课分别做出了独立插件。这一课把它们组装成一个**完整可用的小 harness**：

```
装载清单（组装处）：
  bash + read_file          工具(L2/L5)
  permissionPlugin          权限：guard + ask 确认(L5)
  memoryPlugin              跨会话记忆(L7)
  timeContextPlugin         上下文注入(L4)
  compactionPlugin          自动压缩(L6)
```

## 收束点：组装只有一段

```ts
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry(ctx))
bashPlugin(ctx)
readFilePlugin(ctx)
permissionPlugin(ctx)
memoryPlugin(ctx)
timeContextPlugin(ctx)
compactionPlugin(ctx)
```

这就是「一切皆插件」的复利：**每个能力正交、互不依赖，增删只改这一段，循环与其它插件都不动**。想去掉压缩？删一行。想加个 `web_search` 工具？仿照 `bashPlugin` 写一个，加一行。

各能力在同一条 `pre-step` 瀑布上有序协作：记忆召回、时间注入、压缩各挂一个监听器，彼此独立却共同构成每次请求的最终上下文。

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 **P1 一切皆插件** | ✅ 六个正交插件组装成完整 harness；增删一行即可。 |
| 📜 **P2 Session Log** | ✅ 用户/模型/工具消息、`tool/call` 审计、`compact/*`、记忆召回——全是同一条日志上的事件。 |
| ⚡ **P3 KV Cache** | ✅ 时间注入追加末尾、记忆召回置于稳定早段、压缩复用摘要前缀——都遵守缓存纪律。 |

> 至此可以看清：一个 harness 的**不变内核**很小——一个精简循环 + 一条事件日志 + 一套插件/事件系统 + 几个扩展点（`pre-step`、工具管线）。其余全部是插件。

## 试一下

```bash
cp .env.example .env
npm install
npm run dev
```

综合演练（一次跑通全部能力）：

1. `记住我叫 Alex，项目用 pnpm` —— 触发 remember（记忆）。
2. `读一下 code.ts 的前 30 行` —— read_file 直接执行。
3. `新建 note.txt 写入 hi` —— 写操作触发权限确认。
4. 连续多问几轮闲聊 —— surface 超过阈值时自动压缩（紫色 `[compaction]`）。
5. 退出后重跑 —— 启动即召回「叫 Alex / 用 pnpm」。

## 接下来

这套 harness 已经可用。剩下两课展示**一切皆插件**的更高级形态：
- **L9 子 agent**：把「派生一个带独立 session 的子循环」做成一个工具。
- **L10 自我修改**：让模型在运行时编写并挂载一个新插件。
