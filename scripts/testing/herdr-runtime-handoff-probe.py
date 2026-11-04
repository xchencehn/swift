#!/usr/bin/env python3
"""Exercise only disposable Herdr instances, including failed import recovery."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('migration', ROOT / 'runtime/herdr/migrate.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def wait(predicate, seconds=10):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(.02)
    raise RuntimeError('Isolated handoff fixture timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--full-state', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'production_input': False}
    with tempfile.TemporaryDirectory(prefix='swift-handoff-probe-') as directory:
        home = Path(directory)
        (home / 'config/herdr').mkdir(parents=True)
        # Debug candidates use herdr-dev. Both paths belong to this fixture.
        (home / 'config/herdr-dev').symlink_to(home / 'config/herdr', target_is_directory=True)
        socket_path = home / 'config/herdr/sessions/fixture/herdr.sock'
        env = {'PATH': os.environ['PATH'], 'HOME': directory, 'XDG_CONFIG_HOME': str(home / 'config'),
               'SHELL': '/bin/sh', 'TERM': 'xterm-256color', 'HERDR_SESSION': 'fixture'}
        source = subprocess.Popen([str(args.source), '--session', 'fixture', 'server'], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait(socket_path.exists)
            for index in range(2):
                pane = migration.request(socket_path, 'workspace.create', {'cwd': directory, 'focus': False})[0]['root_pane']
                program = home / f'program-{index}.py'
                program.write_text(f"""import os,time,tty,select
from pathlib import Path
tty.setraw(0)
root=Path({directory!r})
index={index}
count=0
phase=0
while True:
 count+=1
 (root / f'beat-{{index}}').write_text(str(count))
 if index == 0 and phase == 0 and (root / 'snapshot-start').exists():
  for row in range(1200): os.write(1,('\\r\\nSAVED_HISTORY_'+str(row)).encode())
  os.write(1,b'\\x1b[?1049h\\x1b[?1003h\\x1b[?1006h\\x1b[?2004h\\x1b[>31u\\x1b[5 qALT_SNAPSHOT_\\xe4\\xb8')
  phase=1
 elif index == 0 and phase == 1 and (root / 'snapshot-resume').exists():
  os.write(1,b'\\xad')
  phase=2
 elif index == 0 and phase == 2 and (root / 'snapshot-exit').exists():
  os.write(1,b'\\x1b[?1049l')
  phase=3
 elif phase == 0: os.write(1,('\\r\\nALIVE_'+str(index)+'_'+str(count)).encode())
 if select.select([0],[],[],.03)[0]:
  data=os.read(0,4096)
  with (root / f'input-{{index}}').open('ab') as stream: stream.write(data)
""")
                subprocess.run([str(args.source), '--session', 'fixture', 'pane', 'run', pane['pane_id'],
                                'python3 -u ' + shlex.quote(str(program))], env=env,
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wait(lambda: all((home / f'beat-{index}').exists() for index in range(2)))
            original_capture = migration.capture
            before = original_capture(socket_path)
            def corrupted(path):
                value = original_capture(path)
                value['terminals'][0]['child_pid'] += 1000000
                return value
            migration.capture = corrupted
            try:
                migration.migrate(socket_path, args.candidate, args.output / 'rejected.json', apply=True, development=not (args.candidate.parent / 'build.json').exists())
                raise AssertionError('Incorrect process mapping was accepted')
            except RuntimeError:
                pass
            finally:
                migration.capture = original_capture
            assert migration.request(socket_path, 'ping')[1] == before['source_pid']
            assert original_capture(socket_path)['terminals'] == before['terminals']
            report['failed_import_preserves_source'] = True
            build_path = args.candidate.parent / 'build.json'
            build = json.loads(build_path.read_text()) if build_path.exists() else {}
            if build.get('target') == 'x86_64-unknown-linux-musl':
                installer_spec = importlib.util.spec_from_file_location('runtime_install', ROOT / 'deploy/herdr/install.py')
                installer = importlib.util.module_from_spec(installer_spec)
                installer_spec.loader.exec_module(installer)
                tools = home / 'tools'; tools.mkdir()
                commands = home / 'service-commands'
                fake = tools / 'systemctl'
                fake.write_text('#!/bin/sh\nprintf \'%s\\n\' "$*" >> ' + shlex.quote(str(commands)) + '\ncase "$*" in *EnvironmentFiles*) printf \'%s\\n\' ' + shlex.quote(str(home / 'managed-runtime/runtime.env')) + ';; esac\nexit 0\n')
                fake.chmod(0o755)
                previous_home, previous_path = os.environ.get('HOME'), os.environ['PATH']
                try:
                    os.environ['HOME'] = directory
                    os.environ['PATH'] = str(tools) + os.pathsep + previous_path
                    prefix = home / 'managed-runtime'
                    installed = installer.install(build_path, prefix, socket_path, apply=True)
                    assert installed['installed']
                    result = json.loads(next((prefix / 'receipts').glob('*.json')).read_text())
                    assert (prefix / 'current').is_symlink()
                    pid = migration.request(socket_path, 'ping')[1]
                    again = installer.install(build_path, prefix, socket_path, apply=True)
                    assert again['installed'] and not again['applied']
                    assert migration.request(socket_path, 'ping')[1] == pid
                    assert commands.read_text().splitlines() == ['--user daemon-reload',
                        '--user show swift.service -p EnvironmentFiles --value',
                        '--user show swift-runtime.service -p EnvironmentFiles --value',
                        '--user is-active --quiet swift.service',
                        '--user restart swift.service'] * 2
                    for unit in ('swift.service', 'swift-runtime.service'):
                        config = home / '.config/systemd/user' / (unit + '.d') / '30-swift-herdr.conf'
                        assert config.is_symlink() and config.resolve().is_relative_to(prefix)
                        assert config.read_text().startswith(installer.MARKER)
                    (args.output / 'migration.json').write_text(json.dumps(result, indent=2) + '\n')
                    report['isolated_install_and_idempotency'] = True
                finally:
                    os.environ['PATH'] = previous_path
                    if previous_home is None: os.environ.pop('HOME', None)
                    else: os.environ['HOME'] = previous_home
            else:
                result = migration.migrate(socket_path, args.candidate, args.output / 'migration.json', apply=True, development=not build_path.exists())
            assert result['identities_preserved']
            for index in range(2):
                beat = home / f'beat-{index}'
                previous = int(beat.read_text() or 0)
                wait(lambda: int(beat.read_text() or 0) > previous)
            pane = result['after']['terminals'][0]
            def state():
                return migration.request(socket_path, 'terminal.state.subscribe', {'terminal_id': pane['terminal_id']})[0]
            def text(frame):
                return '\n'.join(''.join(cell[0] for cell in row['cells']) for _, row in frame['changes'])
            if args.full_state:
                (home / 'snapshot-start').touch()
                wait(lambda: 'ALT_SNAPSHOT_' in text(state()))
                # Alternate-screen activation also removes Herdr's primary scrollbar.
                # Wait for that native geometry change before comparing handoff state.
                time.sleep(.2)
                snapshot_before = state()
                assert snapshot_before['alternate_screen'] and snapshot_before['cursor_shape'] == 5
            # A subsequent custom-to-custom handoff needs no external identity map.
            migration.request(socket_path, 'server.live_handoff', {'import_exe': str(args.candidate.resolve()),
                              'expected_protocol': before['source_protocol'], 'expected_version': result['version']})
            after_second = migration.capture(socket_path)
            assert after_second['terminals'] == result['after']['terminals']
            report['subsequent_handoff_preserves_identities'] = True
            if args.full_state:
                snapshot_after = state()
                (args.output / 'state-before.json').write_text(json.dumps(snapshot_before, indent=2))
                (args.output / 'state-after.json').write_text(json.dumps(snapshot_after, indent=2))
                for field in ('changes', 'cursor', 'cursor_shape', 'alternate_screen', 'mouse_tracking', 'mouse_sgr', 'bracketed_paste'):
                    assert snapshot_after[field] == snapshot_before[field], field
                (home / 'snapshot-resume').touch()
                wait(lambda: 'ALT_SNAPSHOT_中' in text(state()))
                (home / 'snapshot-exit').touch()
                wait(lambda: not state()['alternate_screen'])
                primary = state()
                assert primary['first_row'] > 1100
                history = migration.request(socket_path, 'terminal.history.read', {
                    'terminal_id': pane['terminal_id'], 'boot_id': primary['boot_id'], 'revision': primary['revision'],
                    'history_epoch': primary['history_epoch'], 'start': primary['row_offset'], 'limit': 64})[0]
                saved = '\n'.join(''.join(cell[0] for cell in row['cells']) for row in history['content'])
                assert 'SAVED_HISTORY_0' in saved
                report['full_state_handoff'] = {'alternate_screen': True, 'history_rows': primary['first_row'],
                    'partial_utf8': True, 'input_modes': True, 'cursor': True}

            pane = after_second['terminals'][0]
            migration.request(socket_path, 'pane.send_input', {'pane_id': pane['pane_id'], 'text': 'Z', 'keys': []})
            wait(lambda: (home / 'input-0').exists())
            received = (home / 'input-0').read_bytes()
            expected = b'\x1b[200~Z\x1b[201~' if args.full_state else b'Z'
            assert received == expected, received.hex()
            state = migration.request(socket_path, 'terminal.state.subscribe', {'terminal_id': pane['terminal_id']})[0]
            assert state['terminal_id'] == pane['terminal_id']
            report.update(ok=True, identities_preserved=True, process_output_continues=True,
                          target_input_exactly_once=True, state_subscription=True,
                          handoff_ms=result['handoff_ms'], source_version=before['source_version'],
                          target_version=result['version'])
        finally:
            try:
                migration.request(socket_path, 'server.stop', timeout=5)
            except (OSError, RuntimeError):
                pass
            if source.poll() is None:
                source.terminate()
            source.wait(timeout=10)
            time.sleep(.2)
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
