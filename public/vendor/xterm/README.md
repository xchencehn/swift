# xterm.js 浏览器资源

运行时固定 @xterm/xterm 6.0.0 与 @xterm/addon-fit 0.11.0，来源为 package-lock.json 对应的 npm 包。这里只保存浏览器发行文件与原始 MIT 许可证，用于离线、Android 和 Windows 资源打包。

更新依赖后运行 `npm run generate:terminal`。`npm run check` 逐字节核对包内资源及本地补丁，防止内嵌资源与锁文件版本漂移。生成过程不修改 node_modules。

Swift 的输入法修复保存在 `scripts/build/patches/xterm-ime.js`，生成器核对上游 xterm.js 的 SHA-256，再按 JavaScript 方法节点替换。229 按键不再阻止 input 提交；明确的 input 事件取消 textarea 延迟差分；旧输入法的差分检查合并执行，进入预编辑或普通按键前完成；composition 提交仍由原生 finalizer 负责，避免重复发送和提前按回车。软键盘的前后删除及换行也通过 input 处理。

上游同步入口为 [PR #6009](https://github.com/xtermjs/xterm.js/pull/6009) 与 [Issue #6045](https://github.com/xtermjs/xterm.js/issues/6045)。本地实现不是直接摘取未合并 PR。升级时生成器会拒绝未知文件：先核对正式版本是否覆盖两类问题，运行 `npm run validate -- fast terminal-ime terminal-preview`，再删除已由上游覆盖的替换和版本保护；保留输入回归。不得仅替换哈希跳过补丁审查。浏览器事件重放不代表真实手机输入法验收。

API 来源：https://xtermjs.org/docs/api/terminal/classes/terminal/
