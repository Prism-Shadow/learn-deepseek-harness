# 课程网站（docs/）

`learn-deepseek-harness` 的静态课程网站，托管于 GitHub Pages。功能：

- **目录**：L1–L10，读 README + 代码。
- **代码对比 (Diff)**：任选两课对比 `code.ts`，绿条=新增、红条=删除。
- 代码页提供「复制本地运行命令」（不在浏览器执行——课程代码依赖 Node 的 bash/fs/readline，且 API key 不宜放静态页）。

## 技术

纯静态：`index.html` + `styles.css` + `app.js`，CDN 引入 marked / highlight.js / jsdiff。无框架、无打包。

课程内容通过 `build.mjs` 预先嵌入到 `lessons.json`（GitHub Pages 只做静态托管、不跑构建，故内容必须提交）。

## 改动课程后如何更新网站

任何一课的 `README.md` 或 `code.ts` 改动后，重新生成并提交 `lessons.json`：

```bash
node docs/build.mjs
# 然后提交 docs/lessons.json
```

## 本地预览

```bash
cd docs
python3 -m http.server 8099   # 或任意静态服务器
# 浏览器打开 http://localhost:8099
```

## 启用 GitHub Pages（一次性）

仓库 **Settings → Pages → Build and deployment**：
- Source 选 **Deploy from a branch**
- Branch 选 `main`，目录选 **`/docs`**，保存。

稍后站点即在 `https://<user>.github.io/learn-deepseek-harness/` 上线。`.nojekyll` 已包含，避免 Jekyll 处理静态文件。
