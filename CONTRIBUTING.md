# 参与开发

欢迎提交问题报告、文档改进和代码修改。请先阅读[产品范围](docs/PRODUCT_SPEC.md)、[架构](docs/ARCHITECTURE.md)与[目录说明](docs/development/structure.md)。

## 准备环境

Node.js 至少为 22.13。获取源码后在根目录执行 `npm ci`。基础检查与多数测试不需要个人凭据、生产服务器或运行中的 Agent；测试启动器使用独立 HOME。

```bash
npm run validate -- fast
npm run format:check
```

完整浏览器组合使用独立合成数据，其中直连网关需要 Rust 工具链。仅检查网页可先运行 `npm run harness:frontend`。完整组合命令为：

```bash
npx playwright install firefox
SWIFT_VALIDATION_BROWSER=firefox npm run validate -- browser
```

Rust 核心与桌面连接组合使用 `npm run desktop:test` 和 `npm run harness:desktop`。Windows 原生可执行文件可用 `npm run desktop:build -- --no-bundle` 构建，无需发行签名私钥。实际 Windows UI 与安装器验证使用隔离虚拟机，不能以构建成功替代。

Android 无需发行签名即可检查和构建 debug 版本：

```bash
npm run validate -- android-debug
```

完整工具链、可选原生运行时与环境保护要求见[验证流程](docs/VALIDATION.md)。

## 修改约定

- 将产品行为、代码实现与验证证据放在同一个变更中；说明具体触发条件和修改后的行为。
- JavaScript、TypeScript、JSON、CSS、HTML 和 Markdown 使用仓库内固定版本的 Prettier。运行 `npm run format` 格式化；第三方、生成文件与补丁不参与格式化。
- Rust 使用 `cargo fmt --manifest-path desktop/core/Cargo.toml`；Java 与 Python 沿用组件现有风格。
- 保持同一系统与本机 Windows/WSL 免认证，其他局域网连接验证 token；不要把私有 IP 网段整体视为可信。
- 修改终端、聊天、文件或同步前阅读[共享运行时约束](docs/SHARED_RUNTIME_ARCHITECTURE.md)。草稿、阅读位置与展示模式属于各窗口，观察不取得焦点或尺寸，输入不得重放。
- 合成夹具只使用示例账号与内容。个人配置、凭据、构建产物和原始采集数据留在忽略目录。
- 修改第三方材料时保留版权、许可证、固定来源和本地修改说明。

涉及生成文件时，先修改 `shared/` 或生成器，再使用对应 `generate:*` 命令更新产物。不要手工编辑 `public/vendor/` 或生成的协议类型来绕过一致性检查。

## 提交问题与变更

问题报告应包含版本、运行平台、连接方式、最短复现步骤、预期与实际结果。日志请移除 token、个人路径和会话正文。安全问题按[安全说明](SECURITY.md)私下报告。

提交前运行与改动相符的检查，在变更描述中写清实际执行的命令、结果与未覆盖的平台。不要将夹具、静态检查、构建、实际运行、安装和公开发布混作同一种证据。界面变化可附合成数据的截图。

提交内容采用本项目的 Apache-2.0 许可；保留依赖原有许可。此约定不授权重新许可第三方代码。

## 导出源码

提交并固定源码后运行 `npm run release:source`，在 `artifacts/release/<version>/source/` 生成仅包含当前 Git 树的源码包、清单和 SHA256。该包不包含 Git 历史、其他分支或本地忽略文件，可用于检查准备公开的具体内容。

维护者会话开发完成后按[GitHub 发布与部署](docs/RELEASING.md)继续执行公开同步、CI、Release 和适用环境的安装。服务器 Release 自动由精确提交的完整 CI 触发；客户端仍需签名与平台验收。
