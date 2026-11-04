# Windows 桌面客户端

`core/` 提供 Rust 直连、系统凭据、存储和本机 HTTP/WebSocket 网关；`src-tauri/` 提供 Tauri 2 窗口、单进程和更新；`ui/` 提供连接管理。业务界面由 `../public/` 生成至忽略的 `dist/`。

## 开发

```bash
npm ci
npm run desktop:test
npm run harness:desktop
npm run desktop:build -- --no-bundle
```

Windows 构建使用 Rust MSVC target、Visual Studio C++ 构建工具与 WebView2。Linux / WSL 可使用 cargo-xwin、LLVM、NSIS 和已配置的 Windows target；构建脚本选择对应工具链。

实际 WebView2 与安装器验证在隔离 Windows 虚拟机进行。入口与配置见[验证流程](../docs/VALIDATION.md)，公开 CI 的构建不代替实际运行。

## 直连与存储

客户端支持同系统、Windows/WSL 和局域网连接。LAN token 从链接解析并保存到系统凭据库；普通连接记录只保留干净地址与连接身份。升级保留已有 direct ID、稳定本机端口、草稿和活动选择。

## 发行

更新私钥放在忽略的 `.local/config/desktop-updater.key`。配置 `src-tauri/tauri.conf.json` 中的更新端点和公钥，私钥不要进入 Git。当前官方通道的公开信任材料位于 `../deploy/windows/`，连接服务器使用标准系统信任与单独的局域网 token。

```bash
npm run desktop:build
npm run release:desktop
```

正式发行要求干净、固定的源码。输出位于 `../artifacts/release/<version>/windows/`，包含安装器、更新签名、源码指纹、哈希和静态更新清单。更新签名与 Windows Authenticode 是不同的签名；未配置发行者证书时不声明 Authenticode 签名。

Windows 安装验证使用安装包实际 payload 的哈希。Tauri 会写入 bundle 类型标记，不应直接拿打包前 EXE 的哈希判断安装失败。

`npm run validate -- desktop-startup` 在相同隔离 Windows 虚拟机检查窗口几何、背景与首屏时序。凭据和服务器网络连接不阻塞本地首屏。
