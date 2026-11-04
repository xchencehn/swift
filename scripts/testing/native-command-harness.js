'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { HerdrClient } = require('../../lib/herdr-client'),
  { CommandInteraction } = require('../../lib/command-interaction');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const codexProcesses = (processes) =>
  processes.filter(
    (p) => p.name === 'codex' || p.argv?.some((arg) => path.basename(arg) === 'codex'),
  );

async function run(output, { hfork = false, menuFork = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-commands-')),
    session = hfork ? 'swift' : `swift-commands-${process.pid}`,
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
  let modelRequests = 0;
  const modelServer = require('node:http').createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    modelRequests++;
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const id = 'response-fixture-' + modelRequests,
        item = {
          id: 'message-fixture-' + modelRequests,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'HFORK_FIXTURE_READY', annotations: [] }],
        };
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
      if (raw.includes('SWIFT_INTERRUPT_LOCAL_FIXTURE')) return;
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
        delta: 'HFORK_FIXTURE_READY',
      });
      event('response.output_text.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: 'HFORK_FIXTURE_READY',
      });
      event('response.content_part.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
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
  const modelUrl = 'http://127.0.0.1:' + modelServer.address().port + '/v1';
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
      cols: 100,
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
      'model="fixture-model"',
      '-c',
      'model_providers.fixture.name="Fixture"',
      '-c',
      'model_providers.fixture.base_url=' + JSON.stringify(modelUrl),
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
    view = await call('edit', { text: '/' });
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, 'native-slash-probe.json'),
      JSON.stringify(
        { view, raw: await herdr.readPane(paneId, { lines: 160, ansi: true }) },
        null,
        2,
      ),
    );
    assert.equal(view.mode, 'query');
    assert(view.options.some((item) => item.label === '/model'));
    view = await call('edit', { text: '/sta' });
    assert(view.options.some((item) => item.label === '/status'));
    view = await call('edit', { text: '/status' });
    view = await call('key', { key: 'enter', revision: view.revision });
    assert.equal(view.mode, 'result');
    assert.match(
      view.rows
        .flat()
        .map((span) => span.text)
        .join('\n'),
      /Session:|Model provider:/,
    );
    const status = view;
    view = await call('edit', { text: '/model' });
    view = await call('key', { key: 'enter', revision: view.revision });
    assert.equal(view.mode, 'menu');
    assert(view.options.length >= 2);
    const selected = view.options.findIndex((item) => item.selected);
    view = await call('key', { key: 'down', revision: view.revision });
    assert(view.options.findIndex((item) => item.selected) !== selected);
    view = await call('close');
    assert.notEqual(view.mode, 'menu');
    const long = '/goal ' + 'design details '.repeat(20);
    view = await call('edit', { text: long });
    assert.equal(view.input, long);
    view = await call('edit', { text: long + ' extra' });
    assert.equal(view.input, long + ' extra');
    view = await call('close');
    assert.equal(view.mode, 'idle');
    // Exercise the same two native calls as "新建 Codex", with a temporary
    // configuration and a local provider that cannot reach an external model.
    const targetDirectory = path.join(temporary, 'codex-target');
    await fs.mkdir(targetDirectory);
    await fs.writeFile(
      path.join(env.CODEX_HOME, 'config.toml'),
      `model_provider = "fixture"\nmodel = "fixture-model"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${modelUrl}"\nenv_key = "SWIFT_FIXTURE_KEY"\nwire_api = "responses"\n[projects.${JSON.stringify(targetDirectory)}]\ntrust_level = "trusted"\n`,
    );
    const { invoke } = require('../../lib/herdr-ui'),
      originalProcesses = codexProcesses(
        (await herdr.readProcessInfo(paneId)).foreground_processes,
      );
    const target = json([
      'workspace',
      'create',
      '--label',
      'new Codex target',
      '--cwd',
      targetDirectory,
      '--no-focus',
    ]);
    const snapshotBefore = await herdr.dashboard(),
      createdTab = await invoke(
        herdr,
        'tab.create',
        { workspace_id: target.workspace.workspace_id, label: 'Codex' },
        { runtimeId: snapshotBefore.runtimeId },
      );
    const fresh = createdTab.root_pane;
    const startResult = await invoke(
      herdr,
      'agent.start',
      { pane_id: fresh.pane_id, name: 'codex-new-session-fixture', kind: 'codex' },
      {
        runtimeId: snapshotBefore.runtimeId,
        paneId: fresh.pane_id,
        terminalId: fresh.terminal_id,
        sessionId: '',
      },
    );
    let started;
    for (let attempt = 0; attempt < 100; attempt++) {
      started = (await herdr.dashboard()).panes.find((p) => p.paneId === fresh.pane_id);
      if (started?.agent?.label === 'codex' && !started.agent.launchPending) break;
      await delay(150);
    }
    await fs.writeFile(
      path.join(output, 'native-new-codex-start.json'),
      JSON.stringify({ startResult, started }, null, 2),
    );
    await fs.writeFile(
      path.join(output, 'native-new-codex-screen.txt'),
      await herdr.readPane(fresh.pane_id, { lines: 80, ansi: false }),
    );
    assert.equal(started.workspaceId, target.workspace.workspace_id);
    assert.equal(started.baseCwd, targetDirectory);
    assert.equal(started.agent?.label, 'codex');
    assert.notEqual(started.paneId, paneId);
    assert.equal(started.terminalId, fresh.terminal_id);
    assert(!started.agent.launchPending, 'The new Codex must reach the native ready state');
    const newProcess = (await herdr.readProcessInfo(fresh.pane_id)).foreground_processes.find(
      (p) => p.name === 'codex',
    );
    assert(newProcess?.pid);
    const newArgv = (await fs.readFile('/proc/' + newProcess.pid + '/cmdline', 'utf8'))
      .split('\0')
      .filter(Boolean);
    assert(!newArgv.includes('resume'), 'The new Codex must not resume the original session');
    assert(!originalProcesses.some((p) => p.pid === newProcess.pid));
    assert.deepEqual(
      codexProcesses((await herdr.readProcessInfo(paneId)).foreground_processes),
      originalProcesses,
      'The existing Agent process is untouched',
    );
    await fs.writeFile(
      path.join(output, 'native-new-codex.json'),
      JSON.stringify(
        {
          targetWorkspace: target.workspace.workspace_id,
          pane: started,
          newProcess: newProcess.pid,
          argv: newArgv,
        },
        null,
        2,
      ),
    );
    let forkEvidence;
    if (hfork) {
      const workspaceId = created.workspace.workspace_id;
      const beforeTab = json([
        'tab',
        'create',
        '--workspace',
        workspaceId,
        '--label',
        'before',
        '--no-focus',
      ]).tab.tab_id;
      const afterTab = json([
        'tab',
        'create',
        '--workspace',
        workspaceId,
        '--label',
        'after',
        '--no-focus',
      ]).tab.tab_id;
      await herdr.request('tab.move', { tab_id: beforeTab, insert_index: 0 });
      const sourceThread = status.rows
        .flat()
        .map((span) => span.text)
        .join(' ')
        .match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
      assert(sourceThread);
      cli([
        'pane',
        'report-agent-session',
        paneId,
        '--source',
        'herdr:codex',
        '--agent',
        'codex',
        '--agent-session-id',
        sourceThread,
        '--seq',
        String(Date.now()),
      ]);
      await herdr.request('pane.send_input', {
        pane_id: paneId,
        text: 'SWIFT_HFORK_LOCAL_FIXTURE',
        keys: [],
      });
      await delay(150);
      await herdr.request('agent.send_keys', { target: paneId, keys: ['enter'] });
      let seeded = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (await herdr.readPane(paneId, { lines: 60, ansi: false })).includes('HFORK_FIXTURE_READY')
        ) {
          seeded = true;
          break;
        }
        await delay(150);
      }
      assert(seeded, 'The local model fixture must establish an archived source session');
      await delay(300);
      const seedRequests = modelRequests;
      assert(seedRequests > 0);
      const stable = await herdr.dashboard(),
        source = stable.panes.find((p) => p.paneId === paneId);
      const beforeInfo = await herdr.readProcessInfo(paneId),
        beforeProcesses = codexProcesses(beforeInfo.foreground_processes);
      assert(beforeProcesses.some((p) => p.name === 'codex'));
      const focused = stable.focusedPaneId;
      const children = [];
      for (let count = 0; count < 2; count++) {
        await herdr.request('pane.send_input', { pane_id: paneId, text: '/hfork', keys: [] });
        await delay(150);
        await herdr.request('agent.send_keys', { target: paneId, keys: ['enter'] });
        let next;
        for (let attempt = 0; attempt < 100; attempt++) {
          next = await herdr.dashboard();
          const tabs = next.tabs.filter((t) => t.workspace_id === workspaceId);
          if (tabs.length === 4 + count) {
            const index = tabs.findIndex((t) => t.tab_id === created.tab.tab_id),
              childTab = tabs[index + 1];
            const child = next.panes.find((p) => p.tabId === childTab?.tab_id);
            if (child && !children.some((previous) => previous.tabId === child.tabId)) {
              const processes = (await herdr.readProcessInfo(child.paneId)).foreground_processes;
              const resume = processes.find((p) => p.argv?.includes('resume')),
                args = resume?.argv || [],
                forkSessionId = args[args.indexOf('resume') + 1];
              const screen = await herdr.readPane(child.paneId, { lines: 100, ansi: false });
              if (
                processes.some((p) => p.name === 'codex') &&
                /^[0-9a-f-]{36}$/i.test(forkSessionId || '') &&
                forkSessionId !== source.agent?.session?.value &&
                screen.includes('Thread forked from ' + source.agent.session.value)
              ) {
                children.push({ ...child, forkSessionId });
                break;
              }
            }
          }
          await delay(150);
        }
        await fs.writeFile(
          path.join(output, 'hfork-' + count + '-screen.txt'),
          await herdr.readPane(paneId, { lines: 100, ansi: false }),
        );
        await fs.writeFile(
          path.join(output, 'hfork-' + count + '-snapshot.json'),
          JSON.stringify(next, null, 2),
        );
        if (children.length !== count + 1) {
          const tabs = next.tabs.filter((t) => t.workspace_id === workspaceId),
            index = tabs.findIndex((t) => t.tab_id === created.tab.tab_id),
            child = next.panes.find((p) => p.tabId === tabs[index + 1]?.tab_id);
          if (child) {
            await fs.writeFile(
              path.join(output, 'hfork-child-screen.txt'),
              await herdr.readPane(child.paneId, { lines: 100, ansi: false }),
            );
            await fs.writeFile(
              path.join(output, 'hfork-child-process.json'),
              JSON.stringify(await herdr.readProcessInfo(child.paneId), null, 2),
            );
          }
        }

        assert.equal(
          children.length,
          count + 1,
          'Native /hfork must create a ready adjacent Codex Tab',
        );
        assert.equal(next.focusedPaneId, focused, 'Fork must preserve native focus');
        assert.equal(next.panes.find((p) => p.paneId === paneId).terminalId, source.terminalId);
        const afterInfo = await herdr.readProcessInfo(paneId);
        assert.deepEqual(codexProcesses(afterInfo.foreground_processes), beforeProcesses);
        assert.equal(afterInfo.shell_pid, beforeInfo.shell_pid);
        assert.equal(afterInfo.foreground_process_group_id, beforeInfo.foreground_process_group_id);
        assert.equal(
          next.panes.find((p) => p.paneId === paneId).agent.session.value,
          source.agent.session.value,
        );
        assert(
          next.tabs
            .filter((t) => t.workspace_id === workspaceId)
            .every((t) => next.panes.filter((p) => p.tabId === t.tab_id).length === 1),
        );
        await delay(300);
      }
      const final = await herdr.dashboard(),
        order = final.tabs.filter((t) => t.workspace_id === workspaceId).map((t) => t.tab_id);
      assert.deepEqual(order, [
        beforeTab,
        created.tab.tab_id,
        children[1].tabId,
        children[0].tabId,
        afterTab,
      ]);
      assert.notEqual(children[0].forkSessionId, children[1].forkSessionId);
      assert.equal(
        modelRequests - seedRequests,
        0,
        'Native /hfork must not submit a model request',
      );
      forkEvidence = {
        source: { paneId, terminalId: source.terminalId, sessionId: source.agent?.session?.value },
        children,
        order,
        modelRequests: modelRequests - seedRequests,
        seedRequests,
        originalProcessUnchanged: true,
        focusPreserved: true,
        menuCommandFlow: false,
      };
      await fs.writeFile(path.join(output, 'hfork.json'), JSON.stringify(forkEvidence, null, 2));
      if (menuFork) {
        const { SessionInterrupt, runningScreen } = require('../../lib/session-interrupt');
        const archives = await fs.readdir(path.join(env.CODEX_HOME, 'sessions'), {
          recursive: true,
        });
        const archive = archives.find((file) =>
          file.endsWith(source.agent.session.value + '.jsonl'),
        );
        assert(archive);
        const readTurn = async () =>
          require('../../lib/conversation-state').turnToken(
            'codex',
            (await fs.readFile(path.join(env.CODEX_HOME, 'sessions', archive), 'utf8'))
              .trim()
              .split('\n'),
          );
        const binding = {
          paneId,
          terminalId: source.terminalId,
          sessionId: source.agent.session.value,
          runtimeId: stable.runtimeId,
        };
        let escCalls = 0;
        const exactInputPane = async (id) => {
          const pane = await exactPane(id),
            process = (await herdr.readProcessInfo(id)).foreground_processes.find(
              (p) => p.name === 'codex',
            );
          assert(process);
          const start = (await fs.readFile('/proc/' + process.pid + '/stat', 'utf8'))
            .split(') ')[1]
            .split(' ')[19];
          return { ...pane, runtimeId: process.pid + ':' + start };
        };
        const interrupt = new SessionInterrupt({
          herdr,
          exactPane: exactInputPane,
          readTurn,
          interrupt: async (id) => {
            escCalls++;
            await herdr.request('agent.send_keys', { target: id, keys: ['esc'] });
          },
        });
        await herdr.request('pane.send_input', {
          pane_id: paneId,
          text: 'SWIFT_INTERRUPT_LOCAL_FIXTURE',
          keys: [],
        });
        await delay(150);
        await herdr.request('agent.send_keys', { target: paneId, keys: ['enter'] });
        let active;
        for (let i = 0; i < 100; i++) {
          active = await interrupt.preview(binding);
          if (active.canInterrupt) break;
          await delay(150);
        }
        await fs.writeFile(
          path.join(output, 'interrupt-running-screen.txt'),
          await herdr.readPane(paneId, { lines: 100, ansi: true }),
        );
        assert(active.canInterrupt, 'The current native running turn must enable interruption');
        const body = {
          ...binding,
          turnId: active.turnId,
          processRuntimeId: active.processRuntimeId,
          requestId: 'native-menu-interrupt',
        };
        assert((await interrupt.run(body)).interrupted);
        assert((await interrupt.run(body)).interrupted);
        for (let i = 0; i < 100; i++) {
          if (
            !(await readTurn()) &&
            !runningScreen(await herdr.readPane(paneId, { lines: 100, ansi: true }))
          )
            break;
          await delay(100);
        }
        const stopped = await herdr.readPane(paneId, { lines: 100, ansi: true });
        assert.equal(
          await readTurn(),
          null,
          'The native archive must confirm that the running turn ended',
        );
        assert.equal((await interrupt.preview(binding)).canInterrupt, false);
        try {
          await interrupt.run({ ...body, requestId: 'native-menu-interrupt-again' });
        } catch (error) {
          assert.equal(error.code, 'TURN_CHANGED');
        }
        assert.equal(escCalls, 1);
        assert(!/Edit previous message|Select a previous message/i.test(stopped));
        assert.deepEqual(
          codexProcesses((await herdr.readProcessInfo(paneId)).foreground_processes),
          beforeProcesses,
        );
        await fs.writeFile(path.join(output, 'interrupt-stopped-screen.txt'), stopped);
        await fs.writeFile(
          path.join(output, 'menu-interrupt.json'),
          JSON.stringify(
            {
              ok: true,
              oneEsc: true,
              stoppedDisabled: true,
              noHistoryPicker: true,
              originalProcessUnchanged: true,
              externalModel: false,
              productionInput: false,
            },
            null,
            2,
          ),
        );
      }
    }
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, 'native-command-status.json'),
      JSON.stringify(status, null, 2) + '\n',
    );
    return {
      ok: true,
      codexVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      realHerdrTransport: true,
      slashCandidates: true,
      liveQuery: true,
      statusResult: true,
      modelNavigation: true,
      nativeEscape: true,
      longArguments: true,
      newCodexInTargetSpace: true,
      newCodexInheritsDirectory: true,
      newCodexWithoutResume: true,
      originalProcessUnchanged: true,
      emptyHome: true,
      fakeLocalProvider: true,
      modelTurn: hfork,
      externalModel: false,
      productionInput: false,
      ...(hfork ? { hfork: forkEvidence } : {}),
    };
  } finally {
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
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
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
module.exports = { run };
if (require.main === module) {
  if (process.argv.includes('--menu-fork')) {
    // The Swift menu now uses an independent native fork operation. Keep this
    // entry point aligned with that implementation; --hfork tests the CLI helper.
    const result = require('node:child_process').spawnSync(
      process.execPath,
      [path.join(__dirname, 'busy-session-fork-native-harness.js')],
      { stdio: 'inherit' },
    );
    process.exitCode = result.status ?? 1;
  } else {
    const hfork = process.argv.includes('--hfork');
    run(
      path.resolve(
        __dirname,
        hfork ? '../../artifacts/tab-only/native' : '../../artifacts/validation/native-commands',
      ),
      { hfork },
    )
      .then((value) => console.log(JSON.stringify(value)))
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
