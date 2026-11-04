'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { create } = require('../scripts/testing/command-interaction-fixture');
function fixture() {
  const state = {
    runtimeId: 'runtime',
    sessions: {
      p: {
        settings: {},
        pane: {
          paneId: 'p',
          terminalId: 't',
          runtimeId: '1:2',
          agent: { label: 'codex', name: 'codex', session: { value: 's' } },
        },
      },
    },
  };
  const service = create(state),
    contexts = [];
  service.beforeWrite = async (_pane, context) => {
    contexts.push(context.continuingStatusView);
    if (state.nativeCommandPanes.p?.phase === 'warnings')
      assert.equal(context.continuingStatusView, 'warnings');
  };
  let serial = 0;
  const base = {
    paneId: 'p',
    terminalId: 't',
    runtimeId: 'runtime',
    sessionId: 's',
    clientId: 'client',
  };
  const call = (action, view, extra = {}) =>
    service.handle({
      ...base,
      requestId: `key-${++serial}`,
      action,
      leaseId: view.leaseId,
      revision: view.revision,
      ...extra,
    });
  return { state, service, contexts, base, call };
}
test('closing after navigating warnings preserves all visited warnings instead of sending Escape', async () => {
  const f = fixture();
  let view = await f.service.execute({ ...f.base, requestId: 'open-warnings', text: '/warnings' });
  assert.equal(view.surface, 'warnings');
  assert.equal(view.warningIndex, 1);
  view = await f.call('key', view, { key: 'right' });
  assert.equal(view.warningIndex, 2);
  for (let i = 0; view.mode === 'menu' && i < 8; i++) view = await f.call('close', view);
  assert(!view.pending && !['menu', 'query'].includes(view.mode));
  assert.deepEqual(f.state.nativeCommandPanes.p.warningKept.sort(), [0, 1]);
  assert.deepEqual(f.state.nativeCommandPanes.p.warningDismissed, []);
  assert(!f.state.nativeCommandPanes.p.writes.some((row) => row.keys?.includes('esc')));
  assert(f.contexts.includes('warnings'));
});
test('explicit warning dismissal remains separate and duplicate requests do not dismiss twice', async () => {
  const f = fixture();
  let view = await f.service.execute({ ...f.base, requestId: 'warnings', text: '/warnings' });
  const body = {
    ...f.base,
    requestId: 'dismiss-once',
    action: 'key',
    leaseId: view.leaseId,
    revision: view.revision,
    key: 'esc',
  };
  view = await f.service.handle(body);
  const count = f.state.nativeCommandPanes.p.writes.length;
  assert(!view.pending && !['menu', 'query'].includes(view.mode));
  assert.deepEqual(f.state.nativeCommandPanes.p.warningDismissed, [0]);
  await f.service.handle(body);
  assert.equal(f.state.nativeCommandPanes.p.writes.length, count);
});
test('a close awaiting native confirmation only reads and never repeats a keep key', async () => {
  const f = fixture();
  let view = await f.service.execute({ ...f.base, requestId: 'warnings', text: '/warnings' });
  const read = f.service.herdr.readPane;
  let frozen = await read('p');
  f.service.herdr.readPane = async (id) => frozen || read(id);
  view = await f.call('close', view);
  assert(view.pending);
  const count = f.state.nativeCommandPanes.p.writes.length;
  await assert.rejects(f.call('close', view), { code: 'COMMAND_ACTION_PENDING' });
  assert.equal(f.state.nativeCommandPanes.p.writes.length, count);
  frozen = '';
  view = await f.call('read', view);
  assert(!view.pending);
  assert.equal(view.warningIndex, 2);
  view = await f.call('close', view);
  assert(!['menu', 'query'].includes(view.mode));
  assert.deepEqual(f.state.nativeCommandPanes.p.warningKept.sort(), [0, 1]);
});
test('warning scope cannot be forged or used to send unrelated control input', async () => {
  const f = fixture();
  const seen = [];
  f.service.beforeWrite = async (_pane, context) => {
    seen.push(context.continuingStatusView);
  };
  let view = await f.service.execute({
    ...f.base,
    requestId: 'warnings',
    text: '/warnings',
    continuingStatusView: 'warnings',
  });
  assert.equal(seen[0], '');
  const count = f.state.nativeCommandPanes.p.writes.length;
  await assert.rejects(f.call('key', view, { key: 'ctrl+c' }), { code: 'INVALID_WARNING_ACTION' });
  await assert.rejects(f.call('key', view, { key: 'k', revision: 'old' }), {
    code: 'COMMAND_MENU_CHANGED',
  });
  assert.equal(f.state.nativeCommandPanes.p.writes.length, count);
  f.state.sessions.p.pane.runtimeId = '1:3';
  await assert.rejects(f.call('close', view), { code: 'SESSION_CHANGED' });
  assert.equal(f.state.nativeCommandPanes.p.writes.length, count);
});
