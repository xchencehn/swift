#!/usr/bin/env python3
"""Populate the Zig package cache for the Herdr runtime build.

Herdr vendors libghostty-vt, which is built by Zig. Zig's own downloader does
not use the HTTP proxy exported in this environment, so every dependency fetch
fails with "bad HTTP response code: '400 Bad Request'". curl and git do work
through the proxy, so this script resolves the dependency closure itself and
hands each package to `zig fetch`, which stores it under the expected hash.

Run it once before building, and again after syncing upstream when the vendored
dependency set changes.

Zig 0.16 (required from Herdr v0.9.1) no longer builds from the global cache: each
project reads its dependencies from a project-local `zig-pkg/<hash>/` directory
and fetches whatever is missing there. So after filling the cache this script also
copies the dependency closure of every vendored project into its `zig-pkg/`
(already git-ignored upstream). Copies, not symlinks: Zig resolves paths such as
`../../.zig-cache` relative to the package directory, which a symlink breaks.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ENTRY = re.compile(r'\.url\s*=\s*"([^"]+)"\s*,\s*\.hash\s*=\s*"([^"]+)"', re.S)


def cache_root():
    out = subprocess.run(['zig', 'env'], capture_output=True, text=True, check=True).stdout
    match = re.search(r'\.global_cache_dir\s*=\s*"([^"]+)"', out) or re.search(r'"global_cache_dir"\s*:\s*"([^"]+)"', out)
    if not match:
        raise SystemExit('无法从 zig env 读取全局缓存目录。')
    return Path(match.group(1).replace('\\\\', '/')) / 'p'


def manifests(roots):
    for root in roots:
        if root.is_dir():
            yield from sorted(root.rglob('build.zig.zon'))


def declared(roots):
    """Return {hash: url} for every dependency declared under roots."""
    found = {}
    for path in manifests(roots):
        try:
            text = path.read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        for url, digest in ENTRY.findall(text):
            found.setdefault(digest, url)
    return found


def fetch_tarball(url, workdir):
    target = workdir / url.rsplit('/', 1)[-1]
    subprocess.run(['curl', '-sfL', '--max-time', '900', '-o', str(target), url], check=True)
    return target


def fetch_git(url, workdir):
    remote, _, commit = url[len('git+'):].partition('#')
    checkout = workdir / 'repo'
    subprocess.run(['git', 'init', '--quiet', str(checkout)], check=True)
    subprocess.run(['git', '-C', str(checkout), 'remote', 'add', 'origin', remote], check=True)
    ref = commit or 'HEAD'
    subprocess.run(['git', '-C', str(checkout), 'fetch', '--quiet', '--depth', '1', 'origin', ref], check=True)
    subprocess.run(['git', '-C', str(checkout), 'checkout', '--quiet', 'FETCH_HEAD'], check=True)
    shutil.rmtree(checkout / '.git')
    return checkout


def zig_version():
    out = subprocess.run(['zig', 'version'], capture_output=True, text=True, check=True).stdout.strip()
    return tuple(int(part) for part in re.findall(r'\d+', out)[:2])


def hashes_in(manifest):
    try:
        text = manifest.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return set()
    return {digest for _, digest in ENTRY.findall(text)}


def populate_pkg_dir(project, cache):
    """Copy the transitive dependencies of one Zig project from the cache into its zig-pkg/."""
    target = project / 'zig-pkg'
    target.mkdir(exist_ok=True)
    # 起点是项目里所有的 build.zig.zon：本地子包（`.path = "pkg/zlib"` 这类）有自己的依赖，
    # 而且它们同样从这个项目的 zig-pkg/ 里取。
    pending, seen, copied = set(), set(), 0
    for manifest in project.rglob('build.zig.zon'):
        if not {'zig-pkg', '.zig-cache', 'zig-out'} & set(manifest.relative_to(project).parts):
            pending |= hashes_in(manifest)
    while pending:
        digest = pending.pop()
        if digest in seen:
            continue
        seen.add(digest)
        source, dest = cache / digest, target / digest
        if not source.is_dir():
            continue
        if not dest.exists():
            shutil.copytree(source, dest, symlinks=True)
            copied += 1
        pending |= hashes_in(dest / 'build.zig.zon')
    return copied


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--runtime', default=os.path.expanduser('~/workdir/herdr'),
                        help='Herdr 源码仓位置，默认 ~/workdir/herdr')
    parser.add_argument('--passes', type=int, default=8, help='解析传递依赖的最大轮数')
    args = parser.parse_args()

    runtime = Path(args.runtime).expanduser()
    if not (runtime / 'Cargo.toml').is_file():
        raise SystemExit(f'{runtime} 不是 Herdr 源码仓。')
    cache = cache_root()
    cache.mkdir(parents=True, exist_ok=True)

    added = failed = 0
    for _ in range(args.passes):
        pending = {h: u for h, u in declared([runtime / 'vendor', cache]).items() if not (cache / h).exists()}
        if not pending:
            break
        for digest, url in sorted(pending.items()):
            with tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp)
                try:
                    source = fetch_git(url, work) if url.startswith('git+') else fetch_tarball(url, work)
                    got = subprocess.run(['zig', 'fetch', str(source)], capture_output=True, text=True, check=True).stdout.strip()
                except subprocess.CalledProcessError as error:
                    detail = (error.stderr or '').strip().splitlines()[-1:] or ['']
                    print(f'失败 {digest}: {detail[0]}', file=sys.stderr)
                    failed += 1
                    continue
            if got != digest:
                print(f'哈希不符 {url}\n  声明 {digest}\n  实得 {got}', file=sys.stderr)
                failed += 1
                continue
            print(f'已缓存 {digest}')
            added += 1

    if zig_version() >= (0, 16):
        for project in sorted(path.parent for path in (runtime / 'vendor').glob('*/build.zig.zon')):
            copied = populate_pkg_dir(project, cache)
            print(f'{project.name}/zig-pkg：补齐 {copied} 个包')

    remaining = [h for h in declared([runtime / 'vendor', cache]) if not (cache / h).exists()]
    print(f'新增 {added} 个，失败 {failed} 个，仍缺 {len(remaining)} 个。')
    return 1 if remaining else 0


if __name__ == '__main__':
    sys.exit(main())
