'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { register } = require('../lib/http/routes/agents');
function fixture(apply = async (_pane, value) => value) {
  const routes = new Map(),
    state = { writes: 0 },
    pane = {
      paneId: 'pane',
      terminalId: 'term',
      agent: { label: 'codex', session: { value: 'session' } },
    };
  register(
    { get() {}, post: (path, handler) => routes.set(path, handler) },
    {
      exactPane: async () => pane,
      readJson: async (req) => req.body,
      json: (_res, _status, value) => value,
      herdr: { normalizeSnapshot: () => ({ runtimeId: 'runtime' }) },
      currentRoot: () => ({ data: { directory: '/fixture' } }),
      deviceId: () => 'fixture',
      getAgentSettings: async () => ({ editable: true, model: 'model' }),
      readAgentCatalog: async () => ({ models: [] }),
      validateSettings: (body) => ({ effort: body.effort }),
      codexSettings: {
        apply: async (...args) => {
          state.writes++;
          return apply(...args);
        },
      },
      broadcastHerdrChanged() {},
      apiError: require('../lib/message-queue').apiError,
    },
  );
  const body = {
    paneId: 'pane',
    terminalId: 'term',
    sessionId: 'session',
    threadId: 'session',
    runtimeId: 'runtime',
    requestId: 'settings-once',
    effort: 'low',
  };
  return { state, pane, body, call: (body) => routes.get('/api/agent-settings')({ body }, {}) };
}
test('concurrent copies of a settings request share one native application', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve)),
    f = fixture(async (_pane, value) => {
      await gate;
      return value;
    });
  const a = f.call(f.body),
    b = f.call({ ...f.body });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.writes, 1);
  release();
  assert.deepEqual(await a, await b);
  await assert.rejects(f.call({ ...f.body, effort: 'high' }), { code: 'REQUEST_CHANGED' });
  assert.equal(f.state.writes, 1);
});
test('uncertain settings failures are retained and never automatically replayed', async () => {
  const f = fixture(async () => {
    throw new Error('Native result uncertain');
  });
  await assert.rejects(f.call(f.body), /uncertain/);
  await assert.rejects(f.call(f.body), /uncertain/);
  assert.equal(f.state.writes, 1);
});
test('terminal, runtime and session mismatches reject settings before native input', async () => {
  for (const changes of [
    { terminalId: 'other' },
    { runtimeId: 'other' },
    { sessionId: 'other' },
    { threadId: 'other' },
  ]) {
    const f = fixture();
    await assert.rejects(f.call({ ...f.body, ...changes }), (error) =>
      ['SESSION_CHANGED', 'RUNTIME_CHANGED'].includes(error.code),
    );
    assert.equal(f.state.writes, 0);
  }
});
test('frontend shortcuts can change a fresh Codex terminal before its first session ID exists', async () => {
  const f = fixture();
  f.pane.agent.session = null;
  const errors = [],
    posted = [],
    state = { chatPaneId: 'pane', chatAgents: [f.pane], herdrRuntimeId: 'runtime' };
  const settings = require('../public/chat/agent-settings').create({
    state,
    settingsStore: {},
    UI: { providerId: () => 'codex' },
    identity: () => 'pane:term:',
    paneOf: () => f.pane,
    remember() {},
    onApplied() {},
    reportError: (error) => errors.push(error),
    request: async (url, options) => {
      if (url.startsWith('/api/agent-catalog'))
        return {
          models: [
            {
              id: 'model',
              efforts: [{ id: 'low' }, { id: 'medium', isDefault: true }, { id: 'high' }],
            },
          ],
        };
      if (!options) return { editable: true, model: 'model', effort: 'medium' };
      const body = JSON.parse(options.body);
      posted.push(body);
      return f.call(body);
    },
  });
  assert.equal(await settings.stepSetting('effort', 1), true);
  assert.equal(f.state.writes, 1);
  assert.equal(posted[0].sessionId, '');
  assert.equal(posted[0].terminalId, 'term');
  assert.equal(posted[0].effort, 'high');
  assert.deepEqual(errors, []);
});
