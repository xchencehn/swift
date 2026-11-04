#!/usr/bin/env python3
"""Allow a Herdr session hook only from that pane's foreground Codex TUI.

Shared app-server daemons inherit the first TUI's HERDR_* environment. Their
hooks cannot identify a client by that environment; Swift recovers those
identities independently from native archives and verified terminal content.
This helper never consumes hook stdin, reports a session, or writes a terminal.
"""
import json
import os
from pathlib import Path
import socket
import sys


def process(pid, proc=Path('/proc')):
    directory = proc / str(pid)
    stat = (directory / 'stat').read_text()
    fields = stat[stat.rfind(')') + 2:].split()
    argv = (directory / 'cmdline').read_bytes().split(b'\0')
    return {
        'pid': pid, 'parent': int(fields[1]), 'start': fields[19],
        'codex': Path(os.fsdecode(argv[0])).name in ('codex', 'codex.exe'),
        'server': b'app-server' in argv[1:3],
    }


def reporter(pid, read=process):
    seen = set()
    for _ in range(64):
        if pid <= 1 or pid in seen:
            return None
        seen.add(pid)
        item = read(pid)
        if item['codex']:
            return None if item['server'] else item
        pid = item['parent']
    return None


def process_info(socket_path, pane):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(0.5)
        client.connect(socket_path)
        client.sendall((json.dumps({'id': 'swift-session-owner',
                                   'method': 'pane.process_info',
                                   'params': {'pane_id': pane}}) + '\n').encode())
        data = b''
        while b'\n' not in data:
            chunk = client.recv(4096)
            if not chunk or len(data) + len(chunk) > 131072:
                return None
            data += chunk
        result = json.loads(data.split(b'\n', 1)[0])
        if result.get('id') != 'swift-session-owner' or result.get('error'):
            return None
        return result.get('result', {}).get('process_info')


def allowed(env, pid, read=process, query=process_info):
    if env.get('HERDR_ENV') != '1':
        return False
    pane, endpoint = env.get('HERDR_PANE_ID'), env.get('HERDR_SOCKET_PATH')
    if not pane or not endpoint:
        return False
    owner = reporter(pid, read)
    if owner is None:
        return False
    info = query(endpoint, pane)
    foreground = (info or {}).get('foreground_processes', [])
    if (info or {}).get('pane_id') != pane or not any(p.get('pid') == owner['pid'] for p in foreground):
        return False
    return read(owner['pid']) == owner


if __name__ == '__main__':
    try:
        permitted = allowed(os.environ, os.getppid())
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        permitted = False
    sys.exit(0 if permitted else 1)
