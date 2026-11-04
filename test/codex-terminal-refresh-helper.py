#!/usr/bin/env python3
"""Standard-library helper checks; all PTYs, sockets and processes are isolated.

Optional Node entry: spawn python3 with ['-I', thisFile, explicitHelperPath].
The stdout JSON is the complete report. No live Herdr/Codex session is used.
"""
import contextlib
import copy
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import pty
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

sys.dont_write_bytecode = True


def fixtures():
    focus = dict(focused_pane_id='p', focused_workspace_id='w', focused_tab_id='tab')
    pane = dict(pane_id='p', terminal_id='t', workspace_id='w', tab_id='tab', agent='codex', agent_session=dict(kind='uuid', value='session'))
    layout = dict(tab_id='tab', workspace_id='w', zoomed=False, area=dict(width=80, height=24), focused_pane_id='p', panes=[dict(pane_id='p', focused=True, rect=dict(width=80, height=24))], splits=[])
    guard = dict(focus=focus, pane=pane, paneAgent=None, layout=layout)
    return guard, dict(**focus, panes=[pane], agents=[], layouts=[layout])


def pure_checks(module):
    checks = []
    guard, snapshot = fixtures()
    module.validate_snapshot(snapshot, guard)
    checks.append('matching-snapshot')
    for name, code in [('focus', 'FOCUS_CHANGED'), ('pane', 'PANE_CHANGED'), ('agent', 'AGENT_CHANGED'), ('layout', 'LAYOUT_CHANGED'), ('layout-bool', 'LAYOUT_CHANGED')]:
        value = copy.deepcopy(snapshot)
        if name == 'focus': value['focused_pane_id'] = 'other'
        elif name == 'pane': value['panes'][0]['terminal_id'] = 'other'
        elif name == 'agent': value['agents'] = [dict(pane_id='p')]
        elif name == 'layout': value['layouts'][0]['area']['width'] = 79
        else: value['layouts'][0]['zoomed'] = 0
        try:
            module.validate_snapshot(value, guard)
            raise AssertionError('accepted changed ' + name)
        except module.Refused as error:
            assert error.code == code, (name, error.code)
        checks.append(name + '-refused')
    assert module.encoded_tty_device(os.makedev(136, 300)) == ((136 << 8) | (300 & 255) | ((300 & 0xfff00) << 12))
    checks.append('tty-device-high-minor')

    class Simulated(module.TerminalRefresh):
        def __init__(self):
            super().__init__({})
            self.fd = 42
            self.original = (24, 80, 800, 480)
            self.temporary = (24, 79, 800, 480)
            self.current = self.original
            self.sets = []
            self.owner = True

        def validate_all(self, expected):
            if not self.owner: raise module.Refused('FOCUS_CHANGED')
            if self.current != expected: raise module.Refused('WINSIZE_CHANGED')

        def validate_process(self):
            return 100

    old_ioctl, old_winsize, old_close = module.fcntl.ioctl, module.winsize, module.os.close
    try:
        active = Simulated()

        def fake_ioctl(_fd, _op, value):
            active.current = struct.unpack('HHHH', value)
            active.sets.append(active.current)

        module.fcntl.ioctl = fake_ioctl
        module.winsize = lambda _fd: active.current
        module.os.close = lambda _fd: None
        with contextlib.redirect_stdout(io.StringIO()):
            active.narrow()
            active.cleanup()
        assert active.sets == [(24, 79, 800, 480), (24, 80, 800, 480)]
        checks.append('conditional-cleanup-restores')
        active = Simulated()
        with contextlib.redirect_stdout(io.StringIO()):
            active.narrow()
            active.current = (24, 79, 801, 480)
            active.cleanup()
        assert active.sets == [(24, 79, 800, 480)]
        checks.append('pixel-change-not-overwritten')
        active = Simulated()
        with contextlib.redirect_stdout(io.StringIO()):
            active.narrow()
            active.owner = False
            active.cleanup()
        assert active.sets == [(24, 79, 800, 480)]
        checks.append('owner-change-not-overwritten')
        active = Simulated()
        module._stop_reason = 'SIGNAL_SIGTERM'
        try:
            active.narrow()
            raise AssertionError('signal accepted')
        except module.Refused as error:
            assert error.code == 'SIGNAL_SIGTERM'
        assert active.sets == [] and not active.pending_restore
        checks.append('signal-before-ioctl-refused')
        module._stop_reason = None
        active = Simulated()
        active.current = active.temporary
        with contextlib.redirect_stdout(io.StringIO()) as output:
            try:
                active.narrow()
                raise AssertionError('external temporary size accepted')
            except module.Refused as error:
                assert error.code == 'WINSIZE_CHANGED'
            active.cleanup()
        assert active.sets == [] and active.current == active.temporary and output.getvalue() == ''
        checks.append('external-temporary-before-narrow-not-restored')
    finally:
        module.fcntl.ioctl, module.winsize, module.os.close = old_ioctl, old_winsize, old_close
        module._stop_reason = None
    assert len(checks) == 12
    return dict(ok=True, count=len(checks), checks=checks)


class OutputLines:
    def __init__(self, process):
        self.process = process
        self.buffer = bytearray()

    def next(self, timeout=3):
        deadline = time.monotonic() + timeout
        while True:
            end = self.buffer.find(b'\n')
            if end >= 0:
                line = bytes(self.buffer[:end])
                del self.buffer[:end + 1]
                return json.loads(line)
            remaining = deadline - time.monotonic()
            assert remaining > 0, 'helper output deadline exceeded'
            assert select.select([self.process.stdout], [], [], remaining)[0], 'helper output timeout'
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                assert not self.buffer, 'partial helper output'
                return None
            self.buffer.extend(chunk)
            assert len(self.buffer) <= 1024 * 1024


def lifecycle_checks(helper):
    master, slave = pty.openpty()
    original = (24, 80, 800, 480)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', *original))

    def setup():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        os.tcsetpgrp(0, os.getpgrp())

    # This synthetic process owns only this test's PTY. Its comm is changed so
    # the real helper's exact Codex identity gate can be exercised without a model.
    worker = subprocess.Popen([sys.executable, '-I', '-c', "import ctypes,signal;ctypes.CDLL(None).prctl(15,b'codex',0,0,0);print('ready',flush=True);signal.pause()"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=setup)
    processes = []
    stop = threading.Event()
    server = None
    try:
        assert select.select([worker.stdout], [], [], 3)[0]
        assert worker.stdout.readline().strip() == b'ready'
        raw = pathlib.Path('/proc/%d/stat' % worker.pid).read_text()
        start = raw[raw.rfind(')') + 2:].split()[19]
        tty = os.readlink('/proc/%d/fd/0' % worker.pid)
        guard, snapshot = fixtures()
        with tempfile.TemporaryDirectory(prefix='swift-tty-helper-check-') as directory:
            address = os.path.join(directory, 'herdr.sock')
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(address)
            server.listen(8)
            server.settimeout(.1)

            def serve():
                while not stop.is_set():
                    try: connection, _ = server.accept()
                    except socket.timeout: continue
                    except OSError: return
                    with connection:
                        connection.settimeout(1)
                        request_bytes = bytearray()
                        try:
                            while b'\n' not in request_bytes:
                                chunk = connection.recv(1024)
                                if not chunk: break
                                request_bytes.extend(chunk)
                            request = json.loads(request_bytes)
                            assert request == dict(id='swift-terminal-refresh', method='session.snapshot', params={})
                            connection.sendall((json.dumps(dict(id=request['id'], result=dict(snapshot=copy.deepcopy(snapshot)))) + '\n').encode())
                        except (BrokenPipeError, ConnectionResetError): pass

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            identity = os.stat(address)
            base = dict(pid=worker.pid, start=start, tty=tty, socketPath=address, socketIdentity=dict(dev=str(identity.st_dev), ino=str(identity.st_ino), ctimeNs=str(identity.st_ctime_ns)), guard=guard, timeoutMs=1500)
            results = []
            for name in ('normal', 'eof', 'sigterm', 'timeout', 'partial-command', 'pixel-change', 'focus-change'):
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', *original))
                snapshot.update(guard['focus'])
                process = subprocess.Popen([sys.executable, '-I', str(helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                processes.append(process)
                lines = OutputLines(process)
                config = dict(base, timeoutMs=450 if name in ('timeout', 'partial-command') else 1500)
                process.stdin.write((json.dumps(config) + '\n').encode())
                process.stdin.flush()
                prepared = lines.next()
                assert prepared['type'] == 'prepared', prepared
                assert prepared['original'] == list(original)
                process.stdin.write(b'{"command":"narrow"}\n')
                process.stdin.flush()
                narrowed = lines.next()
                assert narrowed['type'] == 'narrowed', narrowed
                assert struct.unpack('HHHH', fcntl.ioctl(slave, termios.TIOCGWINSZ, b'\0' * 8)) == (24, 79, 800, 480)
                if name == 'normal':
                    process.stdin.write(b'{"command":"restore"}\n')
                    process.stdin.flush()
                elif name == 'sigterm': process.send_signal(signal.SIGTERM)
                elif name == 'pixel-change':
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 79, 801, 480))
                    process.stdin.close()
                elif name == 'focus-change':
                    snapshot['focused_pane_id'] = 'other'
                    process.stdin.close()
                elif name == 'eof': process.stdin.close()
                elif name == 'partial-command':
                    process.stdin.write(b'{"command":')
                    process.stdin.flush()
                events = []
                while True:
                    event = lines.next()
                    if event is None: break
                    events.append(event)
                assert process.wait(timeout=3) in (0, 2)
                assert not process.stderr.read()
                expected = (24, 79, 801, 480) if name == 'pixel-change' else (24, 79, 800, 480) if name == 'focus-change' else original
                assert struct.unpack('HHHH', fcntl.ioctl(slave, termios.TIOCGWINSZ, b'\0' * 8)) == expected, (name, events)
                assert any(event['type'] == ('abandoned' if name in ('pixel-change', 'focus-change') else 'restored') for event in events), (name, events)
                results.append(dict(case=name, ok=True, events=events, kernel=list(expected)))
            return dict(ok=True, count=len(results), syntheticCodexComm=True, isolatedPTY=True, productionInput=False, cases=results)
    finally:
        stop.set()
        if server: server.close()
        for process in processes + [worker]:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
        os.close(master)
        os.close(slave)


def main():
    helper = pathlib.Path(sys.argv[1]).resolve(strict=True)
    spec = importlib.util.spec_from_file_location('terminal_refresh_under_test', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    report = dict(ok=True, helper=str(helper), sha256=hashlib.sha256(helper.read_bytes()).hexdigest(), pure=pure_checks(module), lifecycle=lifecycle_checks(helper))
    print(json.dumps(report, separators=(',', ':')))


if __name__ == '__main__':
    main()
