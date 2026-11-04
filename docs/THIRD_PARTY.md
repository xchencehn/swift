# 第三方声明

Swift 原创代码采用 [Apache-2.0](../LICENSE)。第三方材料继续使用各自许可证；本文件登记来源，不重新许可这些材料。发行时保留实际包含组件的版权、许可和必要声明。

## 依赖与固定资源

| 组件                                        | 来源与许可材料                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node-pty、node-addon-api、ws                | 版本由 `package-lock.json` 固定，保留各 npm 包中的 MIT 许可与原生组件声明。                                                                                                                       |
| xterm、addon-fit、addon-web-links、headless | 固定 npm 版本；网页资源和本地输入法补丁见 [xterm 说明](../public/vendor/xterm/README.md)，许可证与源码一起保留。                                                                                  |
| Cascadia Mono                               | 固定字体来源、转换方法和哈希见 [字体说明](../public/vendor/cascadia/README.md)，保留 SIL Open Font License 1.1。                                                                                  |
| CodeMirror 6、Lezer 及语言模块              | 精确版本由 npm 锁文件固定，浏览器产物按需加载；[资源说明](../public/vendor/code-editor/README.md)及全部实际捆绑依赖的 MIT 许可位于 [LICENSES.txt](../public/vendor/code-editor/LICENSES.txt)。    |
| highlight.js                                | 固定网页产物和 BSD-3-Clause 文本位于 [highlight](../public/vendor/highlight/LICENSE)。                                                                                                            |
| KaTeX                                       | 网页产物、字体和 MIT 许可位于 [katex](../public/vendor/katex/LICENSE)，字体材料保留各自声明。                                                                                                     |
| Mermaid                                     | 固定浏览器产物和许可位于 [mermaid](../public/vendor/mermaid/LICENSE)。                                                                                                                            |
| jsdiff                                      | `diff@8.0.3` 的浏览器产物；BSD-3-Clause 文本位于 [diff](../public/vendor/diff/LICENSE)。                                                                                                          |
| OkHttp                                      | Android 原生终端的依赖由 Gradle 固定；[4.12.0 上游许可证](https://github.com/square/okhttp/blob/parent-4.12.0/LICENSE.txt)为 Apache-2.0。                                                         |
| Termux terminal-view / terminal-emulator    | Android 原生终端使用固定版本；[v0.118.0 许可说明](https://github.com/termux/termux-app/blob/v0.118.0/LICENSE.md)明确区分仓库许可与这两个终端库的 Apache-2.0 例外。分发时按实际 AAR 内容保留材料。 |
| Tauri 与 Rust 依赖                          | 精确版本见 `desktop/Cargo.lock`，保留实际分发组件的许可与版权。                                                                                                                                   |

开发工具由 npm、Gradle 和 Cargo 锁文件固定。将工具或原生运行包一并分发时，也应保留其配套资源的声明，不能只检查直接依赖。

## 改编代码

### herdr-web-ui

部分协议生成、提供方读取、输出窗口和客户端工作线程适配自 `devswha/herdr-web-ui@685293e0a7b912f28b3e19af7e07ae335cfb45e0`。相关文件保留来源注释；MIT 原文及 Copyright (c) 2026 devswha 位于 [herdr-web-ui/LICENSE](../public/vendor/herdr-web-ui/LICENSE)。上游的合成/脱敏 fixture 仅用于测试。

### DeepSeek Harness

文件树采用 `deepseek-ai/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60` 的 MIT 源码。原件、逐文件哈希与改编边界见 [third_party/deepseek-harness](../third_party/deepseek-harness/README.md)，浏览器产物附带同一许可证。

### OpenBitFun

搜索结果投影适配自 `GCWing/OpenBitFun@675ad70ee844a8197475508edeb96939aaad19fd` 的 `packages/flow-chat-presentation/src/search.ts`。Swift 保留其 MIT 声明于 [openbitfun/LICENSE](../public/vendor/openbitfun/LICENSE)，不引入其运行时或会话存储。

### 原生运行时

Herdr 的固定基线、补丁和构建入口见 [runtime/herdr](../runtime/herdr/README.md)。Codex 补丁、基线和配套资源边界见 [runtime/codex](../runtime/codex/README.md)，官方 Apache-2.0 文本位于 `runtime/codex/UPSTREAM_LICENSE`。

终端首页测试图案来自 OpenAI Codex 固定源码的 Apache-2.0 快照，只用于测试，不替换生产终端内容。
