# Learn DeepSeek Harness

从最裸的一个循环开始，一课一课地把它长成一个**真正的 agent harness**。每一课是一个能独立运行的 TypeScript 小包，`npm install && npm run dev` 就能跟真实 DeepSeek 模型对话。

> 这门课**不是** learn-claude-code 的翻版。Claude Code 和 DeepSeek Harness 的设计理念完全不同。这门课只借用「一课一个可运行小包」的形态，内核完全围绕 DeepSeek Harness 自己的三根支柱来讲。

---

## 三根支柱（这门课的骨架）

DeepSeek Harness 之所以是它，就靠这三件事。整门课都在反复强化它们：

### 🧩 P1 · 一切皆插件
核心循环极瘦，只负责「跑 + 到点喊人」。工具、上下文、压缩、记忆——所有真正的能力都是**外挂的插件**，通过一个共享的 `ctx` 和一条事件总线挂上去。加功能 = 加插件，主干永不改动。

### 📜 P2 · Session Log 是永远的唯一真相
一次对话不是内存里的一个消息数组，而是一条**只增不改（append-only）的事件日志**。模型看到的对话是从日志**派生**出来的。这让 harness 能确定性重放、可崩溃恢复、可压缩、可 fork。

### ⚡ P3 · 对 KV Cache 的敏感
服务端前缀缓存的铁律是「token 序列逐字节一致才命中」。所以往对话里加东西**一律 append-only**（只往末尾加，绝不动中间）；一旦改了中间，从那个位置往后的缓存全废。这门课会让你**亲手实测**缓存命中，并理解每个设计为什么这么做。

每课 README 都有一个固定小节：**「三根支柱在本课如何体现」**。

---

## 课程地图

| # | 课程 | 主打支柱 | 你会学到 |
|---|------|---------|---------|
| **L1** | 最裸的循环 | (铺垫) | agent 的本质：user→LLM→tool→loop；并**故意埋下三根支柱要治的病** |
| **L2** | 一切皆插件 | **P1** | 迷你框架：`ctx` + 事件总线 + waterfall；把 bash 变成插件 |
| **L3** | Session Log 是唯一真相 | **P2** | 用事件日志替换消息数组；从日志派生消息；surface |
| **L4** | 对 KV Cache 敏感 | **P3** | append-only 上下文注入插件；实测 `cacheReadTokens` |
| **L5** | 工具管线 + 权限 | P1+P2 | 六段执行管线；权限做成插件 |
| **L6** | 上下文压缩 | **P1+P2+P3** | 皇冠课：压缩=插件+replace事件+缓存悬崖 |
| **L7** | 跨 session 记忆 | P2+P3 | memory 插件：召回 + 写入 |
| **L8** | 组装成小 harness | 三支柱合体 | 把所有插件拼成一个完整体 |
| **L9** | 子 agent | P1 | 派生子 agent 当工具 |
| **L10** | 自我修改 | **P1 极致** | 运行时挂插件（一切皆插件的终极形态） |

建议按顺序读。每课的 `README.md` 里有「问题 → 核心代码 → 工作原理 → 三根支柱体现 → 试一下 → 接下来埋了什么坑」。

---

## 怎么跑

每一课都是独立的包：

```bash
cd L01_agent_loop
cp .env.example .env      # 填入你的 DEEPSEEK_API_KEY
npm install
npm run dev
```

需要一个 DeepSeek API key（[platform.deepseek.com](https://platform.deepseek.com)）。DeepSeek 的 API 与 OpenAI 兼容，所以我们用 `openai` 这个 SDK 指向 DeepSeek 的地址。

---

## 给 TypeScript 小白的一句话

代码里凡是能省的类型我都省了（用 `any`），并配了**中文注释**。你只要看「它在干嘛」，不用管类型体操。想深究类型时再说。
