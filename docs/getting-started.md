# 快速开始

## 服务器

服务器需要 Node.js 22.13+、Python 3、兼容的 Herdr 和已经存在的项目目录。Linux / WSL 安装器使用 systemd 用户服务；可选的受管 Codex 扩展需要 Python 3.12+，详见[扩展说明](../runtime/codex/README.md)。

先安装并运行兼容的 Herdr，准备 `swift` Session。运行时的固定来源与扩展构建见[运行时来源](RUNTIME_SOURCE.md)。Swift 安装器不会为了启动网页而重启已有 Herdr 或 Agent。

在源码根目录执行：

```bash
npm ci
bash deploy/install.sh --root /absolute/project --herdr /absolute/path/to/herdr --start
swift
```

确认 `~/.local/bin` 已加入 PATH。安装器将配置存放在本仓库忽略的 `.local/config/`，创建指向本安装的用户服务与命令入口，保留已有配置。

已有配置时可管理网页服务：

```bash
systemctl --user status swift.service
systemctl --user restart swift.service
swift info
```

`swift` 与 `swift info` 显示服务器名称、版本、项目目录、监听地址和连接链接；`swift terminal` 进入同一 Herdr Session。自定义服务管理器可直接运行 `node server.js`，按 [swift.env.example](../deploy/swift.env.example)设置环境变量。

## 客户端

Windows 运行发行版安装器，在“服务器”中添加连接。Android 会话版加载服务器网页，原生终端版使用同一连接配置。浏览器可直接打开服务器链接。

- 同一系统使用摘要中的本机地址，默认是 `http://127.0.0.1:8792/swift/`。
- Windows 连接本机 WSL 时选择 Windows / WSL。安装器登记明确检测到的宿主地址。
- 局域网选择局域网方式，粘贴摘要中的完整 token 链接。客户端分开保存普通地址与凭据，不要求手工拆出 token。

连接失败时核对端口、防火墙、服务器状态及链接。token 失效时重新粘贴当前摘要链接。不要将带 token 的链接公开发送。

## 跨网络与加密

Swift 不提供网络中转。可以在产品之外配置 SSH 隧道、VPN 或自己的网络。转发到回环地址可能使服务器无法区分本地与远端来源；应转发到局域网监听地址，或对该服务设置 `SWIFT_DIRECT_AUTH=token`。

服务器原生接口为 HTTP/WebSocket；需要传输加密时配置 HTTPS/WSS 入口或使用加密隧道。转发不会改变客户端草稿、会话身份或原生进程的归属。
