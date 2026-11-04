'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const http = require('node:http'),
  path = require('node:path');
const { once } = require('node:events'),
  { WebSocket } = require('ws');
const { createTerminalTransport } = require('../lib/terminal-transport');
const fs = require('node:fs/promises'),
  os = require('node:os');
async function fixture(t, snapshot, readPane) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-shell-test-'));
  t.shellInputLog = path.join(directory, 'input.jsonl');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = http.createServer();
  const transport = createTerminalTransport({
    server,
    herdr: {
      bin: path.resolve(__dirname, '../scripts/testing/shell-terminal-fixture.js'),
      snapshot: typeof snapshot === 'function' ? snapshot : async () => snapshot,
      readPane,
      normalizeSnapshot: (value) => value,
      env: (extra) => ({ ...process.env, ...extra, SWIFT_SHELL_FIXTURE_LOG: t.shellInputLog }),
    },
    basePath: '',
    isAuthorized: () => true,
    getCwd: () => '/tmp',
    maxInputBytes: 65536,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    transport.close();
    server.close();
  });
  return `ws://127.0.0.1:${server.address().port}/api/terminal?shell=1&flow=ack&pane=pane-shell&terminalId=terminal-shell&runtimeId=runtime-shell`;
}
const snapshot = () => ({
  runtimeId: 'runtime-shell',
  panes: [{ paneId: 'pane-shell', terminalId: 'terminal-shell', agent: null }],
});
test('Shell control targets one native terminal and streams input, resize and scroll', async (t) => {
  const ws = new WebSocket(await fixture(t, snapshot()));
  t.after(() => ws.terminate());
  let output = '',
    ready = false;
  const records = [],
    order = [];
  ws.on('message', (raw, binary) => {
    if (binary) {
      output += raw.toString();
      order.push(raw.toString());
    } else {
      const msg = JSON.parse(raw);
      records.push(msg);
      if (msg.type !== 'terminal.flow') order.push(msg.type);
      if (msg.type === 'terminal.ready') ready = true;
    }
  });
  await once(ws, 'open');
  await wait(() => ready && output.includes('SHELL_FIXTURE_READY'));
  ws.send(JSON.stringify({ type: 'terminal.input', data: '中文 paste\r\x03' }));
  ws.send(JSON.stringify({ type: 'terminal.resize', cols: 88, rows: 24 }));
  ws.send(JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 8 }));
  await wait(
    () =>
      output.includes('中文 paste\r\x03') &&
      output.includes('SIZE:88x24') &&
      output.includes('SCROLL:up:8') &&
      output.includes('CONTROL:{"type":"terminal.scroll"'),
  );
  assert.equal(records.find((msg) => msg.type === 'terminal.ready').terminalId, 'terminal-shell');
  assert(records.some((msg) => msg.type === 'terminal.full'));
  order.length = 0;
  ws.send(JSON.stringify({ type: 'terminal.input', data: 'FULL_BURST' }));
  await wait(() => output.includes('BURST_B'));
  assert.deepEqual(order, ['terminal.full', 'BURST_A', 'terminal.full', 'BURST_B']);
});
test('Agent control keeps the exact native terminal target', async (t) => {
  const state = snapshot();
  state.panes[0].agent = { label: 'codex' };
  const ws = new WebSocket(await fixture(t, state));
  let ready = false,
    output = '';
  t.after(() => ws.terminate());
  ws.on('message', (raw, binary) => {
    if (binary) output += raw.toString();
    else ready ||= JSON.parse(raw).type === 'terminal.ready';
  });
  await once(ws, 'open');
  await wait(() => ready);
  ws.send(JSON.stringify({ type: 'terminal.input', data: '/model\r\x1b[A' }));
  await wait(() => output.includes('/model\r\x1b[A'));
});
test('Idle viewing is read-only; activity acquires control and blur releases it without replay', async (t) => {
  const ws = new WebSocket(await fixture(t, snapshot()));
  let output = '',
    ready = false;
  t.after(() => ws.terminate());
  ws.on('message', (raw, binary) => {
    if (binary) output += raw.toString();
    else ready ||= JSON.parse(raw).type === 'terminal.ready';
  });
  await once(ws, 'open');
  await wait(() => ready && output.includes('MODE:observe'));
  assert(!output.includes('MODE:control'));
  for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ type: 'terminal.focus', focused: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(!output.includes('MODE:control'), 'Passive browser focus never acquires Herdr control');
  ws.send(JSON.stringify({ type: 'terminal.input', data: 'ONCE_BEFORE_BLUR' }));
  ws.send(JSON.stringify({ type: 'terminal.focus', focused: false }));
  await wait(() => output.split('MODE:observe').length === 3);
  assert.equal((await fs.readFile(t.shellInputLog, 'utf8')).split('ONCE_BEFORE_BLUR').length, 2);
  output = '';
  ws.send(JSON.stringify({ type: 'terminal.input', data: 'ONCE_AFTER_BLUR' }));
  await wait(() => output.includes('MODE:control') && output.includes('ONCE_AFTER_BLUR'));
  await wait(() => output.includes('MODE:observe'));
  assert.equal((await fs.readFile(t.shellInputLog, 'utf8')).split('ONCE_AFTER_BLUR').length, 2);
});
test('A foreground terminal keeps control after a tap until it leaves the foreground', async (t) => {
  const ws = new WebSocket((await fixture(t, snapshot())) + '&retainControl=1');
  let output = '',
    ready = false;
  t.after(() => ws.terminate());
  ws.on('message', (raw, binary) => {
    if (binary) output += raw.toString();
    else ready ||= JSON.parse(raw).type === 'terminal.ready';
  });
  await once(ws, 'open');
  await wait(() => ready && output.includes('MODE:observe'));
  ws.send(
    JSON.stringify({ type: 'terminal.mouse', action: 'down', button: 'left', column: 2, row: 2 }),
  );
  ws.send(
    JSON.stringify({ type: 'terminal.mouse', action: 'up', button: 'left', column: 2, row: 2 }),
  );
  await wait(() => output.includes('MODE:control'));
  output = '';
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert(
    !output.includes('MODE:observe'),
    'The foreground terminal must not return to the native viewer while reading',
  );
  ws.send(JSON.stringify({ type: 'terminal.focus', focused: false }));
  await wait(() => output.includes('MODE:observe'));
});
test('Composition holds control until it ends; changing observer height retains the complete read-only stream', async (t) => {
  const ws = new WebSocket(await fixture(t, snapshot()));
  let output = '',
    ready = false;
  t.after(() => ws.terminate());
  ws.on('message', (raw, binary) => {
    if (binary) output += raw.toString();
    else ready ||= JSON.parse(raw).type === 'terminal.ready';
  });
  await once(ws, 'open');
  await wait(() => ready && output.includes('MODE:observe'));
  output = '';
  ws.send(
    JSON.stringify({ type: 'terminal.mouse', action: 'move', button: 'left', column: 1, row: 1 }),
  );
  ws.send(JSON.stringify({ type: 'terminal.resize', cols: 100, rows: 22 }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    output,
    '',
    'Keyboard height changes neither restart the observer nor acquire control',
  );
  output = '';
  ws.send(JSON.stringify({ type: 'terminal.focus', focused: true, composing: true }));
  await wait(() => output.includes('MODE:control'));
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert(!output.includes('MODE:observe'));
  ws.send(JSON.stringify({ type: 'terminal.focus', focused: true, composing: false }));
  await wait(() => output.includes('MODE:observe'));
});
test('Unchanged terminal dimensions retain the read-only observer and its frame', async (t) => {
  const ws = new WebSocket(await fixture(t, snapshot()));
  let ready = false,
    full = 0;
  t.after(() => ws.terminate());
  ws.on('message', (raw, binary) => {
    if (!binary) {
      const message = JSON.parse(raw);
      ready ||= message.type === 'terminal.ready';
      if (message.type === 'terminal.full') full++;
    }
  });
  await once(ws, 'open');
  await wait(() => ready);
  for (let i = 0; i < 5; i++)
    ws.send(JSON.stringify({ type: 'terminal.resize', cols: 100, rows: 32 }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(full, 1, 'Identical resize notifications must not restart the native observer');
});
test('Native mouse and wheel preserve cells, modifiers and page-key routing; invalid clicks are dropped', async (t) => {
  const ws = new WebSocket(await fixture(t, snapshot()));
  let ready = false,
    output = '';
  t.after(() => ws.terminate());
  ws.on('message', (raw, binary) => {
    if (binary) output += raw.toString();
    else ready ||= JSON.parse(raw).type === 'terminal.ready';
  });
  await once(ws, 'open');
  await wait(() => ready);
  const commands = [
    { type: 'terminal.mouse', action: 'down', button: 'left', column: 20, row: 8, modifiers: 2 },
    { type: 'terminal.mouse', action: 'drag', button: 'left', column: 21, row: 9, modifiers: 0 },
    { type: 'terminal.mouse', action: 'up', button: 'left', column: 21, row: 9, modifiers: 0 },
    {
      type: 'terminal.scroll',
      direction: 'up',
      lines: 3,
      source: 'wheel',
      column: 20,
      row: 8,
      modifiers: 4,
    },
    {
      type: 'terminal.scroll',
      direction: 'down',
      lines: 24,
      source: 'page_key',
      column: 0,
      row: 0,
      modifiers: 0,
    },
  ];
  for (const message of commands) ws.send(JSON.stringify(message));
  ws.send(
    JSON.stringify({ type: 'terminal.mouse', action: 'down', button: 'left', column: -1, row: 8 }),
  );
  ws.send(
    JSON.stringify({ type: 'terminal.mouse', action: 'down', button: 'left', column: 400, row: 8 }),
  );
  ws.send(JSON.stringify({ type: 'terminal.input', data: 'END_MOUSE_TEST' }));
  await wait(() => output.includes('END_MOUSE_TEST'));
  const actual = output
    .split('CONTROL:')
    .slice(1)
    .map((line) => JSON.parse(line.split('\r\n')[0]));
  assert.deepEqual(actual, commands);
});
test('Touch scroll distance becomes bounded native wheel steps', async (t) => {
  const ws = new WebSocket(await fixture(t, snapshot()));
  let ready = false,
    output = '';
  t.after(() => ws.terminate());
  ws.on('message', (raw, binary) => {
    if (binary) output += raw.toString();
    else ready ||= JSON.parse(raw).type === 'terminal.ready';
  });
  await once(ws, 'open');
  await wait(() => ready);
  ws.send(
    JSON.stringify({
      type: 'terminal.scroll',
      source: 'touch',
      direction: 'up',
      lines: 4,
      column: 12,
      row: 5,
      modifiers: 0,
    }),
  );
  ws.send(JSON.stringify({ type: 'terminal.input', data: 'END_TOUCH' }));
  await wait(() => output.includes('END_TOUCH'));
  const commands = output
    .split('CONTROL:')
    .slice(1)
    .map((line) => JSON.parse(line.split('\r\n')[0]));
  assert.equal(commands.length, 4);
  assert(
    commands.every(
      (c) =>
        c.source === 'wheel' &&
        c.direction === 'up' &&
        c.lines === 1 &&
        c.column === 12 &&
        c.row === 5,
    ),
  );
});
for (const variant of ['runtime', 'terminal', 'missing'])
  test(`Shell rejects changed ${variant} binding before input`, async (t) => {
    const state = snapshot();
    if (variant === 'runtime') state.runtimeId = 'other';
    if (variant === 'terminal') state.panes[0].terminalId = 'other';
    if (variant === 'missing') state.panes = [];
    const ws = new WebSocket(await fixture(t, state));
    const records = [];
    ws.on('message', (raw, binary) => {
      assert(!binary);
      records.push(JSON.parse(raw));
    });
    await once(ws, 'close');
    assert(records.some((msg) => msg.type === 'terminal.error'));
    assert(!records.some((msg) => msg.type === 'terminal.ready'));
  });
async function wait(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('terminal response timeout');
}
test('Temporary native read failures allow reconnection; changed terminal identity does not', async (t) => {
  for (const [value, expected] of [
    [
      async () => {
        throw new Error('temporary native socket failure');
      },
      1013,
    ],
    [{ runtimeId: 'changed', panes: [] }, 1008],
  ]) {
    const ws = new WebSocket(await fixture(t, value)),
      records = [];
    ws.on('message', (raw, binary) => {
      if (!binary) records.push(JSON.parse(raw));
    });
    const [code] = await once(ws, 'close');
    assert.equal(code, expected);
    assert.equal(records.find((x) => x.type === 'terminal.error').recoverable, expected === 1013);
  }
});
test('只读历史补充校验终端身份，不申请控制、不改变尺寸、不写入终端', async (t) => {
  const state = snapshot(),
    reads = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ws = new WebSocket(
    await fixture(t, state, async (pane, options) => {
      reads.push({ pane, options });
      await gate;
      return 'EARLIER\nSHELL_FIXTURE_READY';
    }),
  );
  t.after(() => {
    release();
    ws.terminate();
  });
  const messages = [];
  let ready = false;
  ws.on('message', (raw, binary) => {
    if (!binary) {
      const value = JSON.parse(String(raw));
      messages.push(value);
      ready ||= value.type === 'terminal.ready';
    }
  });
  await once(ws, 'open');
  await wait(() => ready);
  ws.send(JSON.stringify({ type: 'terminal.history.request', requestId: 'history-one' }));
  await wait(() => reads.length === 2);
  ws.send(JSON.stringify({ type: 'terminal.history.request', requestId: 'history-one' }));
  release();
  await wait(() =>
    messages.some((item) => item.type === 'terminal.history' && item.requestId === 'history-one'),
  );
  const history = messages.find((item) => item.type === 'terminal.history');
  assert(history.available);
  assert.match(history.text, /EARLIER/);
  assert.deepEqual(
    reads,
    ['recent', 'visible'].map((source) => ({
      pane: 'pane-shell',
      options: { source, lines: 200, ansi: true, exact: true },
    })),
  );
  assert.equal(await fs.readFile(t.shellInputLog, 'utf8').catch(() => ''), '');
});
test('历史读取期间终端身份改变时不返回旧目标内容', async (t) => {
  const state = snapshot();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = false;
  const ws = new WebSocket(
    await fixture(
      t,
      () => state,
      async () => {
        started = true;
        await gate;
        return 'STALE TARGET';
      },
    ),
  );
  t.after(() => {
    release();
    ws.terminate();
  });
  const messages = [];
  let ready = false;
  ws.on('message', (raw, binary) => {
    if (!binary) {
      const value = JSON.parse(String(raw));
      messages.push(value);
      ready ||= value.type === 'terminal.ready';
    }
  });
  await once(ws, 'open');
  await wait(() => ready);
  ws.send(JSON.stringify({ type: 'terminal.history.request', requestId: 'history-old-target' }));
  await wait(() => started);
  state.panes[0].terminalId = 'replacement';
  release();
  await wait(() => messages.some((item) => item.type === 'terminal.history'));
  const history = messages.find((item) => item.type === 'terminal.history');
  assert.equal(history.available, false);
  assert.equal(history.text, undefined);
});
