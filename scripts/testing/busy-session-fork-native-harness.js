'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  syncFs = require('node:fs');
const os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { HerdrClient } = require('../../lib/herdr-client');
const { CodexFork, readGoalDeferral } = require('../../lib/codex-fork');
const { processStart } = require('../../lib/codex-restart');
const { readCodexGoalRecord } = require('../../lib/agent-goal');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const codexProcesses = (info) =>
  info.foreground_processes.filter((process) => process.name === 'codex');

async function runCase(output, { cols = 100, sharedDaemon = false } = {}) {
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-busy-fork-'));
  const home = path.join(temporary, '.codex'),
    config = path.join(temporary, 'herdr.toml'),
    session = 'swift';
  // Bypass the local convenience launcher and its updater inside the fixture.
  // Other installations can supply their native binary explicitly.
  const custom = path.join(os.homedir(), '.local/share/codex-custom/current/bin/codex');
  const binary =
    process.env.SWIFT_CODEX_FIXTURE_BIN || (syncFs.existsSync(custom) ? custom : 'codex');
  let client, cli, modelServer, herdrFixture, fixtureEnv;
  const requests = [],
    held = [],
    phases = [],
    writes = [];
  const write = (name, value) =>
    fs.writeFile(
      path.join(output, name),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    );
  try {
    await fs.mkdir(home);
    await fs.mkdir(path.join(temporary, 'runtime'), { mode: 0o700 });
    await fs.mkdir(path.join(temporary, 'bin'));
    await fs.writeFile(
      path.join(temporary, 'bin/codex'),
      '#!/bin/sh\nexec ' + quote(binary) + ' "$@"\n',
      { mode: 0o755 },
    );
    await fs.writeFile(
      config,
      'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
    );
    const env = {
      PATH: path.join(temporary, 'bin') + ':' + process.env.PATH,
      HOME: temporary,
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: home,
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
    fixtureEnv = env;
    modelServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      let raw = '';
      req.on('data', (part) => {
        raw += part;
      });
      req.on('end', () => {
        const number = requests.length + 1,
          id = 'response-fixture-' + number;
        requests.push({
          number,
          url: req.url,
          at: Date.now(),
          goalRequest: raw.includes('SWIFT_BUSY_GOAL_FIXTURE'),
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let sequence = 0;
        const event = (type, value) =>
          res.write(
            'event: ' +
              type +
              '\ndata: ' +
              JSON.stringify({ type, sequence_number: sequence++, ...value }) +
              '\n\n',
          );
        event('response.created', {
          response: { id, object: 'response', status: 'in_progress', output: [] },
        });
        if (number > 1) {
          held.push(res);
          return;
        }
        const item = {
          id: 'message-fixture',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'BUSY_FORK_FIXTURE_READY', annotations: [] }],
        };
        event('response.output_item.added', {
          output_index: 0,
          item: { ...item, status: 'in_progress', content: [] },
        });
        event('response.content_part.added', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        event('response.output_text.delta', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: 'BUSY_FORK_FIXTURE_READY',
        });
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', {
          response: {
            id,
            object: 'response',
            status: 'completed',
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        res.end();
      });
    });
    await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
    await fs.writeFile(
      path.join(home, 'config.toml'),
      `model_provider = "fixture"\nmodel = "fixture-model"\ncheck_for_update_on_startup = false\n[features]\ngoals = true\nplugins = false\n[analytics]\nenabled = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${modelServer.address().port}/v1"\nenv_key = "SWIFT_FIXTURE_KEY"\nwire_api = "responses"\n[projects.${JSON.stringify(temporary)}]\ntrust_level = "trusted"\n`,
    );
    const seed = await new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        ['exec', '--cd', temporary, '--skip-git-repo-check', '--json', 'SWIFT_BUSY_FORK_SEED'],
        { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout.on('data', (bytes) => {
        stdout += bytes;
      });
      child.stderr.on('data', () => {});
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Isolated Codex seed timed out'));
      }, 60000);
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve(stdout) : reject(new Error('Isolated Codex seed failed'));
      });
    });
    await write('seed.jsonl', seed);
    const parentId = seed
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'thread.started').thread_id;
    cli = (args) => {
      const response = JSON.parse(
        execFileSync('herdr', ['--session', session, ...args], {
          cwd: temporary,
          env,
          encoding: 'utf8',
          timeout: 45000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) || '{}',
      );
      assert(!response.error);
      return response.result || response;
    };
    client = require('node-pty').spawn('herdr', ['--session', session], {
      cwd: temporary,
      env,
      cols,
      rows: 45,
    });
    client.onData(() => {});
    let snapshot;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        snapshot = cli(['api', 'snapshot']).snapshot;
        if (snapshot?.panes?.length) break;
      } catch {}
      await delay(100);
    }
    assert(snapshot?.panes?.length);
    const created = cli([
        'workspace',
        'create',
        '--label',
        'busy fork fixture',
        '--cwd',
        temporary,
        '--no-focus',
      ]),
      parentPane = created.root_pane.pane_id;
    async function findSocket(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = path.join(directory, entry.name);
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
    herdr.env = (extra) => ({ ...env, ...extra });
    herdrFixture = herdr;
    cli([
      'agent',
      'start',
      'busy_parent',
      '--kind',
      'codex',
      '--pane',
      parentPane,
      '--',
      'resume',
      parentId,
      ...(sharedDaemon ? [] : ['--no-daemon']),
      '--no-alt-screen',
      '--cd',
      temporary,
    ]);
    const exactPane = async (id) => {
      const pane = (await herdr.dashboard()).panes.find((item) => item.paneId === id);
      if (!pane) return null;
      const processes = codexProcesses(await herdr.readProcessInfo(id));
      if (processes.length === 1) pane.runtimeId = await processStart(processes[0].pid);
      return pane;
    };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await herdr.readPane(parentPane, { lines: 100, ansi: false })).includes(
          'BUSY_FORK_FIXTURE_READY',
        )
      ) {
        ready = true;
        break;
      }
      await delay(100);
    }
    assert(ready);
    await herdr.request('pane.send_input', {
      pane_id: parentPane,
      text: '/goal SWIFT_BUSY_GOAL_FIXTURE',
      keys: [],
    });
    await delay(150);
    await herdr.request('agent.send_keys', { target: parentPane, keys: ['enter'] });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (requests.length === 2 && readCodexGoalRecord(parentId, { home })?.status === 'active')
        break;
      await delay(100);
    }
    assert.equal(requests.length, 2);
    assert.equal(readCodexGoalRecord(parentId, { home }).status, 'active');
    assert.equal(held.length, 1);
    assert(!held[0].destroyed);
    await herdr.request('pane.report_agent_session', {
      pane_id: parentPane,
      source: 'herdr:codex',
      agent: 'codex',
      seq: Date.now() * 1e6,
      agent_session_id: parentId,
      session_start_source: 'resume',
    });
    await write(
      'parent-busy-screen.txt',
      await herdr.readPane(parentPane, { lines: 100, ansi: true }),
    );
    const original = await exactPane(parentPane),
      beforeProcess = await herdr.readProcessInfo(parentPane),
      beforeView = await herdr.dashboard(),
      beforeRequests = requests.length;
    await write('original.json', original);
    await write('original-process.json', beforeProcess);
    const request = herdr.request.bind(herdr),
      run = herdr.run.bind(herdr);
    herdr.request = async (method, params, options) => {
      if (
        [
          'pane.send_input',
          'pane.send_text',
          'pane.send_keys',
          'agent.send_keys',
          'agent.prompt',
        ].includes(method)
      )
        writes.push({ method, paneId: params.pane_id || params.target });
      return request(method, params, options);
    };
    herdr.run = async (args, options) => {
      if (args[0] === 'pane' && args[1] === 'run')
        writes.push({ method: 'pane.run', paneId: args[2] });
      return run(args, options);
    };
    const native = new CodexFork({ herdr, exactPane });
    const result = await native.run(original, {
      validate: async () => {
        const current = await exactPane(parentPane);
        assert.equal(current.terminalId, original.terminalId);
        assert.equal(current.runtimeId, original.runtimeId);
        assert.equal(current.agent.session.value, parentId);
      },
      progress: async (fields) => {
        phases.push(fields);
        await write('progress.json', phases);
      },
    });
    await delay(1500);
    const afterProcess = await herdr.readProcessInfo(parentPane),
      afterView = await herdr.dashboard(),
      parentGoal = readCodexGoalRecord(parentId, { home }),
      childGoal = readCodexGoalRecord(result.sessionId, { home });
    assert.deepEqual(codexProcesses(afterProcess), codexProcesses(beforeProcess));
    assert.equal(afterProcess.shell_pid, beforeProcess.shell_pid);
    assert.equal(
      afterProcess.foreground_process_group_id,
      beforeProcess.foreground_process_group_id,
    );
    assert.equal(afterView.focusedPaneId, beforeView.focusedPaneId);
    assert.equal(parentGoal.status, 'active');
    assert.equal(childGoal.status, 'paused');
    assert.equal(requests.length, beforeRequests);
    assert(held.length === 1 && !held[0].destroyed);
    assert(writes.every((write) => write.paneId === result.paneId));
    assert(readGoalDeferral(result.sessionId, { home }));
    const tabs = afterView.tabs.filter((tab) => tab.workspace_id === original.workspaceId),
      index = tabs.findIndex((tab) => tab.tab_id === original.tabId);
    assert.equal(tabs[index + 1].tab_id, result.tabId);
    const childInfo = await herdr.readProcessInfo(result.paneId),
      childProcess = codexProcesses(childInfo)[0];
    const childArgv = (await fs.readFile('/proc/' + childProcess.pid + '/cmdline', 'utf8'))
      .split('\0')
      .filter(Boolean);
    assert(childArgv.includes('resume'));
    assert.equal(childArgv[childArgv.indexOf('resume') + 1], result.sessionId);
    const binaryPath = await fs.readlink('/proc/' + childProcess.pid + '/exe');
    await write(
      'child-paused-screen.txt',
      await herdr.readPane(result.paneId, { lines: 100, ansi: true }),
    );
    const report = {
      ok: true,
      terminalColumns: cols,
      codexVersion: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
      codexBinarySha256: createHash('sha256')
        .update(await fs.readFile(binaryPath))
        .digest('hex'),
      herdrVersion: execFileSync('herdr', ['--version'], { encoding: 'utf8' }).trim(),
      parent: {
        paneId: parentPane,
        terminalId: original.terminalId,
        sessionId: parentId,
        processRuntimeId: original.runtimeId,
      },
      child: result,
      parentGoal,
      childGoal,
      phases,
      nativeWrites: writes,
      seedRequests: 1,
      parentGoalRequests: 1,
      forkAndChildModelRequests: requests.length - beforeRequests,
      parentPtyWritesAfterBusy: writes.filter((write) => write.paneId === parentPane).length,
      parentProcessUnchanged: true,
      parentTurnStillRunning: true,
      parentGoalStillActive: true,
      childGoalPaused: true,
      childContinuationDeferred: true,
      adjacentTab: true,
      nativeFocusPreserved: true,
      realHerdrTransport: true,
      isolatedHome: true,
      sharedDaemon,
      localSyntheticResponses: true,
      externalModel: false,
      externalInference: false,
      productionInput: false,
    };
    if (sharedDaemon) {
      const daemon = JSON.parse(
        execFileSync(binary, ['app-server', 'daemon', 'version'], {
          cwd: temporary,
          env,
          encoding: 'utf8',
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
      const version = report.codexVersion.replace(/^codex-cli\s+/, '');
      assert.equal(daemon.status, 'running');
      assert.equal(daemon.backend, 'pid');
      for (const field of ['managedCodexVersion', 'cliVersion', 'appServerVersion'])
        assert.equal(daemon[field], version);
      assert.equal(
        daemon.socketPath,
        path.join(home, 'app-server-control/app-server-control.sock'),
      );
      assert(daemon.managedCodexPath.startsWith(home + path.sep));
      await write('daemon-version.json', daemon);
      report.isolatedDaemonObserved = true;
    }
    await write('report.json', report);
    return report;
  } catch (error) {
    await write('failure.json', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      partial: error.partial,
      requests,
      phases,
      writes,
    });
    if (herdrFixture && phases.at(-1)?.paneId) {
      await write(
        'child-process-failure.json',
        await herdrFixture
          .readProcessInfo(phases.at(-1).paneId)
          .catch((error) => ({ error: error.message })),
      );
      await write(
        'child-screen-failure.txt',
        await herdrFixture
          .readPane(phases.at(-1).paneId, { lines: 100, ansi: true })
          .catch(() => ''),
      );
    }
    throw error;
  } finally {
    await write('model-requests.json', requests);
    if (modelServer) {
      modelServer.closeAllConnections();
      await new Promise((resolve) => modelServer.close(resolve));
    }
    if (cli)
      try {
        cli(['server', 'stop']);
      } catch {}
    if (client)
      try {
        client.kill();
      } catch {}
    if (sharedDaemon && fixtureEnv)
      try {
        execFileSync(binary, ['app-server', 'daemon', 'stop'], {
          cwd: temporary,
          env: fixtureEnv,
          timeout: 15000,
          stdio: 'ignore',
        });
      } catch {}
    await delay(300);
    for (const entry of await fs.readdir('/proc'))
      if (/^\d+$/.test(entry))
        try {
          const cwd = await fs.readlink('/proc/' + entry + '/cwd'),
            name = (await fs.readFile('/proc/' + entry + '/comm', 'utf8')).trim();
          if (
            (cwd === temporary || cwd.startsWith(temporary + '/')) &&
            /^codex(?:-app-server)?$/.test(name)
          )
            process.kill(Number(entry), 'SIGTERM');
        } catch {}
    await delay(300);
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
async function run(output) {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    results = [];
  for (const options of [{ cols: 100 }, { cols: 45 }, { cols: 100, sharedDaemon: true }])
    results.push(
      await runCase(
        path.join(output, options.sharedDaemon ? 'daemon-100' : String(options.cols)),
        options,
      ),
    );
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  const report = {
    ok: true,
    before,
    after,
    results,
    productionInput: false,
    externalInference: false,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
module.exports = { run, runCase };
if (require.main === module)
  run(path.resolve(process.argv[2] || 'artifacts/testing/busy-session-fork/native'))
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
