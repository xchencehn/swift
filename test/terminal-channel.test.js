'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');
const { attachTerminalChannel } = require('../lib/terminal-channel');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read) {
  for (let i = 0; i < 100; i++) {
    if (read()) return;
    await pause(5);
  }
  assert.fail('Channel response timed out');
}
async function fixture(t, attach) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (ws) =>
    attachTerminalChannel({
      ws,
      url: new URL('http://fixture/api/terminal'),
      herdr: {},
      maxInputBytes: 65536,
      attach,
    }),
  );
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return async () => {
    const ws = new WebSocket('ws://127.0.0.1:' + server.address().port),
      frames = [];
    ws.on('message', (bytes, binary) =>
      frames.push(
        binary
          ? { selectionId: bytes.readUInt32LE(), text: bytes.subarray(4).toString() }
          : JSON.parse(String(bytes)),
      ),
    );
    await once(ws, 'open');
    await until(() => frames.some((frame) => frame.type === 'terminal.channel.ready'));
    return {
      ws,
      frames,
      select(id, terminalId) {
        ws.send(
          JSON.stringify({
            type: 'terminal.select',
            selectionId: id,
            target: terminalId
              ? {
                  runtimeId: 'runtime',
                  paneId: 'pane-' + terminalId,
                  terminalId,
                  cols: 100,
                  rows: 30,
                }
              : null,
          }),
        );
      },
      input(id, data) {
        ws.send(JSON.stringify({ type: 'terminal.input', selectionId: id, data }));
      },
    };
  };
}
function attachEcho(log) {
  return async ({ ws, url }) => {
    const terminalId = url.searchParams.get('terminalId');
    log.push({ event: 'attach', terminalId });
    ws.shellTerminal = {
      stop() {
        log.push({ event: 'stop', terminalId });
      },
    };
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      log.push({ event: 'input', terminalId, data: message.data });
      ws.send(Buffer.from(message.data));
    });
    ws.send(JSON.stringify({ type: 'terminal.full' }));
    ws.send(Buffer.from('CURRENT_' + terminalId));
  };
}
test('one channel selects eight terminals with full frames and rejects old-target input', async (t) => {
  const log = [],
    connect = await fixture(t, attachEcho(log)),
    client = await connect();
  for (let id = 1; id <= 8; id++) {
    client.select(id, String(id));
    await until(() =>
      client.frames.some((frame) => frame.selectionId === id && frame.text === 'CURRENT_' + id),
    );
    const start = client.frames.findIndex(
      (frame) => frame.selectionId === id && frame.type === 'terminal.full',
    );
    assert(start >= 0);
    assert.equal(client.frames[start + 1].text, 'CURRENT_' + id);
  }
  client.input(7, 'wrong');
  client.input(8, '中文');
  await until(() =>
    client.frames.some((frame) => frame.selectionId === 8 && frame.text === '中文'),
  );
  assert.deepEqual(
    log.filter((row) => row.event === 'input'),
    [{ event: 'input', terminalId: '8', data: '中文' }],
  );
  client.select(9, null);
  await until(() => log.filter((row) => row.event === 'stop').length === 8);
  client.input(8, 'hidden');
  await pause(10);
  assert.equal(log.filter((row) => row.event === 'input').length, 1);
  assert.equal(client.ws.readyState, WebSocket.OPEN);
});
test('slow previous attach cannot publish and intermediate selections are superseded', async (t) => {
  let release, started;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const attached = new Promise((resolve) => {
      started = resolve;
    }),
    log = [];
  t.after(release);
  const connect = await fixture(t, async (options) => {
    const id = options.url.searchParams.get('terminalId');
    log.push(id);
    if (id === 'A') {
      started();
      await waiting;
      options.ws.send(Buffer.from('STALE_A'));
      return;
    }
    await attachEcho([])(options);
  });
  const client = await connect();
  client.select(1, 'A');
  await attached;
  client.select(2, 'B');
  client.select(3, 'C');
  await until(() => client.frames.some((frame) => frame.text === 'CURRENT_C'));
  release();
  await pause(10);
  assert.deepEqual(log, ['A', 'C']);
  assert(!client.frames.some((frame) => frame.text === 'STALE_A'));
});
test('returning to a releasing PTY displays immediately but waits before controlling that same PTY', async (t) => {
  let finish;
  const closing = new Promise((resolve) => {
    finish = resolve;
  });
  t.after(finish);
  let visits = 0;
  const connect = await fixture(t, async ({ ws, url, controlReleased }) => {
    const id = url.searchParams.get('terminalId');
    ws.shellTerminal = { stop: () => (id === 'A' && visits === 1 ? closing : undefined) };
    if (id === 'A') visits++;
    ws.send(Buffer.from('CURRENT_' + id));
    ws.on('message', async (raw) => {
      await controlReleased;
      if (ws.readyState === 1) ws.send(Buffer.from(JSON.parse(String(raw)).data));
    });
  });
  const client = await connect();
  client.select(1, 'A');
  await until(() => client.frames.some((frame) => frame.selectionId === 1));
  client.select(2, 'B');
  await until(() => client.frames.some((frame) => frame.selectionId === 2));
  client.select(3, 'A');
  await until(() => client.frames.some((frame) => frame.selectionId === 3));
  client.input(3, 'after-release');
  await pause(15);
  assert(!client.frames.some((frame) => frame.text === 'after-release'));
  finish();
  await until(() => client.frames.some((frame) => frame.text === 'after-release'));
});
test('two clients keep independent selected terminals and survive the other client closing', async (t) => {
  const log = [],
    connect = await fixture(t, attachEcho(log)),
    a = await connect(),
    b = await connect();
  a.select(1, 'A');
  b.select(1, 'B');
  await until(
    () =>
      a.frames.some((frame) => frame.text === 'CURRENT_A') &&
      b.frames.some((frame) => frame.text === 'CURRENT_B'),
  );
  a.input(1, 'a');
  b.input(1, 'b');
  await until(() => log.filter((row) => row.event === 'input').length === 2);
  assert.deepEqual(
    log
      .filter((row) => row.event === 'input')
      .map(({ terminalId, data }) => [terminalId, data])
      .sort(),
    [
      ['A', 'a'],
      ['B', 'b'],
    ],
  );
  a.ws.close();
  await once(a.ws, 'close');
  b.input(1, 'still-B');
  await until(() => b.frames.some((frame) => frame.text === 'still-B'));
  assert(!b.frames.some((frame) => frame.text === 'a' || frame.text === 'CURRENT_A'));
});
test('another terminal can display and receive input while the old terminal is still closing', async (t) => {
  let finish;
  const closing = new Promise((resolve) => {
    finish = resolve;
  });
  t.after(finish);
  const log = [],
    echo = attachEcho(log);
  const connect = await fixture(t, async (options) => {
    await echo(options);
    if (options.url.searchParams.get('terminalId') === 'A')
      options.ws.shellTerminal.stop = () => closing;
  });
  const client = await connect();
  client.select(1, 'A');
  await until(() => client.frames.some((frame) => frame.text === 'CURRENT_A'));
  client.select(2, 'B');
  await until(() => client.frames.some((frame) => frame.text === 'CURRENT_B'));
  client.input(2, 'responsive');
  await until(() => client.frames.some((frame) => frame.text === 'responsive'));
  client.input(1, 'stale');
  assert(!log.some((row) => row.data === 'stale'));
});
test('replayed selections do not replace the current target; malformed bindings close the channel', async (t) => {
  const log = [],
    connect = await fixture(t, attachEcho(log)),
    client = await connect();
  client.select(3, 'A');
  await until(() => client.frames.some((frame) => frame.text === 'CURRENT_A'));
  client.select(2, 'B');
  client.select(3, 'C');
  client.input(3, 'correct');
  await until(() => client.frames.some((frame) => frame.text === 'correct'));
  assert.deepEqual(
    log.filter((row) => row.event === 'attach').map((row) => row.terminalId),
    ['A'],
  );
  client.ws.send(JSON.stringify({ type: 'terminal.select', selectionId: 4, target: {} }));
  const [code] = await once(client.ws, 'close');
  assert.equal(code, 1008);
});
