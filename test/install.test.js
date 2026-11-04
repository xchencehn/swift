'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'portable project 100%/.code/swift'),
    home = path.join(dir, 'home'),
    bin = path.join(dir, 'bin');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.cpSync(path.join(root, 'deploy'), path.join(source, 'deploy'), { recursive: true });
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const operations = path.join(dir, 'operations');
  for (const command of ['npm', 'systemctl'])
    fs.writeFileSync(
      path.join(bin, command),
      `#!/bin/sh\nprintf '%s\\n' '${command}' "$@" >> '${operations}'\n`,
      { mode: 0o755 },
    );
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const run = () =>
    spawnSync(
      'bash',
      ['deploy/install.sh', '--root', path.join(dir, 'projects'), '--herdr', herdr, '--no-start'],
      { cwd: source, env, encoding: 'utf8' },
    );
  return { dir, source, home, operations, run };
}
test('任意目录安装生成自有单元且不启动服务，重复安装保留配置', (t) => {
  const f = fixture(t),
    first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const config = path.join(f.source, '.local/config/swift.env'),
    bytes = fs.readFileSync(config);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  const service = path.join(f.home, '.config/systemd/user/swift.service');
  assert.equal(
    fs.realpathSync(service),
    path.join(f.source, '.local/config/systemd/swift.service'),
  );
  const unit = fs.readFileSync(service, 'utf8');
  assert(unit.includes('portable\\x20project\\x20100%%/.code/swift/server.js'));
  assert(!unit.includes('%h/workdir/swift'));
  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  assert(fs.readFileSync(config).equals(bytes));
  assert(!fs.readFileSync(f.operations, 'utf8').includes('\nstart\n'));
  // Validate actual systemd parsing; no reload/start is sent to the user's manager.
  const verify = spawnSync(
    'systemd-analyze',
    ['verify', path.join(f.source, '.local/config/systemd/swift.service')],
    { env: { ...process.env, HOME: f.home }, encoding: 'utf8' },
  );
  assert.equal(verify.status, 0, verify.stderr);
});
test('其他安装的服务在依赖安装和写配置之前被拒绝', (t) => {
  const f = fixture(t),
    units = path.join(f.home, '.config/systemd/user');
  fs.mkdirSync(units, { recursive: true });
  const file = path.join(units, 'swift.service');
  fs.writeFileSync(file, 'owned elsewhere');
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(f.operations), false);
  assert.equal(fs.existsSync(path.join(f.source, '.local')), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'owned elsewhere');
});
test('通过管理仓兼容链接调用安装器仍绑定实际源码目录', (t) => {
  const f = fixture(t),
    entry = path.join(f.dir, 'management-entry');
  fs.mkdirSync(entry);
  fs.symlinkSync(path.join(f.source, 'deploy'), path.join(entry, 'deploy'));
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(
    'bash',
    ['deploy/install.sh', '--root', f.dir, '--herdr', path.join(f.dir, 'bin/herdr'), '--no-start'],
    {
      cwd: entry,
      env: { ...process.env, HOME: f.home, PATH: `${f.dir}/bin:${process.env.PATH}` },
      encoding: 'utf8',
    },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.existsSync(path.join(entry, '.local')), false);
  assert.equal(
    fs.realpathSync(path.join(f.home, '.config/systemd/user/swift.service')),
    path.join(f.source, '.local/config/systemd/swift.service'),
  );
});
test('升级移除旧 Shell 集成并让 Codex 继承用户账号与代理环境', (t) => {
  const f = fixture(t),
    binaryDirectory = path.join(f.home, '.local/bin'),
    configDirectory = path.join(f.home, '.config/swift');
  fs.mkdirSync(binaryDirectory, { recursive: true });
  fs.mkdirSync(configDirectory, { recursive: true });
  const keys = [
    'CODEX_HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
  ];
  const probe = path.join(f.dir, 'native-codex.js');
  fs.writeFileSync(
    probe,
    `console.log(JSON.stringify({ args: process.argv.slice(2), values: Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]])) }));`,
  );
  const config = path.join(configDirectory, 'execution.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      codex: { binary: process.execPath, args: [probe] },
      accounts: [{ home: '/retired-account' }],
    }),
  );
  const configBytes = fs.readFileSync(config);
  const launcher = path.join(binaryDirectory, 'codex');
  fs.writeFileSync(launcher, '#!/bin/sh\n# Swift-managed execution environment\nexit 99\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(binaryDirectory, 'swift'),
    '#!/bin/sh\n# Swift-managed execution environment\nexit 99\n',
    { mode: 0o755 },
  );
  const userStartup = '# user startup\nexport USER_PREFERENCE=keep\n';
  for (const name of ['.profile', '.bashrc', '.bash_profile'])
    fs.writeFileSync(
      path.join(f.home, name),
      userStartup +
        '# BEGIN Swift execution environment\nexport CODEX_HOME=/retired-account\n# END Swift execution environment\n',
    );
  const credentials = path.join(f.home, '.codex/auth.json');
  fs.mkdirSync(path.dirname(credentials));
  fs.writeFileSync(credentials, 'fixture-credential-preserved');
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stderr);
  for (const name of ['.profile', '.bashrc', '.bash_profile'])
    assert.equal(fs.readFileSync(path.join(f.home, name), 'utf8'), userStartup);
  assert(fs.readFileSync(config).equals(configBytes));
  assert.equal(fs.readFileSync(credentials, 'utf8'), 'fixture-credential-preserved');
  assert.equal(
    fs.realpathSync(path.join(binaryDirectory, 'swift')),
    path.join(f.source, 'deploy/swift.sh'),
  );
  const values = Object.fromEntries(keys.map((key, index) => [key, `user-choice-${index}`]));
  const result = spawnSync(launcher, ['resume', 'fixture-thread'], {
    env: { ...process.env, ...values },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['resume', 'fixture-thread'], values });
  const restored = fs.readFileSync(launcher),
    second = f.run();
  assert.equal(second.status, 0, second.stderr);
  assert(fs.readFileSync(launcher).equals(restored));
});
