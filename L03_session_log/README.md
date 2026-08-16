# L3 · Session Log 是唯一真相 (支柱 P2 📜)

## 这一课要解决的问题

L2 里对话仍是可变数组 `history`（局限 ❷），有三个弱点：

- **进程结束即丢失**——状态只在内存中。
- **无法确定性重放**——没有可靠来源可「重新算出」当前对话。
- **无法优雅压缩**——替换中间一段只能直接改数组，且无法保留原始内容。

DeepSeek Harness 的第二根支柱：

> **一次对话不是可变数组，而是一条 append-only 事件日志。模型看到的对话由日志派生。**

## 两个概念

```
   事件日志 events[]  （记录全部事件，仅追加）
   ┌──────────────────────────────────────────────┐
   │ seq0 turn/start        [仅日志]                │
   │ seq1 user/message      [在 surface] 用户输入   │
   │ seq2 assistant/message [在 surface] 请求工具   │
   │ seq3 tool/result       [在 surface] 命令输出   │
   │ seq4 assistant/message [在 surface] 模型回答   │
   │ seq5 turn/end          [仅日志]                │
   └──────────────────────────────────────────────┘
              │  deriveMessages(): 按 surface 顺序取出对应事件
              ▼
   surface = [1, 2, 3, 4]   模型实际看到的事件子集，按此顺序
```

- **事件日志 `events[]`**：记录全部事件（含 `turn/start`、`turn/end` 边界），仅追加、不修改。
- **surface `surface[]`**：一个有序 seq 列表，表示当前对话包含哪些事件；`turn` 边界不进入。

派生即：按 surface 列出的 seq 依次取出对应事件、投影为模型消息。

## 核心代码：Session 类

```ts
class Session {
  events: SessionEvent[] = []
  surface: number[] = []

  append(type, data, onSurface = false) {
    const event = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (onSurface) this.surface.push(event.seq)   // 消息进入 surface；turn 边界不进
    return event
  }

  deriveMessages() {
    return this.surface.map((seq) => {
      const e = bySeq.get(seq)!
      switch (e.type) {
        case "user/message":      return { role: "user", content: e.data.content }
        case "assistant/message": return e.data.message
        case "tool/result":       return { role: "tool", tool_call_id: e.data.tool_call_id, content: e.data.content }
      }
    })
  }
}
```

循环不再 `history.push(...)`，改为 `session.append(...)`；请求前调 `session.deriveMessages()`。

`SYSTEM` 不写入日志：它属于请求信封，每次组装，不是对话历史的一部分——这也是真实 harness 的处理方式。

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 P1 一切皆插件 | 保持：框架与 bash/log 插件不变，仅更换状态载体。 |
| 📜 **P2 Session Log** | ✅ 本课主题。可变数组 → append-only 事件日志；消息从日志派生；引入 surface。 |
| ⚡ P3 KV Cache | 铺垫：每步重新派生对话——L4 从缓存角度审视这串 token。 |

> 这一分离是后续能力的地基：
> - **压缩 (L6)**：不删日志，仅追加一条 replace 事件改写 surface，原始内容保留。
> - **崩溃恢复**：重放日志即可精确重建。
> - **记忆 (L7)**：写入即追加事件。

## 试一下

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
npm install
npm run dev
```

对照 log 与 surface：

1. 先问一句需用工具的，如 `当前目录有几个文件？`
2. 输入 **`/log`**：完整日志中，`turn/start`、`turn/end` 标为 `[仅日志]`，消息标为 `[在 surface]`。
3. 输入 **`/surface`**：仅剩进入 surface 的 seq，即模型实际看到的对话。

日志记录全部事件（含模型不可见的边界事件），模型只接收 surface 中的事件。这一「记全 / 只暴露子集」的分离，是 L6 压缩能「遮蔽而不删除」的原因。

## 接下来

L4 引入第三根支柱——**对 KV Cache 敏感**：接入第一个上下文注入插件（在 `pre-step` 修改消息），并实测 `prompt_cache_hit_tokens`，验证「追加到末尾」命中缓存、「修改中间」使缓存从该处起全部失效。
