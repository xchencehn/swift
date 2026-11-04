#!/usr/bin/env bash
set +x
set -euo pipefail
swift_launcher=$(readlink -f -- "${BASH_SOURCE[0]}")
swift_source=$(cd -- "$(dirname -- "$swift_launcher")/.." && pwd -P)
swift_environment="$swift_source/.local/config/swift.env"
if [[ -f "$swift_environment" ]]; then
  set -a
  source "$swift_environment"
  set +a
fi
swift_runtime_environment="${XDG_DATA_HOME:-$HOME/.local/share}/swift/herdr/runtime.env"
if [[ -f "$swift_runtime_environment" ]]; then
  set -a
  source "$swift_runtime_environment"
  set +a
fi
exec node "$swift_source/bin/swift.js" "$@"
