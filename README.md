<p align="center"><img src="public/icon-192.png" width="72" height="72" alt="Swift"></p>

# Swift

在浏览器、Windows 和 Android 上接续同一组终端与 Agent 会话。

Swift 连接 Herdr 管理的真实终端，读取 Codex、Claude Code 等工具的原生存档，提供结构化聊天、终端交互、文件阅读与编辑。各窗口独立保存草稿、阅读位置和展示模式；关闭客户端会保留服务器上的会话。

[快速开始](docs/getting-started.md) · [文档](docs/README.md) · [参与开发](CONTRIBUTING.md) · [Apache-2.0 许可](LICENSE)

## 直接连接

Swift 只有服务器和客户端，不需要中转服务或 Swift 账号。

| 连接方式      | 操作                                                            |
| ------------- | --------------------------------------------------------------- |
| 同一系统      | 连接本机服务器，无需认证。                                      |
| Windows / WSL | Windows 客户端连接本机 WSL 服务器，无需认证。                   |
| 局域网        | 在服务器运行 `swift`，把摘要中带 token 的完整链接粘贴到客户端。 |

需要跨网络时，可在 Swift 之外配置 SSH 隧道或自己的网络连接。HTTPS/WSS 可由部署方提供。局域网 token 具有服务器操作权限，应当作为连接凭据保存。

## 快速开始

服务器需要 Node.js 22.13+、Python 3 和兼容的 Herdr。Linux / WSL 的服务安装使用 systemd 用户服务。

正式安装与升级使用 [GitHub Releases](https://github.com/xchencehn/swift/releases)的校验安装入口，命令与迁移说明见[发布部署流程](docs/RELEASING.md#安装与升级服务器)。本地源码开发进入仓库后：

```bash
npm ci
bash deploy/install.sh --root /absolute/project --herdr /absolute/path/to/herdr --start
swift
```

安装器保留已有私有配置，使用已经运行的 Herdr `swift` Session。首次部署的准备步骤、手动启动和连接说明见[快速开始](docs/getting-started.md)。

Windows 使用发行版安装器；Android 提供会话版和原生终端版。浏览器直接打开服务器链接。客户端不需要安装服务器的 Node.js 或开发工具链。

## 功能

- 结构化聊天保留各提供方的消息、工具结果与原生会话身份。
- 原生终端复用 Herdr 的 PTY、画面、键盘模式与历史。
- 文件页面提供目录树、全文复制、显式文本编辑和 Markdown 阅读布局。
- 离线草稿与缓存优先恢复，重连追平状态且不重放输入。
- 客户端和服务器分别提供版本检查与更新入口。

## 开发

```bash
npm run validate -- fast
npm run format:check
```

浏览器、Android、Rust 与 Windows 的独立构建和验证见[贡献指南](CONTRIBUTING.md)与[验证流程](docs/VALIDATION.md)。[目录说明](docs/development/structure.md)列出模块职责和生成文件。

## 许可

Swift 原创代码采用 [Apache-2.0](LICENSE)。第三方代码、字体和原生组件保留各自许可，来源与分发边界见 [NOTICE](NOTICE) 和[第三方声明](docs/THIRD_PARTY.md)。
