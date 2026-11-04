'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { HerdrClient } = require('../../lib/herdr-client'),
  { CommandInteraction } = require('../../lib/command-interaction');
const { TerminalScreen } = require('../../lib/terminal-screen');
const { projectTerminalScreen, textOf } = require('../../public/native-status');
const { matchActivityLine } = require('../../public/ansi');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(output, { cols = 100, shell = '/bin/sh' } = {}) {
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
    // Codex 0.163.0 supports configurable ordering but has no account or Goal
    // status_line item. The native Goal indicator is appended independently.
    // Omit run-state/context fields so their legacy keywords cannot recognize it.
    const statusLine = ['current-dir', 'model-with-reasoning'];
    const args = [
      '--no-alt-screen',
      '--sandbox',
      'workspace-write',
      '-a',
      'never',
      '-c',
      'model_provider="fixture"',
      '-c',
      'model="gpt-6-astra"',
      '-c',
      'model_reasoning_effort="ultra"',
      '-c',
      'tui.status_line=' + JSON.stringify(statusLine),
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
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    // Herdr's managed startup readiness does not cover every custom native
    // footer. Start once in this fixture's own Shell, then observe the real UI.
    try {
      const deadline = performance.now() + 15000;
      let shellReady = false;
      while (performance.now() < deadline) {
        const info = await herdr.readProcessInfo(paneId);
        if (
          info.shell_pid &&
          info.foreground_processes?.length &&
          info.foreground_processes.every((item) => item.pid === info.shell_pid)
        ) {
          shellReady = true;
          break;
        }
        await delay(100);
      }
      assert(shellReady, 'The isolated fixture Shell must be available before launching Codex');
      cli(['pane', 'run', paneId, ['codex', ...args].map(quote).join(' ')]);
      const readyDeadline = performance.now() + 15000;
      let ready = false;
      while (performance.now() < readyDeadline) {
        const raw = await herdr.readPane(paneId, { lines: 70, ansi: false, exact: true }),
          info = await herdr.readProcessInfo(paneId);
        if (
          info.foreground_processes?.some((item) => item.name === 'codex') &&
          raw.split('\n').some((line) => /^\s*[›❯»]\s/.test(line)) &&
          /GPT-6-Astra ultra\b/.test(raw)
        ) {
          ready = true;
          break;
        }
        await delay(100);
      }
      assert(ready, 'The real native ultra composer and custom model footer must become ready');
    } catch (error) {
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(
        path.join(output, 'startup-failure.txt'),
        await herdr.readPane(paneId, { source: 'recent', lines: 120, exact: true }).catch(() => ''),
      );
      throw error;
    }
    const { processStart, captureLaunch } = require('../../lib/codex-restart');
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
    const projections = [];
    async function captureProjection(name, { active = false, paused = false } = {}) {
      const deadline = performance.now() + 8000;
      let raw,
        screen,
        footerRows,
        settled = false;
      do {
        raw = await herdr.readPane(paneId, {
          source: 'recent',
          lines: 120,
          ansi: true,
          exact: true,
        });
        const terminal = new TerminalScreen();
        try {
          await terminal.feed(raw.replace(/\r?\n/g, '\r\n'), { full: true });
          screen = terminal.snapshot();
        } finally {
          terminal.close();
        }
        const lines = screen.rows.map(textOf),
          prompt = lines.findLastIndex((line) => /^\s*[›❯»](?:\s|$)/.test(line));
        let footer = prompt + 1;
        while (footer < lines.length && !lines[footer].trim()) footer++;
        footerRows = prompt >= 0 ? screen.rows.slice(footer) : [];
        const footerText = footerRows.map(textOf).join('\n');
        settled = active
          ? /Pursuing goal\s*\(/.test(footerText) &&
            lines.some((line) => matchActivityLine(line)?.running)
          : paused
            ? /Goal paused/.test(footerText)
            : Boolean(footerText) && !/Pursuing goal|Goal paused/.test(footerText);
        if (settled) break;
        await delay(100);
      } while (performance.now() < deadline);
      const projection = projectTerminalScreen(screen.rows);
      await fs.writeFile(path.join(output, name + '.ansi'), raw);
      await fs.writeFile(
        path.join(output, name + '-projection.json'),
        JSON.stringify(screen, null, 2),
      );
      assert(settled, 'The native footer must finish displaying its current Goal state');
      assert.deepEqual(
        screen.projection,
        projection,
        'The observer and direct screen projection must agree',
      );
      assert.equal(
        projection.recognized,
        true,
        'The native custom footer must be recognized without run-state/context fields',
      );
      const status = projection.statusRows.map(textOf),
        activity = projection.rows.map(textOf);
      if (active && cols >= 100)
        assert(
          status.some((line) => /GPT-6-Astra ultra\b/.test(line)),
          'The native footer must display the actual model and reasoning effort',
        );
      assert(
        !status.some((line) => /\b(?:Ready|Working|Context)\b|\d+%/.test(line)),
        'Legacy footer keywords must not mask this regression',
      );
      assert.deepEqual(
        projection.statusRows,
        footerRows,
        'Every native footer span and its color must survive projection unchanged',
      );
      const colored = projection.statusRows.flat().filter((span) => span.color || span.background);
      assert(colored.length > 0, 'The real native footer must provide colored spans');
      if (active || paused)
        assert(
          colored.some((span) => /Pursuing goal|Goal paused/.test(span.text)),
          'The native Goal status color must remain attached to its text',
        );
      if (active) {
        assert(
          status.some((line) => /Pursuing goal\s*\(/.test(line)),
          'The active native Goal label and elapsed time must remain visible',
        );
        assert(
          activity.some((line) => matchActivityLine(line)?.running),
          'The current native working activity must remain visible',
        );
      } else
        assert(
          !status.some((line) => /Pursuing goal/.test(line)),
          'Paused/cleared Goals must not retain the active footer label',
        );
      const result = {
        name,
        recognized: projection.recognized,
        status,
        activity,
        coloredSpans: colored.length,
      };
      projections.push(result);
      return result;
    }
    await captureProjection('active', { active: true });
    const commands = new CommandInteraction({ herdr, exactPane });
    const { GoalActions } = require('../../lib/goal-actions');
    const controller = new GoalActions({ commands });
    const binding = {
      paneId,
      terminalId: original.terminalId,
      sessionId: original.agent.session.value,
      runtimeId: (await herdr.dashboard()).runtimeId,
      clientId: 'goal-fixture',
    };
    const outcomes = [];
    async function act(action, objective) {
      const preview = await controller.preview(binding),
        requestId = 'goal-' + outcomes.length;
      const body = {
        ...binding,
        requestId,
        action,
        objective,
        revision: preview.revision,
        processRuntimeId: preview.processRuntimeId,
      };
      await controller.start(body);
      await controller.running.get(requestId);
      const job = controller.get(requestId);
      await fs.writeFile(
        path.join(output, requestId + '-screen.txt'),
        await herdr.readPane(paneId, { lines: 100, ansi: false }),
      );
      outcomes.push(job);
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      assert.deepEqual(await controller.start(body), job);
      return job;
    }
    await act('edit', '优化 A3 softmax 到第一名。\n保留全部测试，核对真实结果。');
    assert.equal(readGoal().token_budget, goalBefore.token_budget);
    await act(
      'edit',
      Array.from(
        { length: 12 },
        (_, i) => `第 ${i + 1} 项：检查输入与结果，并保留可复现的证据。`,
      ).join('\n'),
    );
    await act('edit', '优化 A3 softmax 到第一名。\n保留全部测试。');
    await act('pause');
    for (let i = 0; i < 60 && readGoal().status !== 'paused'; i++) await delay(100);
    assert.equal(readGoal().status, 'paused');
    await captureProjection('paused', { paused: true });
    // /goal pause preserves the in-flight turn. Interrupt it explicitly before
    // proving that resume schedules a new model request from the paused Goal.
    await press(['esc']);
    for (let i = 0; i < 80; i++) {
      const raw = await herdr.readPane(paneId, {
        source: 'recent',
        lines: 40,
        ansi: false,
        exact: true,
      });
      if (!/esc to interrupt/.test(raw)) break;
      await delay(50);
    }
    const beforeResume = requests.length;
    await act('resume');
    for (let i = 0; i < 60 && requests.length === beforeResume; i++) await delay(100);
    assert(requests.length > beforeResume, 'resume must trigger a model request');
    await captureProjection('resumed', { active: true });
    await act('clear');
    assert.equal(readGoal(), null);
    await captureProjection('cleared');
    const report = {
      ok: true,
      terminalColumns: cols,
      codexVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      launchMethod: 'isolated-shell-pane.run',
      statusLine,
      projections,
      requestModels: requests.map((request) => request.model),
      requestEfforts: requests.map((request) => request.reasoning?.effort || null),
      outcomes,
      budgetPreserved: true,
      resumeContinued: true,
      goalCleared: true,
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
    for (const cols of [100, 45])
      console.log(
        JSON.stringify(
          await run(path.resolve('artifacts/testing/goal-status-footer/native', String(cols)), {
            cols,
          }),
        ),
      );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
