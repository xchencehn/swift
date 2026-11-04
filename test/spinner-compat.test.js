'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { matchActivityLine, stripAnsi, parseAnsiLine } = require('../public/ansi');
const { CodexSide, sideScreen } = require('../lib/codex-side');
const { surface } = require('../lib/codex-rewind-native');

// Codex 0.163.0 motion.rs:99-112 alternates these two frames without truecolor.
// The native failing screen retained an older Worked line above the live task.
const frame = (icon) =>
  `› SIDE QUESTION\n\n• SIDE ANSWER. Temporary discussion.\n  Worked for <1s • 2:28 AM\n\n› SIDE WORK\n\n${icon} Working (0s • esc to interrupt)\n\n› \x1b[2mAsk a follow-up question\x1b[0m\n\n  GPT-6.1-Sol high · ~ · Agent       Side from main thread · ^/ to switch · ^c to close`;
const nativeFrames = ['•', '\x1b[2m◦\x1b[0m'];

test('both official native Working frames remain running and keep the same activity body', () => {
  for (const icon of nativeFrames) {
    const match = matchActivityLine(`${icon} Working (0s • esc to interrupt)`);
    assert(match);
    assert.equal(match.running, true);
    assert.equal(match.icon, stripAnsi(icon));
    assert.equal(match.body, 'Working (0s • esc to interrupt)');
  }
  for (const text of [
    '◦ Working is useful.',
    'An answer quotes ◦ Working (0s • esc to interrupt)',
    '◦ project · main…',
  ])
    assert.equal(matchActivityLine(text), null);
});

test('a live alternating spinner never authorizes closing Side because of an older Worked line', () => {
  const views = nativeFrames.map((icon) => sideScreen(frame(icon)));
  for (const view of views) {
    assert.equal(view.mode, 'side');
    assert.equal(view.hasSide, true);
    assert.equal(view.canClose, false);
    assert.equal(view.inputOccupied, false);
  }
  assert.deepEqual(views[0], views[1]);
});

test('rewind native observation treats both official spinner frames as working', () => {
  for (const icon of nativeFrames) {
    const raw = frame(icon),
      rows = raw.split('\n').map(parseAnsiLine);
    assert.equal(surface({ raw, rows }).working, true);
  }
});

test('a spinner-only frame change preserves the Side revision before a switch and never replays the switch', async () => {
  const pane = {
    paneId: 'fixture-side',
    terminalId: 'fixture-terminal',
    runtimeId: 'fixture:1',
    agent: { label: 'codex', session: { value: 'main' } },
  };
  const parked =
    '• Working (0s • esc to interrupt)\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  GPT-6.1-Sol high · ~ · Main [high]    ^/ for side';
  let reads = 0,
    switched = false;
  const writes = [];
  const controller = new CodexSide({
    settleMs: 0,
    exactPane: async () => pane,
    herdr: {
      readPane: async () =>
        switched ? parked : frame(nativeFrames[reads++ % nativeFrames.length]),
    },
    press: async (_pane, keys) => {
      writes.push(keys);
      switched = true;
    },
    paste: async () => {
      throw Error('A switch must not paste input.');
    },
  });
  const first = await controller.read(pane),
    second = await controller.read(pane);
  assert.equal(first.revision, second.revision);
  const body = { ...first, requestId: 'native-spinner-switch', action: 'main' };
  assert.equal((await controller.handle(body)).mode, 'main');
  assert.equal((await controller.handle(body)).mode, 'main');
  assert.deepEqual(writes, [['ctrl+/']]);
});
