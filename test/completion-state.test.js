'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const UI = require('../public/ui-model');
const pane = (status, extra = {}) => ({
  paneId: 'p',
  terminalId: 'terminal',
  lastMessageAt: 100,
  agent: { label: 'codex', name: 'agent', session: { value: 'conversation' }, status, ...extra },
});

test('未知、缺失和未支持的 Agent 状态不猜空闲或 Shell，断线保留独立语义', () => {
  for (const status of ['unknown', '', 'network error', 'running', 'completed']) {
    const p = pane(status, { message: 'waiting for input network completed' });
    assert.equal(UI.statusKind(p), 'unknown');
    assert.equal(UI.activityKind(p, false), 'offline');
  }
  const gemini = pane('working', { label: 'gemini' });
  assert.equal(UI.providerId(gemini), 'gemini');
  assert.equal(UI.statusKind(gemini), 'working');
  assert.equal(UI.statusKind({ title: 'codex settings', agent: null }), 'shell');
});

test('原生完成序号无需前端看到 working，消息时间变化不制造完成', () => {
  const tracker = UI.createCompletionTracker(),
    seen = {};
  for (const status of ['idle', 'done']) {
    const restored = pane(status, { completionSeq: null, stateChangeSeq: 10 });
    tracker.observe([restored]);
    assert.equal(tracker.unread(restored, seen), false);
  }
  const completed = pane('idle', { completionSeq: 12, stateChangeSeq: 12 });
  tracker.observe([completed]);
  assert.equal(tracker.unread(completed, seen), true);
  seen[tracker.key(completed)] = Date.now();
  assert.equal(tracker.unread({ ...completed, lastMessageAt: 200 }, seen), false);
  const next = pane('idle', { completionSeq: 15, stateChangeSeq: 15 });
  assert.equal(tracker.unread(next, seen), true);
  assert.equal(
    tracker.unread(pane('idle', { completionSeq: 12, stateChangeSeq: 15 }), seen),
    false,
  );
});

test('旧版只将实际观察到的工作结束记为完成，初始 done 和恢复 idle 不算', () => {
  const tracker = UI.createCompletionTracker(),
    seen = {};
  tracker.observe([pane('done')]);
  assert.equal(tracker.unread(pane('done'), seen), false);
  tracker.observe([pane('working')]);
  tracker.observe([pane('unknown')]);
  tracker.observe([pane('idle')]);
  assert.equal(tracker.unread(pane('idle'), seen), true);
  const key = tracker.key(pane('idle'));
  seen[key] = 1;
  tracker.observe([pane('idle')]);
  assert.equal(tracker.key(pane('idle')), key);
  tracker.observe([pane('working')]);
  tracker.observe([pane('idle')]);
  assert.equal(tracker.unread(pane('idle'), seen), true);
  tracker.observe([]);
  tracker.observe([pane('idle')]);
  assert.equal(tracker.unread(pane('idle'), seen), false);
});

test('设备已读独立，终端或原生会话替换后不共用完成记录', () => {
  const tracker = UI.createCompletionTracker();
  const completed = pane('idle', { completionSeq: 9, stateChangeSeq: 9 });
  const seen = { [tracker.key(completed)]: 1 };
  assert.equal(tracker.unread(completed, seen), false);
  assert.equal(tracker.unread(completed, {}), true);
  assert.equal(tracker.unread({ ...completed, terminalId: 'replacement' }, seen), true);
  assert.equal(
    tracker.unread(
      { ...completed, agent: { ...completed.agent, completionScope: 'restarted' } },
      seen,
    ),
    true,
  );
  assert.equal(
    tracker.unread(
      { ...completed, agent: { ...completed.agent, session: { value: 'other' } } },
      seen,
    ),
    true,
  );
});

test('同一个 Tab 的两个 Pane 保留各自会话标题与定位信息', () => {
  for (const id of ['a', 'b']) {
    const p = {
      ...pane('idle'),
      paneId: id,
      tabTitle: '123',
      workspace: 'group',
      sessionTitle: `conversation ${id}`,
    };
    assert.equal(UI.sessionLabel(p), `conversation ${id}`);
    assert.match(UI.sessionTooltip(p), new RegExp(`123 · ${id}$`));
  }
});
