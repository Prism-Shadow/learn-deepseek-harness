# CLAUDE.md — Learn DeepSeek Harness

> ⚠️ **本文件必须显式纳入 Git 版本控制**（切勿加入 `.gitignore`、切勿取消追踪）。
> 它不只是给 agent 的操作指南，更是**整个仓库的宪法**——任何改动都以它为标准，因此它的每次变更都必须被记录、可回溯。

> 这是一门**极简教学课程**：从最裸的循环开始，一课一课把它长成一个真正的 agent harness。
> 每一课是一个能独立运行的 TypeScript 小包，配真实 DeepSeek 模型。
> **本文件是项目宪法**，每次在本项目工作前先读一遍，所有决策以此为准。

---

## 0. 沟通风格（最高优先级）

- **说话直接**：先给结论，别铺垫客套，不确定就说不确定。（用户明确要求）
- 用**中文**。技术名词保留英文。
- 涉及改动前先讲清取舍让用户拍板；已定的决策别反复请示。

## 1. 三根支柱（课程的骨架，每一课都要体现）

这门课不抄 learn-claude-code 的话题列表。DeepSeek Harness 的灵魂是这三点，**每课 README 都要有「三根支柱在本课如何体现」小节**：

- **🧩 P1 一切皆插件**：循环极瘦，只负责驱动流程并在固定扩展点触发事件；能力全是挂在 `ctx` + 事件系统上的插件。加功能=加插件，主干不改。
- **📜 P2 Session Log 是永远的唯一真相**：对话是 append-only 事件日志，模型看到的是从日志**派生**的 surface。可重放、可恢复、可压缩的地基。
- **⚡ P3 对 KV Cache 敏感**：前缀缓存「逐字节一致才命中」→ 往对话加东西**一律 append-only**，绝不动中间。

三支柱按 P1→P2→P3 落在 L2/L3/L4，后面每课在此地基上叠插件。

## 2. 类型策略：固定「B 档」

> 详见长期记忆 `learn-deepseek-harness-b-tier-types`。

- **外围补类型**：消息用 `ChatCompletionMessageParam`、工具用 `ChatCompletionTool`、函数签名、`JSON.parse(...) as {...}`——换编辑器补全 + 防手滑。
- **框架内部从简**：`ctx.services`、事件 `payload` 保持 `any`，**绝不引入泛型 / `keyof` / 映射类型**。配一行注释说明取舍并对照真实 harness。
- **看得懂 > 类型严谨**。拿不准选更简单的写法。外部 API 私有字段（如 DeepSeek 的缓存字段）用 `as any` 是合理边界。

## 3. 课程约定

- **每课 = 一个独立可运行的 TS 包**：`LNN_名字/` 下含 `package.json` / `tsconfig.json` / `.env.example` / `code.ts` / `README.md`。进去 `npm install && npm run dev` 就能跑。
- **迷你框架 copy-forward 内联进每课**（不抽公共库），用 `═══` 注释块划出「和上一课一样」与「本课新增」。每课自包含、能单独拷出去跑。
- **代码**：全中文注释，TS 小白友好；能省的类型体操都省（见 B 档）。
- **行文正式、简洁**：不用口语化表达（"到点喊人""喊一嗓子""举手""焊死""插座板""购物清单"…）和比喻（"治病/病根"）。用直接的技术词：事件说「触发/广播/监听/注册」，ctx 说「共享上下文」，disposer 说「注销函数」。L1 刻意保留的不足统一叫「局限 ❶❷❸」，后续「解决/改进」它们。
- **注释只写 why**：说明「为什么这么做／解决了什么／边界在哪」，不复述代码在做什么。能不加就不加。
- **README 结构固定**：`要解决什么问题/要说什么` → `核心代码` → `工作原理(ASCII 图)` → `三根支柱在本课的体现`(表格) → `试一下` → `接下来`。**图用 ASCII，不做 SVG。**
- **承上启下，禁止「先使用后定义」**：阅读顺序固定 root `README.md` → L1 → … → L10。任何概念/术语/变量首次出现时必须此前已解释过。写完每课以「只读到此处的读者」视角自检，不留裸术语；root README 作为总览可提前点名后续概念，但须附一句直观说明。
- **命名对齐真实 harness**：节俭前提下，类型/事件/变量名尽量与真源码一致（`ctx`、`Session`、`surface`、`deriveMessages`、`surfaceOp:{op:'replace'}`、`agent/pre-step`、`tools/pre-execute|post-execute|result`、`guard`、`compact/*` 等）。自造名字须在「对照真实 harness」小节点明映射。
- **对照真实 harness**：每课点一下我们的迷你实现对应真源码里的什么（见第 5 节映射）。

## 4. 技术栈 & 命令

- **模型**：DeepSeek API（与 OpenAI 兼容）。用 `openai` SDK，`baseURL` 指向 `https://api.deepseek.com`，默认模型 `deepseek-chat`。key 放 `.env` 的 `DEEPSEEK_API_KEY`。
- **运行**：`npm run dev`（= `tsx code.ts`，直接跑 .ts，无需编译）。
- **类型检查**：`npx tsc --noEmit`（**不带文件名**，让它读 tsconfig；`tsc code.ts` 会忽略 tsconfig 用错默认值）。每课交付前必须 **0 报错**。
- **KV 缓存观测**：DeepSeek 在 `usage` 里返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（openai 标准类型里没有，用 `as any` 取）。

## 5. 迷你框架 → 真实 DeepSeek Harness 映射

| 本课迷你实现 | 真实 harness |
|---|---|
| `ctx` + `ctx.services` | Cordis 的 `Context` + service 注册 |
| `ctx.on` / `emit`（通知型） | Cordis 事件（notification） |
| `ctx.waterfall`（可拦截改写） | Cordis waterfall / 各扩展点 |
| `agent/pre-step` 瀑布（我们的） | `agent/pre-step`（同名） |
| `Session` 事件日志 + `surface` | 事件溯源 session：log + surface（seq 数组） |
| surface 的 `replace`（L6 起） | 压缩的 `surfaceOp: {op:'replace'}` |
| `tools/result` 通知 | `tools/result`（同名） |

## 6. 课程路线图与进度

全部 10 课已完成并 typecheck 通过。

- [x] **L1** 最裸的循环（铺垫；故意留下三处局限 ❶耦合 ❷可变数组 ❸每步重发）
- [x] **L2** 一切皆插件（**P1**：迷你框架 + bash/log 插件）
- [x] **L3** Session Log 唯一真相（**P2**：事件日志 + surface + `/log` `/surface`）
- [x] **L4** 对 KV Cache 敏感（**P3**：注入插件 + 实测缓存 + `/append`↔`/prepend` 对比）
- [x] **L5** 工具管线 + 权限（`pre-execute→guard→execute→post-execute→result` + 确认服务）
- [x] **L6** 上下文压缩（三支柱合体：插件 + surface replace + 摘要前缀复用）
- [x] **L7** 跨 session 记忆（remember 工具 + 会话开始召回）
- [x] **L8** 组装成小 harness（六插件组合）
- [x] **L9** 子 agent（`spawn_subagent`：独立 Session + 受限工具集 + 只回传结论）
- [x] **L10** 自我修改（`define_tool`：运行时挂载新工具）

## 7. Git

- 本项目是 git 仓库，远程 `github.com/Prism-Shadow/learn-deepseek-harness`（用户自建）。
- **不主动提交/推送**，除非用户明确要求。`node_modules/` 和 `.env` 已在 `.gitignore`。

## 8. 参考仓库的边界

`/data/workspace/chat/learn-claude-code` **只借用「一课一个可运行小包 + README」的形态**。Claude Code 的设计理念与 DeepSeek Harness 完全不同，**内核一律围绕上面三根支柱**，不照搬它的内容。
