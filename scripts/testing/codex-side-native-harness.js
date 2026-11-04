#!/usr/bin/env node
'use strict';
// Real Codex, temporary HOME and local synthetic Responses; no production input.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const { execFileSync } = require('node:child_process'),
  { randomUUID } = require('node:crypto');
const pty = require('node-pty'),
  { Terminal } = require('@xterm/headless'),
  assert = require('node:assert/strict');
const { CodexSide, sideScreen } = require('../../lib/codex-side');
const { stripAnsi } = require('../../public/ansi');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error('Native side fixture timed out');
}
(async () => {
  const unified = process.argv.includes('--unified');
  const before = sourceFingerprint(process.cwd()),
    binary = process.env.SWIFT_CODEX_FIXTURE_BIN || 'codex';
  const effort =
    process.argv.find((arg) => arg.startsWith('--effort='))?.slice(9) ||
    process.env.SWIFT_CODEX_SIDE_EFFORT ||
    'ultra';
  assert(
    ['high', 'max', 'ultra'].includes(effort),
    'The native side fixture covers high, max and ultra reasoning effort',
  );
  const statusLineName =
    process.argv.find((arg) => arg.startsWith('--status-line='))?.slice(14) ||
    process.env.SWIFT_CODEX_SIDE_LAYOUT ||
    'default';
  assert(
    ['default', 'reordered'].includes(statusLineName),
    'The native side fixture covers default and reordered status lines',
  );
  const statusLine =
    statusLineName === 'reordered' ? ['current-dir', 'model-with-reasoning', 'run-state'] : null;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-side-native-'));
  const suffix = (effort === 'ultra' ? '' : '-' + effort) + (statusLine ? '-reordered' : '');
  const output = path.resolve(
    process.env.SWIFT_CODEX_SIDE_OUTPUT ||
      (unified
        ? 'artifacts/testing/side-session-unification/native'
        : 'artifacts/codex-side-native' + suffix),
  );
  fs.mkdirSync(output, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    SWIFT_FIXTURE_KEY: 'local-fixture',
  };
  if (unified)
    Object.assign(env, {
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'fixture-side',
      HERDR_SOCKET_PATH: path.join(home, 'no-production-herdr.sock'),
    });
  fs.mkdirSync(env.CODEX_HOME);
  const version = execFileSync(binary, ['--version'], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: false, running: true, before, version }),
  );
  const requests = [],
    held = new Map(),
    interrupted = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    requests.push(body);
    const id = 'response-' + requests.length;
    const prompt =
      body.input
        ?.at(-1)
        ?.content?.map((part) => part.text || '')
        .join('') || '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sequence = 0,
      completed = false;
    const event = (type, value) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
      );
    event('response.created', {
      response: { id, object: 'response', status: 'in_progress', output: [] },
    });
    const finish = () => {
      completed = true;
      if (unified && prompt === 'SIDE TOOL') {
        const item = {
          id: 'fc-' + requests.length,
          type: 'function_call',
          call_id: 'side-tool-call',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'printf SIDE_TOOL_OUTPUT', yield_time_ms: 1000 }),
        };
        event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } });
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', {
          response: {
            id,
            object: 'response',
            status: 'completed',
            output: [item],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          },
        });
        res.end();
        return;
      }
      const text = prompt.startsWith('MAIN')
        ? 'MAIN ANSWER. Primary work continues.'
        : 'SIDE ANSWER. Temporary discussion.';
      const item = {
        id: 'msg-' + requests.length,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
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
        delta: text,
      });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      });
      res.end();
    };
    if (['MAIN WORK', 'SIDE WORK', 'SIDE INTERRUPT'].includes(prompt)) {
      held.set(prompt, finish);
      res.once('close', () => {
        if (!completed) interrupted.add(prompt);
      });
    } else finish();
  });
  const terminal = new Terminal({ cols: 120, rows: 45, allowProposedApi: true });
  let child;
  const screen = async () => {
    await new Promise((resolve) => terminal.write('', resolve));
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, y) => {
      const line = buffer.getLine(y);
      let text = '';
      for (let x = 0; x < terminal.cols; x++) {
        const cell = line?.getCell(x);
        if (!cell?.getWidth()) continue;
        text += (cell.isDim() ? '\x1b[2m' : '\x1b[22m') + (cell.getChars() || ' ');
      }
      return text + '\x1b[0m';
    }).join('\n');
  };
  const save = async (name) => fs.writeFileSync(path.join(output, name + '.txt'), await screen());
  const send = async (text) => {
    child.write('\x1b[200~' + text + '\x1b[201~');
    await delay(100);
    child.write('\r');
  };
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const launchArgs = [
      '--no-alt-screen',
      '-a',
      'never',
      '--sandbox',
      'workspace-write',
      '-c',
      'model="gpt-6.1-sol"',
      '-c',
      `model_reasoning_effort="${effort}"`,
      '-c',
      'model_provider="fixture"',
      '-c',
      'model_providers.fixture.name="Fixture"',
      '-c',
      `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
      '-c',
      'model_providers.fixture.env_key="SWIFT_FIXTURE_KEY"',
      '-c',
      'model_providers.fixture.wire_api="responses"',
      ...(statusLine ? ['-c', 'tui.status_line=' + JSON.stringify(statusLine)] : []),
      '-c',
      `projects."${home}".trust_level="trusted"`,
    ];
    child = pty.spawn(binary, launchArgs, { cwd: home, env, cols: 120, rows: 45 });
    child.onData((data) => terminal.write(data));
    await wait(async () => stripAnsi(await screen()).includes('OpenAI Codex'));
    await send('MAIN QUESTION');
    await wait(async () => stripAnsi(await screen()).includes('MAIN ANSWER'));
    await delay(200);
    const pane = {
        paneId: 'fixture-side',
        terminalId: 'fixture-terminal',
        runtimeId: 'fixture:' + child.pid,
        agent: { label: 'codex', session: { value: 'main' } },
      },
      writes = [];
    let forkSessionId = null,
      busyForkSessionId = null;
    if (unified) {
      pane.runtimeId = await require('../../lib/codex-restart').processStart(child.pid);
      const file = fs
        .readdirSync(path.join(env.CODEX_HOME, 'sessions'), { recursive: true })
        .find((file) => file.endsWith('.jsonl'));
      pane.agent.session.value = JSON.parse(
        fs.readFileSync(path.join(env.CODEX_HOME, 'sessions', file), 'utf8').split('\n')[0],
      ).payload.id;
      const state = await require('../../lib/codex-side-native').request(pane, 'state');
      assert.equal(state.mainId, pane.agent.session.value);
    }
    let obscuredReads = 0;
    const readNative = async () => {
      if (obscuredReads > 0) {
        obscuredReads--;
        return '';
      }
      return screen();
    };
    const controller = new CodexSide({
      herdr: { readPane: readNative },
      exactPane: async () => pane,
      settleMs: 80,
      paste: async (_id, text) => {
        writes.push(text);
        child.write('\x1b[200~' + text + '\x1b[201~');
      },
      press: async (_id, keys) => {
        writes.push(keys);
        for (const key of keys)
          child.write({ enter: '\r', 'ctrl+/': '\x1f', 'ctrl+c': '\x03' }[key]);
      },
    });
    const action = async (name, extra = {}) => {
      const body = {
        ...(await controller.read(pane)),
        requestId: randomUUID(),
        action: name,
        ...extra,
      };
      const result = await controller.handle(body),
        count = writes.length;
      await controller.handle(body);
      assert.equal(writes.length, count);
      return result;
    };
    const nativeMain = stripAnsi(await screen());
    const prompt = nativeMain
      .split('\n')
      .findLast((line) => /^\s*[›❯»](?:\s|$)/.test(line))
      ?.trimStart()[0];
    assert.equal(
      prompt,
      effort === 'ultra' ? '»' : '›',
      'The fixture must exercise the actual native prompt for its reasoning effort',
    );
    assert(
      new RegExp(`GPT-6\\.1-Sol ${effort}\\b`).test(nativeMain),
      'The native footer must confirm the requested reasoning effort',
    );
    const nativeStatusRow =
      nativeMain
        .split('\n')
        .findLast((line) => new RegExp(`GPT-6\\.1-Sol ${effort}\\b`).test(line))
        ?.trim() || '';
    if (statusLine) {
      assert(
        /^~\s+·\s+GPT-6\.1-Sol /.test(nativeStatusRow),
        'Native Codex must render the configured directory before its model',
      );
      assert(
        /·\s+Ready\b/.test(nativeStatusRow),
        'Native Codex must accept and render the configured run-state item',
      );
      assert(
        !/unknown item identifiers/i.test(nativeMain),
        'The installed Codex must accept every configured status line item',
      );
    }
    const requestEfforts = requests.map((request) => request.reasoning?.effort || null);
    await save('main-' + effort);
    obscuredReads = 2;
    await controller.assertMain(pane);
    assert.equal(obscuredReads, 0);
    assert.equal(writes.length, 0, 'A transient observation must recover without native input');
    const mainSizes = [];
    for (const size of [
      { cols: 120, rows: 45 },
      { cols: 80, rows: 70 },
      { cols: 45, rows: 45 },
      { cols: 35, rows: 24 },
    ]) {
      terminal.resize(size.cols, size.rows);
      child.resize(size.cols, size.rows);
      await delay(350);
      assert.equal((await controller.read(pane)).mode, 'main');
      await controller.assertMain(pane);
      await save('main-' + size.cols + 'x' + size.rows);
      mainSizes.push(size);
    }
    terminal.resize(120, 45);
    child.resize(120, 45);
    await delay(350);
    await send('MAIN WORK');
    await wait(() => held.has('MAIN WORK'));
    await delay(200);
    await save('main-working');
    assert.equal((await action('open')).mode, 'side');
    await save('side-empty');
    await send('SIDE QUESTION');
    await wait(async () => stripAnsi(await screen()).includes('SIDE ANSWER'));
    await delay(250);
    await save('side-answer');
    if (unified) {
      const native = require('../../lib/codex-side-native');
      fs.writeFileSync(
        path.join(output, 'side-native-read.json'),
        JSON.stringify(await require('../../lib/codex-side-native').request(pane, 'read'), null, 2),
      );
      fs.writeFileSync(
        path.join(output, 'fixture-inputs.json'),
        JSON.stringify(
          requests.map((request) => request.input),
          null,
          2,
        ),
      );
      const transcript = await controller.transcript(pane);
      assert(JSON.stringify(transcript.messages).includes('SIDE QUESTION'));
      assert(JSON.stringify(transcript.messages).includes('SIDE ANSWER'));
      assert(!JSON.stringify(transcript.messages).includes('MAIN QUESTION'));
      assert.equal(
        transcript.messages.filter((message) => message.role === 'user').length,
        1,
        'Side user messages must not be duplicated by live snapshots',
      );
      const sideId = (await controller.read(pane)).sideId;
      await action('send', { sideId, text: 'SIDE TOOL' });
      await wait(() =>
        requests.some((request) => JSON.stringify(request.input).includes('SIDE_TOOL_OUTPUT')),
      );
      await delay(350);
      const toolTranscript = await controller.transcript(pane);
      assert(
        toolTranscript.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.kind === 'tools' &&
              block.items.some((item) => item.result?.text.includes('SIDE_TOOL_OUTPUT')),
          ),
        ),
        'Native side tools must use normal structured tool presentation',
      );

      const sideText = 'SIDE 中文消息\n第二行';
      const sideRequests = () =>
        requests.filter(
          (request) =>
            request.input
              ?.findLast((item) => item.role === 'user')
              ?.content?.map((part) => part.text || '')
              .join('') === sideText,
        );
      await action('send', { sideId, text: sideText });
      await wait(() => sideRequests().length === 1);
      await delay(300);
      assert.equal(
        sideRequests().length,
        1,
        'A repeated action must submit the multiline side turn exactly once; background title requests are separate turns',
      );
      const mainFile = fs
        .readdirSync(path.join(env.CODEX_HOME, 'sessions'), { recursive: true })
        .find((file) => file.endsWith('.jsonl'));
      const original = fs.readFileSync(path.join(env.CODEX_HOME, 'sessions', mainFile), 'utf8');
      assert(!original.includes('SIDE QUESTION'));
      assert(!original.includes('第二行'));
      const count = requests.length;
      const fork = await native.request(pane, 'fork', sideId);
      forkSessionId = fork.data.sessionId;
      assert(
        forkSessionId && forkSessionId !== pane.agent.session.value && forkSessionId !== sideId,
      );
      assert.equal(requests.length, count, 'Fork must not submit model work');
      assert.equal(
        fs.readFileSync(path.join(env.CODEX_HOME, 'sessions', mainFile), 'utf8'),
        original,
      );
      const forkFile = fs
        .readdirSync(path.join(env.CODEX_HOME, 'sessions'), { recursive: true })
        .find((file) => file.endsWith(forkSessionId + '.jsonl'));
      assert(forkFile, 'Fork must own a persistent archive');
      const forkText = fs.readFileSync(path.join(env.CODEX_HOME, 'sessions', forkFile), 'utf8');
      assert(
        forkText.includes('MAIN QUESTION') &&
          forkText.includes('SIDE QUESTION') &&
          forkText.includes('第二行'),
      );
      assert(!forkText.includes('Side conversation boundary.'));
      assert(!forkText.includes('This thread is ephemeral'));
      assert.equal(
        (await controller.read(pane)).sideId,
        sideId,
        'Fork preserves the live side thread',
      );
    }
    const widths = [];
    for (const cols of [80, 45, 35]) {
      terminal.resize(cols, 45);
      child.resize(cols, 45);
      await delay(350);
      const view = sideScreen(await screen());
      assert.equal(view.mode, 'side');
      assert.equal(view.canClose, true);
      await save('side-' + cols);
      widths.push(cols);
    }
    terminal.resize(120, 45);
    child.resize(120, 45);
    await delay(350);
    await send('SIDE WORK');
    await wait(() => held.has('SIDE WORK'));
    await delay(250);
    assert.equal(sideScreen(await screen()).canClose, false);
    await save('side-working');
    if (unified) {
      const native = require('../../lib/codex-side-native'),
        sideId = (await controller.read(pane)).sideId;
      const count = requests.length,
        pendingFork = native.request(pane, 'fork', sideId);
      assert.equal(
        (await native.request(pane, 'state')).sideId,
        sideId,
        'State remains independently readable during fork',
      );
      busyForkSessionId = (await pendingFork).data.sessionId;
      assert(
        busyForkSessionId && busyForkSessionId !== forkSessionId && busyForkSessionId !== sideId,
      );
      assert.equal(requests.length, count);
      assert(!interrupted.has('MAIN WORK'));
      assert(!interrupted.has('SIDE WORK'));
    }

    assert.equal((await action('main')).mode, 'main');
    assert(!interrupted.has('SIDE WORK'));
    assert(!interrupted.has('MAIN WORK'));
    held.get('MAIN WORK')();
    await delay(350);
    await save('switched-main');
    assert.equal((await action('side')).mode, 'side');
    held.get('SIDE WORK')();
    await delay(350);
    await save('switched-side');
    if (unified) {
      await action('send', {
        sideId: (await controller.read(pane)).sideId,
        text: 'SIDE INTERRUPT',
      });
      await wait(() => held.has('SIDE INTERRUPT'));
      await delay(250);
      const working = await controller.read(pane);
      assert(working.turnId, 'Side interruption binds the native active turn');
      await action('interrupt');
      await wait(() => interrupted.has('SIDE INTERRUPT'));
      await wait(async () => (await controller.read(pane)).canClose);
    }
    assert.equal((await action('close')).hasSide, false);
    await save('closed');
    const directory = path.join(env.CODEX_HOME, 'sessions');
    const files = fs
      .readdirSync(directory, { recursive: true })
      .filter((file) => file.endsWith('.jsonl'));
    const archive = files
      .map((file) => fs.readFileSync(path.join(directory, file), 'utf8'))
      .join('\n');
    assert.equal(files.length, unified ? 3 : 1);
    const mainArchive = files
      .filter(
        (file) =>
          ![forkSessionId, busyForkSessionId]
            .filter(Boolean)
            .some((id) => file.endsWith(id + '.jsonl')),
      )
      .map((file) => fs.readFileSync(path.join(directory, file), 'utf8'))
      .join('\n');
    assert(!mainArchive.includes('SIDE QUESTION'));
    assert(!mainArchive.includes('SIDE WORK'));
    assert(
      requests.some(
        (request) =>
          JSON.stringify(request.input).includes('SIDE QUESTION') &&
          JSON.stringify(request.input).includes('MAIN QUESTION'),
      ),
    );
    const after = sourceFingerprint(process.cwd());
    assert.equal(before.treeSha256, after.treeSha256);
    const report = {
      ok: true,
      version,
      before,
      after,
      effort,
      statusLineName,
      statusLine,
      nativeStatusRow,
      nativePrompt: prompt,
      nativeEffortConfirmed: true,
      requestEfforts,
      mainSizes,
      transientObservationRecovered: true,
      unified,
      forkSessionId,
      busyForkSessionId,
      structuredSideRead: unified,
      structuredSideSend: unified,
      structuredSideTool: unified,
      structuredSideInterrupt: unified,
      persistentSideFork: unified,
      archiveCount: files.length,
      mainContextInherited: true,
      sideNotArchived: true,
      mainWorkUninterrupted: true,
      sideWorkUninterrupted: true,
      runningCloseDisabled: true,
      narrowColumns: widths,
      duplicateActionsNotReplayed: true,
      writes,
      productionInput: false,
      externalInference: false,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    await save('failure');
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify({ ok: false, version, before, error: error.stack }, null, 2),
    );
    throw error;
  } finally {
    child?.kill();
    terminal.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
