'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { actionFor, create } = require('../public/chat/shortcuts');
function key(key, fields = {}) {
  return {
    key,
    preventDefault() {
      this.prevented = true;
    },
    stopImmediatePropagation() {},
    ...fields,
  };
}
const tick = () => new Promise(setImmediate);
test('directional shortcuts require exact modifiers and leave IME candidate keys alone', () => {
  assert.equal(actionFor(key('Escape')), 'pause');
  for (const [arrow, action] of [
    ['Up', 'effortUp'],
    ['Down', 'effortDown'],
    ['Left', 'modelPrevious'],
    ['Right', 'modelNext'],
  ])
    assert.equal(actionFor(key('Arrow' + arrow, { shiftKey: true })), action);
  for (const event of [
    key('ArrowUp'),
    key('m', { ctrlKey: true }),
    key('Escape', { shiftKey: true }),
    key('ArrowUp', { shiftKey: true, keyCode: 229 }),
    key('Escape', { isComposing: true }),
    key('ArrowLeft', { shiftKey: true, altKey: true }),
    key('ArrowRight', { shiftKey: true, ctrlKey: true }),
  ])
    assert.equal(actionFor(event), null);
});
function fixture(actions = {}) {
  const state = { identity: 'one', enabled: true, provider: 'codex' },
    calls = [],
    errors = [];
  const service = create({
    context: () => state,
    actions: {
      pause: () => {
        calls.push('pause');
        return true;
      },
      ...Object.fromEntries(
        ['effortUp', 'effortDown', 'modelPrevious', 'modelNext'].map((action) => [
          action,
          () => {
            calls.push(action);
            return true;
          },
        ]),
      ),
      ...actions,
    },
    reportError: (error) => errors.push(error),
    document: { addEventListener() {}, removeEventListener() {} },
  });
  return { state, calls, errors, service };
}
test('overlays, editable text and the native terminal retain ownership of their keys', async () => {
  const { state, calls, service } = fixture();
  state.blocked = true;
  assert(!service.keydown(key('Escape')));
  state.blocked = false;
  state.terminalFocus = true;
  assert(!service.keydown(key('Escape')));
  assert(!service.keydown(key('ArrowUp', { shiftKey: true })));
  state.terminalFocus = false;
  service.keydown(key('ArrowUp', { shiftKey: true }));
  service.keydown(key('ArrowRight', { shiftKey: true }));
  service.keydown(key('ArrowRight', { shiftKey: true, repeat: true }));
  await tick();
  assert.deepEqual(calls, ['effortUp', 'modelNext']);
  state.provider = 'claude';
  assert(!service.keydown(key('ArrowLeft', { shiftKey: true })));
  state.editing = true;
  assert(!service.keydown(key('ArrowRight', { shiftKey: true })));
  service.keydown(key('Escape'));
  service.keydown(key('Escape'));
  await tick();
  assert.deepEqual(calls, ['effortUp', 'modelNext', 'pause']);
});
test('local settings intents proceed while earlier writes await acknowledgement; changed sessions discard queued callbacks', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve)),
    steps = [];
  const f = fixture({
    effortUp: async () => {
      steps.push('up');
      await gate;
      return true;
    },
    modelNext: () => {
      steps.push('model');
      return false;
    },
  });
  f.service.keydown(key('ArrowUp', { shiftKey: true }));
  f.service.keydown(key('ArrowRight', { shiftKey: true }));
  f.service.keydown(key('ArrowDown', { shiftKey: true }));
  await tick();
  assert.deepEqual(steps, ['up', 'model']);
  assert.deepEqual(f.calls, ['effortDown']);
  release();
  await tick();
  f.service.keydown(key('ArrowLeft', { shiftKey: true }));
  f.state.identity = 'replacement';
  await tick();
  assert.deepEqual(f.calls, ['effortDown']);
});
