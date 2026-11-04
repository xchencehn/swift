# 原生运行时来源

Swift 连接 Herdr 管理的真实终端，原生 Agent 仍由对应工具运行。兼容通过能力协商实现；客户端不重新实现另一套 PTY 或 Agent 执行循环。

| 组件               | 固定来源与维护入口                                                                      |
| ------------------ | --------------------------------------------------------------------------------------- |
| Herdr 共享运行时   | [runtime/herdr/](../runtime/herdr/README.md)、固定的 `source.json` 和 `runtime.patch`。 |
| Codex 扩展与更新器 | [runtime/codex/](../runtime/codex/README.md)、`recipe.json`、版本对应补丁与上游许可证。 |
| 命令行入口         | [bin/swift.js](../bin/swift.js)。                                                       |

Herdr 构建、安装和迁移记录源提交、补丁及产物哈希。运行包按源码清单验证后切换新入口，保留旧包与回退。协议、能力或二进制升级遵循[共享运行时约束](SHARED_RUNTIME_ARCHITECTURE.md)。

Codex 扩展保留官方源码与配套资源许可，不复制用户账号凭据。默认配置、更新策略和显式覆盖规则见组件说明。已有原生进程不因更新入口而被终止。
