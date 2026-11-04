# Swift 管理的 Codex 扩展

Swift 维护账户简称与 `/hfork` 的 Rust 补丁、更新器、安装器和隔离验收。官方源码仍来自 OpenAI；`recipe.json` 固定已审计的基线提交与原生二进制哈希，后续构建记录实际官方标签、补丁、锁文件和测试。此目录取代旧项目的管理脚本作为当前维护入口，不链接旧项目的源码、依赖或可写配置。

账户简称来自当前连接的 app-server。`tui.account_aliases` 忽略邮箱 ASCII 大小写匹配；未配置时使用邮箱前缀，过滤控制字符并最多显示 12 个字符；API key 模式显示 `api`，未知身份隐藏。现有账户映射和凭据不迁移。Swift 随安装携带 `defaults.toml`：默认 `approval_policy=never` 和 `sandbox_mode=danger-full-access`，关闭 analytics、feedback、OTel 日志／跟踪／指标导出及用户提示记录。关闭遥测不影响正常模型请求发送任务所需上下文。

新用户的状态栏顺序为模型及推理强度、账户简称、周额度、目录、项目名、Git 分支、运行状态、上下文用量、五小时额度、任务进度。启动器为当前 `CODEX_HOME` 缺少的用户配置项补充启动参数；已有用户配置、选定的权限 profile 和显式命令行参数保留。已有状态栏仅在缺少 account 时补充账户项，显式空列表保持隐藏；不写回 config.toml，也不读取 auth.json。个人账户别名不随发行分发，未配置时使用原生邮箱前缀规则。`SWIFT_CODEX_DEFAULTS_POLICY=off` 可停用权限与隐私默认参数，`SWIFT_CODEX_STATUS_POLICY=off` 可关闭状态栏补齐。


## 安装与管理

Linux x86_64 使用 Python 3.12+、Node 24 和 Swift 的 node-pty。主构建端需要 Git、官方标签要求的 Rust 工具链和 C/C++ 构建依赖。新主机构建使用：

```sh
/usr/bin/python3 -B deploy/codex/install.py --source "$PWD" --build
```

已有 Swift 验证包使用 `--archive /路径/runtime.tar.gz`，无需编译器。初次从旧实现迁移时，可用 `--legacy /旧运行包 --provenance /已审计源码`；必须匹配 recipe 的提交、完整补丁与二进制哈希，并重新通过隔离验收。该参数仅用于一次迁移，之后不依赖旧目录。Swift 常规安装器发现已安装的 Codex npm 包时会自动初始化扩展，首次构建和原生验证成功后才启用入口；已有安装更新管理器。没有 Codex npm 包的纯网页安装继续跳过该组件。

真实状态保存在 Swift 的 `.local/runtime/codex`，系统 `~/.local/share/swift/codex` 只链接到这里。旧运行包和备份保留；运行中的 Codex 不被终止、覆盖或重启。默认 `codex` 启动入口和 `/hfork` helper 都归 Swift，旧 `codex-custom-status/update` 命令继续兼容。

```sh
swift-codex status
swift-codex upgrade
swift-codex update --force
swift-codex rollback
swift-codex resume-updates
swift-codex export --archive /路径/runtime.tar.gz
```

回滚验证上一包的完整清单，并暂停自动更新，避免定时任务立即恢复刚回滚的版本；`resume-updates` 恢复跟随本机 npm。每个运行包记录全部程序、配套资源、许可与 Rust 账户模块的 SHA-256、大小和权限，清单哈希另存批准记录。当前指针与旧进程的 inode 分离，切换只影响新启动的进程。

## 自动更新

WSL 的 `swift-codex-update.timer` 每两分钟检查，Codex 启动也会触发异步检查。更新器跟随已安装的 npm 版本，不擅自升级全局 npm。对应资源在本机构建并通过原生验收后更新新进程入口。

受管 Codex 0.166.0 起，原生更新菜单调用 `swift-codex upgrade`。该命令在登记的 npm 安装前缀更新官方包，等待共享构建锁，构建并验证扩展后原子切换全局入口；只有实际运行包与 npm 版本一致才返回成功。构建失败保留旧包并返回错误，不能把 npm 安装成功当作 Codex 更新完成。更新不终止已有会话，之后所有 Tab 的新进程使用同一 `current`。后台更新仍不主动升级 npm，回滚暂停和 follower 分发边界保持。

0.164／0.165 使用 `extensions.patch`；0.166 起使用 `extensions-0.166.patch`，适配上游新增的状态栏项及账户 workspace 字段。两份补丁共同进入运行包来源指纹，上游继续变化时仍需完成补丁兼容与原生验收。


## 验证与来源

`npm run validate -- codex-runtime` 运行隔离实际安装、三项实际 Rust 账户测试、五组简称、官方 app-server 身份优先、安装后 launcher、原生 `/hfork`、忙碌 Fork 及恢复／提供方回归。默认从当前 Swift 验证包取样；`SWIFT_CODEX_VERIFIED_ROOT` 可指定已有 Swift 验证根。所有账户均为 example.test 合成数据，模型请求为零，不向生产终端输入探针。管理器、安装器及同步分支另由 fast 中的 Python 与 Node 测试覆盖。

基线基于 OpenAI Codex `rust-v0.164.0`；Apache-2.0 许可保存在 [UPSTREAM_LICENSE](UPSTREAM_LICENSE)。补丁包含账户简称及原有 `/hfork`；本项目调整生命周期管理、隔离验证与部署。官方运行包内的配套资源和各自许可完整保留，不因它们不在主二进制中而省略。
