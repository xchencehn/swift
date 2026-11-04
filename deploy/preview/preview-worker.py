#!/usr/bin/env python3
"""Optional document converter using isolated Docker containers.

Every conversion runs in a fresh Docker sandbox with no network, host HOME,
capabilities, or writable root filesystem. Only the current temporary job is mounted.
"""
import argparse
import base64
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import uuid

LIMIT = 64 * 1024 * 1024
EXTENSIONS = {'.doc', '.docx', '.docm', '.odt', '.rtf', '.ppt', '.pptx', '.pptm', '.odp', '.xls', '.xlsx', '.xlsm', '.ods'}


def output_bytes(file, limit):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            raise ValueError('Invalid preview output')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) != info.st_size:
            raise ValueError('Preview output changed')
        return data
    finally:
        os.close(fd)


def convert(config, request):
    command = request.get('command')
    if command not in {'libreoffice', 'pdfinfo', 'pdftoppm', 'pdftotext'}:
        raise ValueError('Unsupported converter')
    data = base64.b64decode(request.get('input', ''), validate=True)
    if not 0 < len(data) <= LIMIT:
        raise ValueError('Invalid input size')
    extension = request.get('extension', '')
    if command == 'libreoffice' and (extension not in EXTENSIONS or len(data) > 32 * 1024 * 1024):
        raise ValueError('Unsupported Office input')
    page = request.get('page')
    if command in {'pdftoppm', 'pdftotext'} and (type(page) is not int or not 1 <= page <= 1000000):
        raise ValueError('Invalid page')
    name = 'swift-preview-job-' + uuid.uuid4().hex
    directory = Path(tempfile.mkdtemp(prefix='job-', dir=config['jobs']))
    try:
        directory.chmod(0o700)
        (directory / 'home').mkdir(mode=0o700)
        if command == 'libreoffice':
            (directory / ('input' + extension)).write_bytes(data)
            profile = directory / 'profile/user'
            profile.mkdir(parents=True)
            (profile / 'registrymodifications.xcu').write_text('<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item></oor:items>')
            args = ['/usr/bin/libreoffice', '-env:UserInstallation=file:///work/profile', '--headless', '--norestore', '--nodefault', '--convert-to', 'pdf', '--outdir', '/work', '/work/input' + extension]
        else:
            (directory / 'document.pdf').write_bytes(data)
            if command == 'pdfinfo':
                args = ['/usr/bin/pdfinfo', '/work/document.pdf']
            elif command == 'pdftotext':
                args = ['/usr/bin/pdftotext', '-f', str(page), '-l', str(page), '-layout', '-nopgbrk', '/work/document.pdf', '-']
            else:
                args = ['/usr/bin/pdftoppm', '-f', str(page), '-l', str(page), '-singlefile', '-scale-to', '1600', '-png', '/work/document.pdf', '/work/page']
        invocation = ['docker', 'run', '--rm', '--name', name, '--label', 'swift.component=preview', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2', '--ulimit', 'cpu=45:45', '--ulimit', 'fsize=134217728:134217728', '--user', str(os.getuid()) + ':' + str(os.getgid()), '--tmpfs', '/tmp:rw,nosuid,nodev,size=134217728', '--mount', 'type=bind,src=' + str(directory) + ',dst=/work', '--workdir', '/work', '-e', 'HOME=/work/home', '-e', 'LANG=C.UTF-8', '-e', 'SAL_USE_VCLPLUGIN=svp', config['image'], *args]
        # Spool converter diagnostics to the private job instead of allocating an
        # unbounded subprocess output buffer in the long-lived worker.
        with (directory / 'stdout').open('wb') as stdout, (directory / 'stderr').open('wb') as stderr:
            result = subprocess.run(invocation, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, timeout=60)
        if result.returncode:
            raise ValueError('Converter failed')
        text = output_bytes(directory / 'stdout', 1024 * 1024).decode('utf8', errors='replace') if (directory / 'stdout').stat().st_size else ''
        output = None
        if command in {'libreoffice', 'pdftoppm'}:
            output = output_bytes(directory / ('input.pdf' if command == 'libreoffice' else 'page.png'), LIMIT if command == 'libreoffice' else 16 * 1024 * 1024)
        return {'text': text, 'output': base64.b64encode(output).decode() if output else None}
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        shutil.rmtree(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    jobs = Path(config['jobs'])
    if not jobs.is_dir() or jobs.is_symlink() or not jobs.is_absolute() or jobs.stat().st_uid != os.getuid() or jobs.stat().st_mode & 0o077:
        raise ValueError('Unexpected preview job directory')
    if not re.fullmatch(r'swift-preview:[a-f0-9]{12,40}', config['image']):
        raise ValueError('Unexpected preview image')
    slots = threading.BoundedSemaphore(2)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path != '/health':
                self.send_error(404)
                return
            response = json.dumps({'ok': True, 'image': config['image']}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def do_POST(self):
            authenticated = hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + config['token'])
            if self.path != '/run' or not authenticated:
                self.send_error(403)
                return
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 90 * 1024 * 1024 or not slots.acquire(blocking=False):
                self.send_error(503)
                return
            try:
                self.connection.settimeout(75)
                request = json.loads(self.rfile.read(size))
                response = json.dumps(convert(config, request)).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)
            except (ValueError, OSError, subprocess.SubprocessError):
                self.send_error(422, 'Preview failed')
            finally:
                slots.release()

    ThreadingHTTPServer((config['bind'], config['port']), Handler).serve_forever()


if __name__ == '__main__':
    main()
