'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { create, validKey } = require('../public/chat/terminal-keyboard');
const { commandPacket, Reader } = require('../lib/herdr-terminal-session');
const key = (type, text, options = {}) => ({
  type,
  key: text,
  code: 'KeyA',
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...options,
});
test('semantic keys preserve text, shifted identity and release pairing without replaying cleared presses', () => {
  const keyboard = create();
  const press = keyboard.event(key('keydown', 'A', { shiftKey: true }));
  assert.deepEqual(press, {
    type: 'terminal.key',
    key: 'a',
    modifiers: 1,
    kind: 'press',
    shiftedCodepoint: 65,
    text: 'A',
  });
  assert.deepEqual(keyboard.event(key('keyup', 'a')), { ...press, kind: 'release', text: null });
  assert.equal(keyboard.event(key('keyup', 'a')), null);
  keyboard.event(key('keydown', 'a'));
  keyboard.clear();
  assert.equal(keyboard.event(key('keyup', 'a')), null);
  assert.equal(keyboard.event(key('keydown', 'a', { isComposing: true })), null);
  assert.equal(
    keyboard.event(key('keydown', '@', { getModifierState: (name) => name === 'AltGraph' })),
    null,
  );
});
test('protocol 22 semantic packet retains UTF-8 char, modifiers, text and release metadata', () => {
  const command = {
    type: 'terminal.key',
    paneId: 'p1',
    key: '中',
    kind: 'press',
    modifiers: 1,
    shiftedCodepoint: null,
    text: '中',
  };
  const reader = new Reader(commandPacket(command).subarray(4));
  assert.equal(reader.uint(), 13);
  assert.equal(reader.bytes().toString(), 'p1');
  assert.deepEqual([reader.uint(), reader.uint(), reader.uint()], [1, 0, 15]);
  assert.equal(reader.take(3).toString(), '中');
  assert.deepEqual(
    [reader.uint(), reader.uint(), reader.uint(), reader.uint(), reader.uint()],
    [1, 0, 1, 0, 1],
  );
  assert.equal(reader.bytes().toString(), '中');
  assert.deepEqual([reader.bool(), reader.uint(), reader.uint()], [true, 0, 0]);
  reader.end();
  assert(validKey('😀'));
  assert(validKey('F24'));
  assert(!validKey('F25'));
  assert(!validKey('Dead'));
  assert(!validKey('\x1b'));
  assert(!validKey('\ud800'));
});
