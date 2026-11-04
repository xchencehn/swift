#!/usr/bin/env python3
"""Remove the retired Swift Shell integration without changing user defaults."""
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time


def uninstall(home, history):
    changes = []
    codex = home / '.local/bin/codex'
    if codex.is_file() and b'# Swift-managed execution environment' in codex.read_bytes():
        config = json.loads((home / '.config/swift/execution.json').read_text())
        command = config['codex']
        binary = Path(command['binary'])
        if not binary.is_absolute() or not binary.is_file():
            raise ValueError('The previous Codex launcher is unavailable; preserving the integration.')
        previous = binary.read_bytes() if binary.name == 'previous-codex' else b''
        if b'Swift-managed Codex runtime' in previous:
            restored = previous
        else:
            restored = ('#!/bin/sh\nexec ' + shlex.join([str(binary), *command.get('args', [])]) + ' "$@"\n').encode()
        changes.append((codex, restored))
    for name in ['.profile', '.bashrc', '.bash_profile']:
        file = home / name
        if not file.is_file():
            continue
        old = file.read_bytes()
        new = re.sub(rb'# BEGIN Swift execution environment\r?\n[\s\S]*?# END Swift execution environment(?:\r?\n|$)', b'', old)
        if new != old:
            changes.append((file, new))
    if changes:
        history.mkdir(parents=True, exist_ok=True, mode=0o700)
    for file, data in changes:
        target = file.resolve()
        backup = history / (file.name + '-' + str(time.time_ns()))
        backup.write_bytes(target.read_bytes())
        backup.chmod(0o600)
        temporary = target.with_name(target.name + '.swift-new')
        temporary.write_bytes(data)
        temporary.chmod(target.stat().st_mode & 0o777)
        os.replace(temporary, target)
    return [file.name for file, _ in changes]


if __name__ == '__main__':
    source = Path(sys.argv[1]).resolve()
    print(json.dumps({'removedLegacyShellIntegration': uninstall(Path.home(), source / '.local/history/retired-environment')}))
