'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');
const { attachTerminalMultiplexer } = require('../lib/terminal-multiplexer');
const { createOutputControl } = require('../lib/output-control');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read) {
  for (let i = 0; i < 120; i++) {
    if (read()) return;
    await pause(10);
  }
  assert.fail('Multiplex response timed out');
}
async function fixture(t) {
  const targets = new Map(),
    inputs = [],
    closed = [],
    acknowledgements = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (ws) => {
    attachTerminalMultiplexer({
      ws,
      url: new URL('http://fixture/api/terminal'),
      herdr: {},
      maxInputBytes: 65536,
      attach: async ({ ws: target, url }) => {
        const id = url.searchParams.get('terminalId');
        targets.set(id, target);
        const output = createOutputControl({
          ws: target,
          acknowledged: true,
          pause() {},
          resume() {},
        });
        target.shellTerminal = {
          output,
          stop() {
            closed.push(id);
            output.stop();
          },
        };
        target.output = output;
        target.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === 'terminal.input') {
            inputs.push([id, message.data]);
            output.write(Buffer.from(message.data));
          }
        });
        target.send(JSON.stringify({ type: 'terminal.full' }));
        output.write(Buffer.from('CURRENT_' + id));
      },
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'terminal.ack') {
        acknowledgements.push(message);
        ws.shellTerminal.output.acknowledge(message);
      }
    });
  });
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const ws = new WebSocket('ws://127.0.0.1:' + server.address().port),
    frames = [];
  let flow;
  ws.on('message', (bytes, binary) => {
    if (binary) {
      frames.push({
        subscriptionId: bytes.readUInt32LE(),
        text: bytes.subarray(4).toString(),
        flow,
      });
      flow = null;
    } else {
      const value = JSON.parse(String(bytes));
      frames.push(value);
      if (value.type === 'terminal.flow') flow = value;
    }
  });
  await once(ws, 'open');
  await until(() => frames.some((frame) => frame.type === 'terminal.channel.ready'));
  const send = (value) => ws.send(JSON.stringify(value));
  return {
    ws,
    frames,
    targets,
    inputs,
    closed,
    acknowledgements,
    send,
    subscribe(id, name) {
      send({
        type: 'terminal.subscribe',
        subscriptionId: id,
        target: { paneId: 'p-' + name, terminalId: name, runtimeId: 'r', cols: 100, rows: 30 },
      });
    },
    activate(selectionId, subscriptionId) {
      send({ type: 'terminal.activate', selectionId, subscriptionId });
    },
  };
}
test('hidden subscriptions continue output, preserve flow ownership and reject stale input', async (t) => {
  const f = await fixture(t);
  f.subscribe(1, 'A');
  f.activate(1, 1);
  f.subscribe(2, 'B');
  f.activate(2, 2);
  await until(() => f.targets.size === 2);
  f.targets.get('A').output.write(Buffer.from('BACKGROUND_A'));
  f.send({ type: 'terminal.input', subscriptionId: 1, selectionId: 1, data: 'wrong' });
  f.send({ type: 'terminal.input', subscriptionId: 2, selectionId: 2, data: 'right' });
  await until(() => f.frames.some((frame) => frame.text === 'right'));
  assert.deepEqual(f.inputs, [['B', 'right']]);
  assert.deepEqual(f.closed, []);
  assert(f.frames.some((frame) => frame.text === 'BACKGROUND_A'));
  for (const frame of f.frames.filter((frame) => frame.text)) {
    assert.equal(frame.flow.subscriptionId, frame.subscriptionId);
    f.send({ type: 'terminal.ack', streamId: frame.flow.streamId, offset: frame.flow.offset });
  }
  await until(() => f.acknowledgements.length === 4);
  f.activate(3, 1);
  f.send({ type: 'terminal.input', subscriptionId: 1, selectionId: 3, data: 'return' });
  await until(() => f.frames.some((frame) => frame.text === 'return'));
  assert.equal(f.targets.size, 2);
  assert.deepEqual(f.closed, []);
});
test('background output overflow closes only that subscription and foreground input remains usable', async (t) => {
  const f = await fixture(t);
  f.subscribe(1, 'A');
  f.subscribe(2, 'B');
  f.activate(1, 2);
  await until(() => f.targets.size === 2);
  f.targets.get('A').output.write(Buffer.alloc(1024 * 1024 + 1));
  await until(() =>
    f.frames.some(
      (frame) => frame.type === 'terminal.subscription.closed' && frame.subscriptionId === 1,
    ),
  );
  assert.deepEqual(f.closed, ['A']);
  assert.equal(f.ws.readyState, WebSocket.OPEN);
  f.send({ type: 'terminal.input', subscriptionId: 2, selectionId: 1, data: 'still-responsive' });
  await until(() => f.frames.some((frame) => frame.text === 'still-responsive'));
  assert(
    !f.frames.some(
      (frame) => frame.type === 'terminal.subscription.closed' && frame.subscriptionId === 2,
    ),
  );
});
test('unsubscribe retires the native stream while other terminals keep their subscription', async (t) => {
  const f = await fixture(t);
  f.subscribe(1, 'A');
  f.subscribe(2, 'B');
  f.activate(1, 2);
  await until(() => f.targets.size === 2);
  f.send({ type: 'terminal.unsubscribe', subscriptionId: 1 });
  await until(() => f.closed.includes('A'));
  f.targets.get('A').send(Buffer.from('retired'));
  f.targets.get('B').output.write(Buffer.from('live'));
  await until(() => f.frames.some((frame) => frame.text === 'live'));
  assert(!f.frames.some((frame) => frame.text === 'retired'));
});
