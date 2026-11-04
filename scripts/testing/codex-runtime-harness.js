'use strict';
// Native acceptance uses a verified runtime, isolated HOME and synthetic accounts only.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { managedCodexBinary } = require('../../lib/codex-runtime');
const root = path.resolve(__dirname, '../..'),
  before = sourceFingerprint(root);
const output = path.join(root, 'artifacts/testing/codex-runtime/native');
fs.mkdirSync(output, { recursive: true });
const original =
  process.env.SWIFT_CODEX_VERIFIED_ROOT || path.join(os.homedir(), '.local/share/swift/codex');
const work = fs.mkdtempSync(path.join(output, 'run-')),
  home = path.join(work, 'home'),
  runtime = path.join(work, 'runtime');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: '1', SWIFT_CODEX_ROOT: runtime };
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, ...options });
const compiler = path.join(
  execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim(),
  'bin/rustc',
);
let report = { ok: false, before, work, productionInput: false, externalInference: false };
try {
  const originalBinary = fs.realpathSync(path.join(original, 'current/bin/codex')),
    originalInode = fs.statSync(originalBinary).ino;
  const archive = path.join(work, 'runtime.tar.gz');
  run('/usr/bin/python3', [
    '-B',
    'runtime/codex/manager.py',
    'export',
    '--root',
    original,
    '--archive',
    archive,
  ]);
  const npmPackage =
    process.env.SWIFT_CODEX_NPM_PACKAGE ||
    path.join(os.homedir(), '.npm-global/lib/node_modules/@openai/codex/package.json');
  const installation = run('/usr/bin/python3', [
    '-B',
    'deploy/codex/install.py',
    '--source',
    root,
    '--root',
    runtime,
    '--npm-package',
    npmPackage,
    '--node',
    process.execPath,
    '--mode',
    'follower',
    '--scheduler',
    'none',
    '--archive',
    archive,
  ]);
  fs.writeFileSync(path.join(work, 'installation.log'), installation);
  const release = fs.realpathSync(path.join(runtime, 'current'));
  assert.equal(managedCodexBinary({ root: runtime }), path.join(release, 'bin/codex'));
  const module = fs
    .readFileSync(path.join(release, 'source-evidence/account.rs'), 'utf8')
    .replace('    use pretty_assertions::assert_eq;\n', '');
  fs.writeFileSync(path.join(work, 'account-tests.rs'), module);
  run(compiler, [
    '--edition=2024',
    '--test',
    path.join(work, 'account-tests.rs'),
    '-o',
    path.join(work, 'account-tests'),
  ]);
  const unit = run(path.join(work, 'account-tests'), []);
  fs.writeFileSync(path.join(work, 'account-tests.log'), unit);
  assert.match(unit, /3 passed; 0 failed/);
  const imported = fs
    .readdirSync(path.join(runtime, 'builds'))
    .find((name) => name.startsWith('import-'));
  const proof = path.join(runtime, 'builds', imported);
  const display = JSON.parse(fs.readFileSync(path.join(proof, 'display.json'))),
    remote = JSON.parse(fs.readFileSync(path.join(proof, 'remote-display.json')));
  assert.equal(display.results.length, 5);
  assert(display.results.every((item) => item.passed));
  assert(remote.passed);
  assert.equal(remote.results[0].alias, 'chen');
  assert.equal(display.modelRequests, 0);
  assert.equal(remote.modelRequests, 0);
  const hforkDirectory = fs.readdirSync(proof).find((name) => name.startsWith('native-'));
  const hfork = JSON.parse(fs.readFileSync(path.join(proof, hforkDirectory, 'report.json')));
  assert(hfork.passed);
  assert.equal(hfork.modelRequests, 0);
  // Exercise the installed launcher as well as the native binary. The launcher sees only fixture UI settings.
  fs.copyFileSync(
    path.join(root, 'runtime/codex/check-status.cjs'),
    path.join(work, 'check-status.cjs'),
  );
  const nodeModules = JSON.parse(fs.readFileSync(path.join(runtime, 'config.json'))).nodeModules;
  const launcherLog = run(
    process.execPath,
    [path.join(work, 'check-status.cjs'), path.join(home, '.local/bin/codex'), '--quick'],
    { env: { ...env, NODE_PATH: nodeModules } },
  );
  fs.writeFileSync(path.join(work, 'launcher.log'), launcherLog);
  const launcher = JSON.parse(fs.readFileSync(path.join(work, 'installed-display.json')));
  assert(launcher.passed);
  assert.equal(launcher.modelRequests, 0);
  const defaults = JSON.parse(
    run('/usr/bin/python3', [
      '-B',
      'runtime/codex/check-defaults.py',
      path.join(home, '.local/bin/codex'),
    ]),
  );
  assert(defaults.ok);
  fs.writeFileSync(path.join(work, 'defaults.json'), JSON.stringify(defaults, null, 2));
  assert.equal(fs.statSync(originalBinary).ino, originalInode);
  const after = sourceFingerprint(root);
  assert.deepEqual(after, before);
  report = {
    ...report,
    ok: true,
    after,
    aliasCases: 5,
    rustUnitTests: 3,
    officialServer: true,
    nativeHfork: true,
    installedLauncher: true,
    managedBinarySelected: true,
    originalBinaryInodePreserved: true,
    modelRequests: 0,
    active: JSON.parse(installation.trim().split('\n').at(-1)).active,
  };
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    ok: true,
    source: before,
    aliasCases: 5,
    rustUnitTests: 3,
    modelRequests: 0,
    output,
  }),
);
