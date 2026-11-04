#!/usr/bin/env bash
# swift 持久会话的 systemd 托管入口。
#
# 为什么不直接 `ExecStart=herdr server`：herdr 的交互客户端在没有 server 时会自己
# 拉起一个，而让出所有权的旧 server（例如 live-handoff）是以状态码 0 退出的。于是
# systemd 判定这个 unit "正常跑完"，Restart=on-failure 不触发，服务停在 inactive，
# 持久会话落到某个交互 shell 拉起的孤儿进程手里——2026-07-24 就是这样丢的所有权。
#
# 策略：已有 server 就守着不动，绝不抢占（pane 里通常跑着 Claude/Codex agent），
# 等它消失后再接管；没有 server 就直接 exec 一个。配合 Restart=always，重启机器或
# 旧 server 退出后，systemd 都能重新成为持久会话的持有者。
#
# 注意 session 名只能靠 `--session` 传：herdr 不认 HERDR_SESSION 环境变量，旧 unit
# 里的 `Environment=HERDR_SESSION=` 一直是摆设，只是默认 session 恰好同名才没出事。

set -euo pipefail

SESSION="${HERDR_SESSION:-swift}"
# 二进制由 HERDR_BIN 决定。systemd 单元现在显式设置它 —— 切换自建运行时改那里，
# 不要只替换 ~/.local/bin/herdr，否则重启后会悄悄退回已安装版本。
HERDR_BIN="${HERDR_BIN:-${HOME}/.local/bin/herdr}"
if [ ! -x "$HERDR_BIN" ]; then
  echo "HERDR_BIN=$HERDR_BIN 不存在或不可执行，拒绝启动 —— 宁可让 unit 失败，也不要静默换成别的二进制" >&2
  exit 78
fi
SOCKET="${HOME}/.config/herdr/sessions/${SESSION}/herdr.sock"
POLL_SECONDS="${HERDR_RUNTIME_POLL_SECONDS:-5}"

# 只有真正连得上才算活着：socket 文件残留不代表 server 还在。
server_alive() {
  [ -S "$SOCKET" ] || return 1
  python3 - "$SOCKET" <<'PY'
import socket
import sys

probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
probe.settimeout(2)
try:
    probe.connect(sys.argv[1])
except OSError:
    sys.exit(1)
finally:
    probe.close()
PY
}

if server_alive; then
  echo "herdr session ${SESSION} already has a live server; waiting instead of taking it over" >&2
  while server_alive; do
    sleep "$POLL_SECONDS"
  done
  echo "previous herdr server for ${SESSION} is gone; taking over now" >&2
fi

exec "$HERDR_BIN" --session "$SESSION" server
