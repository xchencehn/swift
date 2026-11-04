'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutputControl } = require('../lib/output-control');
const { OutputWindow, OUTPUT_HIGH_BYTES } = require('../lib/output-window');
const { WatchStreamParser } = require('../lib/watch-stream');

test('consumer credit pauses output, rejects future offsets, and isolates retired streams', () => {
  const w = new OutputWindow();
  w.write(OUTPUT_HIGH_BYTES);
  assert.equal(w.blocked, true);
  assert.equal(w.acknowledge('retired', w.sent), false);
  assert.equal(w.acknowledge(w.id, w.sent + 1), false);
  assert.equal(w.acknowledge(w.id, w.sent), true);
  assert.equal(w.pending, 0);
  assert.equal(w.blocked, false);
  w.acknowledge(w.id, 0);
  assert.equal(w.pending, 0);
});
test('a stalled consumer is closed while a healthy consumer resumes after acknowledgement', () => {
  let now = 0,
    paused = 0,
    resumed = 0;
  const frames = [],
    closes = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (value) => frames.push(value),
    close: (...args) => closes.push(args),
  };
  const output = createOutputControl({
    ws,
    acknowledged: true,
    pause: () => paused++,
    resume: () => resumed++,
    now: () => now,
  });
  try {
    output.write(Buffer.alloc(OUTPUT_HIGH_BYTES));
    assert.equal(paused, 1);
    const credit = JSON.parse(frames[0]);
    output.acknowledge(credit);
    assert.equal(resumed, 1);
    output.write(Buffer.alloc(OUTPUT_HIGH_BYTES));
    now = 2100;
    output.acknowledge({ streamId: output.streamId, offset: 0 });
    assert.equal(closes[0][0], 4008);
  } finally {
    output.stop();
  }
});
test('observer decoding preserves split UTF-8, full frame ordering and an unterminated final record', () => {
  const events = [],
    bytes = Buffer.from('你🙂');
  const parser = new WatchStreamParser({
    onFrame: (data) => events.push(data),
    onFull: () => events.push('full'),
    onEnd: () => events.push('end'),
  });
  const a = JSON.stringify({
    type: 'terminal.frame',
    encoding: 'ansi',
    full: true,
    bytes: bytes.subarray(0, 2).toString('base64'),
  });
  const b = JSON.stringify({
    type: 'terminal.frame',
    encoding: 'ansi',
    bytes: bytes.subarray(2).toString('base64'),
  });
  parser.push(a.slice(0, 20));
  parser.push(a.slice(20) + '\n' + b);
  parser.finish();
  assert.equal(events[0], 'full');
  assert.equal(events.slice(1).join(''), '你🙂');
});
