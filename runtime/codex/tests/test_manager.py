import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('swift_codex_manager_test',TOOLS/'manager.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name);self.tools=self.root/'tools';self.tools.mkdir()
        for name in ['recipe.json','extensions.patch','extensions-0.166.patch']:shutil.copy2(TOOLS/name,self.tools/name)
        self.package=self.root/'npm/package.json';self.package.parent.mkdir()
        self.vendor=self.package.parent/'node_modules/@openai/codex-linux-x64/vendor/linux';self.vendor.mkdir(parents=True)
        self.version('0.164.0')
        m.atomic_json(self.root/'config.json',{'npmPackage':str(self.package),'nodeModules':'fixture','node':'node','mode':'builder','scheduler':'none'})
        self.manager=m.Manager(self.root,self.tools);self.builds=0
        self.patches=[patch.object(self.manager,'source',self.source),patch.object(self.manager,'build',self.build),patch.object(self.manager,'verify',return_value=self.verification())]
        for value in self.patches:value.start();self.addCleanup(value.stop)
        self.addCleanup(patch.stopall)

    def verification(self):
        return {'accountRustTests':True,'aliasCases':5,'officialServer':True,'hfork':True,'modelRequests':0}

    def version(self,version):
        m.atomic_json(self.package,{'version':version})
        for name in ['bin/codex','bin/codex-code-mode-host','codex-path/rg','codex-resources/voice/model']:
            p=self.vendor/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('#!/bin/sh\necho codex-cli '+version+'\n');p.chmod(0o755)
        m.atomic_json(self.vendor/'codex-package.json',{'version':version,'target':'musl'})

    def source(self,version,work):
        source=work/'source';p=source/m.ACCOUNT_SOURCE;p.parent.mkdir(parents=True);p.write_text('audited Rust module\n')
        return source,{'upstreamCommit':'f'*40,'tag':'rust-v'+version}

    def build(self,source,work):
        self.builds+=1;p=work/'codex';p.write_text('#!/bin/sh\necho codex-cli '+self.manager.desired_version()+'\n');p.chmod(0o755);return p

    def update(self,**options):
        with contextlib.redirect_stdout(io.StringIO()):self.manager.update(**options)

    def test_official_tag_fetch_and_patch_use_an_independent_git_checkout(self):
        import subprocess
        repo=self.root/'official-repo';repo.mkdir()
        def git(*args):return subprocess.check_output(['git',*args],cwd=repo,text=True,stderr=subprocess.DEVNULL)
        git('init');(repo/'fixture.rs').write_text('before\n');git('add','fixture.rs')
        git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','baseline')
        commit=git('rev-parse','HEAD').strip();git('tag','rust-v0.164.0')
        (repo/'fixture.rs').write_text('after\n');patch_text=git('diff','--full-index');(self.tools/'extensions.patch').write_text(patch_text)
        self.manager.recipe['upstream']=str(repo);self.manager.recipe['baseline']['upstreamCommit']=commit
        work=self.root/'prepare';work.mkdir()
        with (work/'prepare.log').open('w') as log,contextlib.redirect_stdout(log),contextlib.redirect_stderr(log):
            source,metadata=m.Manager.source(self.manager,'0.164.0',work)
        self.assertEqual((source/'fixture.rs').read_text(),'after\n');self.assertEqual(metadata['upstreamCommit'],commit)
        self.assertEqual(git('rev-parse','HEAD').strip(),commit)
        self.assertFalse((source/'.git').is_symlink())

    def test_npm_overwrite_preserves_running_inode_and_old_resources(self):
        self.update();old,meta=self.manager.release();inode=(old/'bin/codex').stat().st_ino
        self.version('0.165.0');self.assertTrue(self.manager.current('0.164.0'));self.update()
        self.assertTrue(self.manager.current('0.165.0'));self.assertEqual((old/'bin/codex').stat().st_ino,inode)
        self.assertIn('0.164.0',(old/'codex-resources/voice/model').read_text())

    def prepare_global_package(self):
        package = self.root / 'prefix/lib/node_modules/@openai/codex/package.json'
        package.parent.parent.mkdir(parents=True)
        shutil.move(self.package.parent, package.parent)
        self.package = package
        self.vendor = package.parent / 'node_modules/@openai/codex-linux-x64/vendor/linux'
        self.manager.config['npmPackage'] = str(package)
        return self.root / 'prefix'

    def test_explicit_upgrade_uses_managed_prefix_and_activates_for_new_launches(self):
        prefix = self.prepare_global_package()
        self.update(); old, _ = self.manager.release()
        with patch.object(self.manager, 'run', side_effect=lambda args: self.version('0.166.0')) as npm:
            with contextlib.redirect_stdout(io.StringIO()): self.manager.upgrade()
        npm.assert_called_once_with(['npm', 'install', '--global', '--prefix', prefix, '@openai/codex@latest'])
        self.assertTrue(self.manager.current('0.166.0'))
        self.assertIn('0.164.0', (old / 'bin/codex').read_text())

    def test_explicit_upgrade_waits_and_never_reports_npm_only_success(self):
        self.prepare_global_package(); self.update()
        with patch.object(self.manager, 'run', side_effect=lambda args: self.version('0.166.0')):
            with patch.object(self.manager, 'update') as update:
                with self.assertRaisesRegex(ValueError, 'not activated'):
                    self.manager.upgrade()
                update.assert_called_once_with(force=True, wait=True)

    def test_explicit_upgrade_build_failure_preserves_current_and_propagates(self):
        self.prepare_global_package(); self.update(); old = (self.root / 'current').resolve()
        with patch.object(self.manager, 'run', side_effect=lambda args: self.version('0.166.0')):
            with patch.object(self.manager, 'build', side_effect=RuntimeError('patch incompatible')):
                with self.assertRaisesRegex(RuntimeError, 'patch incompatible'): self.manager.upgrade()
        self.assertEqual((self.root / 'current').resolve(), old)

    def test_explicit_upgrade_respects_rollback_and_follower_before_npm(self):
        with patch.object(self.manager, 'run') as npm:
            m.atomic_json(self.root / 'policy.json', {'hold': True})
            with self.assertRaisesRegex(ValueError, 'paused'): self.manager.upgrade()
            (self.root / 'policy.json').unlink()
            self.manager.config['mode'] = 'follower'
            with self.assertRaisesRegex(ValueError, 'follower'): self.manager.upgrade()
            npm.assert_not_called()

    def test_all_resources_are_checked_and_corruption_is_not_accepted(self):
        self.update();release,_=self.manager.release();(release/'codex-resources/voice/model').write_text('corrupted')
        self.assertFalse(self.manager.current('0.164.0'))
        with self.assertRaises(ValueError):self.manager.release()

    def test_manifest_tampering_is_rejected_by_separate_approval(self):
        self.update();release,_=self.manager.release();p=release/'runtime-manifest.json';value=m.read_json(p);value['source']['upstreamCommit']='0'*40;m.atomic_json(p,value)
        with self.assertRaisesRegex(ValueError,'manifest changed'):self.manager.release()

    def test_extra_nested_manifest_file_is_not_exempt_from_integrity(self):
        self.update();release,_=self.manager.release();(release/'codex-resources/runtime-manifest.json').write_text('{}')
        self.assertFalse(self.manager.current('0.164.0'))

    def test_missing_binary_or_resource_does_not_pass_version_only_check(self):
        self.update();release,_=self.manager.release();(release/'bin/codex-code-mode-host').unlink()
        self.assertFalse(self.manager.current('0.164.0'))

    def test_unchanged_version_is_a_noop(self):
        self.update();current=(self.root/'current').resolve();self.update();self.assertEqual(self.builds,1);self.assertEqual((self.root/'current').resolve(),current)

    def test_failed_verification_retains_current_and_force_retries(self):
        self.update();old=(self.root/'current').resolve();self.version('0.165.0')
        with patch.object(self.manager,'verify',side_effect=RuntimeError('native alias absent')):
            with self.assertRaises(RuntimeError):self.update()
        count=self.builds;self.update();self.assertEqual(count,self.builds);self.assertEqual((self.root/'current').resolve(),old)
        self.update(force=True);self.assertTrue(self.manager.current('0.165.0'))

    def test_interrupted_build_is_recorded_and_not_repeated_each_tick(self):
        self.update();self.version('0.165.0');m.atomic_json(self.root/'status.json',{'state':'building','requestedVersion':'0.165.0','extensionSha256':self.manager.extension,'attemptEpoch':__import__('time').time()})
        self.update();self.assertEqual(m.read_json(self.root/'status.json')['state'],'failed');self.assertEqual(self.builds,1)

    def test_interrupted_state_after_promotion_recovers_without_rebuilding(self):
        self.update();m.atomic_json(self.root/'status.json',{'state':'building','requestedVersion':'0.164.0'})
        self.update();self.assertEqual(self.builds,1);self.assertEqual(m.read_json(self.root/'status.json')['state'],'ready')

    def test_build_environment_does_not_forward_model_or_swift_credentials(self):
        env=m.operation_env({'PATH':'/bin','HTTPS_PROXY':'http://127.0.0.1:1','OPENAI_API_KEY':'private','SWIFT_TOKEN':'private','HERDR_PANE_ID':'private','CUSTOM_ACCESS_TOKEN':'private'})
        self.assertEqual(env,{'PATH':'/bin','HTTPS_PROXY':'http://127.0.0.1:1'})

    def test_concurrent_update_does_not_build_or_change_state(self):
        with (self.root/'update.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);self.update()
        self.assertEqual(self.builds,0)

    def test_npm_changes_during_copy_cannot_mix_resources(self):
        self.update();old=(self.root/'current').resolve();self.version('0.165.0');original=m.copy_runtime
        def changed(source,destination):
            original(source,destination)
            if Path(source)==self.vendor:self.version('0.166.0')
        with patch.object(m,'copy_runtime',side_effect=changed):
            with self.assertRaisesRegex(ValueError,'npm changed'):self.update()
        self.assertEqual((self.root/'current').resolve(),old)

    def test_npm_changes_during_build_cannot_activate_obsolete_version(self):
        self.update();old=(self.root/'current').resolve();self.version('0.165.0');original=self.build
        def changed(source,work):
            binary=original(source,work);self.version('0.166.0');return binary
        with patch.object(self.manager,'build',side_effect=changed):
            with self.assertRaisesRegex(ValueError,'npm changed during the build'):self.update()
        self.assertEqual((self.root/'current').resolve(),old)

    def test_rollback_pins_selected_release_across_timer_updates(self):
        self.update();first=(self.root/'current').resolve();self.version('0.165.0');self.update();self.manager.rollback();self.update(force=True)
        self.assertEqual((self.root/'current').resolve(),first);self.assertTrue(m.read_json(self.root/'policy.json')['hold'])
        m.atomic_json(self.root/'policy.json',{'hold':False});self.update();self.assertTrue(self.manager.current('0.165.0'))

    def test_rollback_rejects_corrupted_previous_release(self):
        self.update();first=(self.root/'current').resolve();self.version('0.165.0');self.update();(first/'bin/codex').write_text('corrupt')
        with self.assertRaises(ValueError):self.manager.rollback()
        self.assertTrue(self.manager.current('0.165.0'))

    def test_follower_waits_for_builder_without_running_compilers(self):
        self.update();self.version('0.165.0');self.manager.config['mode']='follower';self.update()
        self.assertEqual(self.builds,1);self.assertEqual(m.read_json(self.root/'status.json')['state'],'waiting_for_builder')

    def test_target_release_is_built_once_without_changing_local_pointer(self):
        self.update();old=(self.root/'current').resolve();self.version('0.165.0')
        with contextlib.redirect_stdout(io.StringIO()):
            release=self.manager.ensure_release('0.165.0');again=self.manager.ensure_release('0.165.0')
        self.assertEqual(release,again);self.assertEqual(self.builds,2);self.assertEqual((self.root/'current').resolve(),old)

    def test_import_rejects_wrong_version_before_native_execution(self):
        self.update();archive=self.root/'runtime.tar.gz';self.manager.export(archive);self.version('0.165.0')
        with self.assertRaisesRegex(ValueError,'does not match'):self.manager.import_package(archive)
        self.assertTrue(self.manager.current('0.164.0'))

    def test_import_rejects_archive_path_traversal(self):
        archive=self.root/'bad.tar.gz'
        with tarfile.open(archive,'w:gz') as tar:
            item=tarfile.TarInfo('runtime/../../escape');item.size=1;tar.addfile(item,io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError,'Unsafe'):self.manager.import_package(archive)
        self.assertFalse((self.root.parent/'escape').exists())

    def test_unavailable_npm_status_preserves_active_release_and_reports_missing(self):
        self.update();self.package.unlink();status=self.manager.status();self.assertEqual(status['npmVersion'],None);self.assertEqual(status['active']['version'],'0.164.0')


class LauncherTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('manager',TOOLS/'manager.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        self.patch=patch.dict(__import__('sys').modules,{'manager':module});self.patch.start();self.addCleanup(self.patch.stop)
        spec=importlib.util.spec_from_file_location('swift_launcher',TOOLS/'launcher.py');self.launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.launcher)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.home=Path(self.temp.name);self.env={'CODEX_HOME':str(self.home)}

    def test_inserts_account_without_rewriting_existing_config_or_aliases(self):
        p=self.home/'config.toml';original='[tui]\nstatus_line=["model-with-reasoning","weekly-limit","current-dir"]\naccount_aliases={"fixture@example.test"="fx"}\n';p.write_text(original)
        args=self.launcher.status_override([],self.env,['model-with-reasoning','current-dir','thread-name'])
        self.assertEqual(json.loads(args[1].split('=',1)[1]),['model-with-reasoning','account','weekly-limit','current-dir']);self.assertEqual(p.read_text(),original)

    def test_existing_account_and_explicit_hidden_footer_are_preserved(self):
        for selected in [['model-with-reasoning','account'],[]]:
            (self.home/'config.toml').write_text('[tui]\nstatus_line='+json.dumps(selected))
            self.assertEqual(self.launcher.status_override([],self.env,[]),[])

    def test_missing_configuration_has_account_after_model_before_weekly(self):
        defaults=__import__('tomllib').loads((TOOLS/'defaults.toml').read_text())
        args=self.launcher.status_override([],self.env,defaults['tui']['status_line'])
        self.assertEqual(json.loads(args[1].split('=',1)[1])[:3],['model-with-reasoning','account','weekly-limit'])
        self.assertEqual(json.loads(args[1].split('=',1)[1])[-3:],['context-used','five-hour-limit','task-progress'])

    def test_fresh_home_gets_permission_and_privacy_defaults_without_writes(self):
        defaults=__import__('tomllib').loads((TOOLS/'defaults.toml').read_text())
        args=self.launcher.default_overrides([],self.env,defaults)
        self.assertIn('approval_policy="never"',args)
        self.assertIn('sandbox_mode="danger-full-access"',args)
        for value in ['analytics.enabled=false','feedback.enabled=false','otel.log_user_prompt=false',
                      'otel.exporter="none"','otel.trace_exporter="none"','otel.metrics_exporter="none"']:
            self.assertIn(value,args)
        self.assertEqual(list(self.home.iterdir()),[])

    def test_existing_permission_privacy_and_selected_profile_are_preserved(self):
        original='approval_policy="on-request"\n[analytics]\nenabled=true\n[profiles.safe]\nsandbox_mode="read-only"\n'
        (self.home/'config.toml').write_text(original)
        defaults=__import__('tomllib').loads((TOOLS/'defaults.toml').read_text())
        args=self.launcher.default_overrides(['--profile','safe'],self.env,defaults)
        self.assertFalse(any(v.startswith(('approval_policy=','sandbox_mode=','analytics.enabled=')) for v in args))
        self.assertIn('feedback.enabled=false',args)
        self.assertEqual((self.home/'config.toml').read_text(),original)

    def test_explicit_opt_out_and_malformed_config_are_not_overridden(self):
        defaults=__import__('tomllib').loads((TOOLS/'defaults.toml').read_text())
        self.assertEqual(self.launcher.default_overrides([],dict(self.env,SWIFT_CODEX_DEFAULTS_POLICY='off'),defaults),[])
        (self.home/'config.toml').write_text('[broken')
        self.assertEqual(self.launcher.default_overrides([],self.env,defaults),[])

    def test_diagnostics_do_not_read_private_ui_configuration(self):
        with patch.object(Path,'read_text',side_effect=AssertionError('configuration unexpectedly read')):
            self.assertEqual(self.launcher.status_override(['--version'],self.env,[]),[])
            self.assertEqual(self.launcher.status_override(['app-server'],self.env,[]),[])


if __name__=='__main__':unittest.main()
