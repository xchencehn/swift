#!/usr/bin/env python3
"""Stage a verified runtime and optionally migrate Swift's existing Herdr session."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('swift_herdr_migration', ROOT / 'runtime/herdr/migrate.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
MARKER = '# Managed by Swift Herdr runtime installer.\n'


def atomic_text(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def stage(build_path, prefix):
    build = json.loads(build_path.read_text())
    target = {'x86_64': 'x86_64-unknown-linux-musl', 'aarch64': 'aarch64-unknown-linux-musl'}.get(platform.machine())
    if platform.system() != 'Linux' or build.get('target') != target or not target:
        raise RuntimeError('Install requires the portable Linux build for this architecture')
    if not build.get('built') or build.get('handoff_identity_version') != 1:
        raise RuntimeError('Build receipt lacks verified identity support')
    binary = Path(build['binary'])
    if not binary.is_absolute():
        binary = build_path.parent / binary
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if digest != build['binary_sha256']:
        raise RuntimeError('Binary checksum does not match its build receipt')
    release = prefix / 'releases' / digest
    release.parent.mkdir(parents=True, exist_ok=True)
    if not release.exists():
        with tempfile.TemporaryDirectory(prefix='.stage-', dir=release.parent) as directory:
            prepared = Path(directory) / 'release'
            prepared.mkdir()
            shutil.copy2(binary, prepared / 'herdr')
            (prepared / 'herdr').chmod(0o755)
            shutil.copy2(build_path.parent / 'LICENSE', prepared / 'LICENSE')
            shutil.copytree(build_path.parent / 'licenses', prepared / 'licenses')
            public_build = {key: value for key, value in build.items() if key not in ('source', 'binary')}
            public_build.update(binary='herdr', installed=False)
            (prepared / 'build.json').write_text(json.dumps(public_build, indent=2) + '\n')
            os.rename(prepared, release)
    if hashlib.sha256((release / 'herdr').read_bytes()).hexdigest() != digest:
        raise RuntimeError('Existing managed runtime has unexpected contents')
    return release


def install(build_path, prefix, socket_path, apply=False, services=True):
    prefix = prefix.absolute()
    current = prefix / 'current'
    if current.exists() and not current.is_symlink():
        raise RuntimeError('Managed current path is not a symlink')
    previous = os.readlink(current) if current.is_symlink() else None
    environment = prefix / 'runtime.env'
    unit_root = Path.home() / '.config/systemd/user'
    units = [unit_root / (name + '.d') / '30-swift-herdr.conf' for name in ('swift.service', 'swift-runtime.service')]
    for path in ([environment, *units] if services else []):
        if path.exists() and not path.read_text().startswith(MARKER):
            raise RuntimeError('Existing configuration is not owned by this installer: ' + str(path))
    release = stage(build_path, prefix)
    receipt = prefix / 'receipts' / (str(time.time_ns()) + '.json')
    result = migration.migrate(socket_path, release / 'herdr', receipt, apply=apply)
    result.update(staged=str(release), previous=previous, installed=False)
    if apply:
        temporary = prefix / ('.current-' + str(os.getpid()))
        temporary.symlink_to(release.relative_to(prefix), target_is_directory=True)
        os.replace(temporary, current)
        if services:
            def quote(value):
                value = str(value)
                if any(character in value for character in '\n\r\x00'):
                    raise ValueError('Invalid service path')
                return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
            atomic_text(environment, MARKER + 'HERDR_BIN=' + quote(current / 'herdr') + '\n')
            for unit in units:
                managed = prefix / 'systemd' / unit.parent.name / unit.name
                atomic_text(managed, MARKER + '[Service]\nEnvironmentFile=' + str(environment).replace('%', '%%') + '\n')
                unit.parent.mkdir(parents=True, exist_ok=True)
                link = unit.with_name('.' + unit.name + '-' + str(os.getpid()))
                link.symlink_to(managed)
                os.replace(link, unit)
            subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
            for service in ('swift.service', 'swift-runtime.service'):
                loaded = subprocess.check_output(['systemctl', '--user', 'show', service,
                    '-p', 'EnvironmentFiles', '--value'], text=True)
                if str(environment) not in loaded:
                    raise RuntimeError('systemd did not load the managed runtime environment for ' + service)
            active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'swift.service']).returncode == 0
            if active:
                subprocess.run(['systemctl', '--user', 'restart', 'swift.service'], check=True)
            result['swift_restarted'] = active
        result['installed'] = True
    atomic_text(receipt, json.dumps(result, indent=2) + '\n')
    return {key: result[key] for key in ('version', 'sha256', 'applied', 'installed', 'staged')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', required=True, type=Path)
    parser.add_argument('--socket', required=True, type=Path)
    parser.add_argument('--prefix', type=Path, default=Path.home() / '.local/share/swift/herdr')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--no-service', action='store_true', help='Migrate only; leave service configuration unchanged')
    args = parser.parse_args()
    print(json.dumps(install(args.build, args.prefix, args.socket, args.apply, not args.no_service)))


if __name__ == '__main__':
    main()
