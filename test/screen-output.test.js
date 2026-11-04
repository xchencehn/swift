'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { createScreenOutput } = require('../lib/screen-output');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture() {
  const frames = [],
    closed = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data, done) => {
      frames.push(JSON.parse(data));
      done?.();
    },
    close: (...a) => closed.push(a),
  };
  const output = createScreenOutput({ ws, terminalId: 't', binding: 'p:s', observerId: 'o' });
  const screen = (n) => ({
    revision: n,
    rows: [[{ text: 'raw terminal transcript '.repeat(10000) }]],
    projection: { recognized: true, rows: [[{ text: `Working for ${n}s` }]], statusRows: [] },
  });
  return { ws, frames, closed, output, screen };
}
test('suspended consumers keep one latest status without raw transcript, bytes or a 2-second disconnect', async () => {
  const f = fixture();
  f.output.write(f.screen(1));
  for (let i = 2; i <= 1000; i++) f.output.write(f.screen(i));
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.output.pending, { inFlight: 1, queued: 1 });
  await delay(2150);
  assert.deepEqual(f.closed, []);
  f.output.acknowledge({ observerId: 'o', revision: 1 });
  assert.equal(f.frames.length, 2);
  assert.equal(f.frames[1].revision, 1000);
  assert.deepEqual(f.frames[1].rows, []);
  assert(JSON.stringify(f.frames[1]).length < 400);
  f.output.stop();
});
test('stale and future screen acknowledgements cannot release another frame', () => {
  const f = fixture();
  f.output.write(f.screen(1));
  f.output.write(f.screen(2));
  for (const ack of [
    { observerId: 'old', revision: 1 },
    { observerId: 'o', revision: 3 },
  ])
    f.output.acknowledge(ack);
  assert.equal(f.frames.length, 1);
  f.output.acknowledge({ observerId: 'o', revision: 1 });
  assert.equal(f.frames.length, 2);
  f.output.stop();
});
test('transport congestion waits and coalesces instead of disconnecting', async () => {
  const f = fixture();
  f.ws.bufferedAmount = 5 * 1024 * 1024;
  f.output.write(f.screen(1));
  f.output.write(f.screen(2));
  assert.equal(f.frames.length, 0);
  assert.deepEqual(f.closed, []);
  f.ws.bufferedAmount = 0;
  await delay(70);
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].revision, 2);
  f.output.stop();
});
test('hidden transcript-only changes do not transmit unchanged projected status', () => {
  const f = fixture();
  const a = f.screen(1);
  f.output.write(a);
  f.output.acknowledge({ observerId: 'o', revision: 1 });
  a.revision = 2;
  a.rows = [];
  f.output.write(a);
  assert.equal(f.frames.length, 1);
  f.output.stop();
});
test('transient native redraws retain the complete status, persistent unknown is reported', async () => {
  const f = fixture();
  f.output.write(f.screen(1));
  f.output.acknowledge({ observerId: 'o', revision: 1 });
  const unknown = (n) => ({
    ...f.screen(n),
    projection: { recognized: false, rows: [], statusRows: [] },
  });
  f.output.write(unknown(2));
  await delay(30);
  f.output.write(f.screen(3));
  assert.equal(f.frames.length, 2);
  assert.equal(f.frames[1].projection.recognized, true);
  f.output.acknowledge({ observerId: 'o', revision: 3 });
  f.output.write(unknown(4));
  await delay(400);
  assert.equal(f.frames.at(-1).projection.recognized, false);
  f.output.stop();
});
test('persistent unknown retains its reason and diagnostic ID without transmitting raw terminal text', async () => {
  const frames = [],
    events = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data, done) => {
      frames.push(JSON.parse(data));
      done?.();
    },
  };
  const output = createScreenOutput({
    ws,
    terminalId: 't',
    binding: 'p:s',
    observerId: 'o',
    diagnostics: {
      observe: (event) => {
        events.push(event);
        return 'diagnostic-1';
      },
    },
  });
  const interaction = { thread: 'unknown', inputTarget: 'unknown', reason: 'footer-not-visible' };
  output.write({
    revision: 1,
    cols: 45,
    rows: [[{ text: 'PRIVATE TERMINAL' }]],
    projection: {
      recognized: false,
      rows: [[{ text: 'PRIVATE TERMINAL' }]],
      statusRows: [],
      interaction,
    },
  });
  await delay(400);
  assert.equal(frames[0].projection.interaction.reason, 'footer-not-visible');
  assert.equal(frames[0].diagnosticId, 'diagnostic-1');
  assert(!JSON.stringify(frames).includes('PRIVATE'));
  assert.equal(events.length, 1);
  assert.equal(events[0].rows, 1);
  output.stop();
});
