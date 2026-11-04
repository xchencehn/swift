#!/usr/bin/env python3
"""Read effective configuration from an installed launcher in disposable homes."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import tomllib


def read_config(binary, home, arguments):
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'CODEX_HOME': str(home),
           'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9'}
    if os.environ.get('SWIFT_CODEX_ROOT'):
        env['SWIFT_CODEX_ROOT'] = os.environ['SWIFT_CODEX_ROOT']
    child = subprocess.Popen([binary, *arguments, 'app-server'], cwd=home, env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for request in [
            {'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'swift-defaults-check', 'version': '1'}}},
            {'method': 'initialized'},
            {'id': 2, 'method': 'config/read', 'params': {'includeLayers': False}},
        ]:
            child.stdin.write((json.dumps(request) + '\n').encode())
        child.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            pending = b''
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if not selector.select(1):
                    continue
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError('Codex exited before config/read')
                pending += chunk
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    response = json.loads(line)
                    if response.get('id') == 2:
                        return response['result']['config']
        raise TimeoutError('Codex config/read timed out')
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def check(binary):
    defaults = tomllib.loads((Path(__file__).parent / 'defaults.toml').read_text())
    with tempfile.TemporaryDirectory(prefix='swift-codex-defaults-') as temporary:
        home = Path(temporary)
        config = read_config(binary, home, [])
        for key, value in defaults.items():
            if key != 'tui':
                if isinstance(value, dict):
                    for field, expected in value.items():
                        assert config[key][field] == expected, (key, field)
                else:
                    assert config[key] == value, (key, config[key])
        assert not (home / 'config.toml').exists(), 'Launcher must not write user settings'
        override = read_config(binary, home, ['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="read-only"',
                                             '-c', 'analytics.enabled=true'])
        assert override['approval_policy'] == 'on-request'
        assert override['sandbox_mode'] == 'read-only'
        assert override['analytics']['enabled'] is True
        original = 'approval_policy="on-request"\nsandbox_mode="read-only"\n[analytics]\nenabled=true\n'
        (home / 'config.toml').write_text(original)
        configured = read_config(binary, home, [])
        assert configured['approval_policy'] == 'on-request'
        assert configured['sandbox_mode'] == 'read-only'
        assert configured['analytics']['enabled'] is True
        assert configured['feedback']['enabled'] is False
        assert (home / 'config.toml').read_text() == original
    return {'ok': True, 'freshHome': True, 'explicitCli': True, 'existingConfig': True, 'modelRequests': 0}


if __name__ == '__main__':
    print(json.dumps(check(sys.argv[1])))
