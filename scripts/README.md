# 开发脚本

从仓库根目录使用 `package.json` 中的命令。

| 目录       | 职责                                     |
| ---------- | ---------------------------------------- |
| `build/`   | 资源准备、协议与能力生成、Windows 构建。 |
| `check/`   | 源码/仓库检查、隔离测试与验证调度。      |
| `lib/`     | 共用源码指纹。                           |
| `release/` | 服务器/客户端打包与哈希、签名校验。      |
| `testing/` | 浏览器、原生 PTY、客户端夹具和专项诊断。 |

普通贡献从 `npm run validate -- fast` 开始。`npm run validate -- --help` 列出专项；选择边界见[验证流程](../docs/VALIDATION.md)。测试不使用生产 HOME、终端或个人凭据，输出留在忽略的 `artifacts/`。
