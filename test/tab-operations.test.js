'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { invoke } = require('../lib/herdr-ui');
function fixture() {
  const view = {
    runtimeId: 'runtime',
    workspaces: [{ workspaceId: 'w' }, { workspaceId: 'other' }],
    tabs: [
      { tab_id: 'before', workspace_id: 'w', label: 'before' },
      { tab_id: 't', workspace_id: 'w', label: 'original' },
      { tab_id: 'after', workspace_id: 'w', label: 'after' },
    ],
    panes: [1, 2, 3].map((n) => ({
      paneId: 'p' + n,
      terminalId: 'term' + n,
      tabId: 't',
      workspaceId: 'w',
      label: 'session' + n,
      agent: { session: { value: 's' + n } },
    })),
  };
  const calls = [],
    members = view.panes.map((p) => [p.paneId, p.terminalId, p.agent.session.value]);
  const herdr = {
    dashboard: async () => structuredClone(view),
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'pane.move') {
        const pane = view.panes.find((p) => p.paneId === params.pane_id);
        pane.paneId += '-moved';
        pane.tabId = 'tab-' + pane.terminalId;
        pane.workspaceId = params.destination.workspace_id;
        view.tabs.push({
          tab_id: pane.tabId,
          workspace_id: pane.workspaceId,
          label: params.destination.label,
        });
        return { move_result: { pane: { pane_id: pane.paneId, terminal_id: pane.terminalId } } };
      }
      if (method === 'tab.move') {
        const [tab] = view.tabs.splice(
          view.tabs.findIndex((t) => t.tab_id === params.tab_id),
          1,
        );
        view.tabs.splice(params.insert_index, 0, tab);
      }
      return {};
    },
  };
  return {
    view,
    calls,
    herdr,
    expected: { runtimeId: 'runtime', members, terminalId: 'term2', sessionId: 's2' },
  };
}
test('old splits become adjacent native Tabs without recreating terminals or sessions', async () => {
  const f = fixture(),
    before = f.view.panes.map((p) => [p.terminalId, p.agent.session.value]);
  const result = await invoke(f.herdr, 'tab.separate', { tab_id: 't' }, f.expected);
  assert.deepEqual(
    f.view.tabs.map((t) => t.tab_id),
    ['before', 't', 'tab-term2', 'tab-term3', 'after'],
  );
  assert.deepEqual(
    f.view.panes.map((p) => [p.terminalId, p.agent.session.value]),
    before,
  );
  assert.equal(new Set(f.view.panes.map((p) => p.tabId)).size, 3);
  assert.equal(result.selected_pane_id, 'p2-moved');
  assert(
    f.calls.every(
      (c) => c.method === 'tab.move' || (c.method === 'pane.move' && c.params.focus === false),
    ),
  );
});
test('conversion refuses stale topology and preserves an uncertain partial result without replay', async () => {
  const f = fixture();
  f.view.panes[1].agent.session.value = 'replacement';
  await assert.rejects(invoke(f.herdr, 'tab.separate', { tab_id: 't' }, f.expected), {
    code: 'TARGET_CHANGED',
  });
  assert.equal(f.calls.length, 0);
  const g = fixture(),
    request = g.herdr.request;
  g.herdr.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'pane.move') throw new Error('lost response');
    return result;
  };
  await assert.rejects(
    invoke(g.herdr, 'tab.separate', { tab_id: 't' }, g.expected),
    /lost response/,
  );
  await assert.rejects(invoke(g.herdr, 'tab.separate', { tab_id: 't' }, g.expected), {
    code: 'TARGET_CHANGED',
  });
  assert.equal(g.calls.length, 1);
  assert.equal(g.view.panes[1].terminalId, 'term2');
});
test('moving a Tab to another Space retains its label and rejects a replacement occupant', async () => {
  const f = fixture();
  f.view.panes.splice(1);
  const params = { tab_id: 't', workspace_id: 'other' },
    expected = { runtimeId: 'runtime', terminalId: 'term1', sessionId: 's1' };
  await assert.rejects(
    invoke(f.herdr, 'tab.move_to_workspace', params, { ...expected, terminalId: 'old' }),
    { code: 'TARGET_CHANGED' },
  );
  await invoke(f.herdr, 'tab.move_to_workspace', params, expected);
  assert.deepEqual(f.calls[0], {
    method: 'pane.move',
    params: {
      pane_id: 'p1',
      destination: { type: 'new_tab', workspace_id: 'other', label: 'original' },
      focus: false,
    },
  });
  assert.equal(f.view.panes[0].agent.session.value, 's1');
});
test('concurrent browser conversions cannot move the same native terminals twice', async () => {
  const f = fixture();
  let release;
  const request = f.herdr.request;
  f.herdr.request = async (...args) => {
    if (!release)
      await new Promise((resolve) => {
        release = resolve;
      });
    return request(...args);
  };
  const first = invoke(f.herdr, 'tab.separate', { tab_id: 't' }, f.expected);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(invoke(f.herdr, 'tab.separate', { tab_id: 't' }, f.expected), {
    code: 'TARGET_CHANGED',
  });
  release();
  await first;
  assert.equal(f.calls.filter((c) => c.method === 'pane.move').length, 2);
});
