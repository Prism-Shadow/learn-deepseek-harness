# L10 · 自我修改 (P1 的终极形态)

## 相比上一课（L9 → L10）

- 新增 `selfModificationPlugin`：`define_tool` 用 `new Function` 在运行时编译并挂载新工具。
- 复用注册表「每步重新生成工具清单」的特性，使新工具下一步即可见。
- 为聚焦自我修改，本课仅保留 `bash`。

---

## 这一课要说什么

让模型在**运行时编写一个新工具并挂载**进当前运行的 agent，随即调用它。这是「一切皆插件」的终点：连「扩展自己」本身也是一个工具。

```
你: 给自己造一个反转字符串的工具，然后反转 "hello"
  → 模型: define_tool(name="reverse", code="return input.split('').reverse().join('')")
          [self-mod] 已挂载新工具 "reverse"
  → 模型: reverse(input="hello")            ← 下一步就能调用自己刚造的工具
          olleh
  → 模型: "结果是 olleh"
```

## 为什么成立

两点缺一不可：

```ts
// 1) 工具清单每步都从注册表重新生成 → 运行时新增的工具，下一步即对模型可见
schemas() { return Object.entries(tools).map(...) }

// 2) 注册表允许随时 register → 新增无需重启
ctx.services.tools.register(newName, newSchema, newRun)
```

`define_tool` 的实现，就是把模型给的代码编译成函数并注册进活的注册表：

```ts
(args) => {
  const fn = new Function("input", args.code)       // 编译模型编写的代码
  ctx.services.tools.register(args.name, schema,     // 挂载为一个新工具
    (a) => String(fn(a.input)))
  return `已挂载工具 "${args.name}"`
}
```

## 局限与边界（与真实 harness 一致）

- **临时性**：挂载的工具只存于内存，进程结束即失，没有自动持久化或晋升路径。
- **信任级别等同 bash**：这里用 `new Function` 直接执行模型代码，**不是安全边界**（真实 harness 用 `node:vm` 隔离，但同样声明为 bash 级信任）。
- **自我修改 ≠ 自我进化**：「能改自己」只是机制；要成为自我进化，还需「评估 → 晋升 → 持久化」的闭环（把一次有用的临时工具沉淀为永久能力）。本课只做到机制。

## 三根支柱在本课的体现

| 支柱 | 本课 |
|------|------|
| 🧩 **P1 一切皆插件** | ✅ 终极形态：连扩展自己都是一个工具；动态注册表 + 每步重生成清单使其可行。 |
| 📜 P2 Session Log | 保持：`define_tool` 与新工具的调用都作为事件进入日志。 |
| ⚡ P3 KV Cache | 注意：工具清单变化会改变请求前缀，使其后缓存失效——这是运行时改工具集的代价。 |

> **对照真实 harness**：对应 `cordis_inspect` / `cordis_mount` / `cordis_unmount`——模型可检视并挂载临时插件，同样临时、同样 bash 级信任、同样无自动晋升。

## 试一下

```bash
cp .env.example .env
npm install
npm run dev
```

- `给自己造一个把字符串转大写的工具，然后处理 "hello world"`
- `造一个计算字符串长度的工具并用它数一下这句话有多少字符`
- `造一个反转工具，反转 "深度求索"`

紫色 `[self-mod]` 表示新工具已挂载；随后模型会调用它。

## 全课回顾

十课走完，一个 harness 的**不变内核**清晰可见，且很小：

> **一个精简循环 + 一条 append-only 事件日志 + 一套插件/事件系统 + 几个扩展点（`agent/pre-step`、工具管线）。**

其余一切——工具、权限、上下文注入、压缩、记忆、子 agent、自我修改——都是挂在这套骨架上的插件。三根支柱贯穿始终：

- **P1 一切皆插件**：先把骨架和接缝定对，能力随后自由增删。
- **P2 Session Log 是唯一真相**：可重放、可恢复、可压缩、可隔离的地基。
- **P3 对 KV Cache 敏感**：从第一天就把「是否改动前缀、代价谁付」纳入设计。

造一个 harness 的正确顺序：先立骨架，再挂能力。
