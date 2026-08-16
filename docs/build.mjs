// build.mjs — 扫描各课 README.md 与 code.ts，生成 docs/lessons.json。
// GitHub Pages 只做静态托管、不跑构建，因此内容必须预先嵌入并提交。
// 课程内容改动后，重新运行 `node docs/build.mjs` 并提交更新后的 lessons.json。

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const docsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(docsDir, "..")

// 课程目录形如 L01_agent_loop、L10_self_modification
const lessonDirs = readdirSync(repoRoot)
  .filter((name) => /^L\d+_/.test(name) && statSync(join(repoRoot, name)).isDirectory())
  .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))

const lessons = lessonDirs.map((dir) => {
  const readme = readFileSync(join(repoRoot, dir, "README.md"), "utf8")
  const code = readFileSync(join(repoRoot, dir, "code.ts"), "utf8")
  const num = parseInt(dir.slice(1)) // "L05_..." -> 5
  const title = (readme.split("\n")[0] || dir).replace(/^#\s*/, "").trim()
  return { dir, num, title, readme, code }
})

writeFileSync(join(docsDir, "lessons.json"), JSON.stringify(lessons, null, 0))
console.log(`已生成 lessons.json：${lessons.length} 课 -> ${lessons.map((l) => "L" + l.num).join(", ")}`)
