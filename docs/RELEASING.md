# GitHub 发布与部署

正式发布仓库为 [xchencehn/swift](https://github.com/xchencehn/swift)。维护者会话完成开发后，继续完成适用的验证、公开推送、GitHub CI、Release 和已登记环境的部署；这些步骤属于交付，不需要再次单独确认。保留其他会话的修改和运行状态。

## 提交与公开同步

先吸收 `main`，按[验证流程](VALIDATION.md)完成修改对应的检查，更新发行版本并提交固定源码。`package.json`、锁文件、Tauri 与 Cargo 的桌面版本保持一致；Android 两款应用按自己的版本与签名检查发布。已发布版本不可覆盖，也不将较旧发行重新设为最新版本。

直接在公开仓开发时正常推送 `main`。持有内部历史的开发仓必须使用独立公开工作副本：

```bash
npm run publish:github -- --checkout /absolute/public-swift --ref main --dry-run
npm run publish:github -- --checkout /absolute/public-swift --ref main
```

该入口只复制所选提交的文件树，在公开历史上追加提交；不推送内部分支、标签或 Git 对象。它保留公开副本中的忽略文件，校验最终 Git 树完全一致，并记录本地来源。公开副本必须干净，远端必须匹配指定 GitHub 仓库；禁止强制推送或用内部 `main` 替换公开分支。

## CI 与 Release

推送会触发 `CI`。同一公开提交的 Node 22/24、浏览器、Android debug、Windows 构建以及服务端安装与打包全部通过后，`Release` 工作流自动发布 `v<version>`。

```bash
gh run list --repo xchencehn/swift --commit PUBLIC_COMMIT
gh run watch RUN_ID --repo xchencehn/swift --exit-status
gh release view vVERSION --repo xchencehn/swift
```

自动 Release 包含服务端包、完整源码包、两份来源清单、`server-latest.json`、校验和及 `github-install.py`。发布先上传草稿，确认附件完整后再公开；源码提交必须仍是最新 `main`。失败时修复真实原因，不跳过 CI、覆盖已公开附件或扩大验证结果。相同提交可以恢复残留草稿或重复检查已成功的发行；不同提交不能复用同一版本。服务器单独发布时沿用上一份已公开的客户端 `latest.json`，仍指向原已验证的固定版本安装器。

工作流可手动重跑；`npm run release:github` 也可在干净的公开工作副本中执行，仍检查相同的 CI 和版本条件。GitHub 工作流使用仓库自己的短期令牌，不上传本地账号或发行签名密钥。

## 安装与升级服务器

从公开 Release 下载入口，安装时下载固定版本的服务端包并核对 SHA-256、字节数、版本和来源提交：

```bash
curl -fL https://github.com/xchencehn/swift/releases/latest/download/github-install.py -o swift-install.py
python3 swift-install.py --root /absolute/project --herdr /absolute/path/to/herdr --start \
  --health-url http://127.0.0.1:8792/swift/frontend-version.json
```

默认安装到 `~/.local/share/swift/server/`，各版本放入 `releases/`，`current` 指向所选版本，`state/` 保存共享私有配置和数据。后续执行相同命令即可升级。用 `--version VERSION` 固定发行；`--download-only` 只验证、解包，不改服务；`--assets DIRECTORY` 可使用已经下载的相同 Release 附件。

迁移已有源码安装时，额外传入 `--previous-source /absolute/previous-swift`。安装器沿用原 `.local/` 状态，不复制或输出凭据，保留原目录作为回退依据；不会覆盖开发仓。正式切换仅重启 Swift 网页服务，不重启 Herdr 或 Codex、不向原生终端输入。安装或启动核对失败时恢复原服务定义与入口。没有 `--start` 时只更新安装和服务配置，尚未重启正在运行的服务。

部署后分别核对服务器版本、连接访问和原生终端身份。跨机器执行同一安装流程，保留目标机的配置、用户服务和独立 SSH 隧道；不要把管理机的凭据与私有配置打进安装包。生产状态核对不替代隔离测试。

## Windows 与 Android

CI 的 Windows 可执行文件与 Android debug 构建属于工程验证，不自动成为正式安装包。修改客户端时继续完成对应的签名、[Windows 原生与安装验收](VALIDATION.md#windows-与-android)，再将验证过的安装包、签名、平台清单和独立校验和附加到同一版本的 GitHub Release。不能把未经验证的包安装到生产设备。

Windows 使用 `npm run release:desktop` 生成并验证更新签名，Android 使用现有双产品签名校验入口。签名私钥留在原有本地私有目录。公开下载地址使用固定版本的 GitHub Release URL；原静态更新通道在旧客户端迁移期间只同步已经从 GitHub 下载并核对过的同一产物与清单，不能独立发布另一份构建。客户端更新清单与服务器清单分别维护，服务端单独发布不升级客户端。

任务记录分别保存内部提交、公开提交、CI/Release 链接、产物校验和，以及各环境实际安装版本。源码公开、CI 通过、包已下载、安装成功和实际运行验收是不同结果；失败的环境保留具体原因，不写成已交付。
