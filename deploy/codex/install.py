#!/usr/bin/env python3
"""Install Swift-owned Codex tools and migrate only verified native runtime files."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
sys.dont_write_bytecode = True
import time


def load_manager(source):
    spec = importlib.util.spec_from_file_location('swift_codex_manager', source / 'runtime/codex/manager.py')
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def install(source, state, npm_package, node, mode='builder', scheduler='systemd', auto=False,
            legacy=None, provenance=None, archive=None, build=False):
    source, state = source.resolve(), state.resolve()
    home = Path.home()
    link = home / '.local/share/swift/codex'
    if sys.version_info < (3, 12):
        raise RuntimeError('Swift Codex management requires Python 3.12 or newer')
    if not npm_package.is_file():
        if auto:
            return {'state': 'not_installed'}
        raise ValueError('The installed Codex npm package is required')
    if link.exists() and (not link.is_symlink() or link.resolve() != state):
        raise ValueError('The Swift Codex runtime link belongs to another installation')
    if state.exists() and state.stat().st_uid != os.getuid():
        raise ValueError('Codex runtime state belongs to another user')
    if scheduler == 'systemd':
        subprocess.run(['systemctl', '--user', 'show', '--property=Version'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for path in [state, state / 'managers', state / 'backups', state / 'verification/node_modules']:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    module = load_manager(source)
    tools_source = source / 'runtime/codex'
    names = sorted(p for p in tools_source.iterdir() if p.is_file())
    if any(p.is_symlink() for p in names):
        raise ValueError('Codex manager source files must not be symlinks')
    installer = source / 'deploy/codex/install.py'
    dependencies = {name: source / 'node_modules' / name for name in ['node-pty', 'node-addon-api']}
    for name, origin in dependencies.items():
        if not origin.is_dir():
            raise ValueError('Native verification dependency is unavailable: ' + name)
    fingerprint = hashlib.sha256(b''.join(p.name.encode() + b'\0' + p.read_bytes() for p in names)
        + installer.read_bytes() + json.dumps({name: {key: {**value, 'mode': 0o755 if value['mode'] & 0o111 else 0o644} for key, value in module.tree_files(origin).items()} for name, origin in dependencies.items()}, sort_keys=True).encode()).hexdigest()
    tools = state / 'managers' / fingerprint
    if not tools.exists():
        import tempfile
        staged = Path(tempfile.mkdtemp(prefix='.manager-', dir=state / 'managers'))
        for p in names:
            shutil.copy2(p, staged / p.name)
        shutil.copy2(installer, staged / 'installer.py')
        for name, origin in dependencies.items():
            shutil.copytree(origin, staged / 'node_modules' / name)
        for p in staged.rglob('*'):
            if p.is_file():p.chmod(0o755 if p.stat().st_mode & 0o111 else 0o644)
        os.rename(staged, tools)
    module.atomic_json(state / 'config.json', {'npmPackage': str(npm_package), 'node': str(node),
        'nodeModules': str(tools / 'node_modules'), 'mode': mode, 'scheduler': scheduler,
        'jobs': 2, 'rustc': os.environ.get('SWIFT_CODEX_RUSTC', 'rustc')})
    pointer = state / ('.tools-' + str(time.time_ns()));pointer.symlink_to(tools);os.replace(pointer, state / 'tools')
    manager = module.Manager(state, tools)
    if archive:
        manager.import_package(archive)
    elif legacy and not (state / 'current').exists():
        if not provenance:
            raise ValueError('Audited source provenance is required for initial adoption')
        manager.adopt(legacy, provenance)
    if (build or auto) and not (state / 'current').exists():
        manager.update()
    if not (state / 'current').exists():
        raise ValueError('Use --build or install a verified runtime archive before enabling the launcher')
    manager.release(extension=False)
    # All verification completes before the user-visible launcher or scheduler changes.
    link.parent.mkdir(parents=True, exist_ok=True)
    if not link.exists():
        temporary = link.with_name('.codex-' + str(time.time_ns()));temporary.symlink_to(state);os.replace(temporary, link)
    bin_dir = home / '.local/bin';bin_dir.mkdir(parents=True, exist_ok=True)
    launcher = bin_dir / 'codex'
    if launcher.exists() or launcher.is_symlink():
        data = launcher.read_bytes()
        # Preserve the WSLg initialization when migrating the known launcher.
        old = data.decode()
        if ('codex-custom/current/bin/codex' not in old and 'swift/codex' not in old
                and '.npm-global/bin/codex' not in old and '.npm-global/lib/node_modules/@openai/codex' not in old):
            raise ValueError('Unrecognized Codex launcher; refusing to overwrite it')
        if launcher.is_symlink():
            module.atomic_json(state / 'backups' / ('launcher-' + str(time.time_ns()) + '.json'), {'symlink': os.readlink(launcher)})
        else:
            module.atomic_bytes(state / 'backups' / ('launcher-' + str(time.time_ns())), data)
        if '# The independently managed runtime' in old:
            prefix = old.split('# The independently managed runtime', 1)[0]
        elif '# Swift-managed Codex runtime' in old:
            prefix = old.split('# Swift-managed Codex runtime', 1)[0]
        else:
            prefix = '#!/usr/bin/env bash\n'
    else:
        prefix = '#!/usr/bin/env bash\n'
    def shell(value):
        import shlex
        return shlex.quote(str(value))
    module.atomic_bytes(launcher, (prefix + '# Swift-managed Codex runtime\nexec ' + shell(sys.executable)
        + ' ' + shell(link / 'tools/launcher.py') + ' "$@"\n').encode())
    for name, command in [('swift-codex-status', 'status'), ('swift-codex-update', 'update'),
                          ('codex-custom-status', 'status'), ('codex-custom-update', 'update')]:
        module.atomic_bytes(bin_dir / name, ('#!/bin/sh\nexec ' + shell(sys.executable) + ' '
            + shell(link / 'tools/manager.py') + ' ' + command + ' "$@"\n').encode())
    module.atomic_bytes(bin_dir / 'swift-codex', ('#!/bin/sh\nexec ' + shell(sys.executable) + ' '
        + shell(link / 'tools/manager.py') + ' "$@"\n').encode())
    helper = bin_dir / 'herdr-codex-fork-right'
    if helper.exists() or helper.is_symlink():
        if helper.is_symlink():
            module.atomic_json(state / 'backups' / ('hfork-' + str(time.time_ns()) + '.json'), {'symlink': os.readlink(helper)})
        else:
            module.atomic_bytes(state / 'backups' / ('hfork-' + str(time.time_ns())), helper.read_bytes())
    module.atomic_bytes(helper, ('#!/bin/sh\nexec ' + shell(node) + ' ' + shell(link / 'tools/codex-fork-right.js') + ' "$@"\n').encode())
    if scheduler == 'systemd':
        systemd = home / '.config/systemd/user';systemd.mkdir(parents=True, exist_ok=True)
        service = '[Unit]\nDescription=Build, verify and distribute Swift Codex extensions\n\n[Service]\nType=oneshot\n'
        service += 'ExecStart=' + str(sys.executable) + ' ' + str(link / 'tools/manager.py') + ' update\n'
        service += 'Environment=PATH=' + str(home / '.cargo/bin') + ':' + str(bin_dir) + ':/usr/local/bin:/usr/bin:/bin\n'
        service += 'Nice=10\nIOSchedulingClass=idle\nCPUQuota=200%\nMemoryHigh=6G\nMemoryMax=10G\nTimeoutStartSec=6h\n'
        module.atomic_bytes(systemd / 'swift-codex-update.service', service.encode(), 0o644)
        module.atomic_bytes(systemd / 'swift-codex-update.timer', b'[Unit]\nDescription=Check Swift Codex runtime updates\n\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=2min\nUnit=swift-codex-update.service\n\n[Install]\nWantedBy=timers.target\n', 0o644)
        subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', '--user', 'enable', '--now', 'swift-codex-update.timer'], check=True)
        # Disable the obsolete trigger only after the replacement timer is enabled.
        subprocess.run(['systemctl', '--user', 'disable', '--now', 'codex-custom-update.timer'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif scheduler == 'process':
        (state / 'watch.disabled').unlink(missing_ok=True)
        with (state / 'scheduler.log').open('ab') as log:
            subprocess.Popen([sys.executable, link / 'tools/watch.py', state], stdin=subprocess.DEVNULL,
                             stdout=log, stderr=log, start_new_session=True)
    swift_source = None
    if (source / 'VERSION.json').is_file():
        metadata = json.loads((source / 'VERSION.json').read_text())
        swift_source = {key: metadata.get(key) for key in ['version', 'revision', 'treeSha256']}
    elif (source / '.git').exists():
        swift_source = {'version': json.loads((source / 'package.json').read_text())['version'],
                        'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()}
    result = {'state': 'ready', 'mode': mode, 'scheduler': scheduler, 'managerSha256': fingerprint, 'swiftSource': swift_source,
              'root': str(state), 'active': manager.status()['active'], 'preservedCredentials': True}
    module.atomic_json(state / 'installation.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--root', type=Path)
    parser.add_argument('--npm-package', type=Path, default=Path.home() / '.npm-global/lib/node_modules/@openai/codex/package.json')
    parser.add_argument('--node', type=Path, default=Path(shutil.which('node') or '/usr/bin/node'))
    parser.add_argument('--mode', choices=['builder', 'follower'], default='builder')
    parser.add_argument('--scheduler', choices=['systemd', 'process', 'none'], default='systemd')
    parser.add_argument('--auto', action='store_true')
    parser.add_argument('--legacy', type=Path)
    parser.add_argument('--provenance', type=Path)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args()
    existing = Path.home() / '.local/share/swift/codex'
    state = args.root or (existing.resolve() if existing.exists() else args.source / '.local/runtime/codex')
    if args.auto and (state / 'config.json').is_file():
        current = json.loads((state / 'config.json').read_text())
        args.mode = current.get('mode', args.mode)
        args.scheduler = current.get('scheduler', args.scheduler)
        args.node = Path(current.get('node', str(args.node)))
        args.npm_package = Path(current.get('npmPackage', str(args.npm_package)))
        os.environ['SWIFT_CODEX_RUSTC'] = current.get('rustc', 'rustc')
    print(json.dumps(install(args.source, state, args.npm_package, args.node, args.mode, args.scheduler,
        args.auto, args.legacy, args.provenance, args.archive, args.build), ensure_ascii=False))


if __name__ == '__main__':
    main()
