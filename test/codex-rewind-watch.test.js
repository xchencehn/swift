'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
let script = '',
  missingBinary = false;
const calls = [];
childProcess.spawn = (bin, args, options) => {
  assert.equal(bin, 'mock-herdr');
  assert.deepEqual(args, [
    'terminal',
    'session',
    'observe',
    'term-fixture',
    '--cols',
    '250',
    '--rows',
    '120',
  ]);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
  calls.push({ args, options });
  // Only this Node protocol fixture is started. Never execute Herdr.
  return originalSpawn(
    missingBinary ? '/nonexistent/swift-native-watch-fixture' : process.execPath,
    ['-e', script],
    options,
  );
};
const { NativeWatch, rowsToAnsi } = require('../lib/codex-rewind-watch');
childProcess.spawn = originalSpawn;
const { TerminalScreen } = require('../lib/terminal-screen');
const pane = { terminalId: 'term-fixture', scroll: { viewport_rows: 40 } };
const herdr = {
  bin: 'mock-herdr',
  socketPath: '/ignored/native-watch-fixture.sock',
  env: () => ({
    HERDR_SOCKET_PATH: '/different/server.sock',
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'other:pane',
    HERDR_TAB_ID: 'other:tab',
    HERDR_WORKSPACE_ID: 'other',
  }),
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixturePrelude = `
const frame=(data,full=false)=>process.stdout.write(JSON.stringify({type:'terminal.frame',encoding:'ansi',full,bytes:Buffer.from(data).toString('base64')})+'\\n');
const hold=setInterval(()=>{},1000);
`;
function watch(body, timeoutMs = 2000) {
  script = fixturePrelude + body;
  missingBinary = false;
  return new NativeWatch({ herdr, pane, timeoutMs });
}

test('one observer applies full and deltas, retaining cursor and stable frame sequence', async () => {
  const before = calls.length;
  const observer =
    watch(`frame('\\x1b[H\\x1b[2J\\x1b[38;2;12;34;56;48;2;65;43;21;1;2;7m中文 A\\x1b[0m',true);
    setTimeout(()=>frame('\\x1b[2;1H\\x1b[2mAsk\\x1b[0m'),100);`);
  const roundtrip = new TerminalScreen();
  try {
    const first = await observer.read();
    assert.equal(first.frameSequence, 1);
    assert.deepEqual(first.cursor, { x: 6, y: 0 });
    assert.equal(first.endColumns[0], 6);
    assert.equal(first.viewportRows, 40);
    assert(first.rows[0].some((span) => span.inverse && span.dim && span.bold));
    await roundtrip.feed(rowsToAnsi(first.rows).replace(/\n/g, '\r\n'), { full: true });
    assert.deepEqual(roundtrip.snapshot().rows, first.rows);
    let second = first;
    for (let i = 0; i < 40 && second.frameSequence < 2; i++) {
      await delay(10);
      second = await observer.read();
    }
    assert.equal(second.frameSequence, 2);
    assert.equal(second.watchId, first.watchId);
    assert.deepEqual(second.cursor, { x: 3, y: 1 });
    assert.equal(second.endColumns[1], 3);
    assert.equal(
      (await observer.read()).frameSequence,
      2,
      'sampling must not advance native frame sequence',
    );
    assert.equal(calls.length, before + 1);
    assert.equal(observer.child.stdin, null);
    const env = calls.at(-1).options.env;
    assert.equal(env.HERDR_SOCKET_PATH, herdr.socketPath);
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID'])
      assert.equal(env[key], undefined);
  } finally {
    roundtrip.close();
    await observer.close();
  }
});

test('cell widths and isWrapped come from VT rather than JavaScript string length', async () => {
  const observer = watch(`frame('\\x1b[H\\x1b[2J'+'中'.repeat(126),true);`);
  try {
    const frame = await observer.read();
    assert.deepEqual(frame.endColumns, [250, 2]);
    assert.deepEqual(frame.isWrapped, [false, true]);
    assert.deepEqual(frame.cursor, { x: 2, y: 1 });
  } finally {
    await observer.close();
  }
});

test('EOF invalidates an already applied frame', async () => {
  const observer = watch(`frame('complete frame',true);setTimeout(()=>process.exit(0),100);`);
  try {
    assert.equal((await observer.read()).frameSequence, 1);
    await observer.childClosed;
    await assert.rejects(observer.read(), { code: 'REWIND_WATCH_ENDED' });
  } finally {
    await observer.close();
  }
});

test('terminal.closed invalidates cached data and terminates only its observer', async () => {
  const observer = watch(`frame('complete frame',true);
    setTimeout(()=>process.stdout.write(JSON.stringify({type:'terminal.closed'})+'\\n'),100);`);
  try {
    await observer.read();
    await observer.childClosed;
    await assert.rejects(observer.read(), { code: 'REWIND_WATCH_ENDED' });
    assert.equal(observer.childExited, true);
  } finally {
    await observer.close();
  }
});

test('a missing full frame times out and cannot be revived by a later read', async () => {
  const observer = watch(`frame('delta without full');`, 100);
  try {
    await assert.rejects(observer.read(), { code: 'REWIND_WATCH_TIMEOUT' });
    await observer.childClosed;
    await assert.rejects(observer.read(), { code: 'REWIND_WATCH_TIMEOUT' });
  } finally {
    await observer.close();
  }
});

test('invalid frame protocol cannot silently retain a preceding valid frame', async () => {
  const observer = watch(`frame('complete frame',true);
    setTimeout(()=>process.stdout.write('{malformed}\\n'),100);`);
  try {
    await observer.read();
    await observer.childClosed;
    await assert.rejects(observer.read(), { code: 'REWIND_WATCH_PROTOCOL' });
  } finally {
    await observer.close();
  }
});

test('close rejects readers waiting for the first frame and is idempotent', async () => {
  const observer = watch('');
  const pending = observer.read();
  const rejected = assert.rejects(pending, { code: 'REWIND_WATCH_CLOSED' });
  await observer.close();
  await rejected;
  await observer.close();
  await assert.rejects(observer.read(), { code: 'REWIND_WATCH_CLOSED' });
  assert.equal(observer.childExited, true);
});

test('an observer spawn error rejects pending reads without hanging', async () => {
  missingBinary = true;
  const observer = new NativeWatch({ herdr, pane, timeoutMs: 1000 });
  missingBinary = false;
  try {
    await assert.rejects(observer.read(), { code: 'REWIND_WATCH_START' });
  } finally {
    await observer.close();
  }
});
