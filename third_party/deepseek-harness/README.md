# DeepSeek Harness 文件浏览源码

上游固定版本和原文件 SHA-256 见 source.json。upstream/ 保留本次迁移所用的原始源码，LICENSE 保留 MIT 许可。

Swift 直接使用 directory-node.ts 的编译产物，管理展开目录的异步读取、合并刷新与取消；运行 `node scripts/generate-harness-files.js` 生成 `public/vendor/deepseek-harness/directory-node.js`。

`public/files/workspace.js` 将 FilesBody、store 和 face 的目录排序、按层加载、缓存、过期响应、展开状态与滚动保留适配为 Swift 原生 DOM。React、Cordis、Remote RPC 与会话运行时不引入 Swift。目录失效检查使用可见页面的有界轮询，替代上游 Remote watch 流。

`lib/workspace-files.js` 将 workspace-files.list 的只读范围、单层列表及数量上限适配为 Swift 根目录 HTTP 接口，并添加并发合并、短期缓存、有界文件读取及符号链接范围核验。文件预览继续使用 Swift 的 Markdown、代码和隔离 HTML 渲染器。
