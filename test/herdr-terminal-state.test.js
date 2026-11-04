'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTerminalState } = require('../lib/herdr-terminal-state');

const row = (text) => ({
  cells: [...text].map((c) => [c, 1, -1, -1, 0, -1, null]),
  soft_wrapped: false,
  wrap_continuation: false,
});
const frame = () => ({
  type: 'terminal_state',
  version: 1,
  terminal_id: 't1',
  boot_id: 'boot1',
  revision: 2,
  base_revision: null,
  cols: 2,
  rows: 2,
  total_rows: 2,
  first_row: 0,
  cursor: [1, 1, true],
  alternate_screen: false,
  mouse_tracking: false,
  mouse_sgr: false,
  mouse_pixels: false,
  bracketed_paste: false,
  changes: [
    [0, row('ab')],
    [1, row('cd')],
  ],
});

test('native terminal deltas preserve unchanged rows and apply atomically', () => {
  const initial = applyTerminalState(null, frame(), 't1');
  const delta = { ...frame(), base_revision: 2, revision: 4, changes: [[1, row('ef')]] };
  const updated = applyTerminalState(initial, delta, 't1');
  assert.equal(updated.content[0], initial.content[0]);
  assert.equal(updated.content[1].cells[0][0], 'e');
  assert.equal(initial.content[1].cells[0][0], 'c');
  assert.throws(() =>
    applyTerminalState(
      initial,
      {
        ...delta,
        changes: [
          [0, row('xy')],
          [2, row('zz')],
        ],
      },
      't1',
    ),
  );
  assert.equal(initial.content[0].cells[0][0], 'a');
});

test('missing bases, incomplete frames and crossed identities require resynchronization', () => {
  const initial = applyTerminalState(null, frame(), 't1');
  for (const invalid of [
    { ...frame(), changes: [[0, row('ab')]] },
    { ...frame(), terminal_id: 't2' },
    { ...frame(), cursor_shape: '6 q\x1b[2J' },
    { ...frame(), cursor_shape: 7 },
    { ...frame(), base_revision: 0 },
    {
      ...frame(),
      changes: [
        [0, row('ab')],
        [0, row('cd')],
      ],
    },
  ])
    assert.throws(() => applyTerminalState(null, invalid, 't1'));
  for (const invalid of [
    { ...frame(), revision: 4, boot_id: 'boot2' },
    { ...frame(), revision: 4, base_revision: 1 },
    frame(),
  ])
    assert.throws(() => applyTerminalState(initial, invalid, 't1'));
});
