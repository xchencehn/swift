'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { NativeDraft } = require('../lib/native-draft');
const pane = {
  paneId: 'draft',
  terminalId: 't',
  runtimeId: 'r',
  agent: { name: 'codex', label: 'codex', session: { value: 's' } },
};
function fixture() {
  let text = '中文草稿',
    current = pane;
  const keys = [];
  const manager = new NativeDraft({
    herdr: { readPane: async () => `› ${text}\n\nGPT-6.1-Sol high · /fixture` },
    exactPane: async () => current,
    operate: (_id, run) => run(),
    press: async (value) => {
      keys.push(value);
      text = '';
    },
  });
  return {
    manager,
    keys,
    set text(value) {
      text = value;
    },
    set pane(value) {
      current = value;
    },
    prepare: () =>
      manager.handle({
        action: 'prepare',
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        runtimeId: pane.runtimeId,
        sessionId: 's',
      }),
  };
}
test('prepare is read only and a matching clear never submits', async () => {
  const f = fixture(),
    prepared = await f.prepare();
  assert.equal(prepared.text, '中文草稿');
  assert.deepEqual(f.keys, []);
  await f.manager.handle({ ...prepared, action: 'clear' });
  assert.deepEqual(f.keys, [['ctrl+e', 'ctrl+u', 'ctrl+k']]);
  await f.manager.handle({ ...prepared, action: 'clear' });
  assert.equal(f.keys.length, 1);
});
test('changed draft, changed process and edits during write preflight never erase content', async () => {
  for (const change of ['draft', 'process', 'preflight']) {
    const f = fixture(),
      prepared = await f.prepare();
    if (change === 'draft') f.text = '用户新输入';
    if (change === 'process') f.pane = { ...pane, runtimeId: 'other' };
    if (change === 'preflight')
      f.manager.beforeWrite = async () => {
        f.text = '检查时编辑';
      };
    await assert.rejects(f.manager.handle({ ...prepared, action: 'clear' }));
    assert.deepEqual(f.keys, []);
  }
});
test('collapsed paste and images are retained when their full text cannot be read', async () => {
  for (const text of ['[Pasted Content 1234 chars]', '[Image #1]']) {
    const f = fixture();
    f.text = text;
    await assert.rejects(f.prepare(), { code: 'NATIVE_DRAFT_COLLAPSED' });
    assert.deepEqual(f.keys, []);
  }
});

test('exact observation binding prepares dashboard targets without a process field', async () => {
  const f = fixture();
  const binding = require('../lib/conversation-state').binding(pane);
  const request = { action: 'prepare', paneId: pane.paneId, binding };
  assert.equal((await f.manager.handle(request)).text, '中文草稿');
  f.pane = { ...pane, runtimeId: 'restarted' };
  await assert.rejects(f.manager.handle(request), { code: 'SESSION_CHANGED' });
  assert.deepEqual(f.keys, []);
});
