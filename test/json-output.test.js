'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { createJsonOutput } = require('../lib/json-output');
function fixture(budget = 1024) {
  const sent = [],
    callbacks = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 10 * 1024 * 1024,
    syncReady: true,
    send: (data, done) => {
      sent.push(JSON.parse(data));
      callbacks.push(done);
    },
  };
  return { ws, sent, callbacks, output: createJsonOutput(ws, { budget }) };
}
test('large bootstrap frames serialize through send completion without a bufferedAmount disconnect', async () => {
  const f = fixture();
  const first = f.output.send({ type: 'sync.session', payload: 'a'.repeat(5000) }),
    second = f.output.send({ type: 'terminal.ready' });
  assert.equal(f.sent.length, 1);
  f.callbacks.shift()();
  assert.equal(f.sent.length, 2);
  f.callbacks.shift()();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});
test('a slow live replica uses bounded resynchronization rather than buffering every revision or closing', async () => {
  const f = fixture();
  const promises = [];
  for (let i = 0; i < 1000; i++)
    promises.push(
      f.output.send({ type: 'sync.session', key: 'codex:s', payload: 'x'.repeat(500) }),
    );
  assert(f.output.queuedBytes < 1024);
  assert.equal(f.ws.syncReady, false);
  f.callbacks.shift()();
  assert.equal(f.sent.at(-1).type, 'sync.reset');
  f.callbacks.shift()();
  await Promise.all(promises);
});
test('connection shutdown releases waiting writers', async () => {
  const f = fixture();
  f.output.send({ type: 'terminal.ready' });
  const pending = f.output.send({ type: 'sync.ready' });
  f.output.stop();
  assert.equal(await pending, false);
});

test('negotiated sync gzip keeps terminal notifications plain and serializes through completion', async () => {
  const wire = [],
    options = [];
  const ws = {
    readyState: 1,
    syncCompression: 'gzip',
    send: (data, flags, done) => {
      wire.push(JSON.parse(data));
      options.push(typeof flags === 'object' ? flags : {});
      (done || flags)();
    },
  };
  const output = createJsonOutput(ws);
  const message = {
    type: 'sync.session',
    messages: [{ id: 'm', text: '包含中文与原始代码。\n'.repeat(5000) }],
  };
  const first = output.send(message),
    second = output.send({ type: 'terminal.ready' });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(wire[0].type, 'sync.compressed');
  assert.equal(wire[1].type, 'terminal.ready');
  assert.equal(options[0].compress, false);
  assert.equal(wire[0].bytes, Buffer.byteLength(JSON.stringify(message)));
  assert.deepEqual(
    JSON.parse(require('node:zlib').gunzipSync(Buffer.from(wire[0].data, 'base64'))),
    message,
  );
  assert(Buffer.byteLength(JSON.stringify(wire[0])) < wire[0].bytes / 4);
  output.stop();
});

test('older clients retain ordinary sync JSON and closing during compression releases its writer', async () => {
  const wire = [],
    ws = {
      readyState: 1,
      send: (data, done) => {
        wire.push(JSON.parse(data));
        done();
      },
    };
  const output = createJsonOutput(ws),
    message = { type: 'sync.session', text: 'x'.repeat(20000) };
  await output.send(message);
  assert.deepEqual(wire, [message]);
  ws.syncCompression = 'gzip';
  const pending = output.send(message);
  output.stop();
  assert.equal(await pending, false);
});
