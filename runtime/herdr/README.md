# Swift 的 Herdr 扩展

[source.json](source.json) 固定公开上游、提交、工具链对应版本和补丁 SHA256。[runtime.patch](runtime.patch) 是相对于该提交的完整改动，提供终端状态、历史、语义输入和会话迁移能力，不需要其他私有源码仓。扩展不包含 Swift 商业账号菜单；官方 Herdr 的许可证与第三方声明保持原样。

从 Swift 源码根目录运行：

```sh
python3 runtime/herdr/build.py --prepare-only
python3 runtime/herdr/build.py --jobs 4 --target x86_64-unknown-linux-musl
python3 runtime/herdr/build.py --jobs 4 --target aarch64-unknown-linux-musl --zig
```

构建脚本克隆固定上游版本、应用仓内补丁，并验证完整差异与清单一致。源码、日志和候选保存在忽略的 `artifacts/runtime/herdr/`。可用 `--source /path/to/upstream-checkout` 复用包含该上游提交的本地 Git 缓存；缓存不替代清单或补丁校验。

首次构建需要下载 Rust、Zig 和依赖。Linux 分发采用 musl target，需要相应 Rust 标准库及 musl-tools；跨架构构建还需要 [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild)。默认本机构建可能依赖本机 glibc。构建不会安装或重启服务。

协议说明随补丁提供，位于准备后源码的 `docs/next/swift-runtime.md`。更改扩展时，从固定上游重新导出完整二进制补丁，更新 `patch_sha256`，再执行准备和相应原生验证。不要修改生成目录代替仓内补丁。

```sh
node scripts/testing/herdr-runtime-state-probe.js /absolute/path/to/candidate/herdr
python3 runtime/herdr/package.py --build /path/to/build.json --output /path/to/output
```

运行包包含已核对的二进制、补丁、来源清单与许可证，附带 SHA256，并移除本机构建路径。自更新由 Swift 管理，不使用官方 Herdr 发布渠道。

`migrate.py --socket <socket> --candidate <binary> --receipt <private-receipt>` 默认只读核对；`--apply` 才执行 live handoff。迁移验证候选哈希、Pane ID、Terminal ID、PTY PID 和进程启动时间，不向终端输入探针，不重放输入。完整快照仅适用于具备该能力的扩展版之间；旧官方版本不具备相同的状态保全保证。

安装入口为 [deploy/herdr/install.py](../../deploy/herdr/install.py)。它保留官方二进制，并使用 Swift 自有目录。构建、隔离 PTY、性能、迁移、安装和正式发布分别记录；某一项成功不代表其他项目已经通过。
