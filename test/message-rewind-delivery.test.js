'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const sourceRoot = path.resolve(__dirname, '..');
const candidate = (relative) => require(path.join(sourceRoot, relative));
const { MessageQueue, apiError } = candidate('lib/message-queue.js');
const { createHttp } = candidate('lib/http/index.js');
const Conversation = require(path.join(sourceRoot, 'lib/conversation-state'));
const { ConversationStore } = require(path.join(sourceRoot, 'lib/conversation-store'));
const { RewindInteraction } = require('../lib/rewind-interaction');
const pane = () => ({
  paneId: 'p',
  terminalId: 'terminal',
  runtimeId: '123:456',
  agent: {
    label: 'codex',
    name: 'codex',
    status: 'idle',
    session: { kind: 'uuid', value: 'session' },
  },
});
const normal = (id = 'normal') => ({ id, paneId: 'p', sessionId: 'session', text: 'normal text' });
const edited = (id = 'edited') => ({
  ...normal(id),
  text: 'edited text',
  rewind: { preparationId: 'prepared' },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-rewind-delivery-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'queue.json');
}

// Compile the real candidate server factory in isolation; starting the full
// server would use application configuration and sockets outside this fixture.
function serverQueue({
  file,
  exactPane = async () => pane(),
  controller,
  sendPaneMessage,
  generations = new Map(),
  operations = new ConversationStore(),
} = {}) {
  const context = { messageFile: file };
  const rewind = controller || {
    running: new Map(),
    ensureAvailable: async () => {},
    restore: () => {},
  };
  const code = fs.readFileSync(path.join(sourceRoot, 'server.js'), 'utf8');
  const begin = code.indexOf('function getMessageQueue() {');
  const end = code.indexOf('\n// Herdr and archive changes', begin);
  assert(begin >= 0 && end > begin);
  const sandbox = {
    MessageQueue,
    Conversation,
    apiError,
    rewindGenerations: generations,
    messageRewind: rewind,
    nativeOperations: operations,
    currentRoot: () => context,
    exactPane,
    herdr: { socketPath: '/isolated/unused.sock' },
    broadcastHerdrChanged() {},
    claudeControl: { busy: new Set() },
    codexSettings: { busy: new Set() },
    guardNativeInput: (value) => rewind.ensureAvailable(value),
    prepareNativeComposer: async () => false,
    agentQuestions: { ensureMain: async () => {} },
    codexSide: { assertMain: async () => {} },
    paneTranscriptFile: () => '/isolated/fixture.jsonl',
    readTranscript: async () => ({
      messages: [],
      archive: { ids: new Set(), activeIds: new Set() },
    }),
    sendPaneMessage: sendPaneMessage || (async () => ({})),
  };
  vm.runInNewContext(
    `${code.slice(begin, end)}\nglobalThis.queueFactory = getMessageQueue;`,
    sandbox,
    { filename: 'isolated-candidate-getMessageQueue.js' },
  );
  return { queue: sandbox.queueFactory(), context, generations, operations, rewind };
}

test('ordinary submission captures its server generation before deferred native target lookup', async () => {
  const lookup = deferred(),
    entered = deferred(),
    generations = new Map();
  let reads = 0,
    writes = 0;
  const { queue } = serverQueue({
    generations,
    exactPane: async () => {
      reads++;
      if (reads === 1) {
        entered.resolve();
        return lookup.promise;
      }
      return pane();
    },
    sendPaneMessage: async () => {
      writes++;
      return {};
    },
  });
  const pending = queue.submitNative(normal());
  await entered.promise;
  generations.set('p', 1); // A completed, separately serialized rewind.
  lookup.resolve(pane());
  const result = await pending;
  assert.equal(writes, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'REWIND_HISTORY_CHANGED');
  assert.equal(result.deliveryUncertain, false);
});

test('ordinary native submission waiting on the shared pane lock cannot cross a rewind generation', async () => {
  const gate = deferred(),
    entered = deferred(),
    generations = new Map(),
    operations = new ConversationStore();
  let writes = 0;
  const holding = operations.operate('p', async () => {
    entered.resolve();
    await gate.promise;
    generations.set('p', 1);
  });
  await entered.promise;
  const { queue } = serverQueue({
    generations,
    operations,
    sendPaneMessage: async () => {
      writes++;
      return {};
    },
  });
  const pending = queue.submitNative(normal());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  gate.resolve();
  await holding;
  const result = await pending;
  assert.equal(writes, 0);
  assert.equal(result.error.code, 'REWIND_HISTORY_CHANGED');
  assert.equal(result.deliveryUncertain, false);
});

test('a failed lock-time native identity read reports no native input was attempted', async () => {
  let reads = 0,
    writes = 0;
  const { queue } = serverQueue({
    exactPane: async () => {
      if (++reads > 1)
        throw Object.assign(new Error('native endpoint offline'), { code: 'SERVER_NOT_RUNNING' });
      return pane();
    },
    sendPaneMessage: async () => {
      writes++;
      return {};
    },
  });
  const result = await queue.submitNative(normal());
  assert.equal(writes, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.deliveryUncertain, false);
});

test('legacy queue drain captures its generation before lookup and does not reactivate an obsolete delivery', async () => {
  const lookup = deferred(),
    entered = deferred(),
    generations = new Map();
  let reads = 0,
    writes = 0;
  const { queue } = serverQueue({
    generations,
    exactPane: async () => {
      if (++reads === 2) {
        entered.resolve();
        return lookup.promise;
      }
      return pane();
    },
    sendPaneMessage: async () => {
      writes++;
      return {};
    },
  });
  await queue.enqueue(normal('legacy'));
  const draining = queue.drainPane('p');
  await entered.promise;
  generations.set('p', 1);
  lookup.resolve(pane());
  await draining;
  const result = queue.list('p').find((item) => item.id === 'legacy');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'REWIND_HISTORY_CHANGED');
  assert.equal(result.deliveryUncertain, false);
  assert.equal(result.retryable, false);
  assert.equal(writes, 0);
  await queue.enqueue({ ...normal('legacy'), retry: true });
  await queue.drainPane('p');
  assert.equal(writes, 0);
  assert.equal(queue.list('p')[0].status, 'failed');
});

test('rewind intent belongs to the durable request and conflicts with ordinary or different-target retry', async () => {
  let writes = 0;
  const queue = new MessageQueue({
    getNativePane: async () => pane(),
    sendNative: async () => {
      writes++;
      return {};
    },
  });
  const result = await queue.submitNative(edited());
  assert.equal(result.status, 'dispatched');
  assert.equal(result.nativeUserMessageId, null);
  assert.equal(result.deliveryUncertain, false);
  assert(result.transportAcceptedAt != null);
  for (const change of [
    { rewind: undefined },
    { rewind: { preparationId: 'other' } },
    { text: 'different' },
  ]) {
    await assert.rejects(queue.submitNative({ ...edited(), ...change }), {
      code: 'MESSAGE_ID_CONFLICT',
      deliveryUncertain: false,
      retryable: false,
    });
  }
  const ordinary = new MessageQueue({
    getNativePane: async () => pane(),
    sendNative: async () => ({}),
  });
  await ordinary.submitNative(normal('same-id'));
  await assert.rejects(ordinary.submitNative(edited('same-id')), {
    code: 'MESSAGE_ID_CONFLICT',
    deliveryUncertain: false,
  });
  assert.equal(writes, 1);
});

test('validation, missing identity and offline enqueue failures explicitly retain no-write facts', async () => {
  let writes = 0,
    lookups = 0;
  const queue = new MessageQueue({
    getNativePane: async () => {
      lookups++;
      return pane();
    },
    sendNative: async () => {
      writes++;
      return {};
    },
  });
  for (const body of [
    null,
    { ...normal(), text: '' },
    { ...edited(), rewind: 'bad' },
    { ...edited(), rewind: {} },
    { ...edited(), rewind: { preparationId: 'x', extra: true } },
  ]) {
    await assert.rejects(queue.submitNative(body), { deliveryUncertain: false, retryable: false });
  }
  assert.equal(lookups, 0);
  await assert.rejects(queue.submitNative({ ...normal(), binding: 'stale-binding' }), {
    code: 'SESSION_CHANGED',
    deliveryUncertain: false,
    retryable: false,
  });
  const offline = new MessageQueue({
    getNativePane: async () => {
      throw new Error('offline');
    },
    sendNative: () => {
      writes++;
    },
  });
  await assert.rejects(offline.submitNative(normal()), {
    deliveryUncertain: false,
    retryable: false,
  });
  assert.equal(writes, 0);
});

test('rewind stages are durable before native work, and offline restart never replays an unfinished request', async (t) => {
  const file = temporary(t);
  let writes = 0;
  const queue = new MessageQueue({
    file,
    getNativePane: async () => pane(),
    sendNative: async (item, progress) => {
      progress({
        rewindProgress: { phase: 'revert_pending', revertAttempted: true, sendAttempted: false },
      });
      assert.equal(
        JSON.parse(fs.readFileSync(file)).items[0].rewindProgress.phase,
        'revert_pending',
      );
      writes++;
      progress({
        rewindProgress: {
          phase: 'reverted',
          reverted: true,
          revertAttempted: true,
          sendAttempted: false,
        },
      });
      throw Object.assign(new Error('reverted but not sent'), {
        deliveryUncertain: false,
        retryable: false,
      });
    },
  });
  const result = await queue.submitNative(edited());
  assert.equal(result.status, 'failed');
  assert.equal(result.deliveryUncertain, false);
  assert.equal(result.retryable, false);
  const restarted = new MessageQueue({
    file,
    getNativePane: () => assert.fail('offline receipt read must not inspect native'),
    sendNative: () => assert.fail('durable request must not replay'),
  });
  const recovered = await restarted.submitNative({ ...edited(), retry: true });
  assert.equal(recovered.rewindProgress.phase, 'reverted');
  assert.equal(recovered.deliveryUncertain, false);
  assert.equal(writes, 1);
});

test('a durable submitted rewind receipt restores accepted delivery without a native item ID or connection', async (t) => {
  const file = temporary(t);
  // Simulate process exit between the controller durable submitted checkpoint
  // and MessageQueue's final dispatched write.
  for (const progress of [
    { phase: 'submitted', sendAccepted: true },
    { phase: 'failed', sendAccepted: true },
  ]) {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        items: [
          {
            ...edited(),
            agent: 'codex',
            agentName: 'codex',
            runtimeId: '123:456',
            terminalId: 'terminal',
            nativeDelivery: true,
            status: 'sending',
            sendingAt: 100,
            updatedAt: 100,
            deliveryUncertain: true,
            retryable: false,
            rewindProgress: { ...progress, reverted: true, sendAttempted: true, receipt: {} },
          },
        ],
      }),
    );
    const queue = new MessageQueue({
      file,
      getNativePane: () => assert.fail('accepted receipt is readable offline'),
      sendNative: () => assert.fail('accepted receipt must not replay'),
    });
    const result = await queue.submitNative({ ...edited(), retry: true });
    assert.equal(result.status, 'dispatched');
    assert.equal(result.deliveryUncertain, false);
    assert.equal(result.retryable, false);
    assert(result.transportAcceptedAt != null);
    assert.equal(result.nativeUserMessageId ?? null, null);
  }
});

test('server factory restores pending barriers before a new ordinary send; disconnect retains them', async (t) => {
  const file = temporary(t),
    current = pane();
  let reads = 0,
    writes = 0,
    offline = true;
  const item = {
    ...edited('old-edit'),
    agent: 'codex',
    agentName: 'codex',
    runtimeId: current.runtimeId,
    terminalId: current.terminalId,
    nativeDelivery: true,
    status: 'failed',
    deliveryUncertain: false,
    retryable: false,
    rewindProgress: {
      phase: 'draft_ready',
      reverted: true,
      sendAttempted: false,
      context: {
        identity: {
          paneId: current.paneId,
          processRuntimeId: current.runtimeId,
          terminalId: current.terminalId,
          sessionId: current.agent.session.value,
          provider: 'codex',
          herdrRuntimeId: 'herdr',
        },
        target: {},
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: [item] }));
  let nativeView = { mode: 'main', input: 'restored native draft' };
  const controller = new RewindInteraction({
    native: {
      read: async () => {
        reads++;
        if (offline) throw new Error('observer offline');
        return nativeView;
      },
      close: async () => {},
    },
  });
  const { queue } = serverQueue({
    file,
    controller,
    sendPaneMessage: async () => {
      writes++;
      return {};
    },
  });
  assert(controller.busy.has('p'));
  const disconnected = await queue.submitNative(normal('offline-blocked'));
  assert.equal(disconnected.deliveryUncertain, false);
  assert.equal(writes, 0);
  assert(controller.barriers.has('p'));
  offline = false;
  const occupied = await queue.submitNative(normal('draft-blocked'));
  assert.equal(occupied.error.code, 'REWIND_RECOVERY_REQUIRED');
  assert.equal(writes, 0);
  assert(controller.barriers.has('p'));
  nativeView = { mode: 'main', input: '' };
  const allowed = await queue.submitNative(normal('empty-allowed'));
  assert.equal(allowed.status, 'dispatched', JSON.stringify(allowed));
  assert.equal(writes, 1);
  assert.equal(controller.barriers.has('p'), false);
  assert(reads >= 3);
});

test('HTTP error output forwards explicit booleans, including false, without inventing uncertainty', () => {
  const { sendError } = createHttp({ tokens: [], maxBodyBytes: 1000 });
  for (const flags of [
    { deliveryUncertain: false, retryable: false },
    { deliveryUncertain: true, retryable: false },
    { deliveryUncertain: false, retryable: true },
    {},
    { deliveryUncertain: 'false', retryable: 0 },
  ]) {
    let body, status;
    sendError(
      {
        writeHead: (value) => {
          status = value;
        },
        end: (value) => {
          body = JSON.parse(value.toString());
        },
      },
      Object.assign(new Error('isolated error'), { status: 409, code: 'TEST', ...flags }),
    );
    assert.equal(status, 409);
    for (const key of ['deliveryUncertain', 'retryable']) {
      if (typeof flags[key] === 'boolean') assert.equal(body[key], flags[key]);
      else assert.equal(Object.hasOwn(body, key), false);
    }
  }
});

test('interrupt route uses the shared native lock and refuses a pending rewind before any input', async () => {
  const handlers = new Map(),
    operations = new ConversationStore(),
    current = pane();
  let entered = 0,
    writes = 0;
  const body = { paneId: current.paneId, binding: Conversation.binding(current), turnId: 'turn' };
  const sessionInterrupt = new (require('../lib/session-interrupt').SessionInterrupt)({
    herdr: {
      dashboard: async () => ({ runtimeId: 'runtime' }),
      readPane: async () =>
        '• Working (2s • esc to interrupt)\n\n› Ask Codex to do anything\n\n  gpt-6 high · /fixture/project · Ready · Context 1%',
    },
    exactPane: async () => current,
    readTurn: async () => 'turn',
    operate: (id, run) =>
      operations.operate(id, async () => {
        entered++;
        return run();
      }),
    beforeWrite: async () => {
      throw Object.assign(new Error('pending rewind'), {
        code: 'REWIND_RECOVERY_REQUIRED',
        deliveryUncertain: false,
      });
    },
    interrupt: async () => {
      writes++;
    },
  });
  candidate('lib/http/routes/messages.js').register(
    {
      post: (route, handler) => handlers.set(route, handler),
      add() {},
      get() {},
    },
    {
      Conversation,
      apiError,
      readJson: async () => body,
      exactPane: async () => current,
      sessionInterrupt,
      herdr: { dashboard: async () => ({ runtimeId: 'runtime' }) },
      currentRoot: () => ({
        conversations: { operate: () => assert.fail('per-root lock must not be used') },
      }),
      operateNative: (id, run) =>
        operations.operate(id, async () => {
          entered++;
          return run();
        }),
      claudeControl: { busy: new Set() },
      codexSettings: { busy: new Set() },
      guardNativeInput: async () => {
        throw Object.assign(new Error('pending rewind'), {
          code: 'REWIND_RECOVERY_REQUIRED',
          deliveryUncertain: false,
        });
      },
      codexSide: { assertMain: () => assert.fail('rewind barrier must run before side control') },
      readPaneLines: async () => [],
      interruptPane: async () => {
        writes++;
      },
    },
  );
  await assert.rejects(handlers.get('/api/messages/interrupt')({}, {}), {
    code: 'REWIND_RECOVERY_REQUIRED',
    deliveryUncertain: false,
  });
  assert.equal(entered, 1);
  assert.equal(writes, 0);
});
