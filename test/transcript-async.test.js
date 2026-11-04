'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const Conversation = require('../lib/conversation-state');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function setup() {
  const gate = deferred(),
    routes = new Map(),
    calls = [];
  const pane = {
    paneId: 'p',
    terminalId: 't',
    runtimeId: 'process',
    agent: { label: 'codex', session: { value: 's' } },
  };
  require('../lib/http/routes/transcript').register(
    { get: (path, handler) => routes.set(path, handler) },
    {
      Conversation,
      exactPane: async () => structuredClone(pane),
      json: (_res, _code, value) => value,
      clampInt: (value, min, max, fallback) => Number(value) || fallback,
      locatePaneTranscript: async () => '/isolated/transcript',
      readCodexGoal: () => null,
      transcriptWatcher: { watch() {} },
      readConversationPage: async () => ({
        messages: [
          { id: 'native', role: 'user', blocks: [{ kind: 'text', text: 'Archive is ready' }] },
        ],
        status: {},
      }),
      readPaneStatus: async () => {
        calls.push('terminal');
        return gate.promise;
      },
      getAgentSettings: async () => {
        calls.push('settings');
        return gate.promise;
      },
      agentQuestions: {
        read: async () => {
          calls.push('questions');
          return gate.promise;
        },
      },
      getMessageQueue: () => ({ items: [], list: () => [], recheckConsumed: async () => {} }),
      readStartup: async () => null,
      chatStatus: (terminal) => terminal,
    },
  );
  const read = (query) =>
    routes.get('/api/transcript')(
      {},
      {},
      new URL('http://fixture/api/transcript?pane=p&sessionId=s&' + query),
    );
  return { pane, gate, calls, read };
}
test('history rendering does not wait for settings, questions, or the terminal observer', async () => {
  const f = setup(),
    control = f.read('state=1&window=0');
  let complete = false;
  void control.then(() => (complete = true));
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ['terminal']);
  assert.equal(complete, false);
  const history = await f.read('state=0&terminal=0');
  assert.equal(history.messages[0].id, 'native');
  assert.equal(history.deferredState, true);
  assert.equal(complete, false);
  f.gate.resolve({});
  await control;
  assert(f.calls.includes('questions') && f.calls.includes('settings'));
});
test('late control state is rejected if the native process changes', async () => {
  const f = setup(),
    control = f.read('state=1&window=0');
  await new Promise(setImmediate);
  f.pane.runtimeId = 'replacement';
  f.gate.resolve({});
  await assert.rejects(control, { code: 'SESSION_CHANGED' });
});
