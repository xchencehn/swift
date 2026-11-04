# 验证流程

从仓库根目录运行 `npm run validate -- <环境...>`。调度器为每步记录日志、退出码、耗时和前后源码指纹；命令失败、超时或源码变化都会使环境结果失败。日志与 JSON 位于忽略的 `artifacts/validation/`。

## 基础环境

| 环境              | 覆盖内容                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `fast`            | 仓库内容、JavaScript 语法、生成一致性、类型检查与隔离 Node 测试。                             |
| `browser`         | 独立合成执行端的网页、聊天、设置、文件、提供方、恢复和连接认证。                              |
| `android-debug`   | 两款应用的单元测试、debug 构建和 lint，不需要个人发行签名。                                   |
| `android`         | 两款应用的单元测试、release 构建、lint 与 APK 签名，要求私有签名配置。                        |
| `desktop-ci`      | Rust 核心与 Windows 原生可执行文件构建，不打发行安装包。                                      |
| `desktop`         | Rust、直连网关、多窗口、Windows 安装包构建与更新签名。                                        |
| `direct`          | 四档浏览器的无 token 本机连接、LAN 完整链接、错误和失效凭据、草稿，以及 Java HTTP/WebSocket。 |
| `install`         | 发行源码包在临时 HOME 安装，用记录服务管理器验证，不操作生产服务。                            |
| `windows`         | 隔离 Windows 虚拟机的 WebView2、连接、冷启动、草稿和多窗口。                                  |
| `windows-install` | 同一隔离虚拟机内的实际安装、升级、回退与再次升级。                                            |

推荐基础检查：

```bash
npm ci
npm run format:check
npm run validate -- fast
npx playwright install firefox
SWIFT_VALIDATION_BROWSER=firefox npm run validate -- browser
```

`browser` 使用共用夹具覆盖消息、工具、滚动、设置、文件、恢复和连接，不调用系统 Herdr。完整聊天用例可用 `chat-full` 单独执行；`native-tabs` 等包含 Herdr 的专项需要先配置兼容运行时。

CI 使用公开可获得的工具链和 debug/无安装包构建，不依赖个人服务器、账号或发行密钥。远端 CI 与本地同命令通过分别记录。

## 按修改选验证

终端、输入、流控、缓存与原生协议改动按[共享运行时验证矩阵](SHARED_RUNTIME_ARCHITECTURE.md)选择真实 PTY 和规模对照。界面改动使用现有浏览器夹具，保留主题、窄屏、键盘、草稿和无误发送检查。

`npm run validate -- --help` 可列出可用专项。常用专项包括 `workspace-files`、`message-navigation`、`presentation-mode`、`connection-lifecycle`、`persistent-terminals`、`terminal-background`、`update-settings` 和 `codex-runtime`。某些原生专项要求明确配置兼容 Herdr/Codex；不得改用生产会话补足缺失环境。

纯文档与格式修改不要求重新运行所有原生性能专项。目录、资源、协议生成和安装入口变化需要验证相应的实际读取与打包路径，不能只检查文件存在。

## Windows 与 Android

Windows UI、截图与安装验证使用现有隔离虚拟机。设置 `SWIFT_WINDOWS_VM_CONSOLE` 指向该虚拟机的控制台助手，多个工作副本使用共同的 `SWIFT_WINDOWS_LOCK_ROOT`。传输限制为虚拟机网桥和本次资源，不重置、停止或注销虚拟机，不操作其中其他应用。

`SWIFT_WINDOWS_OUTPUT` 指定忽略的结果目录。运行与安装专项应使用不同目录，避免覆盖证据。直接连接、HTML、输入框、文件页与原生运行时专项由相应 `SWIFT_WINDOWS_*` 选项启用。

Android 工程检查与物理手机反馈分开。浏览器合成触摸、自动化输入、进程强制关闭、设备后台回收和真实无线切换是不同证据，不混作同一种验收。

## 发行与结果

正式打包前提交并固定源码。发行清单绑定版本、源码指纹、哈希和签名；Windows 安装核对实际安装器 payload，不能假定它与打包前 EXE 的字节完全相同。

构建、实际运行、安装、公开下载、更新签名与用户反馈分别记录。只读生产检查不向已有会话输入；不在报告中保存 token、凭据、私人配置或原始正文。调度器的汇总只代表本次指定环境。

`desktop-startup` 在同一隔离 Windows 虚拟机测量无连接、一条连接和多条已保存连接的可见窗口与首屏时间。使用独立程序和数据目录，不读取用户连接；固定产物后停止本任务编译，再进行性能比较。`chat-highlighting` 覆盖 ANSI、围栏语言、复制、工具代码、主题及草稿。

`workspace-files` 覆盖原位代码编辑及 Markdown 源码模式、编辑前后同一实例、行列位置、缩进、撤销重做、查找、保存时继续输入、外部修改冲突，以及聊天与 Markdown 预览不加载编辑器。`SWIFT_WINDOWS_FILES=1 npm run validate -- windows` 在隔离 Windows 的真实 WebView2 中验证中文多行粘贴、保存后的同一可访问节点、文件字节和放弃确认；实际安装另用 `windows-install`。

`npm run validate -- terminal-sync-output` 在四档隔离 Firefox 中将大于16 KiB的原生 ANSI 同步输出拆为多个数据块，并延迟结束标记，检查画面不缺行、不移动、草稿保留和零原生输入。`SWIFT_TERMINAL_SYNC_OUTPUT` 指定证据目录。使用 `--baseline` 运行专项脚本可比较修复前的渲染；计时从最后一个数据块发送后开始，不代表完整公网延迟。`SWIFT_WINDOWS_RUNTIME_BIN=/明确路径/herdr SWIFT_WINDOWS_TERMINAL_ANSI=1 npm run validate -- windows` 在规定 Windows 虚拟机验证旧运行时的 ANSI 兼容路径；默认仍严格验证 `cells-v1`，两种格式分别记录。
