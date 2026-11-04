const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/core/connection-state');
test('connection layers remain independent and old generations cannot alter current target', () => {
  const state = create({ now: () => 1000 });
  const old = state.begin();
  state.transport('connected');
  state.update({ sync: 'ready', observer: 'ready', input: 'available' });
  state.update({ observer: 'failed' });
  assert.equal(state.snapshot().network, 'open');
  assert.equal(state.snapshot().input, 'available');
  state.begin();
  assert.equal(state.update({ sync: 'ready' }, old), false);
  assert.equal(state.snapshot().sync, 'offline');
  state.transport('offline', { blocked: true, code: 1008, retries: 4 });
  assert.equal(state.snapshot().network, 'blocked');
});
test('diagnostics are bounded, packet timestamps stay in memory and content cannot enter export', () => {
  let calls = 0;
  const state = create({ now: () => 1234, trace: () => calls++ });
  for (let i = 0; i < 100000; i++) state.received();
  assert.equal(calls, 0);
  for (let i = 0; i < 100; i++)
    state.update({ input: i % 2 ? 'empty' : 'available', message: 'secret body' });
  const exported = JSON.parse(state.export());
  assert.equal(exported.events.length, 64);
  assert.equal(exported.current.received, 1234);
  assert(!JSON.stringify(exported).includes('secret'));
  assert.equal(exported.current.input, 2);
});
