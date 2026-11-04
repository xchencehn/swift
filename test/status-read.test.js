'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { accountOf, create } = require('../public/chat/status-read');
const row = (text) => [{ text }];
test('only the native Account field supplies the full account, including native decoration', () => {
  assert.equal(
    accountOf([row('│ Account: first@example.test (Pro)           │')]),
    'first@example.test (Pro)',
  );
  assert.equal(accountOf([row('Alias: chen'), row('Diagnostic: other@example.test')]), '');
});
test('narrow native status reads the Account value column without swallowing the next field', () => {
  assert.equal(
    accountOf([
      '  Account:',
      '                       connected@example.tes',
      '                       t (Pro 200)',
      '  Collaboration mode:  Default',
      '  Session:',
      '                       another-session',
    ]),
    'connected@example.test (Pro 200)',
  );
  assert.equal(
    accountOf([
      '  Account:             connected@example.test',
      '                       (Pro 200)',
      '  Session:             other',
    ]),
    'connected@example.test (Pro 200)',
  );
  assert.equal(
    accountOf(['  Account:', '  Session: other', '                       wrong@example.test']),
    '',
  );
});
test('account opens asynchronously, coalesces pending reads and only polls the same lease', async () => {
  let release;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    calls = [];
  const reader = create({
    identity: () => 'same',
    target: () => ({ processRuntimeId: 'process-1' }),
    wait: async () => {},
    request: async (body) => {
      calls.push(body);
      if (body.action === 'execute') {
        await gate;
        return { pending: true, leaseId: 'lease', revision: 'one' };
      }
      return { mode: 'result', rows: [row('Account: first@example.test')], pending: false };
    },
  });
  const first = reader.read(),
    second = reader.read();
  assert.equal(reader.view().phase, 'reading');
  assert(reader.active());
  release();
  await Promise.all([first, second]);
  assert.equal(reader.view().account, 'first@example.test');
  assert(!reader.active());
  assert.deepEqual(
    calls.map((call) => call.action),
    ['execute', 'read'],
  );
  assert.equal(calls[1].leaseId, 'lease');
  assert.equal(calls[0].processRuntimeId, 'process-1');
});
test('failed execute is never replayed and late responses cannot cross session identity', async () => {
  let calls = 0,
    binding = 'first',
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reader = create({
    identity: () => binding,
    target: () => ({}),
    request: async () => {
      calls++;
      await gate;
      return { mode: 'result', rows: [row('Account: first@example.test')] };
    },
  });
  const pending = reader.read();
  await Promise.resolve();
  binding = 'second';
  release();
  await pending;
  assert.deepEqual(reader.view(), { phase: 'idle', account: '' });
  assert.equal(calls, 1);
  const failed = create({
    identity: () => 'same',
    target: () => ({}),
    request: async () => {
      calls++;
      throw Error('response lost');
    },
  });
  await failed.read();
  await failed.read();
  assert.equal(calls, 3);
  assert.equal(failed.view().phase, 'unconfirmed');
});
test('checking an uncertain query retains its client and cannot execute again', async () => {
  const calls = [];
  let online = false;
  const reader = create({
    identity: () => 'same',
    target: () => ({}),
    request: async (body) => {
      calls.push(body);
      if (!online) throw Error('network unavailable');
      return {
        mode: 'result',
        rows: [row('Account: connected@example.test')],
        leaseId: 'original',
      };
    },
  });
  await reader.read();
  assert.equal(reader.view().phase, 'unconfirmed');
  online = true;
  await reader.read({ refresh: true });
  assert.equal(reader.view().account, 'connected@example.test');
  assert.deepEqual(
    calls.map((item) => item.action),
    ['execute', 'read', 'read'],
  );
  assert(calls.every((item) => item.clientId === calls[0].clientId));
});
test('a lost execute reply is recovered by reading the same client without repeating native input', async () => {
  const calls = [];
  const reader = create({
    identity: () => 'same',
    target: () => ({ processRuntimeId: 'bound' }),
    request: async (body) => {
      calls.push(body);
      if (body.action === 'execute') throw Error('response lost after native Enter');
      return {
        mode: 'result',
        rows: [row('Account: connected@example.test')],
        leaseId: 'original',
      };
    },
  });
  await reader.read();
  assert.equal(reader.view().account, 'connected@example.test');
  assert(!reader.active());
  assert.deepEqual(
    calls.map((item) => item.action),
    ['execute', 'read'],
  );
  assert.equal(calls[0].clientId, calls[1].clientId);
  assert.equal(calls[1].processRuntimeId, 'bound');
});
