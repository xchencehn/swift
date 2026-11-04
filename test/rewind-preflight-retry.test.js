'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RewindInteraction, isRewindPreflightFailure } = require('../lib/rewind-interaction');
const { MessageQueue } = require('../lib/message-queue');
const { digest } = require('../lib/codex-rewind-history');
const { Database } = require('../lib/store/database');
const { EventLog } = require('../lib/store/events');
const { MessageStore } = require('../lib/store/message-store');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-preflight-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(options = {}) {
  const pane = {
    paneId: 'p',
    terminalId: 'terminal',
    runtimeId: '123:456',
    agent: {
      label: 'codex',
      name: 'codex',
      status: 'idle',
      session: { kind: 'uuid', value: 'thread' },
    },
  };
  const targets = [
    {
      supported: true,
      messageId: 'first',
      turnId: 'turn-first',
      sourceText: 'first text',
      visibleIndex: 0,
    },
    {
      supported: true,
      messageId: 'chosen',
      turnId: 'turn-chosen',
      sourceText: '原消息\n第二行。',
      visibleIndex: 1,
    },
  ];
  let history = { complete: true, revision: digest(targets), targets },
    scope = 'fixture-root',
    now = 100,
    herdrRuntime = 'herdr-runtime';
  const calls = [],
    checks = [],
    receipts = [];
  const state = { unknown: true, fail: null };
  const native = {
    async select({ target, verify }) {
      await verify();
      calls.push('select');
      if (state.fail === 'select') throw Error('selection failed');
      return { messageId: target.messageId, turnId: target.turnId };
    },
    async confirm({ target, verify }) {
      await verify();
      calls.push('confirm');
      history = { ...history, targets: history.targets.slice(0, target.visibleIndex) };
      history.revision = digest(history.targets);
      if (state.fail === 'confirm') throw Error('revert reply lost');
    },
    async replace({ verify }) {
      await verify();
      calls.push('replace');
      if (state.fail === 'replace') throw Error('replace failed');
    },
    async send({ verify }) {
      await verify();
      calls.push('send');
      if (state.fail === 'send') throw Error('send reply lost');
      return { nativeUserMessageId: 'new-message' };
    },
    async cancel({ verify }) {
      await verify();
      calls.push('cancel');
    },
    async read() {
      calls.push('read');
      return { mode: 'unknown', input: null };
    },
  };
  const deps = {
    native,
    target: async (body) => {
      if (body.runtimeId !== herdrRuntime)
        throw Object.assign(Error('Herdr runtime changed'), { code: 'RUNTIME_CHANGED' });
      return structuredClone(pane);
    },
    readHistory: async () => {
      if (state.readFailure) throw Object.assign(Error('archive offline'), { code: 'READ_FAILED' });
      return structuredClone(history);
    },
    scope: () => scope,
    now: () => now,
    timeoutMs: 20,
    stepMs: 1,
    beforeWrite: async () => {
      checks.push(state.unknown ? 'unknown' : 'main');
      if (state.unknown)
        throw Object.assign(Error('尚未确认原生会话，内容未发送。'), {
          code: 'SIDE_UNKNOWN',
          deliveryUncertain: false,
        });
    },
  };
  let controller = new RewindInteraction(deps);
  const preparationBody = {
    paneId: 'p',
    terminalId: 'terminal',
    runtimeId: 'herdr-runtime',
    sessionId: 'thread',
    clientId: 'client',
    requestId: 'prepare',
    messageId: 'chosen',
  };
  const { preparation } = await controller.prepare(preparationBody);
  const body = {
    id: 'stable-send',
    paneId: 'p',
    sessionId: 'thread',
    text: '编辑后的中文\n第二行。',
    rewind: { preparationId: preparation.id },
  };
  const queue = new MessageQueue({
    file: options.file,
    store: options.store,
    getPane: async () => structuredClone(pane),
    getNativePane: async () => structuredClone(pane),
    readMessages: async () => [],
    sendNative: async (item, progress) => {
      receipts.push({ id: item.id, text: item.text, preparationId: item.rewind.preparationId });
      await controller.ensureAvailable(pane);
      return controller.submit(item, progress);
    },
    send: async () => {
      throw Error('ordinary adapter must not run');
    },
  });
  const submit = (extra) => queue.submitNative({ ...body, ...extra });
  return {
    queue,
    body,
    pane,
    calls,
    checks,
    receipts,
    state,
    preparation,
    deps,
    submit,
    get controller() {
      return controller;
    },
    restartController() {
      controller = new RewindInteraction(deps);
      for (const item of queue.items) controller.restore(item);
    },
    setScope(value) {
      scope = value;
    },
    expire() {
      now += 31 * 60 * 1000;
    },
    changeHerdrRuntime() {
      herdrRuntime = 'new-herdr-runtime';
    },
    changeHistory() {
      history.revision = 'changed';
    },
  };
}

function reload(f) {
  const controller = new RewindInteraction(f.deps);
  const queue = new MessageQueue({
    file: f.queue.file,
    getPane: async () => structuredClone(f.pane),
    readMessages: async () => [],
    sendNative: async (item, progress) => {
      await controller.ensureAvailable(f.pane);
      return controller.submit(item, progress);
    },
  });
  for (const item of queue.items) controller.restore(item);
  return { queue, controller, submit: (extra) => queue.submitNative({ ...f.body, ...extra }) };
}

test('explicit same-ID retry rechecks unknown state without native input, then submits exactly once', async () => {
  const f = await fixture();
  const first = await f.submit();
  assert.equal(first.status, 'failed');
  assert.equal(first.error.code, 'SIDE_UNKNOWN');
  assert.equal(first.retryable, true);
  assert.equal(first.deliveryUncertain, false);
  assert.equal(first.rewindProgress.nativeStarted, false);
  assert(isRewindPreflightFailure(first));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.submit(), first);
  assert.deepEqual(f.checks, ['unknown']);
  const again = await f.submit({ retry: true });
  assert.equal(again.status, 'failed');
  assert.equal(again.retryable, true);
  assert.deepEqual(f.checks, ['unknown', 'unknown']);
  assert.deepEqual(f.calls, []);
  f.state.unknown = false;
  const accepted = await f.submit({ retry: true });
  assert.equal(accepted.status, 'dispatched');
  assert.equal(accepted.retryable, false);
  assert.equal(accepted.nativeUserMessageId, 'new-message');
  assert.deepEqual(f.calls, ['select', 'confirm', 'replace', 'send']);
  assert.deepEqual(await f.submit({ retry: true }), accepted);
  assert.equal(f.calls.filter((value) => value === 'send').length, 1);
  assert.equal(f.queue.items.length, 1);
  assert(
    f.receipts.every(
      (value) =>
        value.id === f.body.id &&
        value.text === f.body.text &&
        value.preparationId === f.preparation.id,
    ),
  );
});

test('known Task085 failed/validated record may omit nativeStarted and retain its immutable intent', async () => {
  const f = await fixture();
  await f.submit();
  const item = f.queue.items[0];
  delete item.rewindProgress.nativeStarted;
  item.retryable = false;
  item.rewindProgress.retryable = false;
  assert(isRewindPreflightFailure(item));
  assert.equal(f.controller.restore(item), false);
  assert.equal(f.controller.busy.size, 0);
  await f.controller.ensureAvailable(f.pane);
  assert.deepEqual(f.calls, []);
  f.state.unknown = false;
  const result = await f.submit({ retry: true });
  assert.equal(result.status, 'dispatched');
  assert.equal(f.queue.items.length, 1);
  assert.equal(f.calls.filter((value) => value === 'send').length, 1);
});

test('incomplete, contradictory and uncertain progress never gains explicit retry eligibility', async () => {
  const f = await fixture();
  const safe = await f.submit();
  const mutations = [];
  for (const key of [
    'nativeStarted',
    'revertAttempted',
    'reverted',
    'sendAttempted',
    'cleanupRequired',
    'recoveryRequired',
    'messageSubmitted',
    'revertUncertain',
    'deliveryUncertain',
  ]) {
    for (const value of [true, null, 0, 'false'])
      mutations.push((item) => {
        item.rewindProgress[key] = value;
      });
    if (key !== 'nativeStarted')
      mutations.push((item) => {
        delete item.rewindProgress[key];
      });
  }
  mutations.push(
    (item) => {
      delete item.rewindProgress.rewindPhase;
    },
    (item) => {
      item.rewindProgress.rewindPhase = 'selecting';
    },
    (item) => {
      item.rewindProgress.phase = 'validated';
    },
    (item) => {
      item.rewindProgress.sendAccepted = true;
    },
    (item) => {
      item.rewindProgress.selection = {};
    },
    (item) => {
      item.rewindProgress.receipt = {};
    },
    (item) => {
      item.rewindProgress.context.preparationId = 'another';
    },
    (item) => {
      delete item.rewindProgress.context.identity.sessionId;
    },
    (item) => {
      delete item.rewindProgress.context.target;
    },
    (item) => {
      delete item.rewindProgress.context.prefix;
    },
    (item) => {
      item.rewindProgress.context.nativeTarget.runtimeId = 'another-runtime';
    },
  );
  for (const mutate of mutations) {
    const item = structuredClone(safe);
    mutate(item);
    item.retryable = true;
    assert.equal(isRewindPreflightFailure(item), false, String(mutate));
    f.queue.items = [item];
    assert.deepEqual(await f.submit({ retry: true }), item);
  }
  f.queue.items = [{ ...structuredClone(safe), deliveryUncertain: true, retryable: true }];
  assert.equal((await f.submit({ retry: true })).deliveryUncertain, true);
  assert.equal(f.checks.length, 1);
  assert.deepEqual(f.calls, []);
});

test('same request ID cannot change text, preparation or session during a preflight retry', async () => {
  const f = await fixture();
  await f.submit();
  for (const change of [
    { text: 'different text' },
    { rewind: { preparationId: 'different' } },
    { sessionId: 'different' },
  ])
    await assert.rejects(f.submit({ retry: true, ...change }), { code: 'MESSAGE_ID_CONFLICT' });
  await assert.rejects(f.submit({ retry: true, id: 'different' }), { code: 'MESSAGE_NOT_FOUND' });
  assert.deepEqual(f.calls, []);
  assert.equal(f.checks.length, 1);
});

test('retry revalidates live preparation, scope, process and original user history before any native key', async () => {
  for (const change of [
    'expired',
    'cancelled',
    'claimed',
    'scope',
    'process',
    'history',
    'context',
  ]) {
    const f = await fixture();
    await f.submit();
    f.state.unknown = false;
    if (change === 'expired') f.expire();
    if (change === 'cancelled')
      f.controller.cancel({ preparationId: f.preparation.id, clientId: 'client' });
    if (change === 'claimed')
      f.controller.preparations.get(f.preparation.id).claimedBy = 'another-send';
    if (change === 'scope') f.setScope('other-root');
    if (change === 'process') f.pane.runtimeId = '999:111';
    if (change === 'history') f.changeHistory();
    if (change === 'context')
      f.queue.items[0].rewindProgress.context.target.sourceText = 'tampered source';
    try {
      const result = await f.submit({ retry: true });
      assert.equal(result.status, 'failed', change);
    } catch (cause) {
      assert(
        ['MESSAGE_ID_CONFLICT', 'SESSION_CHANGED'].includes(cause.code),
        `${change}: ${cause.code}`,
      );
    }
    assert.deepEqual(f.calls, [], change);
  }
});

test('after upgrade an explicit same-ID retry revalidates the Task085 proof and resumes the same preparation exactly once', async (t) => {
  const file = path.join(scratch(t), 'queue.json'),
    f = await fixture({ file });
  await f.submit();
  delete f.queue.items[0].rewindProgress.nativeStarted;
  f.queue.items[0].retryable = false;
  f.queue.items[0].rewindProgress.retryable = false;
  f.queue.persist();
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).items[0];
  assert(isRewindPreflightFailure(before));
  const { queue, controller, submit } = reload(f);
  assert.deepEqual(queue.items[0], before);
  assert.equal(controller.preparations.size, 0);
  assert.deepEqual(await submit(), before);
  assert.equal(controller.preparations.size, 0);
  await assert.rejects(
    controller.submit(before, async () => {}),
    { code: 'REWIND_PREPARATION_EXPIRED' },
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.checks.length, 1);
  const stillUnknown = await submit({ retry: true });
  assert.equal(stillUnknown.error.code, 'SIDE_UNKNOWN');
  assert.equal(stillUnknown.retryable, true);
  assert.equal(controller.preparations.size, 1);
  assert.deepEqual(f.calls, []);
  f.state.unknown = false;
  const result = await submit({ retry: true });
  assert.equal(result.status, 'dispatched');
  assert.deepEqual(f.calls, ['select', 'confirm', 'replace', 'send']);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].rewind.preparationId, f.preparation.id);
  assert.equal(Object.hasOwn(queue.items[0], 'rewindPreflightRetry'), false);
  const restartedAgain = reload({ ...f, queue });
  assert.deepEqual(await restartedAgain.submit({ retry: true }), result);
  assert.equal(f.calls.filter((value) => value === 'send').length, 1);
});

test('safe-proof recovery after restart refuses every changed identity, scope, target, history and prefix before native input', async (t) => {
  const dir = scratch(t);
  for (const change of [
    'scope',
    'herdr',
    'process',
    'pane',
    'terminal',
    'session',
    'provider',
    'history',
    'target',
    'prefix',
    'missingClient',
    'offline',
  ]) {
    const f = await fixture({ file: path.join(dir, `${change}.json`) });
    await f.submit();
    f.state.unknown = false;
    if (change === 'scope') f.setScope('another-root');
    if (change === 'herdr') f.changeHerdrRuntime();
    if (change === 'process') f.pane.runtimeId = '999:111';
    if (change === 'pane') f.pane.paneId = 'other-pane';
    if (change === 'terminal') f.pane.terminalId = 'other-terminal';
    if (change === 'session') f.pane.agent.session.value = 'other-session';
    if (change === 'provider') f.pane.agent.label = 'claude';
    if (change === 'history') f.changeHistory();
    if (change === 'target')
      f.queue.items[0].rewindProgress.context.target.sourceText = 'tampered text';
    if (change === 'prefix') f.queue.items[0].rewindProgress.context.prefix = [];
    if (change === 'missingClient')
      delete f.queue.items[0].rewindProgress.context.nativeTarget.clientId;
    if (change === 'offline') f.state.readFailure = true;
    f.queue.persist();
    const resumed = reload(f);
    try {
      const result = await resumed.submit({ retry: true });
      assert.equal(result.status, 'failed', change);
      assert.equal(result.deliveryUncertain, false, change);
    } catch (cause) {
      assert(
        ['MESSAGE_ID_CONFLICT', 'SESSION_CHANGED', 'UNSUPPORTED_PROVIDER'].includes(cause.code),
        `${change}: ${cause.code}`,
      );
    }
    assert.equal(resumed.controller.preparations.size, 0, change);
    assert.deepEqual(f.calls, [], change);
  }
});

test('restart uncertainty and incomplete progress cannot authorize reconstruction even with an explicit retry', async (t) => {
  const dir = scratch(t);
  for (const change of ['started', 'missingPhase', 'missingFlag', 'uncertain', 'sending']) {
    const f = await fixture({ file: path.join(dir, `${change}.json`) });
    await f.submit();
    f.state.unknown = false;
    const item = f.queue.items[0];
    if (change === 'started') item.rewindProgress.nativeStarted = true;
    if (change === 'missingPhase') delete item.rewindProgress.rewindPhase;
    if (change === 'missingFlag') delete item.rewindProgress.sendAttempted;
    if (change === 'uncertain') item.deliveryUncertain = true;
    if (change === 'sending') {
      item.status = 'sending';
      item.deliveryUncertain = true;
    }
    item.retryable = true;
    f.queue.persist();
    const resumed = reload(f);
    const result = await resumed.submit({ retry: true });
    assert.equal(result.status, 'failed', change);
    assert.equal(resumed.controller.preparations.size, 0, change);
    assert.deepEqual(f.calls, [], change);
  }
});

test('resumed selection, revert and uncertain delivery failures persist to the real queue and cannot replay after another restart', async (t) => {
  const dir = scratch(t);
  for (const stage of ['select', 'confirm', 'replace', 'send']) {
    const f = await fixture({ file: path.join(dir, `${stage}.json`) });
    await f.submit();
    const resumed = reload(f);
    f.state.unknown = false;
    f.state.fail = stage;
    const failed = await resumed.submit({ retry: true });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.retryable, false);
    assert.equal(failed.rewindProgress.nativeStarted, true);
    assert.equal(isRewindPreflightFailure(failed), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.queue.file, 'utf8')).items[0], failed);
    const originalCalls = [...f.calls];
    resumed.queue.items[0].retryable = true;
    resumed.queue.persist();
    f.state.fail = null;
    await resumed.submit({ retry: true });
    assert.deepEqual(f.calls, originalCalls, stage);
    const restartedAgain = reload({ ...f, queue: resumed.queue });
    await restartedAgain.submit({ retry: true });
    assert.deepEqual(f.calls, originalCalls, stage);
    assert.equal(restartedAgain.controller.preparations.size, 0, stage);
  }
});

test('simultaneous explicit retries share the same durable submission', async () => {
  const f = await fixture();
  await f.submit();
  f.state.unknown = false;
  const [a, b] = await Promise.all([f.submit({ retry: true }), f.submit({ retry: true })]);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'dispatched');
  assert.equal(f.checks.length, 2);
  assert.equal(f.calls.filter((value) => value === 'send').length, 1);
});

test('removing one safe preflight barrier preserves another unresolved rewind on the same pane', async () => {
  const f = await fixture(),
    safe = await f.submit();
  const other = structuredClone(safe);
  other.id = 'other';
  Object.assign(other.rewindProgress, {
    nativeStarted: true,
    rewindPhase: 'selected',
    cleanupRequired: true,
  });
  assert.equal(f.controller.restore(other), true);
  assert.equal(f.controller.restore(safe), true);
  assert.deepEqual([...f.controller.barriers.get('p').keys()], ['other']);
  await assert.rejects(f.controller.ensureAvailable(f.pane), { code: 'REWIND_RECOVERY_REQUIRED' });
  assert.deepEqual(f.calls, ['read']);
});

test('a failure without durable progress is never replayed merely because it is labelled retryable', async () => {
  const f = await fixture();
  let checks = 0;
  f.queue.sendNative = async () => {
    checks++;
    throw Object.assign(Error('before controller'), {
      code: 'SIDE_UNKNOWN',
      retryable: true,
      deliveryUncertain: false,
    });
  };
  const failed = await f.submit();
  assert.equal(failed.retryable, false);
  await f.submit({ retry: true });
  assert.equal(checks, 1);
  assert.deepEqual(f.calls, []);
});

test('failed preflight checkpoint persistence grants no retry receipt and sends no native input', async () => {
  const f = await fixture();
  const item = {
    ...f.body,
    terminalId: f.pane.terminalId,
    runtimeId: f.pane.runtimeId,
    agent: 'codex',
  };
  await assert.rejects(
    f.controller.submit(item, async () => {
      throw Error('disk failed');
    }),
    { retryable: false, deliveryUncertain: false },
  );
  assert.equal(item.rewindProgress, undefined);
  assert.deepEqual(f.calls, []);
});

test('JSON and SQLite retain the complete safe proof, including the precise legacy missing field', async (t) => {
  const f = await fixture(),
    safe = await f.submit(),
    dir = scratch(t);
  const database = new Database(path.join(dir, 'state.sqlite'));
  t.after(() => database.close());
  const store = new MessageStore(database, new EventLog(database));
  for (const legacy of [false, true]) {
    const item = structuredClone(safe);
    if (legacy) delete item.rewindProgress.nativeStarted;
    const json = JSON.parse(JSON.stringify(item));
    assert(isRewindPreflightFailure(json));
    store.save([item]);
    const loaded = store.load()[0];
    assert.deepEqual(loaded, json);
    assert(isRewindPreflightFailure(loaded));
    assert.equal(Object.hasOwn(loaded.rewindProgress, 'nativeStarted'), !legacy);
  }
});
