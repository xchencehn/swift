# 安装与部署

Linux / WSL 安装使用 `install.sh`，步骤见[快速开始](../docs/getting-started.md)。

| 位置                           | 职责                                     |
| ------------------------------ | ---------------------------------------- |
| `install.sh`                   | 安装项目依赖、私有配置、用户服务和 CLI。 |
| `templates/`                   | 使用实际安装路径渲染的 systemd 模板。    |
| `swift.sh`、`swift-runtime.sh` | 网页/执行环境入口与可选原生运行时入口。  |
| `herdr/`、`codex/`             | 安装固定来源的原生扩展。                 |
| `preview/`                     | 可选的隔离文档预览组件。                 |
| `windows/`                     | Windows 更新通道的公开信任材料。         |

真实配置保存在忽略的 `.local/config/`，状态和业务数据位于 `.local/` 对应目录；安装器创建的系统入口链接到项目内配置。端口、根目录、Herdr 与 token 设置见 [swift.env.example](swift.env.example)。

产品不部署账号或中转服务。跨网络的 SSH 隧道、VPN 和 HTTPS 由部署方单独管理。公开的客户端安装包与更新清单仅用于分发，不参与服务器连接。
