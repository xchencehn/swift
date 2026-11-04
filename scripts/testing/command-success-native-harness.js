'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { HerdrClient } = require('../../lib/herdr-client'),
  { CommandInteraction } = require('../../lib/command-interaction');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(output, { cols = 100 } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-commands-')),
    session = `swift-commands-${process.pid}`,
    config = path.join(temporary, 'config.toml');
  await fs.mkdir(path.join(temporary, '.codex'));
  await fs.mkdir(path.join(temporary, 'runtime'), { mode: 0o700 });
  await fs.writeFile(
    config,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  const env = {
    PATH: process.env.PATH,
    HOME: temporary,
    CODEX_HOME: path.join(temporary, '.codex'),
    XDG_CONFIG_HOME: path.join(temporary, '.config'),
    XDG_STATE_HOME: path.join(temporary, 'state'),
    XDG_DATA_HOME: path.join(temporary, 'data'),
    XDG_CACHE_HOME: path.join(temporary, 'cache'),
    XDG_RUNTIME_DIR: path.join(temporary, 'runtime'),
    HERDR_CONFIG_PATH: config,
    HERDR_SESSION: session,
    SHELL: '/bin/sh',
    ENV: '',
    BASH_ENV: '',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    SWIFT_FIXTURE_KEY: 'fixture-not-a-real-key',
    DISABLE_AUTOUPDATER: '1',
  };
  const cli = (args) =>
    execFileSync('herdr', ['--session', session, ...args], {
      cwd: temporary,
      env,
      encoding: 'utf8',
      timeout: 45000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const json = (args) => {
    const result = JSON.parse(cli(args));
    assert(!result.error);
    return result.result || result;
  };
  const client = require('node-pty').spawn('herdr', ['--session', session], {
      cwd: temporary,
      env,
      cols,
      rows: 40,
    }),
    drain = client.onData(() => {});
  try {
    let snapshot;
    for (let i = 0; i < 80; i++) {
      try {
        snapshot = json(['api', 'snapshot']).snapshot;
        if (snapshot?.panes?.length) break;
      } catch {}
      await delay(100);
    }
    assert(snapshot?.panes?.length);
    const created = json([
        'workspace',
        'create',
        '--label',
        'command fixture',
        '--cwd',
        temporary,
        '--no-focus',
      ]),
      paneId = created.root_pane.pane_id;
    async function findSocket(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const name = path.join(dir, entry.name);
        if (entry.isSocket() && entry.name === 'herdr.sock') return name;
        if (entry.isDirectory()) {
          const found = await findSocket(name);
          if (found) return found;
        }
      }
      return null;
    }
    const socketPath = await findSocket(temporary);
    assert(socketPath);
    const herdr = new HerdrClient({ session, socketPath });
    herdr.resolveTarget = async (target) => ({ paneId: target });
    const args = [
      '--no-alt-screen',
      '--sandbox',
      'workspace-write',
      '-a',
      'never',
      '-c',
      'model_provider="fixture"',
      '-c',
      'model="gpt-6.1-sol"',
      '-c',
      'model_providers.fixture.name="Fixture"',
      '-c',
      'model_providers.fixture.base_url="http://127.0.0.1:9/v1"',
      '-c',
      'model_providers.fixture.env_key="SWIFT_FIXTURE_KEY"',
      '-c',
      'model_providers.fixture.wire_api="responses"',
      '-c',
      `projects."${temporary}".trust_level="trusted"`,
    ];
    json(['agent', 'start', 'command_fixture', '--kind', 'codex', '--pane', paneId, '--', ...args]);
    const exactPane = async (id) => (await herdr.dashboard()).panes.find((p) => p.paneId === id);
    const service = new CommandInteraction({ herdr, exactPane, settleMs: 160 });
    let serial = 0,
      view;
    async function call(action, extra = {}) {
      const dashboard = await herdr.dashboard(),
        pane = dashboard.panes.find((p) => p.paneId === paneId);
      return service.handle({
        paneId,
        terminalId: pane.terminalId,
        sessionId: pane.agent?.session?.value || '',
        runtimeId: dashboard.runtimeId,
        clientId: 'native-fixture',
        requestId: 'native-' + ++serial,
        leaseId: view?.leaseId,
        action,
        ...extra,
      });
    }
    await fs.mkdir(output, { recursive: true });
    await herdr.focusPane(paneId);
    for (let i = 0; i < 100; i++) {
      if (/›/.test(await herdr.readPane(paneId, { lines: 80, ansi: false }))) break;
      await delay(100);
    }
    const probes = [];
    for (const text of ['/status', '/goal resume', '/goal clear']) {
      try {
        const dashboard = await herdr.dashboard(),
          pane = dashboard.panes.find((p) => p.paneId === paneId);
        view = await service.execute({
          paneId,
          terminalId: pane.terminalId,
          sessionId: pane.agent?.session?.value || '',
          runtimeId: dashboard.runtimeId,
          clientId: 'native-fixture',
          requestId: 'probe-' + ++serial,
          text,
        });
        for (let i = 0; i < 20 && (view.pending || view.mode === 'query'); i++) {
          await delay(200);
          view = await call('read', { leaseId: view.leaseId });
        }
        assert.equal(view.mode, 'result');
        assert(!view.pending);
        assert.equal(Boolean(view.failed), text === '/goal resume');
        probes.push({ text, view, raw: await herdr.readPane(paneId, { lines: 160, ansi: true }) });
        await fs.writeFile(
          path.join(output, 'command-probes.json'),
          JSON.stringify(probes, null, 2),
        );
        view = await call('close', { leaseId: view.leaseId });
      } catch (error) {
        probes.push({
          text,
          error: error.message,
          raw: await herdr.readPane(paneId, { lines: 160, ansi: true }),
        });
        await fs.writeFile(
          path.join(output, 'command-probes.json'),
          JSON.stringify(probes, null, 2),
        );
        throw error;
      }
    }
    const report = {
      ok: true,
      terminalColumns: cols,
      codexVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      productionInput: false,
      externalInference: false,
      probes: probes.map((p) => ({
        text: p.text,
        mode: p.view?.mode,
        failed: Boolean(p.view?.failed),
      })),
    };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    try {
      cli(['server', 'stop']);
    } catch {}
    drain.dispose();
    try {
      client.kill();
    } catch {}
    await delay(300);
    for (const entry of await fs.readdir('/proc'))
      if (/^\d+$/.test(entry)) {
        try {
          const cwd = await fs.readlink('/proc/' + entry + '/cwd'),
            name = (await fs.readFile('/proc/' + entry + '/comm', 'utf8')).trim();
          if (
            (cwd === temporary || cwd.startsWith(temporary + '/')) &&
            /^codex(?:-app-server)?$/.test(name)
          )
            process.kill(Number(entry), 'SIGTERM');
        } catch {}
      }
    await delay(300);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module)
  (async () => {
    for (const cols of [100, 45])
      console.log(
        JSON.stringify(
          await run(
            path.resolve('artifacts/testing/command-success-dismiss/native', String(cols)),
            { cols },
          ),
        ),
      );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
