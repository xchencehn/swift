'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { create } = require('../public/chat/session-actions');
const { shouldSubmit } = require('../public/chat/shortcuts');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test('interrupt feedback precedes the response and completion does not wait for page refresh', async () => {
  const gate = deferred(),
    refresh = deferred(),
    calls = [],
    changes = [];
  const target = {
    runtimeId: 'runtime',
    processRuntimeId: 'process',
    paneId: 'p',
    terminalId: 't',
    sessionId: 's',
  };
  const service = create({
    target: () => target,
    request: async (path, options) => {
      calls.push({ path, options });
      return gate.promise;
    },
    refresh: () => refresh.promise,
    onChange: () => changes.push(true),
  });
  const first = service.interrupt(),
    duplicate = service.interrupt();
  assert.equal(service.view().phase, 'pending');
  assert.equal(calls.length, 1);
  assert(changes.length);
  gate.resolve({ interrupted: true });
  await Promise.all([first, duplicate]);
  assert.equal(service.view({ working: true }).phase, 'accepted');
  assert.equal(service.view({ working: false }).phase, 'confirmed');
  refresh.resolve();
});
test('unknown interruption results are checked with GET and never replayed', async () => {
  const calls = [],
    target = {
      runtimeId: 'runtime',
      processRuntimeId: 'process',
      paneId: 'p',
      terminalId: 't',
      sessionId: 's',
    };
  const service = create({
    target: () => target,
    request: async (path, options) => {
      calls.push({ path, options });
      if (options?.method === 'POST') throw new Error('Lost response');
      return { status: 'complete', result: { interrupted: true } };
    },
  });
  await service.interrupt();
  assert.equal(service.view().phase, 'uncertain');
  await service.interrupt();
  assert.equal(calls.length, 1);
  await service.check();
  assert.equal(calls.length, 2);
  assert(!calls[1].options);
  assert.equal(service.view().phase, 'accepted');
  target.processRuntimeId = 'replacement';
  assert.equal(service.view(), null);
});
test('hardware and virtual keyboards have scoped Enter behavior', () => {
  for (const event of [
    { key: 'Enter' },
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 },
    { key: 'Enter', code: 'Enter', shiftKey: true },
  ])
    assert.equal(shouldSubmit(event, { coarse: true }), false);
  for (const event of [
    { key: 'Enter', code: 'Enter' },
    { key: 'Enter', ctrlKey: true },
    { key: 'Enter', metaKey: true },
  ])
    assert.equal(shouldSubmit(event, { coarse: true }), true);
  assert.equal(shouldSubmit({ key: 'Enter' }), true);
});
