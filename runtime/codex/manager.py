#!/usr/bin/env python3
"""Swift-owned, immutable Codex runtime builds, verification and activation."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('SWIFT_CODEX_ROOT', str(Path.home() / '.local/share/swift/codex')))
VERSION = re.compile(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\Z')
ACCOUNT_SOURCE = 'codex-rs/tui/src/status/account.rs'


def read_json(path):
    return json.loads(Path(path).read_text())


def atomic_json(path, value):
    atomic_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode(), 0o600)


def atomic_bytes(path, data, mode=0o755):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        Path(name).unlink(missing_ok=True)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def operation_env(values=None):
    values = dict(os.environ if values is None else values)
    for key in list(values):
        if (key.startswith(('CODEX_', 'HERDR_', 'OPENAI_', 'ANTHROPIC_', 'SWIFT_', 'AGENT_STUDIO_'))
                or re.search(r'(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|SECRET)$', key, re.I)):
            values.pop(key, None)
    return values


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def tree_files(root):
    root = Path(root)
    files = {}
    for item in sorted(root.rglob('*')):
        if item.is_symlink() or (not item.is_file() and not item.is_dir()):
            raise ValueError('Runtime files must be regular files or directories')
        if item.is_file() and item.relative_to(root).as_posix() != 'runtime-manifest.json':
            files[item.relative_to(root).as_posix()] = {'sha256': digest(item), 'bytes': item.stat().st_size,
                                                      'mode': item.stat().st_mode & 0o777}
    return files


def copy_runtime(source, destination):
    source = Path(source).resolve()
    # Dereference only links wholly inside the npm runtime. No mutable external dependency survives.
    for item in source.rglob('*'):
        if item.is_symlink() and not item.resolve().is_relative_to(source):
            raise ValueError('Runtime symlink escapes its package')
    shutil.copytree(source, destination, symlinks=False)


def validate_release(release, extension=None, expected_digest=None):
    release = Path(release)
    manifest_file = release / 'runtime-manifest.json'
    if expected_digest and digest(manifest_file) != expected_digest:
        raise ValueError('Approved runtime manifest changed')
    meta = read_json(manifest_file)
    if meta.get('schema') != 1 or not VERSION.fullmatch(meta.get('version', '')):
        raise ValueError('Invalid runtime manifest')
    if meta.get('target') != 'x86_64-unknown-linux-gnu' or platform.machine() != 'x86_64':
        raise ValueError('Runtime platform does not match this machine')
    if extension and meta.get('extensionSha256') != extension:
        raise ValueError('Runtime extension recipe differs from installed Swift code')
    if tree_files(release) != meta.get('files'):
        raise ValueError('Runtime resource integrity check failed')
    for name in ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg', 'source-evidence/account.rs']:
        if not (release / name).is_file():
            raise ValueError('Runtime is missing a required resource: ' + name)
    if not os.access(release / 'bin/codex', os.X_OK):
        raise ValueError('Runtime executable is not executable')
    return meta


class Manager:
    def __init__(self, root=ROOT, tools=HERE):
        self.root = Path(root).resolve()
        self.tools = Path(tools).resolve()
        self.config = read_json(self.root / 'config.json')
        self.recipe = read_json(self.tools / 'recipe.json')
        self.extension = hashlib.sha256((self.tools / 'extensions.patch').read_bytes()
                                        + (self.tools / 'extensions-0.166.patch').read_bytes()
                                        + b'\0swift-release-profile-opt1-no-lto-v1').hexdigest()
        for name in ['builds', 'releases', 'cache', 'exports']:
            (self.root / name).mkdir(exist_ok=True)

    @contextlib.contextmanager
    def lock(self, wait=False):
        with (self.root / 'update.lock').open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
            yield

    def desired_version(self):
        value = read_json(self.config['npmPackage'])['version']
        if not isinstance(value, str) or not VERSION.fullmatch(value):
            raise ValueError('Invalid installed npm Codex version')
        return value

    def approved(self):
        p = self.root / 'approved.json'
        return read_json(p) if p.exists() else {}

    def release(self, name='current', extension=True):
        p = (self.root / name).resolve(strict=True)
        if p.parent != self.root / 'releases' or p.is_symlink():
            raise ValueError('Runtime pointer escapes the managed release directory')
        approved = self.approved().get(p.name)
        if not approved:
            raise ValueError('Runtime has not passed Swift verification')
        meta = validate_release(p, self.extension if extension else None, approved['manifestSha256'])
        return p, meta

    def current(self, version):
        try:
            return self.release()[1]['version'] == version
        except (FileNotFoundError, ValueError):
            return False

    def status(self):
        result = {'root': str(self.root), 'mode': self.config.get('mode', 'builder'), 'extensionSha256': self.extension}
        try:
            result['npmVersion'] = self.desired_version()
        except (OSError, ValueError, KeyError):
            result['npmVersion'] = None
        try:
            release, meta = self.release(extension=False)
            result['active'] = {'version': meta['version'], 'release': release.name,
                                'binarySha256': meta['files']['bin/codex']['sha256'], 'manifestSha256': digest(release / 'runtime-manifest.json'), 'integrity': True}
        except (OSError, ValueError, KeyError):
            result['active'] = None
        for name in ['status', 'policy', 'targets']:
            p = self.root / (name + '.json')
            result[name] = read_json(p) if p.exists() else {}
        return result

    def run(self, args, cwd=None, env=None, capture=False):
        print('+ ' + ' '.join(map(str, args)), flush=True)
        env = operation_env(env)
        return subprocess.check_output(list(map(str, args)), cwd=cwd, env=env, text=True) if capture else subprocess.run(
            list(map(str, args)), cwd=cwd, env=env, check=True, stdout=sys.stdout, stderr=subprocess.STDOUT)

    def vendor(self, package, version):
        package = Path(package).parent
        candidates = list((package / 'node_modules/@openai/codex-linux-x64/vendor').glob('*'))
        candidates += list((package.parent / 'codex-linux-x64/vendor').glob('*'))
        candidates += list((package / 'vendor').glob('*'))
        for p in candidates:
            if (p / 'codex-package.json').is_file() and read_json(p / 'codex-package.json').get('version') == version:
                return p
        raise ValueError('Matching official npm runtime resources are missing')

    def snapshot(self, version, work, package=None):
        package = Path(package or self.config['npmPackage'])
        vendor = self.vendor(package, version)
        before = tree_files(vendor)  # npm releases used here contain no external links.
        official = work / 'official'
        copy_runtime(vendor, official)
        if read_json(package).get('version') != version or tree_files(vendor) != before or tree_files(official) != before:
            raise ValueError('npm changed while copying runtime resources')
        return official

    def source(self, version, work):
        cache = self.root / 'cache/upstream.git'
        if not cache.exists():
            self.run(['git', 'init', '--bare', cache])
        tag = 'refs/tags/rust-v' + version
        self.run(['git', '--git-dir', cache, 'fetch', '--depth=1', self.recipe['upstream'], tag + ':' + tag])
        commit = self.run(['git', '--git-dir', cache, 'rev-parse', tag + '^{commit}'], capture=True).strip()
        if version == self.recipe['baseline']['version'] and commit != self.recipe['baseline']['upstreamCommit']:
            raise ValueError('Official baseline tag changed')
        source = work / 'source'
        self.run(['git', 'init', source])
        self.run(['git', 'fetch', '--depth=1', cache, tag], cwd=source)
        self.run(['git', 'checkout', '--detach', 'FETCH_HEAD'], cwd=source)
        patch = self.tools / ('extensions-0.166.patch' if tuple(map(int, version.split('-')[0].split('.'))) >= (0, 166, 0) else 'extensions.patch')
        self.run(['git', 'apply', '--check', patch], cwd=source)
        self.run(['git', 'apply', patch], cwd=source)
        self.run(['git', 'diff', '--check'], cwd=source)
        return source, {'upstreamCommit': commit, 'tag': 'rust-v' + version}

    def build(self, source, work):
        workspace = source / 'codex-rs'
        metadata = json.loads(self.run(['cargo', 'metadata', '--no-deps', '--format-version', '1'], cwd=workspace, capture=True))
        members = set(metadata['workspace_members'])
        names = sorted(p['name'] for p in metadata['packages'] if p['id'] in members)
        profile = work / 'build-profile.toml'
        profile.write_text(''.join('[profile.release.package.' + json.dumps(name) + ']\nopt-level=1\n\n'
                                   for name in names + ['starlark']))
        target = self.root / 'cache/target'
        env = {**os.environ, 'CARGO_TARGET_DIR': str(target), 'CARGO_PROFILE_RELEASE_DEBUG': '0',
               'CARGO_PROFILE_RELEASE_LTO': 'false', 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS': '16',
               'CARGO_PROFILE_RELEASE_STRIP': 'symbols', 'RUST_MIN_STACK': '16777216'}
        args = ['cargo', 'build', '--release', '-p', 'codex-cli', '--bin', 'codex', '-j', str(self.config.get('jobs', 2)), '--config', profile]
        self.run(args, cwd=workspace, env=env)
        self.run(args + ['--locked'], cwd=workspace, env=env)
        return target / 'release/codex'

    def verify(self, bundle, version, work, official, rust=True):
        binary = bundle / 'bin/codex'
        if self.run([binary, '--version'], capture=True).strip() != 'codex-cli ' + version:
            raise ValueError('Built Codex version is inconsistent')
        self.run([bundle / 'bin/codex-code-mode-host', '--help'])
        if rust:
            unit = work / 'account-tests.rs'
            unit.write_text((bundle / 'source-evidence/account.rs').read_text().replace('    use pretty_assertions::assert_eq;\n', ''))
            self.run([self.config.get('rustc', 'rustc'), '--edition=2024', '--test', unit, '-o', work / 'account-tests'])
            self.run([work / 'account-tests'])
        env = {**os.environ, 'NODE_PATH': self.config['nodeModules']}
        for name in ['check-status.cjs', 'check-hfork.cjs']:
            shutil.copy2(self.tools / name, work / name)
            self.run([self.config['node'], work / name, binary], env=env)
        self.run([self.config['node'], work / 'check-status.cjs', binary, '--official-server', official / 'bin/codex'], env=env)
        for name in ['display.json', 'remote-display.json']:
            report = read_json(work / name)
            if not report.get('passed') or report.get('modelRequests') != 0:
                raise ValueError('Native account verification failed')
        return {'accountRustTests': True, 'aliasCases': 5, 'officialServer': True, 'hfork': True, 'modelRequests': 0}

    def approve(self, bundle, version, source, verification, activate=True):
        for item in Path(bundle).rglob('*'):
            if item.is_file():
                item.chmod(0o755 if item.stat().st_mode & 0o111 else 0o644)
        manifest = {'schema': 1, 'version': version, 'target': self.recipe['target'], 'extensionSha256': self.extension,
                    'source': source, 'verification': verification, 'verifiedAt': stamp(), 'files': tree_files(bundle)}
        atomic_json(bundle / 'runtime-manifest.json', manifest)
        return self.admit(bundle, activate=activate)

    def admit(self, bundle, activate=True):
        meta = validate_release(bundle, self.extension)
        if not all(meta.get('verification', {}).get(name) for name in ['accountRustTests', 'officialServer', 'hfork']):
            raise ValueError('Runtime lacks required primary verification')
        identifier = meta['version'] + '-' + self.extension[:12] + '-' + str(time.time_ns())
        release = self.root / 'releases' / identifier
        os.rename(bundle, release)
        approved = self.approved()
        approved[identifier] = {'version': meta['version'], 'manifestSha256': digest(release / 'runtime-manifest.json'), 'at': stamp()}
        atomic_json(self.root / 'approved.json', approved)
        if activate:
            self.activate(release)
        return release

    def activate(self, release):
        approved = self.approved().get(release.name)
        validate_release(release, expected_digest=(approved or {})['manifestSha256'])
        current = self.root / 'current'
        if current.is_symlink():
            previous = current.resolve()
            if previous != release and previous.parent == self.root / 'releases':
                self.pointer('previous', previous)
        self.pointer('current', release)
        atomic_json(self.root / 'status.json', {'state': 'ready', 'activeVersion': read_json(release / 'runtime-manifest.json')['version'], 'at': stamp()})

    def pointer(self, name, target):
        temporary = self.root / ('.' + name + '-' + str(time.time_ns()))
        temporary.symlink_to(target)
        os.replace(temporary, self.root / name)

    def rollback(self, identifier=None):
        with self.lock():
            release, _ = self.release('previous' if identifier is None else 'releases/' + identifier, extension=False)
            self.activate(release)
            atomic_json(self.root / 'policy.json', {'hold': True, 'release': release.name, 'at': stamp()})

    def adopt(self, legacy, source):
        with self.lock():
            version = self.desired_version()
            baseline = self.recipe['baseline']
            old = read_json(Path(legacy) / 'custom-build.json')
            if version != baseline['version'] or old.get('binary_sha256') != baseline['binarySha256'] or digest(Path(legacy) / 'bin/codex') != baseline['binarySha256']:
                raise ValueError('Initial adoption requires the audited baseline binary')
            commit = self.run(['git', 'rev-parse', 'HEAD'], cwd=source, capture=True).strip()
            if commit != baseline['customCommit'] or self.run(['git', 'status', '--porcelain'], cwd=source, capture=True):
                raise ValueError('Initial source provenance does not match the audited baseline')
            patch = self.run(['git', 'diff', '--full-index', baseline['upstreamCommit'], commit, '--', '.', ':!codex-rs/Cargo.lock'], cwd=source, capture=True)
            if patch.encode() != (self.tools / 'extensions.patch').read_bytes():
                # git diff omits the final newline only through .strip(); compare exact output instead.
                raise ValueError('Initial extension patch differs from the audited source')
            work = Path(tempfile.mkdtemp(prefix=version + '-adopt-', dir=self.root / 'builds'))
            with (work / 'verification.log').open('w', buffering=1) as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                official = self.snapshot(version, work)
                bundle = work / 'bundle'
                copy_runtime(legacy, bundle)
                (bundle / 'custom-build.json').unlink(missing_ok=True)
                (bundle / 'source-evidence').mkdir(exist_ok=True)
                shutil.copy2(Path(source) / ACCOUNT_SOURCE, bundle / 'source-evidence/account.rs')
                check = self.verify(bundle, version, work, official)
                if self.desired_version() != version:
                    raise ValueError('npm changed during baseline adoption')
                return self.approve(bundle, version, {'upstreamCommit': baseline['upstreamCommit'], 'customCommit': commit}, check)

    def update(self, force=False, wait=False):
        try:
            with self.lock(wait=wait):
                policy = self.root / 'policy.json'
                if policy.exists() and read_json(policy).get('hold'):
                    return
                version = self.desired_version()
                is_current = self.current(version)
                if is_current:
                    state_file = self.root / 'status.json'
                    status = read_json(state_file) if state_file.exists() else {}
                    if status.get('state') == 'building':
                        atomic_json(state_file, {'state': 'ready', 'activeVersion': version, 'recoveredAfterPromotion': True, 'at': stamp()})
                if not is_current:
                    state = self.root / 'status.json'
                    previous = read_json(state) if state.exists() else {}
                    if previous.get('state') == 'building':
                        previous.update(state='failed', error='Interrupted previous build')
                        atomic_json(state, previous)
                    if (not force and previous.get('state') == 'failed' and previous.get('requestedVersion') == version
                            and previous.get('extensionSha256') == self.extension
                            and time.time() - previous.get('attemptEpoch', 0) < self.recipe['retrySeconds']):
                        return
                    if self.config.get('mode') == 'follower':
                        atomic_json(state, {'state': 'waiting_for_builder', 'requestedVersion': version, 'at': stamp()})
                        return
                    work = Path(tempfile.mkdtemp(prefix=version + '-', dir=self.root / 'builds'))
                    status = {'requestedVersion': version, 'extensionSha256': self.extension, 'attemptEpoch': time.time(), 'evidence': str(work)}
                    atomic_json(state, {'state': 'building', **status})
                    try:
                        with (work / 'update.log').open('w', buffering=1) as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                            official = self.snapshot(version, work)
                            source, provenance = self.source(version, work)
                            binary = self.build(source, work)
                            bundle = work / 'bundle'
                            copy_runtime(official, bundle)
                            shutil.copy2(binary, bundle / 'bin/codex')
                            (bundle / 'source-evidence').mkdir()
                            shutil.copy2(source / ACCOUNT_SOURCE, bundle / 'source-evidence/account.rs')
                            package = read_json(bundle / 'codex-package.json');package['target'] = self.recipe['target'];atomic_json(bundle / 'codex-package.json', package)
                            check = self.verify(bundle, version, work, official)
                            if self.desired_version() != version:
                                raise ValueError('npm changed during the build; refusing obsolete activation')
                            self.approve(bundle, version, provenance, check)
                    except Exception as error:
                        atomic_json(state, {'state': 'failed', 'error': str(error), **status})
                        raise
        except BlockingIOError:
            return

    def upgrade(self):
        """Explicit user update: npm and the shared runtime must both succeed."""
        policy = self.root / 'policy.json'
        if policy.exists() and read_json(policy).get('hold'):
            raise ValueError('Runtime updates are paused after rollback; run swift-codex resume-updates first')
        if self.config.get('mode') == 'follower':
            raise ValueError('This runtime is a follower; update its builder and install the verified archive')
        package = Path(self.config['npmPackage'])
        if package.parts[-5:] != ('lib', 'node_modules', '@openai', 'codex', 'package.json'):
            raise ValueError('Managed Codex package is not a global npm installation')
        prefix = package.parents[4]
        self.run(['npm', 'install', '--global', '--prefix', prefix, '@openai/codex@latest'])
        print('Building and verifying the shared Codex runtime; this may take several minutes.', flush=True)
        self.update(force=True, wait=True)
        version = self.desired_version()
        if not self.current(version):
            raise ValueError('Shared runtime was not activated; run swift-codex status for details')
        print('Shared Codex runtime ' + version + ' is ready for all new tabs.', flush=True)

    def cached(self, version):
        for identifier, approval in reversed(list(self.approved().items())):
            release = self.root / 'releases' / identifier
            try:
                if approval.get('version', read_json(release / 'runtime-manifest.json')['version']) != version:
                    continue
                meta = validate_release(release, self.extension, approval['manifestSha256'])
                if meta['version'] == version:
                    return release
            except (OSError, ValueError):
                continue
        return None

    def fetch_package(self, version, work):
        if not VERSION.fullmatch(version):
            raise ValueError('Invalid requested npm version')
        package = work / 'npm-package'
        package.mkdir()
        def unpack(spec, destination):
            env = {**os.environ, 'npm_config_loglevel': 'silent'}
            report = json.loads(self.run(['npm', 'pack', '--ignore-scripts', '--json', '--registry=https://registry.npmjs.org',
                                          '--pack-destination', package, spec], env=env, capture=True))
            archive = package / report[0]['filename']
            with tarfile.open(archive) as tar:
                for item in tar.getmembers():
                    name = Path(item.name)
                    if not name.parts or name.parts[0] != 'package' or '..' in name.parts or name.is_absolute() or not (item.isdir() or item.isfile()):
                        raise ValueError('Unsafe npm runtime archive')
                temporary = Path(tempfile.mkdtemp(prefix='npm-', dir=work))
                tar.extractall(temporary, filter='data')
                shutil.move(temporary / 'package', destination)
            return read_json(destination / 'package.json')
        root = package / 'codex'
        metadata = unpack('@openai/codex@' + version, root)
        if metadata['version'] != version:
            raise ValueError('Downloaded npm version differs from requested version')
        spec = metadata.get('optionalDependencies', {}).get('@openai/codex-linux-x64', '')
        if spec != 'npm:@openai/codex@' + version + '-linux-x64':
            raise ValueError('Unsupported official npm platform dependency; keeping verified runtime')
        platform_dir = root / 'node_modules/@openai/codex-linux-x64'
        platform_dir.parent.mkdir(parents=True)
        unpack(spec.removeprefix('npm:'), platform_dir)
        self.vendor(root / 'package.json', version)
        return root / 'package.json'

    def ensure_release(self, version, force=False):
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise ValueError('Invalid requested Codex version')
        with self.lock():
            cached = self.cached(version)
            if cached:
                return cached
            work = Path(tempfile.mkdtemp(prefix=version + '-target-', dir=self.root / 'builds'))
            receipt = self.root / 'builds' / (version + '-' + self.extension[:12] + '.json')
            previous = read_json(receipt) if receipt.exists() else {}
            if not force and previous.get('state') == 'failed' and time.time() - previous.get('attemptEpoch', 0) < self.recipe['retrySeconds']:
                raise ValueError('Target build retry is deferred after a recorded failure')
            status = {'version': version, 'attemptEpoch': time.time(), 'evidence': str(work)}
            atomic_json(receipt, {'state': 'building', **status})
            try:
                with (work / 'update.log').open('w', buffering=1) as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                    package = self.config['npmPackage'] if self.desired_version() == version else self.fetch_package(version, work)
                    official = self.snapshot(version, work, package)
                    source, provenance = self.source(version, work)
                    binary = self.build(source, work)
                    bundle = work / 'bundle';copy_runtime(official, bundle)
                    shutil.copy2(binary, bundle / 'bin/codex')
                    (bundle / 'source-evidence').mkdir();shutil.copy2(source / ACCOUNT_SOURCE, bundle / 'source-evidence/account.rs')
                    metadata = read_json(bundle / 'codex-package.json');metadata['target'] = self.recipe['target'];atomic_json(bundle / 'codex-package.json', metadata)
                    check = self.verify(bundle, version, work, official)
                    release = self.approve(bundle, version, provenance, check, activate=False)
                atomic_json(receipt, {'state': 'ready', 'release': release.name, **status})
                return release
            except Exception as error:
                atomic_json(receipt, {'state': 'failed', 'error': str(error), **status})
                raise

    def export(self, output, release=None):
        selected, _ = self.release('current' if release is None else 'releases/' + release, extension=False)
        with tarfile.open(output, 'w:gz') as archive:
            archive.add(selected, arcname='runtime')
        return digest(output)

    def import_package(self, archive):
        with self.lock():
            policy = self.root / 'policy.json'
            if policy.exists() and read_json(policy).get('hold'):
                raise ValueError('Runtime is held after rollback; resume updates before importing')
            work = Path(tempfile.mkdtemp(prefix='import-', dir=self.root / 'builds'))
            with tarfile.open(archive) as tar:
                members = tar.getmembers()
                if len(members) > 20000 or sum(item.size for item in members) > 4 * 1024 ** 3:
                    raise ValueError('Runtime archive exceeds its size limit')
                for item in members:
                    name = Path(item.name)
                    if not name.parts or name.parts[0] != 'runtime' or '..' in name.parts or name.is_absolute() or not (item.isfile() or item.isdir()):
                        raise ValueError('Unsafe runtime archive member')
                tar.extractall(work, filter='data')
            bundle = work / 'runtime'
            meta = validate_release(bundle, self.extension)
            version = self.desired_version()
            if meta['version'] != version:
                raise ValueError('Imported runtime does not match this host npm version')
            official = self.snapshot(version, work)
            with (work / 'verification.log').open('w', buffering=1) as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                self.verify(bundle, version, work, official, rust=False)
            return self.admit(bundle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['status', 'update', 'upgrade', 'rollback', 'resume-updates', 'export', 'import', 'adopt'])
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--release')
    parser.add_argument('--legacy', type=Path)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    manager = Manager(args.root)
    if args.command == 'status':
        print(json.dumps(manager.status(), ensure_ascii=False, indent=2))
    elif args.command == 'update':
        manager.update(force=args.force)
    elif args.command == 'upgrade':
        manager.upgrade()
    elif args.command == 'rollback':
        manager.rollback(args.release)
    elif args.command == 'resume-updates':
        atomic_json(manager.root / 'policy.json', {'hold': False, 'at': stamp()});manager.update(force=True)
    elif args.command == 'export':
        print(json.dumps({'sha256': manager.export(args.archive, args.release), 'archive': str(args.archive)}))
    elif args.command == 'import':
        print(json.dumps({'release': str(manager.import_package(args.archive))}))
    elif args.command == 'adopt':
        print(json.dumps({'release': str(manager.adopt(args.legacy, args.source))}))


if __name__ == '__main__':
    main()
