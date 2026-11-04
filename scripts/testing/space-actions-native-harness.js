'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { HerdrClient } = require('../../lib/herdr-client'),
  { CommandInteraction } = require('../../lib/command-interaction');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(output, { cols = 100, shell = '/bin/sh', shellResidue = false } = {}) {
  const http = require('node:http'),
    requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    requests.push(body);
    const id = 'resp-' + requests.length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let seq = 0;
    const event = (type, value) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...value })}\n\n`,
      );
    event('response.created', {
      response: { id, object: 'response', status: 'in_progress', output: [] },
    });
    if (requests.length === 1) {
      const item = {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'FIXTURE READY', annotations: [] }],
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
        delta: 'FIXTURE READY',
      });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-commands-')),
    session = `swift-commands-${process.pid}`,
    config = path.join(temporary, 'config.toml');
  await fs.mkdir(path.join(temporary, '.codex'));
  await fs.mkdir(path.join(temporary, 'runtime'), { mode: 0o700 });
  await fs.writeFile(
    config,
    `onboarding = false\n[terminal]\ndefault_shell = "${shell}"\n[update]\nversion_check = false\nmanifest_check = false\n`,
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
    SHELL: shell,
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
    herdr.env = (extra) => ({ ...env, ...extra });
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
      `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
      '-c',
      'model_providers.fixture.env_key="SWIFT_FIXTURE_KEY"',
      '-c',
      'model_providers.fixture.wire_api="responses"',
      '-c',
      `projects."${temporary}".trust_level="trusted"`,
    ];
    json(['agent', 'start', 'command_fixture', '--kind', 'codex', '--pane', paneId, '--', ...args]);
    const { CodexRestart, processStart, captureLaunch } = require('../../lib/codex-restart');
    const exactPane = async (id) => {
      const pane = (await herdr.dashboard()).panes.find((p) => p.paneId === id);
      const info = await herdr.readProcessInfo(id);
      const process = info.foreground_processes.find((p) => p.name === 'codex');
      if (process) pane.runtimeId = await processStart(process.pid);
      return pane;
    };
    const press = (keys) =>
      require('../../lib/herdr-input').herdrRequest(
        'agent.send_keys',
        { target: paneId, keys },
        { socketFile: herdr.socketPath },
      );
    await require('../../lib/herdr-input').sendPaneMessage(paneId, 'SEED FIXTURE', {
      socketFile: herdr.socketPath,
    });
    for (let i = 0; i < 100; i++) {
      if ((await herdr.readPane(paneId, { lines: 45, ansi: false })).includes('FIXTURE READY'))
        break;
      await delay(150);
    }
    await require('../../lib/herdr-input').pastePaneText(
      paneId,
      '/goal Keep working on fixture goal',
      { socketFile: herdr.socketPath },
    );
    await delay(150);
    await press(['enter']);
    await delay(2500);
    const archives = (
      await fs.readdir(path.join(env.CODEX_HOME, 'sessions'), { recursive: true })
    ).filter((f) => f.endsWith('.jsonl'));
    assert.equal(archives.length, 1);
    const metadata = JSON.parse(
      (await fs.readFile(path.join(env.CODEX_HOME, 'sessions', archives[0]), 'utf8')).split(
        '\n',
      )[0],
    );
    await require('../../lib/herdr-input').herdrRequest(
      'pane.report_agent_session',
      {
        pane_id: paneId,
        source: 'herdr:codex',
        agent: 'codex',
        seq: Date.now() * 1e6,
        agent_session_id: metadata.payload.id,
      },
      { socketFile: herdr.socketPath },
    );
    const original = await exactPane(paneId);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'original.json'), JSON.stringify(original, null, 2));
    await fs.writeFile(
      path.join(output, 'screen.txt'),
      await herdr.readPane(paneId, { lines: 70, ansi: false }),
    );
    assert(original.agent?.session?.value);
    const launch = await captureLaunch(herdr, original),
      readGoal = () =>
        require('../../lib/agent-goal').readCodexGoalRecord(original.agent.session.value, {
          home: launch.goalHome,
        });
    const goalBefore = readGoal();
    assert.equal(goalBefore.status, 'active');
    const requestCount = requests.length;
    const restart = new CodexRestart({ herdr, exactPane });
    const createdIdle = await herdr.json([
      'tab',
      'create',
      '--workspace',
      original.workspaceId,
      '--cwd',
      temporary,
      '--label',
      'idle Codex',
      '--no-focus',
    ]);
    const idleId = createdIdle.root_pane.pane_id;
    await herdr.json([
      'agent',
      'start',
      'idle_fixture',
      '--kind',
      'codex',
      '--pane',
      idleId,
      '--',
      ...args,
    ]);
    const { ConversationStore } = require('../../lib/conversation-store'),
      lock = new ConversationStore(),
      { MessageQueue } = require('../../lib/message-queue');
    const queue = new MessageQueue({
      file: path.join(temporary, 'messages.json'),
      getPane: exactPane,
      getNativePane: exactPane,
      sendNative: (item) =>
        lock.operate(item.paneId, () =>
          require('../../lib/herdr-input').sendPaneMessage(item.paneId, item.text, {
            socketFile: herdr.socketPath,
          }),
        ),
    });
    const controller = new (require('../../lib/space-actions').SpaceActions)({
      herdr,
      exactPane,
      operate: (id, run) => lock.operate(id, run),
      restart,
      file: path.join(temporary, 'actions.json'),
    });
    let idleBefore;
    for (let i = 0; i < 100; i++) {
      idleBefore = await exactPane(idleId);
      if (idleBefore.runtimeId) break;
      await delay(100);
    }
    assert(idleBefore.runtimeId);
    const singlePreview = await controller.preview(original.workspaceId, paneId);
    assert.equal(singlePreview.targets.length, 1);
    let residueInjected = false;
    if (shellResidue) {
      const readProcess = herdr.readProcessInfo.bind(herdr);
      herdr.readProcessInfo = async (id) => {
        const info = await readProcess(id);
        if (
          id === paneId &&
          !residueInjected &&
          info.foreground_process_group_id === launch.shellPid &&
          info.foreground_processes.every((p) => p.pid === launch.shellPid)
        ) {
          residueInjected = true;
          await require('../../lib/herdr-input').herdrRequest(
            'pane.send_text',
            { pane_id: paneId, text: '\x1b[99;5:1u'.repeat(4) },
            { socketFile: herdr.socketPath },
          );
          await delay(120);
          await fs.writeFile(
            path.join(output, 'shell-residue.txt'),
            await herdr.readPane(paneId, { lines: 12, ansi: false }),
          );
        }
        return info;
      };
    }
    const single = {
      requestId: 'native-single-restart',
      action: 'restart',
      workspaceId: original.workspaceId,
      runtimeId: singlePreview.runtimeId,
      targets: singlePreview.targets,
    };
    let restartResult;
    try {
      await controller.start(single, queue);
      await controller.running.get(single.requestId);
      restartResult = controller.get(single.requestId);
      assert.equal(restartResult.items[0].status, 'succeeded', JSON.stringify(restartResult));
    } catch (error) {
      await fs.writeFile(
        path.join(output, 'failure.json'),
        JSON.stringify(
          {
            pane: await exactPane(paneId),
            process: await herdr.readProcessInfo(paneId),
            screen: await herdr.readPane(paneId, { lines: 70, ansi: false }),
          },
          null,
          2,
        ),
      );
      throw error;
    }
    if (shellResidue) assert(residueInjected);
    const restoredScreen = await herdr.readPane(paneId, { lines: 70, ansi: false });
    assert(!restoredScreen.includes('command not found'));
    await fs.writeFile(path.join(output, 'restored.txt'), restoredScreen);
    const idleAfter = await exactPane(idleId);
    assert.equal(idleAfter.runtimeId, idleBefore.runtimeId);
    assert.equal(idleAfter.terminalId, idleBefore.terminalId);
    assert.deepEqual(idleAfter.agent.session, idleBefore.agent.session);
    const restored = await exactPane(paneId);
    assert.equal(restored.terminalId, original.terminalId);
    assert.equal(restored.agent.session.value, original.agent.session.value);
    assert.notEqual(restored.runtimeId, original.runtimeId);
    const goalAfter = readGoal();
    assert.equal(goalAfter.objective, goalBefore.objective);
    assert.equal(goalAfter.token_budget, goalBefore.token_budget);
    assert.equal(goalAfter.status, 'active');
    assert(requests.length > requestCount, 'resumed Goal must call the isolated model');
    const continuedGoalRequests = requests.length - requestCount;
    const preview = await controller.preview(original.workspaceId);
    assert.equal(preview.targets.length, 2);
    const send = {
      requestId: 'native-send',
      action: 'send',
      runtimeId: preview.runtimeId,
      workspaceId: preview.workspaceId,
      targets: preview.targets,
      text: 'SPACE BROADCAST',
    };
    await controller.start(send, queue);
    await controller.running.get(send.requestId);
    const sendResult = controller.get(send.requestId);
    assert(
      sendResult.items.every((i) => i.status === 'succeeded'),
      JSON.stringify(sendResult),
    );
    const stopPreview = await controller.preview(original.workspaceId),
      stop = {
        requestId: 'native-stop',
        action: 'stop',
        runtimeId: stopPreview.runtimeId,
        workspaceId: stopPreview.workspaceId,
        targets: stopPreview.targets,
      };
    await controller.start(stop, queue);
    await controller.running.get(stop.requestId);
    const stopResult = controller.get(stop.requestId);
    assert(stopResult.items.every((i) => i.status === 'succeeded'));
    for (let i = 0; i < 40 && readGoal().status !== 'paused'; i++) await delay(100);
    assert.equal(readGoal().status, 'paused');
    assert.equal(
      (await herdr.dashboard()).panes.filter((p) => p.workspaceId === original.workspaceId).length,
      2,
    );
    const report = {
      ok: true,
      shell,
      residueInjected,
      terminalColumns: cols,
      codexVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      herdrVersion: execFileSync('herdr', ['--version'], { encoding: 'utf8' }).trim(),
      samePane: true,
      sameTerminal: true,
      sameSession: true,
      newProcess: true,
      goalObjectiveAndBudgetPreserved: true,
      goalContinuedModelRequests: continuedGoalRequests,
      includesFreshIdleCodex: true,
      singleAgentRestart: true,
      otherAgentProcessUnchanged: true,
      stopPausedGoal: true,
      restartResult,
      sendResult,
      stopResult,
      productionInput: false,
      externalInference: false,
    };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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
    for (const options of [
      { cols: 100 },
      { cols: 45 },
      { cols: 100, shell: '/bin/bash' },
      { cols: 45, shell: '/bin/bash', shellResidue: true },
    ]) {
      const name = options.shell
        ? options.shellResidue
          ? 'bash-residue'
          : 'bash'
        : String(options.cols);
      console.log(
        JSON.stringify(
          await run(path.resolve('artifacts/testing/space-agent-actions/native', name), options),
        ),
      );
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
