import base64
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preview_worker', Path(__file__).resolve().parents[1] / 'deploy/preview/preview-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PreviewWorkerTest(unittest.TestCase):
    def test_sandbox_and_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            invocations = []

            def run(args, **kwargs):
                invocations.append(args)
                if args[1] == 'run':
                    mount = args[args.index('--mount') + 1]
                    job = Path(mount.split('src=')[1].split(',')[0])
                    (job / 'input.pdf').write_bytes(b'pdf-fixture')
                return subprocess.CompletedProcess(args, 0)

            with patch.object(worker.subprocess, 'run', side_effect=run):
                result = worker.convert({'jobs': root, 'image': 'swift-preview:0123456789ab'}, {'command': 'libreoffice', 'extension': '.docx', 'input': base64.b64encode(b'doc-fixture').decode()})
            self.assertEqual(base64.b64decode(result['output']), b'pdf-fixture')
            args = invocations[0]
            self.assertEqual(args[args.index('--network') + 1], 'none')
            self.assertEqual(args[args.index('--cap-drop') + 1], 'ALL')
            self.assertIn('--read-only', args)
            self.assertIn('no-new-privileges', args)
            self.assertEqual(list(Path(root).iterdir()), [])
            self.assertEqual(invocations[-1][:3], ['docker', 'rm', '-f'])

    def test_rejects_input_and_unsafe_output(self):
        with tempfile.TemporaryDirectory() as root:
            for request in [ {'command': 'sh'}, {'command': 'libreoffice', 'extension': '.py', 'input': 'eA=='}, {'command': 'pdftoppm', 'input': 'eA==', 'page': 0} ]:
                with self.assertRaises(ValueError):
                    worker.convert({'jobs': root}, request)
            (Path(root) / 'original').write_bytes(b'fixture')
            (Path(root) / 'link').symlink_to(Path(root) / 'original')
            with self.assertRaises(OSError):
                worker.output_bytes(Path(root) / 'link', 100)

    def test_timeout_removes_only_its_job(self):
        with tempfile.TemporaryDirectory() as root:
            invocations = []
            def run(args, **kwargs):
                invocations.append(args)
                if args[1] == 'run':
                    raise subprocess.TimeoutExpired(args, 60)
                return subprocess.CompletedProcess(args, 0)
            with patch.object(worker.subprocess, 'run', side_effect=run), self.assertRaises(subprocess.TimeoutExpired):
                worker.convert({'jobs': root, 'image': 'swift-preview:0123456789ab'}, {'command': 'pdfinfo', 'input': 'eA=='})
            self.assertEqual(invocations[-1][:3], ['docker', 'rm', '-f'])
            self.assertTrue(invocations[-1][-1].startswith('swift-preview-job-'))
            self.assertEqual(list(Path(root).iterdir()), [])


unittest.main()
