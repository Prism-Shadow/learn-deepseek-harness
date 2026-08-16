// app.js — 目录 / README / 代码 / Diff + 中英切换 + 暗亮主题。
// 数据来自 build.mjs 生成的 lessons.json。英文内容暂为 TODO 占位。

const I18N = {
  zh: {
    brandSub: "一切皆插件 · Session Log · KV Cache",
    lessons: "课程", tools: "工具", diff: "代码对比 (Diff)", repo: "GitHub 仓库 ↗",
    tabReadme: "README", tabCode: "code.ts",
    old: "旧：", new: "新：", added: "新增", removed: "删除",
    copy: "复制运行命令", copied: "已复制 ✓", codeHint: "本课代码。本地运行：",
    diffTitle: "代码对比 (Diff)",
    stat: (a, b, add, del) => `${a} → ${b}：<b class="add">+${add}</b> / <b class="del">-${del}</b> 行`,
    lessonLabel: (l) => l.title,
    readmeTodo: "🚧 英文版待补充（TODO）",
    langBtn: "EN", // 点击切到英文
  },
  en: {
    brandSub: "Everything is a plugin · Session Log · KV Cache",
    lessons: "Lessons", tools: "Tools", diff: "Code Diff", repo: "GitHub Repo ↗",
    tabReadme: "README", tabCode: "code.ts",
    old: "Old: ", new: "New: ", added: "Added", removed: "Removed",
    copy: "Copy run command", copied: "Copied ✓", codeHint: "Lesson code. Run locally: ",
    diffTitle: "Code Diff",
    stat: (a, b, add, del) => `${a} → ${b}: <b class="add">+${add}</b> / <b class="del">-${del}</b> lines`,
    lessonLabel: (l) => `L${l.num}`,
    readmeTodo: "🚧 English version — TODO",
    langBtn: "中", // 点击切到中文
  },
}

const state = {
  lessons: [],
  current: 0,
  tab: "readme",
  diffA: 0,
  diffB: 1,
  lang: localStorage.getItem("ldh-lang") || "zh",
  theme: localStorage.getItem("ldh-theme") || "dark",
}
const t = (key, ...args) => {
  const v = I18N[state.lang][key]
  return typeof v === "function" ? v(...args) : v
}

async function main() {
  const res = await fetch("./lessons.json")
  state.lessons = await res.json()
  if (state.lessons.length > 1) state.diffB = 1
  applyTheme()
  route()
  window.addEventListener("hashchange", route)
}

// ── 主题 ──
function applyTheme() {
  document.documentElement.dataset.theme = state.theme
  const dark = document.getElementById("hljs-dark")
  const light = document.getElementById("hljs-light")
  if (dark) dark.disabled = state.theme !== "dark"
  if (light) light.disabled = state.theme !== "light"
}
function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark"
  localStorage.setItem("ldh-theme", state.theme)
  applyTheme()
  renderChrome()
}
function toggleLang() {
  state.lang = state.lang === "zh" ? "en" : "zh"
  localStorage.setItem("ldh-lang", state.lang)
  renderChrome()
  renderMain()
}

// ── 路由：#L3 / #L3/code / #diff ──
function route() {
  setDrawer(false)
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
  renderChrome()
  renderMain()
  window.scrollTo(0, 0)
}

// 侧栏与固定 UI 文案（随语言/主题刷新）
function renderChrome() {
  document.getElementById("brand-sub").textContent = t("brandSub")
  document.getElementById("sec-lessons").textContent = t("lessons")
  document.getElementById("sec-tools").textContent = t("tools")
  const diffNav = document.getElementById("nav-diff")
  diffNav.textContent = t("diff")
  diffNav.className = state.tab === "diff" ? "active" : ""
  document.getElementById("repo-link").textContent = t("repo")
  document.getElementById("lang-btn").textContent = t("langBtn")
  document.getElementById("theme-btn").textContent = state.theme === "dark" ? "☀️" : "🌙"

  const ul = document.getElementById("lesson-list")
  ul.innerHTML = ""
  state.lessons.forEach((l, i) => {
    const a = document.createElement("a")
    a.href = `#L${l.num}`
    a.textContent = t("lessonLabel", l)
    if (state.tab !== "diff" && i === state.current) a.className = "active"
    ul.appendChild(document.createElement("li")).appendChild(a)
  })
}

function renderMain() {
  const main = document.getElementById("main")
  main.innerHTML = ""
  if (state.tab === "diff") return renderDiff(main)

  const lesson = state.lessons[state.current]
  const tabs = document.createElement("div")
  tabs.className = "tabs"
  for (const [key, label] of [["readme", t("tabReadme")], ["code", t("tabCode")]]) {
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
  if (state.lang === "en") {
    // 英文内容暂缺，占位 TODO
    const box = document.createElement("div")
    box.className = "todo-box"
    box.textContent = t("readmeTodo")
    main.appendChild(box)
    return
  }
  const div = document.createElement("div")
  div.innerHTML = marked.parse(lesson.readme)
  main.appendChild(div)
  div.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el))
}

function renderCode(main, lesson) {
  const hint = document.createElement("div")
  hint.className = "hint"
  hint.textContent = t("codeHint")
  const btn = document.createElement("button")
  btn.className = "copybtn"
  const cmd = `cd ${lesson.dir} && cp .env.example .env && npm install && npm run dev`
  btn.textContent = t("copy")
  btn.onclick = () => {
    navigator.clipboard?.writeText(cmd)
    btn.textContent = t("copied")
    setTimeout(() => (btn.textContent = t("copy")), 1500)
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
  codeEl.className = "language-typescript hljs"
  codeEl.innerHTML = hljs.highlight(lesson.code, { language: "typescript" }).value
  codePre.appendChild(codeEl)
  block.appendChild(gutter)
  block.appendChild(codePre)
  main.appendChild(block)
}

function renderDiff(main) {
  const h = document.createElement("h1")
  h.textContent = t("diffTitle")
  main.appendChild(h)

  const controls = document.createElement("div")
  controls.className = "diff-controls"
  const lblA = document.createElement("label"); lblA.textContent = t("old"); lblA.appendChild(buildSelect(state.diffA, (v) => { state.diffA = v; drawDiff() }))
  const lblB = document.createElement("label"); lblB.textContent = t("new"); lblB.appendChild(buildSelect(state.diffB, (v) => { state.diffB = v; drawDiff() }))
  const legend = document.createElement("span")
  legend.className = "diff-legend"
  legend.innerHTML = `<span class="sw" style="background:var(--add-bar)"></span>${t("added")}<span class="sw" style="background:var(--del-bar)"></span>${t("removed")}`
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
    opt.textContent = t("lessonLabel", l)
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
    const lines = part.value.replace(/\n$/, "").split("\n")
    for (const line of lines) {
      if (part.added) added++
      if (part.removed) removed++
      const row = document.createElement("div")
      row.className = "row " + cls
      const s = document.createElement("span"); s.className = "sign"; s.textContent = sign
      const tx = document.createElement("span"); tx.className = "txt"; tx.textContent = line || " "
      row.appendChild(s); row.appendChild(tx)
      out.appendChild(row)
    }
  }
  document.getElementById("diff-stat").innerHTML = t("stat", t("lessonLabel", a), t("lessonLabel", b), added, removed)
}

// ── 移动端抽屉开关 ──
function setDrawer(open) {
  document.querySelector(".sidebar")?.classList.toggle("open", open)
  document.getElementById("overlay")?.classList.toggle("show", open)
}
document.getElementById("menu-btn")?.addEventListener("click", () => setDrawer(true))
document.getElementById("overlay")?.addEventListener("click", () => setDrawer(false))
document.getElementById("lang-btn")?.addEventListener("click", toggleLang)
document.getElementById("theme-btn")?.addEventListener("click", toggleTheme)

main()
