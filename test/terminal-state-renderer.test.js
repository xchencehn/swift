'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { create } = require('../public/chat/terminal-state-renderer');
const row = (text) => ({
  cells: Array.from({ length: 12 }, (_, x) => [text[x] || ' ', 1, -1, -1, 0, -1, null]),
  soft_wrapped: false,
  wrap_continuation: false,
});
const frame = (options = {}) => ({
  type: 'terminal_state',
  version: 1,
  terminal_id: 't',
  boot_id: 'b',
  revision: 1,
  base_revision: null,
  cols: 12,
  rows: 3,
  first_row: 2,
  total_rows: 5,
  row_offset: 0,
  history_epoch: 1,
  history_start: 0,
  history: [row('old-0'), row('old-1')],
  cursor: [2, 2, true],
  alternate_screen: false,
  mouse_tracking: false,
  mouse_sgr: false,
  mouse_pixels: false,
  bracketed_paste: false,
  changes: [
    [0, row('live-0')],
    [1, row('live-1')],
    [2, row('prompt>')],
  ],
  ...options,
});
const bytes = (value) => Buffer.from(JSON.stringify(value) + '\n');
const write = (terminal, text) => new Promise((resolve) => terminal.write(text, resolve));
const screen = (terminal) =>
  Array.from({ length: terminal.rows }, (_, y) =>
    terminal.buffer.active
      .getLine(terminal.buffer.active.viewportY + y)
      .translateToString(true)
      .trimEnd(),
  );
test('native cells render without a second terminal parser, local scrolling preserves reading during output', async (t) => {
  const renderer = create({ terminalId: 't' }),
    display = new Terminal({ cols: 12, rows: 3, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  renderer.write(bytes(frame()));
  await write(display, renderer.render({ cols: 12, rows: 3 }));
  assert.deepEqual(screen(display), ['live-0', 'live-1', 'prompt>']);
  assert.equal(renderer.render(), '');
  assert.equal(renderer.scroll('up', 2, 'wheel'), true);
  await write(display, renderer.render());
  assert.deepEqual(screen(display), ['old-0', 'old-1', 'live-0']);
  renderer.write(
    bytes(
      frame({
        revision: 2,
        base_revision: 1,
        first_row: 3,
        total_rows: 6,
        history_start: 2,
        history: [row('live-0')],
        changes: [
          [0, row('live-1')],
          [1, row('prompt>')],
          [2, row('new-output')],
        ],
      }),
    ),
  );
  assert.equal(renderer.render(), '', 'new output must not move the reading position');
  renderer.toBottom();
  await write(display, renderer.render());
  assert.deepEqual(screen(display), ['live-1', 'prompt>', 'new-output']);
});
test('native styles, wide cells, hyperlinks and fragmented UTF-8 reach the visible terminal', async (t) => {
  const renderer = create({ terminalId: 't' }),
    display = new Terminal({ cols: 12, rows: 3, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const styled = row('');
  styled.cells[0] = ['中', 2, 1, 0x1010203, 1 | 2 | 256, -1, 'https://example.test/'];
  styled.cells[1] = ['', 0, -1, -1, 0, -1, null];
  styled.cells[2][0] = '文';
  styled.cells[2][1] = 2;
  styled.cells[3][1] = 0;
  const input = bytes(
    frame({
      cursor_shape: 6,
      changes: [
        [0, styled],
        [1, row('')],
        [2, row('')],
      ],
    }),
  );
  for (let offset = 0; offset < input.length; offset += 7)
    renderer.write(input.subarray(offset, offset + 7));
  let cursorStyle;
  display.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
    cursorStyle = params[0];
    return false;
  });
  await write(display, renderer.render({ cols: 12, rows: 3 }));
  assert.equal(screen(display)[0], '中文');
  assert.equal(cursorStyle, 6);
  const cell = display.buffer.active.getLine(0).getCell(0);
  assert.equal(cell.getWidth(), 2);
  assert.equal(cell.getFgColor(), 1);
  assert.equal(cell.getBgColor(), 0x010203);
  assert(cell.isBold() && cell.isItalic() && cell.isUnderline());
});
test('application mouse and alternate screen preserve remote scroll semantics; Shift can read locally', () => {
  const renderer = create({ terminalId: 't' });
  renderer.write(bytes(frame({ mouse_tracking: true })));
  assert.equal(renderer.scroll('up', 1, 'wheel'), false);
  assert.equal(renderer.scroll('up', 1, 'wheel', true), true);
  renderer.dispose();
});
test('history pages are tied to a terminal epoch and invalid deltas cannot partially replace the screen', () => {
  const renderer = create({ terminalId: 't' });
  renderer.write(bytes(frame({ history: [], history_start: 2 })));
  assert.equal(renderer.historyRequest().start, 0);
  renderer.history({ boot_id: 'wrong', history_epoch: 1, start: 0, content: [row('wrong')] });
  assert.equal(renderer.historyRequest().start, 0);
  renderer.history({
    boot_id: 'b',
    history_epoch: 1,
    start: 0,
    content: [row('old-0'), row('old-1')],
  });
  assert.equal(renderer.historyRequest(), null);
  assert.throws(() => renderer.write(bytes(frame({ revision: 2, base_revision: 0 }))));
  assert.equal(renderer.state.revision, 1);
  renderer.dispose();
});
test('copy uses native soft wraps and wide cells from the displayed state', () => {
  const renderer = create({ terminalId: 't' });
  const first = row('hello world ');
  first.soft_wrapped = true;
  const second = row('');
  second.wrap_continuation = true;
  second.cells[0] = ['中', 2, -1, -1, 0, -1, null];
  second.cells[1][1] = 0;
  const snapshot = frame({
    changes: [
      [0, first],
      [1, second],
      [2, row('next')],
    ],
  });
  renderer.write(bytes(snapshot));
  renderer.render({ cols: 12, rows: 3 });
  const selection = { start: { x: 0, y: 0 }, end: { x: 2, y: 1 } };
  assert.equal(renderer.selectionText(selection), 'hello world 中');
  assert.equal(renderer.selectionText({ start: { x: 0, y: 1 }, end: { x: 4, y: 2 } }), '中\nnext');
  renderer.write(bytes(frame({ revision: 2, base_revision: 1, changes: [[0, row('unpainted')]] })));
  assert.equal(
    renderer.selectionText(selection),
    'hello world 中',
    'unpainted updates cannot change copied content',
  );
  renderer.dispose();
});
test('a shorter native viewport retains status and hint rows below the input cursor', async (t) => {
  const renderer = create({ terminalId: 't' }),
    display = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const lines = [
    'header',
    'logo-1',
    'logo-2',
    'logo-3',
    'prompt>',
    '',
    'MODEL STATUS',
    '? shortcuts',
  ];
  renderer.write(
    bytes(
      frame({
        rows: 8,
        first_row: 0,
        total_rows: 8,
        history: [],
        cursor: [7, 4, true],
        changes: lines.map((text, y) => [y, row(text)]),
      }),
    ),
  );
  await write(display, renderer.render({ cols: 12, rows: 6 }));
  assert.deepEqual(screen(display), lines.slice(2));
  assert.equal(display.buffer.active.cursorY, 2);
  display.resize(12, 4);
  await write(display, renderer.render({ cols: 12, rows: 4 }));
  assert.deepEqual(screen(display), lines.slice(4));
  renderer.write(
    bytes(
      frame({
        revision: 2,
        base_revision: 1,
        rows: 8,
        first_row: 0,
        total_rows: 8,
        history: [],
        cursor: [7, 4, true],
        changes: [[7, row('')]],
      }),
    ),
  );
  await write(display, renderer.render());
  assert.equal(display.buffer.active.cursorY, 0, 'a disappearing hint cannot move the prompt');
  assert.equal(screen(display)[2], 'MODEL STATUS');
  display.resize(12, 8);
  await write(display, renderer.render({ cols: 12, rows: 8 }));
  assert.equal(screen(display)[0], 'header');
  assert.equal(display.buffer.active.cursorY, 4);
  display.resize(12, 4);
  renderer.write(
    bytes(
      frame({
        revision: 3,
        base_revision: 2,
        rows: 8,
        first_row: 0,
        total_rows: 8,
        history: [],
        cursor: [0, 0, true],
        changes: [[0, row('QUESTION>')]],
      }),
    ),
  );
  await write(display, renderer.render({ cols: 12, rows: 4 }));
  assert.equal(
    screen(display)[0],
    'QUESTION>',
    'an active cursor above the bottom remains visible',
  );
});
