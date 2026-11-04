'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { MessageQueue } = require('../lib/message-queue');
function fixture() {
  let calls = [],
    reads = 0;
  const pane = {
    paneId: 'p',
    terminalId: 't',
    runtimeId: 'runtime',
    agent: {
      label: 'codex',
      name: 'codex',
      status: 'working',
      session: { kind: 'uuid', value: 's' },
    },
  };
  const q = new MessageQueue({
    getPane: async () => pane,
    readMessages: async () => {
      reads++;
      throw new Error('archive unavailable during writing');
    },
    send: async (p, text) => {
      calls.push(text);
      return {};
    },
  });
  q.persist = () => {};
  return {
    q,
    pane,
    calls,
    get reads() {
      return reads;
    },
  };
}
test('busy Codex receives consecutive inputs immediately without archive reads or idle waits', async () => {
  const f = fixture();
  for (const text of ['first', 'second', '/goal change']) {
    const r = await f.q.submitNative({ id: text, paneId: 'p', text });
    assert.equal(r.status, 'dispatched');
    assert.equal(r.deliveryUncertain, false);
  }
  assert.deepEqual(f.calls, ['first', 'second', '/goal change']);
  assert.equal(f.reads, 0);
});
test('a failed legacy queue head cannot block a new native delivery', async () => {
  const f = fixture();
  for (let i = 0; i < 40; i++)
    f.q.items.push({
      id: `old-${i}`,
      paneId: 'p',
      status: 'failed',
      retryable: true,
      deliveryUncertain: true,
    });
  await f.q.submitNative({ id: 'new', paneId: 'p', text: 'now' });
  assert.deepEqual(f.calls, ['now']);
});
test('concurrent duplicate HTTP submissions and an explicit retry keep a single native write', async () => {
  const f = fixture();
  let release;
  const wait = new Promise((r) => {
    release = r;
  });
  f.q.send = async (p, text) => {
    f.calls.push(text);
    await wait;
  };
  const body = { id: 'same', paneId: 'p', text: 'once' };
  const a = f.q.submitNative(body),
    b = f.q.submitNative(body);
  await new Promise((r) => setTimeout(r, 10));
  release();
  await Promise.all([a, b]);
  await f.q.submitNative(body);
  assert.deepEqual(f.calls, ['once']);
});
test('native rejection is a failed receipt, never an Agent-idle queue or automatic retry', async () => {
  const f = fixture();
  f.q.send = async () => {
    throw Object.assign(new Error('native dialog'), {
      code: 'agent_blocked',
      deliveryUncertain: false,
    });
  };
  const r = await f.q.submitNative({ id: 'rejected', paneId: 'p', text: 'retryable' });
  assert.equal(r.status, 'failed');
  assert.equal(r.retryable, true);
  await f.q.tick();
  assert.equal(f.q.list('p')[0].status, 'failed');
});
test('unknown delivery results are never replayed by polling or repeating the same id', async () => {
  const f = fixture();
  f.q.send = async () => {
    f.calls.push('write');
    throw new Error('response lost');
  };
  const body = { id: 'unknown', paneId: 'p', text: 'once' };
  const r = await f.q.submitNative(body);
  assert.equal(r.deliveryUncertain, true);
  await f.q.submitNative({ ...body, retry: true });
  await f.q.tick();
  assert.deepEqual(f.calls, ['write']);
});

test('native adapter receives a validated identity once and intermediate writes do not refresh clients', async () => {
  const f = fixture(),
    notices = [];
  let reads = 0;
  const q = new MessageQueue({
    getPane: () => assert.fail('legacy lookup'),
    getNativePane: async () => {
      reads++;
      return f.pane;
    },
    sendNative: async (item) => {
      assert.equal(item.sessionId, 's');
      assert.equal(item.runtimeId, 'runtime');
      assert.equal(notices.length, 0);
      return {};
    },
    onChange: () => notices.push('change'),
  });
  const result = await q.submitNative({ id: 'native', paneId: 'p', text: 'now' });
  assert.equal(reads, 1);
  assert.equal(result.status, 'dispatched');
  assert.equal(notices.length, 1);
  await assert.rejects(
    q.submitNative({ id: 'wrong-binding', paneId: 'p', text: 'no', binding: 'stale' }),
    { code: 'SESSION_CHANGED' },
  );
});
test('native adapter rejection publishes the final failure and preserves the explicit retry boundary', async () => {
  const f = fixture(),
    notices = [],
    q = new MessageQueue({
      getPane: async () => f.pane,
      sendNative: async () => {
        throw Object.assign(new Error('replaced'), { deliveryUncertain: false });
      },
      onChange: () => notices.push('change'),
    });
  const result = await q.submitNative({ id: 'reject', paneId: 'p', text: 'retain' });
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(result.deliveryUncertain, false);
  assert.equal(notices.length, 1);
});
test('failed native receipts do not trigger legacy dashboard polling or replay', async () => {
  const f = fixture();
  let lookups = 0;
  f.q.getPane = async () => {
    lookups++;
    return f.pane;
  };
  f.q.send = async () => {
    throw Object.assign(new Error('pipe closed'), { code: 'EPIPE' });
  };
  await f.q.submitNative({ id: 'pipe-failure', paneId: 'p', text: 'once' });
  const initial = lookups;
  for (let i = 0; i < 5; i++) await f.q.tick();
  assert.equal(lookups, initial);
  assert.equal(f.q.items[0].deliveryUncertain, true);
});
test('a lost HTTP response recovers its receipt with the same id while Herdr is offline', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture();
    if (uncertain)
      f.q.send = async () => {
        f.calls.push('written');
        throw new Error('response lost');
      };
    const body = { id: 'receipt', paneId: 'p', sessionId: 's', text: 'only once' };
    const original = await f.q.submitNative(body);
    f.q.getNativePane = async () => {
      throw new Error('native endpoint offline');
    };
    const recovered = await f.q.submitNative({ ...body, retry: true });
    assert.equal(recovered.status, original.status);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.q.submitNative({ ...body, text: 'changed' }), {
      code: 'MESSAGE_ID_CONFLICT',
    });
    await assert.rejects(f.q.submitNative({ ...body, sessionId: 'replacement' }), {
      code: 'MESSAGE_ID_CONFLICT',
    });
  }
});
