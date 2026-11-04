'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { clearNativeComposer, composerState } = require('../lib/native-composer');
const pane = {
  paneId: 'p',
  terminalId: 't',
  runtimeId: 'r',
  agent: { label: 'codex', session: { value: 's' } },
};
const screen = (text) =>
  `• Working (12s · Esc to interrupt)\n\n› ${text.replaceAll('\n', '\n  ')}\n\nGPT-6-Astra high · ~/fixture`;
test('multiline and blank-first-line composers include every visible line', () => {
  for (const input of ['\n剩余第二行', '中文\n\nthird line', 'x'.repeat(300)])
    assert.equal(composerState(screen(input), 'codex').input.replace(/\n  /g, '\n'), input);
  const rule = '─'.repeat(40),
    input = Array.from({ length: 20 }, (_, i) => 'line ' + i).join('\n');
  assert.equal(
    composerState(`${rule}\n❯ ${input.replaceAll('\n', '\n  ')}\n${rule}`, 'claude').input,
    input,
  );
});
test('clear reads back every edit and never presses submit or interrupt', async () => {
  let value = 'first\nsecond\nlast',
    writes = [];
  const cleared = await clearNativeComposer({
    pane,
    exactPane: async () => pane,
    screen: async () => screen(value),
    stepMs: 1,
    press: async (keys) => {
      writes.push(keys);
      value = value.includes('\n') ? value.slice(0, value.lastIndexOf('\n')) : '';
    },
  });
  assert(cleared);
  assert.equal(value, '');
  assert.equal(writes.length, 3);
  assert(writes.flat().every((k) => ['ctrl+e', 'ctrl+u', 'ctrl+k'].includes(k)));
});
test('empty composer never writes, while side and modal input are not cleared', async () => {
  let writes = 0;
  const options = { pane, exactPane: async () => pane, press: async () => writes++, stepMs: 1 };
  assert.equal(await clearNativeComposer({ ...options, screen: async () => screen('') }), false);
  await assert.rejects(
    clearNativeComposer({
      ...options,
      screen: async () => '› side draft\n\nSide from main thread · ^/ to switch · ^c to close',
    }),
    { code: 'SIDE_ACTIVE' },
  );
  await assert.rejects(
    clearNativeComposer({
      ...options,
      screen: async () =>
        'Select Model and Effort\n\n› 1. GPT-6-Astra\n  2. Other\n\nenter select · esc back',
    }),
    { code: 'NATIVE_INPUT_UNAVAILABLE' },
  );
  assert.equal(writes, 0);
});
test('replacement or concurrent typing during identity verification prevents clearing', async () => {
  for (const replace of [true, false]) {
    let value = 'original',
      writes = 0;
    await assert.rejects(
      clearNativeComposer({
        pane,
        screen: async () => screen(value),
        press: async () => writes++,
        exactPane: async () => {
          value = 'concurrent text';
          return replace ? { ...pane, terminalId: 'changed' } : pane;
        },
      }),
      { code: replace ? 'SESSION_CHANGED' : 'NATIVE_INPUT_CHANGED' },
    );
    assert.equal(writes, 0);
  }
});
test('unchanged input stops at the clearing deadline without submitting', async () => {
  let writes = 0;
  await assert.rejects(
    clearNativeComposer({
      pane,
      exactPane: async () => pane,
      screen: async () => screen('unchanged'),
      press: async () => writes++,
      stepMs: 1,
      timeoutMs: 10,
    }),
    { code: 'NATIVE_INPUT_CLEAR_UNCONFIRMED', deliveryUncertain: false },
  );
  assert(writes >= 1);
});
