'use strict';
const test = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('GitHub installer rejects corrupt archives and unsafe members before changing the installation', () => {
  execFileSync(
    'python3',
    [
      '-c',
      `
import hashlib, importlib.util, io, json, pathlib, sys, tarfile, tempfile
spec = importlib.util.spec_from_file_location('github_install', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='swift-install-security-') as temporary:
    root = pathlib.Path(temporary); archive = root/'release.tar.gz'
    def create(extra=None):
        with tarfile.open(archive, 'w:gz') as package:
            files = {'swift-1.2.3/package.json': b'{"version":"1.2.3"}',
                     'swift-1.2.3/VERSION.json': b'{"version":"1.2.3","revision":"fixture","dirty":false}',
                     'swift-1.2.3/deploy/install.sh': b'#!/bin/sh\\nexit 0\\n'}
            for name, data in files.items():
                info = tarfile.TarInfo(name); info.size = len(data); package.addfile(info, io.BytesIO(data))
            if extra:
                info = tarfile.TarInfo(extra); info.size = 1; package.addfile(info, io.BytesIO(b'x'))
        return {'version':'1.2.3','filename':'swift-1.2.3-server.tar.gz','revision':'fixture',
                'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'bytes':archive.stat().st_size}
    good = create(); module.verify_archive(archive, good)
    installed = module.prepare_release(root/'installed', good, archive)
    assert (installed/'deploy/install.sh').is_file()
    for name in ['swift-1.2.3/../../escaped', '/absolute', 'swift-1.2.3/.local/private']:
        manifest = create(name)
        try: module.prepare_release(root/'unsafe', manifest, archive)
        except ValueError: pass
        else: raise AssertionError('Unsafe archive accepted')
        assert not (root/'unsafe').exists()
    good = create(); archive.write_bytes(archive.read_bytes()+b'corrupt')
    try: module.prepare_release(root/'corrupt', good, archive)
    except ValueError as error: assert 'SHA-256' in str(error)
    else: raise AssertionError('Corrupt archive accepted')
    assert not (root/'corrupt').exists()
`,
      path.resolve(__dirname, '../deploy/github-install.py'),
    ],
    { stdio: 'pipe' },
  );
});

test('a failed upgrade restores the prior service, launcher and current release', () => {
  execFileSync(
    'python3',
    [
      '-c',
      `
import importlib.util, json, os, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('github_install', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='swift-upgrade-rollback-') as temporary:
    root = pathlib.Path(temporary); home = root/'home'; home.mkdir(); os.environ['HOME'] = str(home)
    previous = root/'previous'; release = root/'release'; install = root/'installation'
    for directory, version in [(previous,'1.2.2'),(release,'1.2.3')]:
        (directory/'deploy').mkdir(parents=True)
        (directory/'package.json').write_text(json.dumps({'version':version}))
        (directory/'deploy/swift.sh').write_text('#!/bin/sh\\n')
    unitdir = previous/'.local/config/systemd'; unitdir.mkdir(parents=True)
    links = home/'.config/systemd/user'; links.mkdir(parents=True)
    for name in ['swift.service','swift-runtime.service']:
        (unitdir/name).write_text('original '+name)
        (links/name).symlink_to(unitdir/name)
    bindir = home/'.local/bin'; bindir.mkdir(parents=True)
    (bindir/'swift').symlink_to(previous/'deploy/swift.sh')
    (bindir/'systemctl').write_text('#!/bin/sh\\nexit 0\\n'); (bindir/'systemctl').chmod(0o755)
    os.environ['PATH'] = str(bindir)+os.pathsep+os.environ['PATH']
    install.mkdir(); (install/'current').symlink_to(previous)
    (release/'deploy/install.sh').write_text(
        '#!/bin/sh\\nprintf changed > "'+str(unitdir/'swift.service')+'"\\n'
        'ln -sfn "'+str(release/'deploy/swift.sh')+'" "'+str(bindir/'swift')+'"\\nexit 1\\n')
    try: module.activate(install, release, previous, root, bindir/'herdr', True, None)
    except Exception: pass
    else: raise AssertionError('Failed installer accepted')
    assert (unitdir/'swift.service').read_text() == 'original swift.service'
    assert (unitdir/'swift-runtime.service').read_text() == 'original swift-runtime.service'
    assert (bindir/'swift').resolve() == previous/'deploy/swift.sh'
    assert (install/'current').resolve() == previous
`,
      path.resolve(__dirname, '../deploy/github-install.py'),
    ],
    { stdio: 'pipe' },
  );
});
