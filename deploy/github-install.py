#!/usr/bin/env python3
"""Install a verified GitHub server release without replacing native sessions."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith('https://'):
            raise ValueError('GitHub release downloads must remain on HTTPS.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, target, maximum):
    request = urllib.request.Request(url, headers={'User-Agent': 'Swift-release-installer'})
    with urllib.request.build_opener(HttpsRedirect()).open(request, timeout=30) as response:
        size = 0
        with target.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise ValueError('Release download exceeds its size limit.')
                output.write(chunk)


def verify_archive(archive, manifest):
    version = manifest.get('version', '')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid release version.')
    if manifest.get('filename') != f'swift-{version}-server.tar.gz':
        raise ValueError('Unexpected release archive name.')
    if not re.fullmatch(r'[a-f0-9]{64}', manifest.get('sha256', '')):
        raise ValueError('Missing release SHA-256.')
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['sha256']:
        raise ValueError('Release SHA-256 mismatch; installation was not changed.')
    if archive.stat().st_size != manifest.get('bytes'):
        raise ValueError('Release size mismatch.')
    prefix = f'swift-{version}'
    with tarfile.open(archive, 'r:gz') as package:
        for member in package.getmembers():
            parts = Path(member.name).parts
            if (not parts or parts[0] != prefix or '..' in parts or
                    not (member.isfile() or member.isdir()) or
                    any(p in {'.git', '.local', 'node_modules'} for p in parts)):
                raise ValueError('Unsafe release archive member.')
        required = {f'{prefix}/deploy/install.sh', f'{prefix}/package.json', f'{prefix}/VERSION.json'}
        if not required.issubset({m.name for m in package.getmembers()}):
            raise ValueError('Release archive is incomplete.')


def prepare_release(directory, manifest, archive):
    verify_archive(archive, manifest)
    version = manifest['version']
    destination = directory / 'releases' / version
    if destination.exists():
        receipt = destination / 'GITHUB_RELEASE.json'
        if not receipt.is_file() or json.loads(receipt.read_text())['sha256'] != manifest['sha256']:
            raise ValueError('An existing release directory has different contents.')
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.download-', dir=destination.parent) as temporary:
        with tarfile.open(archive, 'r:gz') as package:
            package.extractall(temporary)
        extracted = Path(temporary) / f'swift-{version}'
        package = json.loads((extracted / 'package.json').read_text())
        metadata = json.loads((extracted / 'VERSION.json').read_text())
        if package['version'] != version or metadata['version'] != version:
            raise ValueError('Archive version differs from the release manifest.')
        if metadata.get('dirty') or metadata.get('revision') != manifest.get('revision'):
            raise ValueError('Archive revision differs from the release manifest.')
        (extracted / 'GITHUB_RELEASE.json').write_text(json.dumps(manifest, indent=2) + '\n')
        extracted.rename(destination)
    return destination


def run(*args, check=True):
    return subprocess.run(args, check=check)


def activate(directory, release, previous, root, herdr, start, health_url):
    if previous and previous != release:
        before = tuple(map(int, json.loads((previous / 'package.json').read_text())['version'].split('.')))
        after = tuple(map(int, json.loads((release / 'package.json').read_text())['version'].split('.')))
        if after < before:
            raise ValueError('Refusing to downgrade the installed server.')
    state = directory / 'state'
    if not state.exists():
        if previous and (previous / '.local').exists():
            state.symlink_to((previous / '.local').resolve(), target_is_directory=True)
        else:
            state.mkdir(mode=0o700)
    local = release / '.local'
    if not local.exists():
        local.symlink_to(state.resolve(), target_is_directory=True)
    if local.resolve() != state.resolve():
        raise ValueError('Release state directory does not match this installation.')
    # Preserve service definitions and the CLI link for rollback. These files contain no tokens.
    links = [Path.home() / '.config/systemd/user/swift.service']
    links.append(Path.home() / '.local/bin/swift')
    saved = []
    for link in links:
        if link.exists() and not link.is_symlink():
            raise ValueError('Existing service or CLI is not a managed symlink.')
        target = link.resolve() if link.is_symlink() else None
        data = target.read_bytes() if target and target.is_file() and link.suffix == '.service' else None
        saved.append((link, os.readlink(link) if link.is_symlink() else None, target, data))
    current = directory / 'current'
    if current.exists() and not current.is_symlink():
        raise ValueError('The installation current path must be a symlink.')
    old_current = os.readlink(current) if current.is_symlink() else None
    # Keep this override when rolling back to an older template as well.
    override = Path.home() / '.config/systemd/user/swift.service.d/90-swift-native-lifetime.conf'
    override_text = '[Service]\nKillMode=process\n'
    if override.exists() and override.read_text() != override_text:
        raise ValueError('The native lifetime service override has local changes; preserve them before upgrading.')
    override.parent.mkdir(parents=True, exist_ok=True)
    override.write_text(override_text)
    was_active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'swift.service'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    service_changed = False
    try:
        command = ['bash', str(release / 'deploy/install.sh'), '--root', str(root), '--herdr', str(herdr),
                   '--no-start', '--skip-runtime']
        if previous and previous != release:
            command += ['--previous-source', str(previous)]
        run(*command)
        expected_frontend = None
        if start and health_url:
            expected_frontend = subprocess.check_output([
                'node', '-e',
                'const p=require("node:path"); const root=process.argv[1]; '
                'process.stdout.write(require(p.join(root,"lib/frontend-assets"))'
                '.createFrontendAssets(p.join(root,"public")).version());', str(release)
            ], text=True).strip()
        replacement = directory / '.current-next'
        if replacement.is_symlink():
            replacement.unlink()
        replacement.symlink_to(release, target_is_directory=True)
        replacement.replace(current)
        if start:
            kill_mode = subprocess.check_output([
                'systemctl', '--user', 'show', 'swift.service', '-p', 'KillMode', '--value'
            ], text=True).strip()
            if kill_mode != 'process':
                raise ValueError('The effective Swift KillMode must preserve native terminal processes.')
            service_changed = True
            run('systemctl', '--user', 'restart', 'swift.service')
            if health_url:
                import time
                for attempt in range(30):
                    try:
                        with urllib.request.urlopen(health_url, timeout=2) as response:
                            version = json.load(response)['version']
                        if version != expected_frontend:
                            raise ValueError('Running frontend does not match the installed release.')
                        break
                    except Exception:
                        if attempt == 29:
                            raise
                        time.sleep(1)
    except BaseException:
        for link, text, target, data in saved:
            if data is not None:
                target.write_bytes(data)
            if link.is_symlink():
                link.unlink()
            if text is not None:
                link.symlink_to(text)
        if current.is_symlink():
            current.unlink()
        if old_current is not None:
            current.symlink_to(old_current, target_is_directory=True)
        run('systemctl', '--user', 'daemon-reload', check=False)
        if service_changed:
            run('systemctl', '--user', 'restart' if was_active else 'stop', 'swift.service', check=False)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default='xchencehn/swift')
    parser.add_argument('--version', default='latest')
    parser.add_argument('--directory', type=Path, default=Path.home() / '.local/share/swift/server')
    parser.add_argument('--previous-source', type=Path)
    parser.add_argument('--root', type=Path, default=Path.home() / 'workdir')
    parser.add_argument('--herdr', type=Path, default=Path.home() / '.local/bin/herdr')
    parser.add_argument('--assets', type=Path, help='Use already downloaded release assets after verification.')
    parser.add_argument('--download-only', action='store_true')
    parser.add_argument('--start', action='store_true')
    parser.add_argument('--health-url', help='Local frontend-version.json URL to verify after restart.')
    args = parser.parse_args()
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repository):
        parser.error('Invalid GitHub repository.')
    if args.version != 'latest' and not re.fullmatch(r'\d+\.\d+\.\d+', args.version):
        parser.error('Use a stable version number or latest.')
    directory = args.directory.expanduser().resolve()
    if (directory / '.git').exists():
        parser.error('Use a separate installation directory; do not overwrite a development repository.')
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.install.lock').open('a') as lock:
        import fcntl
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another GitHub installation is using this directory.') from None
        with tempfile.TemporaryDirectory(prefix='swift-github-download-') as temporary:
            temporary = Path(temporary)
            latest = temporary / 'server-latest.json'
            base = f'https://github.com/{args.repository}/releases/'
            if args.assets:
                shutil.copyfile(args.assets / latest.name, latest)
            else:
                suffix = 'latest/download/' if args.version == 'latest' else f'download/v{args.version}/'
                download(base + suffix + latest.name, latest, 65536)
            manifest = json.loads(latest.read_text())
            version = manifest.get('version', '')
            if not re.fullmatch(r'\d+\.\d+\.\d+', version):
                raise ValueError('Invalid release version.')
            if args.version != 'latest' and version != args.version:
                raise ValueError('Downloaded release does not match the requested version.')
            archive = temporary / f'swift-{version}-server.tar.gz'
            if args.assets:
                shutil.copyfile(args.assets / archive.name, archive)
            else:
                download(base + f'download/v{version}/' + archive.name, archive, 512 * 1024 * 1024)
            release = prepare_release(directory, manifest, archive)
        if not args.download_only:
            previous = args.previous_source.expanduser().resolve() if args.previous_source else None
            if previous is None and (directory / 'current').is_symlink():
                previous = (directory / 'current').resolve()
            activate(directory, release, previous, args.root.expanduser().resolve(),
                     args.herdr.expanduser().resolve(), args.start, args.health_url)
        print(json.dumps({'version': version, 'directory': str(release), 'sha256': manifest['sha256'],
                          'installed': not args.download_only, 'started': args.start and not args.download_only,
                          'nativeRuntimeRestarted': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error)) from None
