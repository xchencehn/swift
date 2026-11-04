import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('session_guard', Path(__file__).parents[1] / 'herdr-session-guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class SessionOwnerTests(unittest.TestCase):
    def test_foreground_identity_and_shared_daemon(self):
        env = {'HERDR_ENV': '1', 'HERDR_PANE_ID': 'w1:p2', 'HERDR_SOCKET_PATH': '/fixture/socket'}
        processes = {
            30: dict(pid=30, parent=20, start='300', codex=False, server=False),
            20: dict(pid=20, parent=10, start='200', codex=True, server=False),
            10: dict(pid=10, parent=1, start='100', codex=True, server=False),
        }
        def query(endpoint, pane):
            self.assertEqual(endpoint, '/fixture/socket')
            return {'pane_id': pane, 'foreground_processes': [{'pid': 20}]}
        self.assertTrue(guard.allowed(env, 30, processes.__getitem__, query))
        processes[20]['server'] = True
        self.assertFalse(guard.allowed(env, 30, processes.__getitem__, query))
        processes[20]['server'] = False
        self.assertFalse(guard.allowed(env, 30, processes.__getitem__, lambda *_: {'pane_id': 'w1:p2', 'foreground_processes': [{'pid': 10}]}))
        self.assertFalse(guard.allowed(env, 30, processes.__getitem__, lambda *_: {'pane_id': 'w1:p3', 'foreground_processes': [{'pid': 20}]}))
        self.assertFalse(guard.allowed(env, 30, processes.__getitem__, lambda *_: None))
        def changed(pid):
            item = dict(processes[pid])
            if pid == 20:
                processes[pid]['start'] = '201'
            return item
        self.assertFalse(guard.allowed(env, 30, changed, query))


if __name__ == '__main__':
    unittest.main()
