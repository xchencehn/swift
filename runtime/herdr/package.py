#!/usr/bin/env python3
"""Package a verified runtime, source patch and licenses without local paths."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    source = json.loads((root / 'source.json').read_text())
    build = json.loads(args.build.read_text())
    keys = ('version', 'base', 'patch_sha256')
    if not build.get('built') or any(build.get(key) != source[key] for key in keys):
        raise RuntimeError('Build does not match the current source manifest')
    binary = Path(build['binary'])
    if not binary.is_absolute():
        binary = args.build.parent / binary
    if hashlib.sha256(binary.read_bytes()).hexdigest() != build['binary_sha256']:
        raise RuntimeError('Runtime binary checksum mismatch')
    patch = (root / source['patch']).read_bytes()
    if hashlib.sha256(patch).hexdigest() != source['patch_sha256']:
        raise RuntimeError('Runtime source patch checksum mismatch')
    public = {key: value for key, value in build.items() if key not in ('source', 'binary')}
    public.update(binary='herdr', installed=False)
    target = build.get('target') or 'local'
    name = f"swift-herdr-{build['version']}-{target}"
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / (name + '.tar.gz')
    files = {'herdr': binary.read_bytes(),
             'source.json': (root / 'source.json').read_bytes(),
             'build.json': (json.dumps(public, indent=2) + '\n').encode(),
             'LICENSE': (args.build.parent / 'LICENSE').read_bytes()}
    files['runtime.patch'] = patch
    for license in sorted((args.build.parent / 'licenses').iterdir()):
        if not license.is_file() or license.is_symlink():
            raise RuntimeError('Unexpected license entry')
        files['licenses/' + license.name] = license.read_bytes()
    with archive.open('wb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as tar:
                for path, data in sorted(files.items()):
                    entry = tarfile.TarInfo(name + '/' + path)
                    entry.size = len(data)
                    entry.mode = 0o755 if path == 'herdr' else 0o644
                    tar.addfile(entry, io.BytesIO(data))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (args.output / (archive.name + '.sha256')).write_text(f'{digest}  {archive.name}\n')
    print(json.dumps({'archive': str(archive), 'sha256': digest, 'binary_sha256': build['binary_sha256']}))


if __name__ == '__main__':
    main()
