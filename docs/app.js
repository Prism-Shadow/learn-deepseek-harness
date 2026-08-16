// app.js — 纯前端逻辑：目录 / README / 代码 / Diff。数据来自 build.mjs 生成的 lessons.json。

const state = { lessons: [], current: 0, tab: "readme", diffA: 0, diffB: 1 }

async function main() {
  const res = await fetch("./lessons.json")
  state.lessons = await res.json()
  if (state.lessons.length > 1) state.diffB = 1
  renderSidebar()
  route()
  window.addEventListener("hashchange", route)
}

// ── 路由：#L3 / #L3/code / #diff ──
function route() {
  setDrawer(false) // 导航即关闭移动端抽屉
  const h = location.hash.replace(/^#/, "")
  if (h === "diff") {
    state.tab = "diff"
  } else {
    const m = h.match(/^L(\d+)(?:\/(code|readme))?$/)
    if (m) {
      const idx = state.lessons.findIndex((l) => l.num === parseInt(m[1]))
      if (idx >= 0) state.current = idx
      state.tab = m[2] || "readme"
    } else {
      state.tab = "readme"
    }
  }
  renderSidebar()
  renderMain()
  window.scrollTo(0, 0)
}

function renderSidebar() {
  const ul = document.getElementById("lesson-list")
  ul.innerHTML = ""
  state.lessons.forEach((l, i) => {
    const li = document.createElement("li")
    const a = document.createElement("a")
    a.href = `#L${l.num}`
    a.textContent = l.title
    if (state.tab !== "diff" && i === state.current) a.className = "active"
    ul.appendChild(li).appendChild(a)
  })
  document.getElementById("nav-diff").className = state.tab === "diff" ? "active" : ""
}

function renderMain() {
  const main = document.getElementById("main")
  main.innerHTML = ""
  if (state.tab === "diff") return renderDiff(main)

  const lesson = state.lessons[state.current]
  const tabs = document.createElement("div")
  tabs.className = "tabs"
  for (const [key, label] of [["readme", "README"], ["code", "code.ts"]]) {
    const b = document.createElement("button")
    b.textContent = label
    if (state.tab === key) b.className = "active"
    b.onclick = () => (location.hash = `L${lesson.num}/${key}`)
    tabs.appendChild(b)
  }
  main.appendChild(tabs)

  if (state.tab === "code") renderCode(main, lesson)
  else renderReadme(main, lesson)
}

function renderReadme(main, lesson) {
  const div = document.createElement("div")
  div.innerHTML = marked.parse(lesson.readme)
  main.appendChild(div)
  // README 里的代码块高亮
  div.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el))
}

function renderCode(main, lesson) {
  const hint = document.createElement("div")
  hint.className = "hint"
  hint.innerHTML = `本课代码。本地运行：`
  const btn = document.createElement("button")
  btn.className = "copybtn"
  const cmd = `cd ${lesson.dir} && cp .env.example .env && npm install && npm run dev`
  btn.textContent = "复制运行命令"
  btn.onclick = () => {
    navigator.clipboard?.writeText(cmd)
    btn.textContent = "已复制 ✓"
    setTimeout(() => (btn.textContent = "复制运行命令"), 1500)
  }
  hint.appendChild(btn)
  main.appendChild(hint)

  const lines = lesson.code.split("\n").length
  const block = document.createElement("div")
  block.className = "codeblock"
  const gutter = document.createElement("pre")
  gutter.className = "gutter"
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n")
  const codePre = document.createElement("pre")
  codePre.className = "code"
  const codeEl = document.createElement("code")
  codeEl.className = "language-typescript"
  codeEl.innerHTML = hljs.highlight(lesson.code, { language: "typescript" }).value
  codePre.appendChild(codeEl)
  block.appendChild(gutter)
  block.appendChild(codePre)
  main.appendChild(block)
}

function renderDiff(main) {
  const h = document.createElement("h1")
  h.textContent = "代码对比 (Diff)"
  main.appendChild(h)

  const controls = document.createElement("div")
  controls.className = "diff-controls"
  const selA = buildSelect(state.diffA, (v) => { state.diffA = v; drawDiff() })
  const selB = buildSelect(state.diffB, (v) => { state.diffB = v; drawDiff() })
  const lblA = document.createElement("label"); lblA.textContent = "旧："; lblA.appendChild(selA)
  const lblB = document.createElement("label"); lblB.textContent = "新："; lblB.appendChild(selB)
  const legend = document.createElement("span")
  legend.className = "diff-legend"
  legend.innerHTML = `<span class="sw" style="background:var(--add-bar)"></span>新增<span class="sw" style="background:var(--del-bar)"></span>删除`
  controls.appendChild(lblA)
  controls.appendChild(lblB)
  controls.appendChild(legend)
  main.appendChild(controls)

  const stat = document.createElement("div")
  stat.className = "diff-stat"
  stat.id = "diff-stat"
  main.appendChild(stat)

  const out = document.createElement("div")
  out.className = "diff"
  out.id = "diff-out"
  main.appendChild(out)

  drawDiff()
}

function buildSelect(selected, onChange) {
  const sel = document.createElement("select")
  state.lessons.forEach((l, i) => {
    const opt = document.createElement("option")
    opt.value = i
    opt.textContent = l.title
    if (i === selected) opt.selected = true
    sel.appendChild(opt)
  })
  sel.onchange = () => onChange(parseInt(sel.value))
  return sel
}

function drawDiff() {
  const a = state.lessons[state.diffA]
  const b = state.lessons[state.diffB]
  const parts = Diff.diffLines(a.code, b.code)
  const out = document.getElementById("diff-out")
  out.innerHTML = ""
  let added = 0
  let removed = 0

  for (const part of parts) {
    const cls = part.added ? "add" : part.removed ? "del" : "ctx"
    const sign = part.added ? "+" : part.removed ? "-" : " "
    // part.value 常以 \n 结尾，去掉末尾空行避免多出一行
    const lines = part.value.replace(/\n$/, "").split("\n")
    for (const line of lines) {
      if (part.added) added++
      if (part.removed) removed++
      const row = document.createElement("div")
      row.className = "row " + cls
      const s = document.createElement("span")
      s.className = "sign"
      s.textContent = sign
      const t = document.createElement("span")
      t.className = "txt"
      t.textContent = line || " "
      row.appendChild(s)
      row.appendChild(t)
      out.appendChild(row)
    }
  }

  document.getElementById("diff-stat").innerHTML =
    `${a.title} → ${b.title}：<b class="add">+${added}</b> / <b class="del">-${removed}</b> 行`
}

// ── 移动端抽屉开关 ──
function setDrawer(open) {
  document.querySelector(".sidebar")?.classList.toggle("open", open)
  document.getElementById("overlay")?.classList.toggle("show", open)
}
document.getElementById("menu-btn")?.addEventListener("click", () => setDrawer(true))
document.getElementById("overlay")?.addEventListener("click", () => setDrawer(false))

main()
