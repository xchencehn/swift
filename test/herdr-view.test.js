'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { viewPane, codexBrowsing } = require('../lib/herdr-view');
const expected = { runtimeId: 'r', terminalId: 'terminal', sessionId: 'session' };
const raw =
  '• Working (2s)\n\x1b[34m ↓ Back to bottom · esc \x1b[0m\n\n› Write a message\nGPT · Working · Context 23%';
function fixture(label = 'Codex') {
  const pane = {
      paneId: 'p',
      terminalId: 'terminal',
      agent: { label, session: { value: 'session' } },
    },
    calls = [];
  const herdr = {
    dashboard: async () => ({ runtimeId: 'r', panes: [pane] }),
    readPane: async () => raw,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'pane.send_keys') herdr.readPane = async () => '• Working (2s)\n› prompt';
      return {};
    },
  };
  return { pane, calls, herdr };
}
test('native browsing is recognized in the composer gap, not in quoted transcript text', () => {
  assert(codexBrowsing(raw));
  assert(codexBrowsing(raw.replace('› Write a message', '›')));
  assert(codexBrowsing(raw.replace('↓ Back', 'New activity · ↓ Back')));
  assert(!codexBrowsing('› quote\n↓ Back to bottom · esc'));
  assert(!codexBrowsing('↓ Back to bottom\nordinary transcript\n› prompt'));
  assert(!codexBrowsing('Working for 2s\n› prompt'));
});
test('viewing uses exact pane focus, Herdr scrollback and Codex latest navigation, never Escape or Enter', async () => {
  const { herdr, calls } = fixture();
  assert.equal((await viewPane(herdr, 'p', expected)).agentScrolled, true);
  assert.deepEqual(calls, [
    { method: 'pane.focus', params: { pane_id: 'p' } },
    { method: 'pane.scroll', params: { pane_id: 'p', offset_from_bottom: 0 } },
    { method: 'pane.send_keys', params: { pane_id: 'p', keys: ['alt+>'] } },
  ]);
});
test('latest Codex, other providers and shells receive no navigation keys', async () => {
  for (const label of ['Codex', 'Claude', '']) {
    const { herdr, calls } = fixture(label);
    herdr.readPane = async () => '• Working (2s)\n› prompt\nGPT · Working';
    await viewPane(herdr, 'p', expected);
    assert.equal(calls.length, 2);
  }
});
test('old runtime, replaced terminal and changed or missing agent identity are rejected before focus', async () => {
  for (const patch of [
    { runtimeId: 'old' },
    { terminalId: 'old' },
    { sessionId: 'old' },
    { sessionId: undefined },
  ]) {
    const { herdr, calls } = fixture();
    await assert.rejects(viewPane(herdr, 'p', { ...expected, ...patch }));
    assert.deepEqual(calls, []);
  }
});
test('identity is checked again immediately before native navigation', async () => {
  const { herdr, pane, calls } = fixture();
  herdr.readPane = async () => {
    pane.agent.session.value = 'new';
    return raw;
  };
  await assert.rejects(viewPane(herdr, 'p', expected), { code: 'TARGET_CHANGED' });
  assert.equal(calls.length, 2);
});
test('unsupported native scrolling fails explicitly without key fallback', async () => {
  const { herdr, calls } = fixture();
  herdr.request = async (method) => {
    calls.push(method);
    if (method === 'pane.scroll')
      throw Object.assign(new Error('unsupported'), { code: 'unknown_method' });
  };
  await assert.rejects(viewPane(herdr, 'p', expected));
  assert.deepEqual(calls, ['pane.focus', 'pane.scroll']);
});

test('an empty redraw is not confirmation and navigation is never repeated', async () => {
  const { herdr, calls } = fixture();
  const request = herdr.request;
  herdr.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'pane.send_keys') herdr.readPane = async () => '';
    return result;
  };
  await assert.rejects(viewPane(herdr, 'p', expected), { code: 'NATIVE_VIEW_PENDING' });
  assert.equal(calls.filter((c) => c.method === 'pane.send_keys').length, 1);
});
