'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { create } = require('../public/chat/agent-settings');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function setup() {
  const pane = {
    paneId: 'p',
    terminalId: 't',
    runtimeId: 'process',
    agent: { session: { value: 's' } },
  };
  const state = {
    config: { rootDirectory: '/one' },
    herdrRuntimeId: 'runtime',
    chatPaneId: 'p',
    chatAgents: [pane],
  };
  const settings = { p: { model: 'model', effort: 'low', editable: true } },
    calls = [],
    pending = [],
    errors = [];
  const service = create({
    state,
    els: {},
    UI: { providerId: () => 'codex' },
    settingsStore: settings,
    identity: () => 'p:t:s',
    paneOf: () => pane,
    remember: () => {},
    onApplied: () => {},
    reportError: (error) => errors.push(error),
    request: async (path, options) => {
      if (!options)
        return {
          models: [
            { id: 'model', efforts: ['low', 'medium', 'high', 'ultra'].map((id) => ({ id })) },
          ],
        };
      const gate = deferred();
      calls.push(JSON.parse(options.body));
      pending.push(gate);
      return gate.promise;
    },
  });
  return { state, pane, settings, calls, pending, errors, service };
}
test('local settings update immediately; in-flight writes coalesce into the latest choice', async () => {
  const f = setup(),
    first = f.service.applyAgentSettings({ effort: 'medium' });
  await new Promise(setImmediate);
  const second = f.service.applyAgentSettings({ effort: 'high' }),
    third = f.service.applyAgentSettings({ effort: 'ultra' });
  assert.equal(f.settings.p.effort, 'low');
  assert.equal(f.settings.p.requested.effort, 'ultra');
  assert.equal(f.settings.p.saving, true);
  assert.equal(f.calls.length, 1);
  f.pending[0].resolve({ settings: { model: 'model', effort: 'medium', editable: true } });
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].effort, 'ultra');
  f.pending[1].resolve({ settings: { model: 'model', effort: 'ultra', editable: true } });
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(f.settings.p.effort, 'ultra');
  assert.equal(f.settings.p.saving, false);
});
test('a root or process change discards queued settings and late acknowledgements', async () => {
  for (const change of [
    (f) => (f.state.config.rootDirectory = '/two'),
    (f) => (f.pane.runtimeId = 'replacement'),
  ]) {
    const f = setup(),
      first = f.service.applyAgentSettings({ effort: 'medium' });
    await new Promise(setImmediate);
    void f.service.applyAgentSettings({ effort: 'high' });
    change(f);
    f.pending[0].resolve({ settings: { effort: 'medium' } });
    await first;
    assert.equal(f.calls.length, 1);
    assert.equal(f.settings.p, undefined);
  }
});
test('a lost response does not replay a settings mutation or apply later choices', async () => {
  const f = setup(),
    first = f.service.applyAgentSettings({ effort: 'medium' });
  await new Promise(setImmediate);
  void f.service.applyAgentSettings({ effort: 'ultra' });
  f.pending[0].reject(new Error('Lost response'));
  assert.equal(await first, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.settings.p.uncertain, true);
  assert.equal(f.settings.p.saving, false);
});
