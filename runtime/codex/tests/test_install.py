import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import test_manager as fixtures

SOURCE=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('swift_installer_test',SOURCE/'deploy/codex/install.py');installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.fx=fixtures.RuntimeTests();self.fx.setUp();self.addCleanup(self.fx.doCleanups)
        self.fx.update();self.archive=self.fx.root/'verified.tar.gz';self.fx.manager.export(self.archive)
        self.home=self.fx.root/'home';self.home.mkdir();self.source=self.fx.root/'swift-source'
        (self.source/'runtime/codex').mkdir(parents=True);(self.source/'deploy/codex').mkdir(parents=True)
        for p in fixtures.TOOLS.iterdir():
            if p.is_file():shutil.copy2(p,self.source/'runtime/codex'/p.name)
        shutil.copy2(SOURCE/'deploy/codex/install.py',self.source/'deploy/codex/install.py')
        for name in ['node-pty','node-addon-api']:
            p=self.source/'node_modules'/name;p.mkdir(parents=True);(p/'package.json').write_text('{"version":"fixture"}')
        (self.home/'.local/bin').mkdir(parents=True);self.launcher=self.home/'.local/bin/codex';self.original='#!/usr/bin/env bash\nexport DISPLAY="${DISPLAY:-:0}"\n# The independently managed runtime survives npm.\nexec /old/codex-custom/current/bin/codex "$@"\n';self.launcher.write_text(self.original);self.launcher.chmod(0o755)
        (self.home/'.codex').mkdir();(self.home/'.codex/auth.json').write_text('credential-canary-must-not-be-read')
        self.environment=patch.dict(os.environ,{'HOME':str(self.home)});self.environment.start();self.addCleanup(self.environment.stop)
        self.loader=patch.object(installer,'load_manager',return_value=fixtures.m);self.loader.start();self.addCleanup(self.loader.stop)
        self.native=patch.object(fixtures.m.Manager,'verify',return_value=self.fx.verification());self.native.start();self.addCleanup(self.native.stop)
        self.state=self.fx.root/'swift-state'

    def install(self,**options):
        return installer.install(self.source,self.state,self.fx.package,Path('/usr/bin/node'),mode='follower',scheduler='none',archive=self.archive,**options)

    def test_migration_owns_helpers_preserves_clipboard_prefix_and_never_copies_auth(self):
        read=Path.read_text
        def guarded(path,*args,**kwargs):
            if path.name=='auth.json':raise AssertionError('credential unexpectedly read')
            return read(path,*args,**kwargs)
        with patch.object(Path,'read_text',guarded):result=self.install()
        self.assertEqual(result['state'],'ready');text=self.launcher.read_text();self.assertIn('export DISPLAY',text);self.assertIn('swift/codex/tools/launcher.py',text);self.assertNotIn('codex-custom/current',text)
        self.assertTrue((self.home/'.local/share/swift/codex').is_symlink())
        self.assertIn('swift/codex/tools/codex-fork-right.js',(self.home/'.local/bin/herdr-codex-fork-right').read_text())
        self.assertFalse(any(p.name=='auth.json' for p in self.state.rglob('*')))
        config=fixtures.m.read_json(self.state/'config.json');self.assertNotIn('sync194',config);self.assertIn('/managers/',config['nodeModules'])

    def test_failed_native_verification_retains_original_launcher_and_aliases(self):
        with patch.object(fixtures.m.Manager,'verify',side_effect=RuntimeError('fixture verification failed')):
            with self.assertRaises(RuntimeError):self.install()
        self.assertEqual(self.launcher.read_text(),self.original);self.assertFalse((self.home/'.local/share/swift/codex').exists());self.assertFalse((self.state/'current').exists())

    def test_auto_install_preserves_follower_role_scheduler_and_existing_package(self):
        self.install()
        result=subprocess.run(['/usr/bin/python3','-B',str(self.source/'deploy/codex/install.py'),'--source',str(self.source),'--auto'],env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);value=json.loads(result.stdout.strip().splitlines()[-1]);self.assertEqual(value['mode'],'follower');self.assertEqual(value['scheduler'],'none')
        self.assertNotIn('sync194',fixtures.m.read_json(self.state/'config.json'))

    def test_first_auto_install_builds_and_enables_codex_without_legacy_state(self):
        def bootstrap(manager,**kwargs):
            self.assertEqual(kwargs,{})
            manager.import_package(self.archive)
        with patch.object(fixtures.m.Manager,'update',bootstrap):
            result=installer.install(self.source,self.state,self.fx.package,Path('/usr/bin/node'),auto=True,scheduler='none')
        self.assertEqual(result['state'],'ready')
        self.assertTrue((self.state/'tools/defaults.toml').is_file())
        self.assertIn('swift/codex/tools/launcher.py',self.launcher.read_text())

    def test_web_only_install_without_codex_keeps_existing_launcher(self):
        value=installer.install(self.source,self.fx.root/'unused',self.fx.root/'missing-package.json',Path('/usr/bin/node'),auto=True)
        self.assertEqual(value['state'],'not_installed');self.assertEqual(self.launcher.read_text(),self.original)


if __name__=='__main__':unittest.main()
