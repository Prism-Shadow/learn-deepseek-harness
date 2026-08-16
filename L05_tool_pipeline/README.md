# L5 · 工具管线 + 权限 (P1 + P2)

## 相比上一课（L4 → L5）

- 工具注册表升级为分层管线：`tools/pre-execute → guard → 执行 → tools/post-execute → tools/result`。
- 新增 `read_file` 工具、`permission` 插件、`confirm` 服务；新增 `tool/call` 审计事件。
- 为聚焦管线，本课未叠加 L4 的上下文注入（L8 会重新组合）。

---

## 这一课要说什么

前几课工具执行是一次直接的函数调用。真实 harness 把它升级为一条**分层管线**，让权限、审计、结果改写各自作为独立环节接入：

```
  pre-execute        guard          执行        post-execute        result
  (瀑布)             (单调否决)                 (瀑布)              (通知)
  允许/拒绝/询问  →  硬规则否决  →  运行工具  →  改写结果内容   →   观察
```

每一环是一个扩展点，职责分明：
- **pre-execute**（瀑布）：可被插件改写的允许/拒绝/询问闸门——安全策略挂这里。
- **guard**（单调）：一旦否决，任何后续环节（包括用户确认）都无法翻转——不可绕过的硬规则。
- **执行**：运行工具体。
- **post-execute**（瀑布）：改写结果内容。
- **result**（通知）：只观察、不可改。

## 权限：策略与硬规则分离

`permissionPlugin` 同时使用两个环节，体现分工：

```ts
// 硬规则：命中即拒绝，用户也无法批准
registry.guard((exec) => {
  if (exec.name === "bash" && /rm\s+-rf\s+\//.test(exec.args.command)) return "危险模式"
})

// 一般写/删操作：返回 ask，交由用户确认
ctx.on("tools/pre-execute", ({ exec }) => {
  if (exec.name === "bash" && /\b(rm|mv|>|git\s+push|...)/.test(exec.args.command))
    return { kind: "ask", reason: `即将执行：${exec.args.command}` }
  return { kind: "allow" }   // read_file、只读命令直接放行
})
```

管线遇到 `ask` 时调用 `confirm` 服务询问用户。**策略（问什么）在权限插件，机制（如何问）在 `confirm` 服务**——两者分离，因此换一个 UI（网页确认框）只需替换 `confirm`，策略不动。

## 审计：先记意图，再执行

循环在执行前先写一条 `tool/call`（log-only），执行后写 `tool/result`（进 surface）：

```ts
session.append("tool/call", { callId, name, args })   // 记录调用意图
const result = await ctx.services.tools.execute(exec)  // 走管线
session.append("tool/result", { tool_call_id, content: result.content }, true)
```

**先记意图后执行**：崩溃在两者之间时，重放日志可发现「某调用已发起但无结果」，从而避免盲目重试有副作用的操作。

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 **P1 一切皆插件** | ✅ 权限是一个插件，通过 `tools/pre-execute` 与 `guard` 接入；管线各环节都是扩展点。 |
| 📜 **P2 Session Log** | ✅ `tool/call`（log-only 审计）与 `tool/result`（surface）都是事件；先记意图后执行。 |
| ⚡ P3 KV Cache | 保持：`tool/result` 追加进 surface，前缀不受影响。 |

> **对照真实 harness**：管线对应 `tools/pre-execute → guard → tools/execute → tools/post-execute → tools/result`；`confirm` 对应 approval 服务。

## 试一下

```bash
cp .env.example .env
npm install
npm run dev
```

- `读一下 code.ts 的前 20 行` —— read_file 与只读命令直接执行。
- `新建一个 test.txt 写入 hello` —— 写操作触发确认，输入 `y` 放行、`N` 拒绝（模型会看到拒绝原因并调整）。
- 让它尝试 `rm -rf /` 类命令 —— 被 guard 直接拒绝，确认环节都不会出现。

## 接下来

L6 是三根支柱的合流点——**上下文压缩**：它是一个插件（P1），通过向日志追加一条 replace 事件改写 surface（P2），并直接涉及缓存失效与摘要请求的前缀复用（P3）。
