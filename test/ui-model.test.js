'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const UI = require('../public/ui-model');

test('providerId detects Codex and Claude without relying on title alone', () => {
  assert.equal(UI.providerId({ agent: { label: 'codex' } }), 'codex');
  assert.equal(UI.providerId({ agent: { name: 'Claude Code' } }), 'claude');
  assert.equal(UI.providerId({ title: 'bash' }), 'shell');
});

test('statusKind recognizes provider and terminal states', () => {
  const panes = [
    { title: 'shell' },
    { title: 'idle', agent: { label: 'codex', status: 'idle' } },
    { title: 'done', agent: { label: 'codex', status: 'completed' } },
    { title: 'working', agent: { label: 'claude', status: 'running' } },
    { title: 'blocked', agent: { label: 'codex', message: 'waiting for input' } },
  ];
  assert.deepEqual(panes.map(UI.statusKind), ['shell', 'idle', 'unknown', 'unknown', 'unknown']);
});

test('preferences retain supported values and drop obsolete or malformed settings', () => {
  assert.deepEqual(
    UI.sanitizePrefs({ haptics: false, keepAwake: true, quickReplies: [], commandExtras: {} }),
    { version: UI.STORAGE_VERSION, haptics: false, keepAwake: true },
  );
  assert.deepEqual(UI.sanitizePrefs({ haptics: 'false', keepAwake: 1 }), UI.cloneDefaults());
  assert.deepEqual(UI.sanitizePrefs(null), UI.cloneDefaults());
});

test('归档先于队列确认时只显示一份消息，旧重复文本不能吞掉新消息', () => {
  const now = Date.now();
  const user = (id, text, ts = now) => ({
    id,
    ts: new Date(ts).toISOString(),
    role: 'user',
    blocks: [{ kind: 'text', text }],
  });
  const item = {
    id: 'pending',
    text: 'same',
    status: 'sending',
    createdAt: now,
    sendingAt: now,
    transportAcceptedAt: now,
    baseline: { lastMessageId: 'old' },
    archiveBaselineIds: ['old'],
  };
  assert.deepEqual(UI.visibleOutbox([item], [user('old', 'same')]), [item]);
  assert.deepEqual(UI.visibleOutbox([item], [user('old', 'same'), user('new', 'same')]), []);
  const second = { ...item, id: 'second' };
  assert.deepEqual(UI.visibleOutbox([item, second], [user('old', 'same'), user('new', 'same')]), [
    second,
  ]);
  assert.deepEqual(
    UI.visibleOutbox([{ ...second, status: 'queued' }], [user('new', 'same')]).length,
    1,
  );
});

test('一次原生归档可以接替整批已投递消息，但不能接替尚未投递的队列', () => {
  const now = Date.now();
  const items = ['a', 'b'].map((text) => ({
    id: text,
    text,
    status: 'sending',
    createdAt: now,
    transportAcceptedAt: now,
  }));
  const user = {
    id: 'combined',
    role: 'user',
    ts: new Date(now).toISOString(),
    blocks: [{ kind: 'text', text: 'a\n\nb' }],
  };
  assert.deepEqual(UI.visibleOutbox(items, [user]), []);
  assert.deepEqual(
    UI.visibleOutbox(
      items.map((i) => ({ ...i, batchId: 'batch', dispatchText: 'a\n\nb' })),
      [user],
    ),
    [],
  );
  const queued = { id: 'waiting', status: 'queued', text: 'b', createdAt: now };
  assert.deepEqual(UI.visibleOutbox([...items, queued], [user]), [queued]);
});

test('回滚记录及旧版弃用失败不显示，普通失败和新消息仍可见', () => {
  const discarded = [
    { id: 'new', status: 'discarded' },
    { id: 'legacy', status: 'failed', retryable: true, error: { code: 'HISTORY_DISCARDED' } },
    { id: 'legacy-answered', status: 'consumed', historyDiscardedAt: 0 },
  ];
  const visible = [
    { id: 'failed', status: 'failed', error: { code: 'SEND_FAILED' } },
    { id: 'waiting', status: 'queued', text: 'new' },
  ];
  assert.deepEqual(UI.visibleOutbox([...discarded, ...visible], []), visible);
  assert.deepEqual(
    UI.visibleOutbox(discarded, [
      { id: 'old', role: 'user', blocks: [{ kind: 'text', text: 'old' }] },
    ]),
    [],
  );
});

test('弃用消息不再影响最近会话排序', () => {
  const panes = [
    { paneId: 'first', lastMessageAt: 10, agent: { session: { value: 's1' } } },
    { paneId: 'second', lastMessageAt: 20, agent: { session: { value: 's2' } } },
  ];
  for (const item of [{ status: 'discarded' }, { status: 'consumed', historyDiscardedAt: 0 }]) {
    assert.deepEqual(
      UI.recentPanes(panes, { first: [{ ...item, sessionId: 's1', createdAt: 30 }] }).map(
        (pane) => pane.paneId,
      ),
      ['second', 'first'],
    );
  }
});

test('带附件的消息按原文确认：附件行已被拆成图片块也能对上', () => {
  const now = Date.now();
  const text = '看看这张图\n\n附件：a.png\n文件路径："/tmp/a.png"';
  const item = {
    id: 'pending',
    text,
    status: 'sending',
    createdAt: now,
    sendingAt: now,
    transportAcceptedAt: now,
    archiveBaselineIds: [],
  };
  const archived = {
    id: 'u1',
    ts: new Date(now).toISOString(),
    role: 'user',
    sourceText: text,
    blocks: [
      { kind: 'text', text: '看看这张图\n\n' },
      { kind: 'image', id: 'x', alt: 'a.png' },
    ],
  };
  assert.deepEqual(UI.visibleOutbox([item], [archived]), []);
});
