'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { RewindNative, surface } = require('../lib/codex-rewind-native'),
  { rowsToAnsi } = require('../lib/codex-rewind-watch');
const { TerminalScreen } = require('../lib/terminal-screen'),
  { textOf } = require('../public/native-status');
const pane = { paneId: 'p', terminalId: 't', runtimeId: '1:1', agent: { session: { value: 's' } } };
const target = {
  messageId: 'm',
  turnId: 'turn',
  visibleIndex: 0,
  sourceText: '中文 original',
  receiptVerified: true,
  nativeUserItemId: 'u',
};
const history = { complete: true, revision: 'r', branch: 'a', targets: [target] };
function frame({
  working = false,
  primed = false,
  selector = false,
  input = '',
  cursorExtra = 0,
} = {}) {
  const rows = selector
    ? [
        [{ text: '› ' }, { text: target.sourceText, inverse: true }],
        [{ text: 'Browsing · ←→ prompts' }],
      ]
    : [
        ...(working ? [[{ text: '• Working (1s • esc to interrupt)' }], []] : []),
        [
          { text: '› ', bold: true },
          { text: input || 'Ask Codex to do anything', ...(input ? {} : { dim: true }) },
        ],
        [],
        [{ text: primed ? 'esc again to edit previous message' : 'GPT-6.1-Sol default · ~' }],
      ];
  const prompt = selector ? 0 : working ? 2 : 0,
    ends = rows.map((r) =>
      Array.from(r.map((s) => s.text).join('')).reduce(
        (n, c) => n + (/[\u4e00-\u9fff]/.test(c) ? 2 : 1),
        0,
      ),
    );
  return {
    rows,
    raw: rowsToAnsi(rows),
    cursor: { x: ends[prompt] + cursorExtra, y: prompt },
    endColumns: ends,
    watchId: 'watch',
    frameSequence: 1,
  };
}
test('working snapshot then task completion before first Esc uses exactly two Esc', async () => {
  let state = frame({ working: true }),
    writes = [];
  const native = new RewindNative({
    readScreen: async () => state,
    verifyProcess: async () => {},
    readHistory: async () => history,
    press: async (_pane, keys) => {
      writes.push(keys[0]);
      state = frame(writes.length === 1 ? { primed: true } : { selector: true });
    },
  });
  const selection = await native.select({ pane, target, history, verify: async () => {} });
  assert.equal(selection.messageId, 'm');
  assert.deepEqual(writes, ['esc', 'esc']);
});
test('active work interruption observes idle and primes before selector', async () => {
  let state = frame({ working: true }),
    writes = [];
  const native = new RewindNative({
    readScreen: async () => state,
    verifyProcess: async () => {},
    press: async (_p, keys) => {
      writes.push(keys[0]);
      state = frame(
        writes.length === 1 ? {} : writes.length === 2 ? { primed: true } : { selector: true },
      );
    },
  });
  await native.select({ pane, target, history, verify: async () => {} });
  assert.deepEqual(writes, ['esc', 'esc', 'esc']);
});
test('preexisting primed state is rejected without keys', async () => {
  let writes = 0;
  const native = new RewindNative({
    readScreen: async () => frame({ primed: true }),
    verifyProcess: async () => {},
    press: async () => writes++,
  });
  await assert.rejects(native.select({ pane, target, history, verify: async () => {} }), {
    code: 'REWIND_NATIVE_MODE',
  });
  assert.equal(writes, 0);
});
test('whitespace cursor beyond rendered text is occupied input', () => {
  const state = surface(frame({ input: 'draft', cursorExtra: 2 }));
  assert.equal(state.input, 'draft  ');
  assert.equal(state.composer.cursorAtEnd, false);
});
test('degraded Browsing footer is selector rather than main', () => {
  assert.equal(surface(frame({ selector: true })).mode, 'selector');
});
test('foreign or unacknowledged selector cannot be cancelled', async () => {
  let writes = 0;
  const native = new RewindNative({
    readScreen: async () => frame({ selector: true }),
    verifyProcess: async () => {},
    press: async () => writes++,
  });
  await assert.rejects(
    native.cancel({
      pane,
      target,
      history,
      selection: { ownerId: 'foreign' },
      verify: async () => {},
    }),
    { code: 'REWIND_SELECTOR_NOT_OWNED' },
  );
  assert.equal(writes, 0);
});
test('owned selector validation failure cancels once before any revert Enter', async () => {
  let state = frame(),
    writes = [];
  const native = new RewindNative({
    readScreen: async () => state,
    verifyProcess: async () => {},
    press: async (_p, keys) => {
      writes.push(keys[0]);
      state =
        keys[0] === 'esc' && writes.length === 1
          ? frame({ primed: true })
          : keys[0] === 'esc' && writes.length === 2
            ? frame({ selector: true })
            : frame();
    },
  });
  const altered = { ...target, sourceText: 'different archived user' };
  await assert.rejects(
    native.select({
      pane,
      target: altered,
      history: { ...history, targets: [altered] },
      verify: async () => {},
    }),
    { code: 'REWIND_SELECTION_UNCONFIRMED' },
  );
  assert.deepEqual(writes, ['esc', 'esc', 'esc']);
  assert.equal(surface(state).mode, 'main');
});
test('identical region after Left is not acknowledged as another duplicate index', async () => {
  let state = frame(),
    writes = [];
  const first = { ...target, messageId: 'first' },
    latest = { ...target, messageId: 'last', visibleIndex: 1 };
  const native = new RewindNative({
    timeoutMs: 12,
    stepMs: 1,
    readScreen: async () => state,
    verifyProcess: async () => {},
    press: async (_p, keys) => {
      writes.push(keys[0]);
      if (keys[0] === 'esc')
        state =
          writes.length === 1
            ? frame({ primed: true })
            : writes.length === 2
              ? frame({ selector: true })
              : frame();
    },
  });
  await assert.rejects(
    native.select({
      pane,
      target: first,
      history: { ...history, targets: [first, latest] },
      verify: async () => {},
    }),
    { code: 'REWIND_NATIVE_UNCONFIRMED' },
  );
  assert.deepEqual(writes, ['esc', 'esc', 'left', 'esc']);
});
test('whitespace edit after owned restore prevents whole-draft clear', async () => {
  let state = frame(),
    writes = [],
    branch = 'a';
  const native = new RewindNative({
    readScreen: async () => state,
    verifyProcess: async () => {},
    readHistory: async () =>
      branch === 'a' ? history : { complete: true, targets: [], branch: 'b' },
    press: async (_p, keys) => {
      writes.push(keys[0]);
      if (keys[0] === 'enter') {
        branch = 'b';
        state = frame({ input: target.sourceText });
      } else state = writes.length === 1 ? frame({ primed: true }) : frame({ selector: true });
    },
  });
  const selected = await native.select({ pane, target, history, verify: async () => {} });
  await native.confirm({ pane, target, selection: selected, verify: async () => {} });
  state = frame({ input: target.sourceText, cursorExtra: 1 });
  state.frameSequence = 2;
  await assert.rejects(
    native.replace({
      pane,
      sourceText: target.sourceText,
      text: 'edited text',
      verify: async () => {},
    }),
    { code: 'REWIND_DRAFT_CHANGED' },
  );
  assert.deepEqual(writes, ['esc', 'esc', 'enter']);
});
test('uncertain revert result sends Enter once and never cancels afterward', async () => {
  let state = frame(),
    writes = [],
    entered = false;
  const native = new RewindNative({
    readScreen: async () => state,
    verifyProcess: async () => {},
    readHistory: async () => {
      if (entered) throw Object.assign(Error('lost observation'), { code: 'OFFLINE' });
      return history;
    },
    press: async (_p, keys) => {
      writes.push(keys[0]);
      if (keys[0] === 'enter') {
        entered = true;
        state = frame({ input: target.sourceText });
      } else state = writes.length === 1 ? frame({ primed: true }) : frame({ selector: true });
    },
  });
  const selected = await native.select({ pane, target, history, verify: async () => {} });
  await assert.rejects(
    native.confirm({ pane, target, selection: selected, verify: async () => {} }),
    { code: 'OFFLINE' },
  );
  assert.deepEqual(writes, ['esc', 'esc', 'enter']);
});

async function emptyPromptFrame({
  indent = 0,
  spaces = 1,
  historical = false,
  footer = 'GPT-6.1-Sol default · ~',
} = {}) {
  const screen = new TerminalScreen({ cols: 80, rows: 12 });
  try {
    const promptY = historical ? 1 : 3,
      cursorY = historical ? 7 : promptY;
    await screen.feed(
      `\x1b[2J\x1b[${promptY};1H${' '.repeat(indent)}\x1b[1m›\x1b[0m${' '.repeat(spaces)}` +
        `\x1b[9;1H${footer}\x1b[${cursorY};${indent + 2 + spaces}H`,
      { full: true },
    );
    const rows = screen.snapshot().rows,
      buffer = screen.terminal.buffer.active;
    const endColumns = rows.map((_row, y) => {
      const line = buffer.getLine(buffer.viewportY + y);
      let end = 0;
      for (let x = 0; line && x < screen.cols; x++) {
        const cell = line.getCell(x);
        if (cell?.getWidth() && !cell.isInvisible() && cell.getChars().trim())
          end = x + cell.getWidth();
      }
      return end;
    });
    return {
      rows,
      raw: rowsToAnsi(rows),
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      endColumns,
      watchId: 'isolated-vt',
      frameSequence: 1,
    };
  } finally {
    screen.close();
  }
}

test('VT-trimmed empty prompt is recognized only at its current cursor and native footer', async () => {
  const native = new RewindNative({ verifyProcess: async () => {} });
  for (const indent of [0, 2]) {
    const frame = await emptyPromptFrame({ indent });
    assert.equal(textOf(frame.rows[2]), ' '.repeat(indent) + '›');
    assert.equal(frame.endColumns[2], indent + 1);
    assert.deepEqual(frame.cursor, { x: indent + 2, y: 2 });
    const state = surface(frame);
    assert.equal(state.mode, 'main');
    assert.ok(state.composer);
    assert.equal(state.input, '');
    assert.doesNotThrow(() => native.assertMainEmpty(state));
  }
});

test('VT-trimmed prompt keeps cursor-only trailing spaces as occupied input', async () => {
  const native = new RewindNative({ verifyProcess: async () => {} });
  for (const indent of [0, 2]) {
    const frame = await emptyPromptFrame({ indent, spaces: 3 });
    assert.equal(textOf(frame.rows[2]), ' '.repeat(indent) + '›');
    const state = surface(frame);
    assert.equal(state.input, '  ');
    assert.throws(() => native.assertMainEmpty(state), { code: 'NATIVE_INPUT_OCCUPIED' });
  }
});

test('historical bare prompt, missing glyph or incomplete cursor/footer evidence stays unconfirmed', async () => {
  const native = new RewindNative({ verifyProcess: async () => {} });
  const historical = surface(await emptyPromptFrame({ historical: true }));
  assert.equal(historical.composer, null);
  assert.throws(() => native.assertMainEmpty(historical), { code: 'REWIND_COMPOSER_UNKNOWN' });
  const frame = await emptyPromptFrame();
  for (const changed of [
    { ...frame, cursor: undefined },
    { ...frame, cursor: { x: 1, y: 2 } },
    { ...frame, endColumns: [] },
    { ...frame, endColumns: frame.endColumns.map((end, y) => (y === 2 ? end + 1 : end)) },
    await emptyPromptFrame({ footer: '00% left' }),
    await emptyPromptFrame({ footer: 'esc again to edit previous message' }),
  ])
    assert.equal(surface(changed).composer, null);
  const rows = frame.rows.map((row, y) => (y === 2 ? [] : row));
  const missing = surface({ ...frame, rows, raw: rowsToAnsi(rows) });
  assert.equal(missing.mode, 'unknown');
  assert.equal(missing.composer, null);
});
