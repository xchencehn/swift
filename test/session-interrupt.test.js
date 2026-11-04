'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { SessionInterrupt, runningScreen } = require('../lib/session-interrupt');
const { ConversationStore } = require('../lib/conversation-store');
const screen = (activity) =>
  activity +
  '\n\n› Ask Codex to do anything\n\n  gpt-6 high · /fixture/project · Ready · Context 1%';
const working = screen('• Working (2s • esc to interrupt)');
function fixture(beforeWrite = async () => {}) {
  const state = {
    raw: working,
    runtimeId: 'runtime',
    turnId: 'turn-1',
    calls: [],
    pane: {
      paneId: 'p',
      terminalId: 'terminal',
      runtimeId: 'process',
      agent: { label: 'codex', session: { value: 'session' } },
    },
  };
  const store = new ConversationStore(),
    target = { paneId: 'p', terminalId: 'terminal', runtimeId: 'runtime', sessionId: 'session' };
  const service = new SessionInterrupt({
    herdr: {
      dashboard: async () => ({ runtimeId: state.runtimeId }),
      readPane: async () => state.raw,
    },
    exactPane: async () => state.pane,
    readTurn: async () => state.turnId,
    operate: (id, run) => store.operate(id, run),
    beforeWrite: (pane) => beforeWrite(state, pane),
    interrupt: async (id) => {
      state.calls.push(id);
    },
  });
  const body = (id) => ({
    ...target,
    turnId: state.turnId,
    processRuntimeId: state.pane.runtimeId,
    requestId: id,
  });
  return { state, service, target, body };
}
test('only the current native running activity permits interruption', () => {
  assert.equal(runningScreen(working), true);
  for (const raw of [
    screen('Worked for 2s'),
    screen('• Working (2s • esc to interrupt)\nAn old answer'),
    working + '\nPress escape again to edit previous message',
    '• Working (2s • esc to interrupt)',
    screen('• Working (2s • esc to interrupt)').replace(
      'Ready · Context 1%',
      'Side from main · ^c to close',
    ),
  ])
    assert.equal(runningScreen(raw), false, raw);
});
test('idle and interrupted native turns never receive Esc', async () => {
  const { state, service, target, body } = fixture();
  state.raw = screen('Worked for 2s');
  assert.equal((await service.preview(target)).canInterrupt, false);
  assert.equal((await service.run(body('idle'))).interrupted, false);
  assert.deepEqual(state.calls, []);
});
test('duplicate and concurrent clicks send one Esc even while the running frame lingers', async () => {
  const { state, service, target, body } = fixture();
  assert.equal((await service.preview(target)).canInterrupt, true);
  const first = body('one'),
    results = await Promise.all([service.run(first), service.run(first), service.run(body('two'))]);
  assert.deepEqual(
    results.map((r) => r.interrupted),
    [true, true, false],
  );
  assert.deepEqual(state.calls, ['p']);
  assert.equal((await service.preview(target)).canInterrupt, false);
  state.turnId = 'turn-2';
  assert.equal((await service.preview(target)).canInterrupt, true);
  await service.run(body('three'));
  assert.equal(state.calls.length, 2);
});
test('completion and turn changes between preview and write do not send Esc', async () => {
  const stopped = fixture((state) => {
    state.raw = screen('Worked for 2s');
  });
  assert.equal((await stopped.service.run(stopped.body('stop-race'))).interrupted, false);
  assert.deepEqual(stopped.state.calls, []);
  const completed = fixture((state) => {
    state.turnId = null;
  });
  assert.equal((await completed.service.run(completed.body('completed-race'))).interrupted, false);
  assert.deepEqual(completed.state.calls, []);
  const changed = fixture((state) => {
    state.turnId = 'new-turn';
  });
  await assert.rejects(changed.service.run(changed.body('turn-race')), { code: 'TURN_CHANGED' });
  assert.deepEqual(changed.state.calls, []);
});
test('stale runtime, terminal, session, process and request identity are rejected', async () => {
  const { state, service, body } = fixture();
  for (const [key, value] of [
    ['runtimeId', 'old'],
    ['terminalId', 'old'],
    ['sessionId', 'old'],
    ['processRuntimeId', 'old'],
    ['turnId', 'old'],
  ]) {
    await assert.rejects(service.run({ ...body('stale-' + key), [key]: value }));
  }
  assert.deepEqual(state.calls, []);
  await service.run(body('once'));
  await assert.rejects(service.run({ ...body('once'), terminalId: 'changed' }), {
    code: 'INTERRUPT_REQUEST_CHANGED',
  });
  assert.equal(state.calls.length, 1);
});
test('an uncertain native write is not repeated for the same turn', async () => {
  const { state, service, target, body } = fixture();
  service.interrupt = async () => {
    state.calls.push('uncertain');
    throw new Error('transport reply lost');
  };
  await assert.rejects(service.run(body('lost')), /reply lost/);
  await assert.rejects(service.run(body('lost')), /reply lost/);
  assert.equal((await service.preview(target)).canInterrupt, false);
  assert.equal((await service.run(body('another-id'))).interrupted, false);
  assert.equal(state.calls.length, 1);
});
test('current-turn actions capture the live turn instead of trusting stale history', async () => {
  const { state, service, body } = fixture();
  const request = { ...body('current'), turnId: 'old-cached-turn', currentTurn: true };
  await service.run(request);
  assert.deepEqual(state.calls, ['p']);
  assert.equal((await service.run({ ...request, requestId: 'other-button' })).interrupted, false);
  assert.equal(state.calls.length, 1);
});
test('a new turn arriving after the live capture is refreshed without an Esc or a stale-history error', async () => {
  const { state, service, body } = fixture((state) => {
    state.turnId = 'new-turn';
  });
  assert.deepEqual(await service.run({ ...body('current-race'), currentTurn: true }), {
    ok: true,
    interrupted: false,
    reason: 'turn-changed',
  });
  assert.deepEqual(state.calls, []);
});
test('Claude stops use the same native running check and deduplicate the active turn', async () => {
  const { state, service, body } = fixture();
  state.pane.agent.label = 'claude';
  state.raw =
    '✻ Thinking… (2s · esc to interrupt)\n────────────────\n❯\n────────────────\n[Opus 4.6] /fixture/project';
  assert.equal(runningScreen(state.raw, 'claude'), true);
  assert.equal(
    runningScreen(
      state.raw.replace('────────────────\n❯', 'An old answer\n────────────────\n❯'),
      'claude',
    ),
    false,
  );
  assert.equal((await service.run({ ...body('claude'), currentTurn: true })).interrupted, true);
  assert.equal(
    (await service.run({ ...body('claude-again'), currentTurn: true })).interrupted,
    false,
  );
  assert.deepEqual(state.calls, ['p']);
});
test('a stop queued behind another native operation never interrupts a later turn', async () => {
  const { state, service, body } = fixture();
  let release, entered;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    waiting = new Promise((resolve) => {
      entered = resolve;
    });
  service.operate = async (_id, work) => {
    entered();
    await gate;
    return work();
  };
  const pending = service.run({ ...body('queued-stop'), currentTurn: true });
  await waiting;
  state.turnId = 'later-turn';
  release();
  assert.deepEqual(await pending, { ok: true, interrupted: false, reason: 'turn-changed' });
  assert.deepEqual(state.calls, []);
});
test('the composer HTTP route ignores a stale cached turn and shares Esc deduplication with the menu', async () => {
  const { state, service, target, body } = fixture(),
    Conversation = require('../lib/conversation-state');
  const handlers = new Map();
  const request = {
    paneId: 'p',
    sessionId: 'session',
    binding: Conversation.binding(state.pane),
    turnId: 'old-ui-turn',
    requestId: 'composer',
  };
  require('../lib/http/routes/messages').register(
    { post: (path, handler) => handlers.set(path, handler), add() {}, get() {} },
    {
      Conversation,
      readJson: async () => request,
      exactPane: async () => state.pane,
      sessionInterrupt: service,
      herdr: { dashboard: async () => ({ runtimeId: state.runtimeId }) },
      json: (_res, _status, value) => value,
    },
  );
  const result = await handlers.get('/api/messages/interrupt')({}, {});
  assert.equal(result.interrupted, true);
  assert.equal((await service.run({ ...body('menu'), currentTurn: true })).interrupted, false);
  assert.deepEqual(state.calls, ['p']);
  assert.equal(target.sessionId, request.sessionId);
});
