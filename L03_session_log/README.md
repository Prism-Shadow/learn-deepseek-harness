# L3 · Session Log 是永远的唯一真相 (支柱 P2 📜)

## 这一课要解决的问题

L2 里对话就是一个可变数组 `history`：谁都能 `push`、能改、能删。它有三个致命弱点（局限 ❷）：

- **崩了就全没**——进程一挂，内存里的数组灰飞烟灭。
- **没法确定性重放**——你没法从一个可靠来源"重新算出"当前对话。
- **没法优雅压缩**——想删掉/替换中间一段？直接改数组，改错了没救，也说不清"原文当时是什么"。

DeepSeek Harness 的答案，是它的第二根支柱：

> **一次对话不是一个可变数组，而是一条「只增不改（append-only）的事件日志」。模型看到的对话，是每次从日志「派生」出来的。**

## 两个新概念

```
   事件日志 events[]  （仓库：记录一切，只增不改）
   ┌──────────────────────────────────────────────┐
   │ seq0 turn/start        [仅日志]                │
   │ seq1 user/message      [在名单] ← 你问的话      │
   │ seq2 assistant/message [在名单] ← 模型要调工具  │
   │ seq3 tool/result       [在名单] ← 命令输出      │
   │ seq4 assistant/message [在名单] ← 模型的回答    │
   │ seq5 turn/end          [仅日志]                │
   └──────────────────────────────────────────────┘
              │
              │  deriveMessages(): 照着「名单」点名
              ▼
   surface 名单 = [1, 2, 3, 4]   （购物清单：模型实际看到这几条，按这个顺序）
```

- **事件日志 `events[]`**：记录一切——用户消息、模型回复、工具结果，连 `turn/start`、`turn/end` 边界都记。**只往末尾加，永不修改。**
- **surface 名单 `surface[]`**：一个**有序的 seq 数组**，记录"当前对话该包含哪些事件"。`turn` 边界这类不进名单。

**派生 = 拿着名单去日志里点名**。日志是仓库（记一切），名单是购物清单（决定端哪些给模型）。

## 核心代码：Session 类

```ts
class Session {
  events: SessionEvent[] = []   // 日志：记录一切，只增不改
  surface: number[] = []        // 名单：当前对话包含哪些 seq

  append(type, data, onSurface = false) {          // 只增不改：永远往末尾加
    const event = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (onSurface) this.surface.push(event.seq)     // 消息进名单；turn 边界不进
    return event
  }

  deriveMessages() {                               // 照着名单点名，投影成模型消息
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

循环也变了：不再 `history.push(...)`，而是 `session.append("user/message" | "assistant/message" | "tool/result", ...)`；要发给模型时调 `session.deriveMessages()`。

**注意一个细节**：`SYSTEM`（系统提示）**不进日志**——它是每次"组装"出来的，不是对话历史的一部分。这也是真实 harness 的做法（系统提示属于"请求信封"，不属于对话）。

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 P1 一切皆插件 | 保持：框架、bash/log 插件原样。循环换了状态载体，但插件一个没动。 |
| 📜 **P2 Session Log** | ✅ **本课主角**。可变数组 → append-only 事件日志；消息从日志派生；引入 surface 名单。 |
| ⚡ P3 KV Cache | 铺垫：`deriveMessages()` 每步都重新派生出对话——L4 就从"这串 token 怎么被缓存"来审视它。 |

> **为什么这是后面一切的地基**：
> - **压缩 (L6)**：不删日志，只 append 一条"replace"事件，让 `surface` 名单把旧的挤掉——原文永远还在。
> - **崩溃恢复**：把日志从头重放，就能精确重建当前状态。
> - **记忆 (L7)**：写入就是往日志/存储追加事件。
>
> 这就是那句「Session Log 是永远的唯一真相」的含金量。

## 试一下

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
npm install
npm run dev
```

**一定要玩这两个命令，亲眼看清 log vs surface：**

1. 先随便问一句要用工具的，比如 `当前目录有几个文件？`
2. 输入 **`/log`** —— 你会看到完整日志：`turn/start`、`user/message`、`assistant/message`、`tool/result`… 其中 `turn/start`/`turn/end` 标着灰色 `[仅日志]`，消息标着绿色 `[在名单]`。
3. 输入 **`/surface`** —— 只剩那串进了名单的 seq。**这就是模型实际看到的对话，而日志里其实记了更多。**

体会：**日志记录了一切（包括模型永远看不到的边界事件），而模型只看到名单点到的那些。** 这个"记全 vs 只给一部分"的分离，是 L6 压缩能"遮蔽而不删除"的根本原因。

## 接下来

现在对话是从日志派生的了。**L4** 上第三根支柱——**对 KV Cache 敏感**：我们挂上第一个"上下文注入插件"（在 `pre-step` 往对话里加东西），并**实测 `cacheReadTokens`**，让你亲眼看到"往末尾加(append-only)"能命中缓存、而"改中间"会让缓存从那一刻起全部作废。这是 DeepSeek Harness 所有上下文设计背后的那条铁律。
