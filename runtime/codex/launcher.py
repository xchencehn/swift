#!/usr/bin/env python3
"""Launch the verified Swift Codex runtime without changing user credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True
import tomllib
from manager import Manager


def read_user_config(env):
    home = Path(env.get('CODEX_HOME', str(Path.home() / '.codex')))
    config = home / 'config.toml'
    if config.exists() and config.stat().st_size > 4 * 1024 * 1024:
        raise ValueError('Codex configuration exceeds launcher read limit')
    return tomllib.loads(config.read_text()) if config.exists() else {}


def default_overrides(arguments, env, defaults):
    if env.get('SWIFT_CODEX_DEFAULTS_POLICY') == 'off':
        return []
    try:
        configured = read_user_config(env)
    except (OSError, ValueError):
        return []  # Let native Codex report invalid configuration.
    # An explicitly selected profile remains responsible for permission policy.
    profile = configured.get('profile')
    for i, arg in enumerate(arguments):
        if arg in ('-p', '--profile') and i + 1 < len(arguments):
            profile = arguments[i + 1]
        elif arg.startswith('--profile='):
            profile = arg.split('=', 1)[1]
    profile_config = configured.get('profiles', {}).get(profile, {})
    result = []
    for section, values in defaults.items():
        values = values if isinstance(values, dict) else {None: values}
        for key, value in values.items():
            if section == 'tui' and (key == 'status_line' or env.get('SWIFT_CODEX_STATUS_POLICY') == 'off'):
                continue  # Interactive status selection is handled separately.
            existing = configured.get(section, {}) if key else configured
            if (key or section) in existing or (not key and section in profile_config):
                continue
            name = section + '.' + key if key else section
            result.extend(['-c', name + '=' + json.dumps(value)])
    return result


def status_override(arguments, env, defaults):
    if env.get('SWIFT_CODEX_STATUS_POLICY') == 'off' or any(value in arguments for value in
            ['--version', '-V', '--help', '-h', 'exec', 'app-server', 'debug', 'login', 'logout', 'mcp', 'mcp-server', 'sandbox', 'completion']):
        return []
    try:
        value = read_user_config(env)
        selected = value.get('tui', {}).get('status_line')
    except (OSError, ValueError):
        return []  # Native Codex retains responsibility for reporting malformed configuration.
    if selected is None:
        selected = list(defaults)
    elif not isinstance(selected, list) or not selected or not all(isinstance(item, str) for item in selected) or 'account' in selected:
        return []
    else:
        selected = list(selected)
        index = next((i + 1 for i, item in enumerate(selected) if item in ['model-with-reasoning', 'model']), 0)
        selected.insert(index, 'account')
    # CLI overrides precede user arguments; explicit user -c values still win.
    return ['-c', 'tui.status_line=' + json.dumps(selected, ensure_ascii=False)]


def launch(arguments):
    manager = Manager()
    release, _ = manager.release(extension=False)
    env = dict(os.environ)
    env['SWIFT_CODEX_ROOT'] = str(manager.root)
    for name in ['CODEX_MANAGED_BY_BUN', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS']:
        env.pop(name, None)
    env['CODEX_MANAGED_BY_NPM'] = '1'
    env['CODEX_MANAGED_PACKAGE_ROOT'] = str(Path(manager.config['npmPackage']).parent)
    if manager.config.get('scheduler') == 'systemd':
        try:
            subprocess.run(['systemctl', '--user', 'start', '--no-block', 'swift-codex-update.service'],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass
    elif manager.config.get('scheduler') == 'process':
        with (manager.root / 'launch-update.log').open('ab') as log:
            subprocess.Popen([sys.executable, manager.tools / 'manager.py', 'update', '--root', manager.root],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    defaults = tomllib.loads((manager.tools / 'defaults.toml').read_text())
    args = default_overrides(arguments, env, defaults)
    args += status_override(arguments, env, defaults['tui']['status_line'])
    args += arguments
    os.execve(release / 'bin/codex', [str(release / 'bin/codex'), *args], env)


if __name__ == '__main__':
    try:
        launch(sys.argv[1:])
    except (OSError, ValueError, KeyError):
        raise SystemExit('Swift 管理的 Codex 运行包未通过检查。请运行 swift-codex status，或用 swift-codex update --force 重试。')
