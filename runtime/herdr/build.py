#!/usr/bin/env python3
"""Prepare a pinned, reviewable Herdr extension and build it without installing."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
SWIFT = ROOT.parent.parent


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, help='Optional local Git cache containing the pinned upstream commit')
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--target', help='Rust target, e.g. x86_64-unknown-linux-musl for portable Linux releases')
    parser.add_argument('--zig', action='store_true', help='Use cargo-zigbuild for cross compilation')
    args = parser.parse_args()
    if args.zig and not args.target:
        parser.error('--zig requires --target')
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    manifest = json.loads((ROOT / 'source.json').read_text())
    patch = ROOT / manifest['patch']
    digest = hashlib.sha256(patch.read_bytes()).hexdigest()
    if digest != manifest['patch_sha256']:
        raise RuntimeError('Runtime patch differs from the source manifest')
    build_root = SWIFT / 'artifacts' / 'runtime' / 'herdr' / digest[:16]
    if args.target and (not args.target.replace('-', '').replace('_', '').isalnum() or '/' in args.target):
        parser.error('Invalid Rust target')
    output = build_root / args.target if args.target else build_root
    output.mkdir(parents=True, exist_ok=True)
    source = build_root / 'source'
    if not source.exists():
        output.mkdir(parents=True, exist_ok=True)
        cache = args.source.resolve() if args.source else None
        if cache is not None and (cache / '.git').exists() and subprocess.run(
            ['git', '-C', str(cache), 'cat-file', '-e', manifest['base'] + '^{commit}'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode == 0:
            run('git', 'clone', '--no-hardlinks', '--no-checkout', str(cache), str(source))
            run('git', 'remote', 'set-url', 'origin', manifest['upstream'], cwd=source)
        else:
            run('git', 'clone', '--depth', '1', '--branch', manifest['tag'], manifest['upstream'], str(source))
        run('git', 'checkout', '--detach', manifest['base'], cwd=source)
        run('git', 'apply', '--check', str(patch), cwd=source)
        run('git', 'apply', str(patch), cwd=source)
        run('git', 'add', '--intent-to-add', '.', cwd=source)
    if run('git', 'rev-parse', 'HEAD', cwd=source) != manifest['base']:
        raise RuntimeError('Prepared checkout has an unexpected base revision')
    actual = subprocess.check_output(['git', 'diff', '--binary', manifest['base']], cwd=source)
    if hashlib.sha256(actual).hexdigest() != digest:
        raise RuntimeError('Prepared checkout differs from the reviewed patch')
    result = {**manifest, 'source': str(source), 'target': args.target, 'linker': 'zig' if args.zig else 'native', 'prepared': True, 'built': False, 'installed': False}
    if not args.prepare_only:
        if hasattr(os, 'sched_setaffinity'):
            os.sched_setaffinity(0, set(sorted(os.sched_getaffinity(0))[:args.jobs]))
        target = build_root.parent / 'target'
        target_args = ['--target', args.target] if args.target else []
        with (output / 'build.log').open('w') as log:
            subprocess.run(['cargo', 'zigbuild' if args.zig else 'build', '--release', '--locked', '--target-dir', str(target), '-j', str(args.jobs), *target_args],
                           cwd=source, stdout=log, stderr=subprocess.STDOUT, check=True)
        binary_root = target / args.target if args.target else target
        binary = binary_root / 'release' / ('herdr.exe' if os.name == 'nt' else 'herdr')
        destination = output / binary.name
        shutil.copy2(binary, destination)
        shutil.copy2(source / 'LICENSE', output / 'LICENSE')
        licenses = output / 'licenses'
        licenses.mkdir(exist_ok=True)
        for relative, name in [('vendor/libghostty-vt/LICENSE', 'libghostty-vt-LICENSE'),
                               ('vendor/portable-pty/LICENSE.md', 'portable-pty-LICENSE.md')]:
            shutil.copy2(source / relative, licenses / name)
        result.update(built=True, binary=str(destination),
                      binary_sha256=hashlib.sha256(destination.read_bytes()).hexdigest())
    (output / 'build.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
