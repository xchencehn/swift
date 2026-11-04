#!/usr/bin/env python3
"""Inspect or apply a Linux Herdr live handoff without sending terminal input."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import socket
import struct
import subprocess
import tempfile
import time


def request(socket_path, method, params=None, timeout=40):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(timeout)
        client.connect(str(socket_path))
        peer_pid = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
        client.sendall((json.dumps({'id': 'swift-handoff', 'method': method, 'params': params or {}}) + '\n').encode())
        with client.makefile('rb') as response:
            line = response.readline(16 * 1024 * 1024 + 1)
        if not line or len(line) > 16 * 1024 * 1024:
            raise RuntimeError('Missing or oversized runtime response')
        message = json.loads(line)
        if message.get('error'):
            raise RuntimeError(method + ': ' + str(message['error'].get('message', 'runtime rejected request')))
        return message['result'], peer_pid


def process_start(pid):
    # The parent shell may have spaces or parentheses in its process name.
    return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]


def capture(socket_path):
    ping, source_pid = request(socket_path, 'ping')
    snapshot = request(socket_path, 'session.snapshot')[0]['snapshot']
    identities = []
    for pane in snapshot['panes']:
        info = request(socket_path, 'pane.process_info', {'pane_id': pane['pane_id']})[0]['process_info']
        pid = info.get('shell_pid')
        if not pid:
            raise RuntimeError('A pane has no live PTY process; migration requires explicit handling')
        identities.append({'pane_id': pane['pane_id'], 'terminal_id': pane['terminal_id'],
                           'child_pid': pid, 'process_start': process_start(pid)})
    after = request(socket_path, 'session.snapshot')[0]['snapshot']
    expected = {(item['pane_id'], item['terminal_id']) for item in identities}
    if {(item['pane_id'], item['terminal_id']) for item in after['panes']} != expected:
        raise RuntimeError('Terminal topology changed during capture; no handoff was attempted')
    if request(socket_path, 'ping')[1] != source_pid:
        raise RuntimeError('Source runtime changed during capture')
    return {'version': 1, 'source_version': ping['version'], 'source_protocol': ping['protocol'],
            'source_pid': source_pid, 'source_start': process_start(source_pid),
            'source_socket': str(socket_path), 'terminals': identities}


def migrate(socket_path, candidate, receipt_path, apply=False, development=False):
    socket_path = Path(socket_path).absolute()
    candidate = Path(candidate).resolve(strict=True)
    version = subprocess.check_output([str(candidate), '--version'], text=True).strip().removeprefix('herdr ')
    if '-swift.' not in version:
        raise RuntimeError('The import binary must be a Swift-managed runtime')
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    if not development:
        build = json.loads((candidate.parent / 'build.json').read_text())
        if not build.get('built') or build.get('handoff_identity_version') != 1 or build.get('binary_sha256') != digest or build.get('version') != version:
            raise RuntimeError('Candidate does not match a verified identity-preserving build receipt')
    source = capture(socket_path)
    receipt = {'source': source, 'candidate': str(candidate), 'version': version,
               'sha256': digest, 'development': development, 'applied': False}
    receipt_path = Path(receipt_path).absolute()
    receipt_path.parent.mkdir(parents=True, exist_ok=True)

    def save():
        descriptor = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(receipt, stream, indent=2)
            stream.write('\n')

    save()
    if not apply:
        return receipt
    if hashlib.sha256(Path(f"/proc/{source['source_pid']}/exe").read_bytes()).hexdigest() == digest:
        receipt.update(already_running=True, identities_preserved=True, after=source)
        save()
        return receipt
    with tempfile.TemporaryDirectory(prefix='swift-herdr-handoff-', dir=receipt_path.parent) as directory:
        identity_path = Path(directory) / 'identities.json'
        identity_path.write_text(json.dumps(source))
        identity_path.chmod(0o600)
        launcher = Path(directory) / 'import'
        launcher.write_text('#!/bin/sh\nexport SWIFT_HERDR_HANDOFF_IDENTITIES=' + shlex.quote(str(identity_path))
                            + '\nexec ' + shlex.quote(str(candidate)) + ' "$@"\n')
        launcher.chmod(0o700)
        if process_start(source['source_pid']) != source['source_start']:
            raise RuntimeError('Source process changed before handoff')
        start = time.monotonic()
        try:
            request(socket_path, 'server.live_handoff', {'import_exe': str(launcher),
                    'expected_protocol': source['source_protocol'], 'expected_version': version})
        except (OSError, RuntimeError) as error:
            # A response can be lost after commit. Inspect, but never replay it.
            receipt['request_error'] = str(error)
        after = None
        for _ in range(100):
            try:
                ping, pid = request(socket_path, 'ping', timeout=1)
                if pid != source['source_pid'] and ping['version'] == version:
                    after = capture(socket_path)
                    break
                if pid == source['source_pid'] and 'request_error' in receipt:
                    break
            except (OSError, RuntimeError):
                pass
            time.sleep(.05)
        receipt['handoff_ms'] = (time.monotonic() - start) * 1000
        if after is not None:
            expected = {(item['pane_id'], item['terminal_id'], item['child_pid'], item['process_start']) for item in source['terminals']}
            observed = {(item['pane_id'], item['terminal_id'], item['child_pid'], item['process_start']) for item in after['terminals']}
            receipt.update(applied=True, after=after, identities_preserved=expected == observed)
        save()
        if not receipt.get('identities_preserved'):
            raise RuntimeError('Handoff did not verify preserved terminal identities; see the private receipt. No retry was sent.')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True, type=Path)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--receipt', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    result = migrate(args.socket, args.candidate, args.receipt, args.apply)
    print(json.dumps({key: result[key] for key in ('version', 'applied', 'sha256')}))


if __name__ == '__main__':
    main()
