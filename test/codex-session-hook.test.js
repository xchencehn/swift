'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const { spawn } = require('node:child_process');
const { CodexSessionHook } = require('../lib/codex-session-hook');

const upstream = `#!/bin/sh
# installed by herdr
# HERDR_INTEGRATION_ID=codex
# HERDR_INTEGRATION_VERSION=8
set -eu
cat >/dev/null
printf 'reported-session\\n'
`;

test('安装仅修改生成的钩子，保留正文与权限，集成重装后恢复校验且不重复插入', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-hook-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'herdr-agent-state.sh');
  await fs.writeFile(file, upstream, { mode: 0o700 });
  const hook = new CodexSessionHook({ retryMs: 0 });
  await Promise.all([hook.ensure(home), hook.ensure(home)]);
  const updated = await fs.readFile(file, 'utf8');
  assert.match(updated, /herdr-session-guard\.py/);
  assert.equal(
    updated.replace(
      /# BEGIN SWIFT CODEX SESSION OWNER\n[\s\S]*?# END SWIFT CODEX SESSION OWNER\n/,
      '',
    ),
    upstream,
  );
  assert.equal((await fs.stat(file)).mode & 0o777, 0o700);
  await hook.ensure(home);
  assert.equal(await fs.readFile(file, 'utf8'), updated);
  await fs.writeFile(file, upstream);
  await hook.ensure(home);
  assert.equal(await fs.readFile(file, 'utf8'), updated);
  await fs.writeFile(file, '#!/bin/sh\n# custom hook\n');
  await hook.ensure(home);
  assert.equal(await fs.readFile(file, 'utf8'), '#!/bin/sh\n# custom hook\n');
});

test(
  '真实进程与 Unix socket 拦截继承标签身份的后台报告，保留前台自身的报告',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-hook-process-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const hook = path.join(home, 'herdr-agent-state.sh'),
      binary = path.join(home, 'codex'),
      socketFile = path.join(home, 's');
    await fs.writeFile(hook, upstream, { mode: 0o700 });
    await new CodexSessionHook().ensure(home);
    await fs.symlink('/usr/bin/python3', binary);
    let foreground = 0,
      queries = 0;
    const server = net.createServer((socket) =>
      socket.once('data', (data) => {
        const request = JSON.parse(data.toString());
        queries++;
        assert.equal(request.method, 'pane.process_info');
        socket.end(
          JSON.stringify({
            id: request.id,
            result: {
              process_info: { pane_id: 'w1:p2', foreground_processes: [{ pid: foreground }] },
            },
          }) + '\n',
        );
      }),
    );
    await new Promise((resolve) => server.listen(socketFile, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    async function run(nested, stale = false) {
      const worker =
        'import subprocess,sys; p=subprocess.run(["sh",sys.argv[1],"session"],input="{\\"session_id\\":\\"other-session\\"}",text=True,capture_output=True); print(p.stdout,end=""); sys.exit(p.returncode)';
      const code = nested
        ? 'import subprocess,sys; sys.exit(subprocess.call([sys.executable,"-c",sys.argv[2],sys.argv[1]]))'
        : worker;
      const child = spawn(binary, ['-c', code, hook, worker], {
        env: {
          ...process.env,
          HERDR_ENV: '1',
          HERDR_PANE_ID: 'w1:p2',
          HERDR_SOCKET_PATH: socketFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      foreground = stale ? child.pid + 1 : child.pid;
      let out = '',
        err = '';
      child.stdout.on('data', (data) => (out += data));
      child.stderr.on('data', (data) => (err += data));
      const status = await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(status, 0, err);
      return out;
    }
    assert.equal(await run(false), 'reported-session\n');
    assert.equal(
      await run(true),
      '',
      'The background Codex inherits the same pane but must not report into its foreground parent',
    );
    assert.equal(await run(false, true), '', 'A stale foreground association is rejected');
    assert.equal(queries, 3);
  },
);
