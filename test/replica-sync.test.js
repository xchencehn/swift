'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Replica = require('../public/core/replica');
const Sync = require('../public/core/sync');

const msg = (id) => ({ id, blocks: [] });
const ids = (record) => record.messages.map((m) => m.id);

test('变化接在锚点之后；版本对不上或锚点不在本地就接不上', () => {
  const local = { revision: 'r1', messages: [msg('1'), msg('2'), msg('3')] };
  assert.deepEqual(
    Replica.applyDelta(local, { base: 'r1', after: '3', messages: [msg('4')] }).map((m) => m.id),
    ['1', '2', '3', '4'],
  );
  assert.deepEqual(
    Replica.applyDelta(local, { base: 'r1', after: '1', messages: [msg('2b')] }).map((m) => m.id),
    ['1', '2b'],
    '回滚后的新分支',
  );
  assert.equal(
    Replica.applyDelta(local, { base: 'r0', after: '3', messages: [msg('4')] }),
    null,
    '版本对不上',
  );
  assert.equal(
    Replica.applyDelta(local, { base: 'r1', after: 'x', messages: [] }),
    null,
    '锚点不在本地',
  );
  assert.equal(
    Replica.applyDelta(null, { base: 'r1', after: '3', messages: [] }),
    null,
    '本地没有这个会话',
  );
  assert.deepEqual(
    Replica.applyDelta(null, { replace: true, messages: [msg('9')] }).map((m) => m.id),
    ['9'],
  );
});

test('本地每个会话最多留 200 条，多出来的记为还有更早的', () => {
  const replica = Replica.create({ indexedDB: undefined });
  const many = Array.from({ length: 250 }, (_, i) => msg(`m${i}`));
  const record = replica.apply({
    key: 'codex:s',
    replace: true,
    revision: 'r',
    messages: many,
    hasMore: true,
  });
  assert.equal(record.messages.length, 200);
  assert.equal(record.messages[0].id, 'm50');
  assert.equal(record.hasMore, true);
});

test('快照按 pane 合并：变了的替换、消失的删掉、按服务端顺序排；全量时丢掉本地旧的', () => {
  const first = Replica.applySnapshot(null, {
    full: true,
    hash: 'h1',
    rootDirectory: '/r',
    focusedPaneId: 'a',
    workspaces: [{ workspaceId: 'w' }],
    panes: [
      { paneId: 'a', v: 1 },
      { paneId: 'b', v: 1 },
    ],
    removed: [],
    order: ['a', 'b'],
  });
  const second = Replica.applySnapshot(first, {
    hash: 'h2',
    panes: [
      { paneId: 'b', v: 2 },
      { paneId: 'c', v: 1 },
    ],
    removed: ['a'],
    order: ['c', 'b'],
    focusedPaneId: 'c',
  });
  assert.deepEqual(second.panes, [
    { paneId: 'c', v: 1 },
    { paneId: 'b', v: 2 },
  ]);
  assert.deepEqual(second.workspaces, [{ workspaceId: 'w' }], '工作区没变就沿用');
  assert.equal(second.focusedPaneId, 'c');
  const full = Replica.applySnapshot(second, {
    full: true,
    hash: 'h3',
    panes: [{ paneId: 'z' }],
    removed: [],
    order: ['z'],
  });
  assert.deepEqual(
    full.panes.map((p) => p.paneId),
    ['z'],
  );
});

test('hello 带本地版本；接不上的会话丢掉版本后重新 hello；ready 之后才算同步生效', async () => {
  const replica = Replica.create({ indexedDB: undefined });
  replica.put('codex:s', { revision: 'r1', messages: [msg('1')] });
  const sent = [],
    sessions = [];
  const sync = Sync.create({
    replica,
    decode: null,
    send: (m) => sent.push(m),
    onSession: (key, event, record) => sessions.push([key, ids(record)]),
  });
  sync.hello();
  assert.deepEqual(sent[0], {
    type: 'sync.hello',
    sessions: { 'codex:s': 'r1' },
    snapshot: '',
    files: {},
    history: '',
  });
  sync.handle({ type: 'sync.welcome' });
  assert.equal(sync.active(), false, '追平还没结束');
  sync.handle({
    type: 'sync.session',
    key: 'codex:s',
    base: 'r1',
    revision: 'r2',
    after: '1',
    messages: [msg('2')],
  });
  sync.handle({ type: 'sync.ready' });
  assert.equal(sync.active(), true);
  assert.deepEqual(sessions, [['codex:s', ['1', '2']]]);
  // 接不上：版本丢掉，稍后带着「没有这个会话」重新 hello。
  sync.handle({
    type: 'sync.session',
    key: 'codex:s',
    base: 'r9',
    revision: 'r10',
    after: '2',
    messages: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(sent.at(-1).sessions, {});
  sync.reset();
  assert.equal(sync.active(), false);
});

test('gzip 同步跨原生网关保持内容与顺序，ready 等待解压完成', async () => {
  const replica = Replica.create({ indexedDB: undefined }),
    sent = [],
    observed = [];
  let ready;
  const completed = new Promise((resolve) => {
    ready = resolve;
  });
  const sync = Sync.create({
    replica,
    send: (message) => sent.push(message),
    onSession: (_key, _event, record) => observed.push(record),
    onReady: ready,
  });
  sync.hello();
  assert.equal(sent[0].compression, 'gzip');
  const message = {
    type: 'sync.session',
    key: 'codex:s',
    revision: 'r1',
    replace: true,
    messages: [
      { id: 'm', blocks: [{ kind: 'text', text: '长消息包含中文与代码。\n'.repeat(2000) }] },
    ],
  };
  const raw = Buffer.from(JSON.stringify(message)),
    compressed = require('node:zlib').gzipSync(raw);
  sync.handle({ type: 'sync.welcome' });
  assert(
    sync.handle({
      type: 'sync.compressed',
      encoding: 'gzip',
      bytes: raw.length,
      data: compressed.toString('base64'),
    }),
  );
  sync.handle({ type: 'sync.ready' });
  assert.equal(sync.active(), false);
  await completed;
  assert.equal(sync.active(), true);
  assert.deepEqual(observed[0].messages, message.messages);
  sync.reset();
});

test('旧连接的迟到解压结果被丢弃，损坏压缩会退回普通 JSON 追平', async () => {
  let release;
  const pending = new Promise((resolve) => {
      release = resolve;
    }),
    sent = [],
    observed = [];
  const sync = Sync.create({
    replica: Replica.create({ indexedDB: undefined }),
    decode: () => pending,
    send: (message) => sent.push(message),
    onSession: () => observed.push(true),
  });
  sync.hello();
  sync.handle({ type: 'sync.compressed' });
  await new Promise((resolve) => setImmediate(resolve));
  sync.reset();
  release({
    type: 'sync.session',
    key: 'codex:old',
    revision: 'old',
    replace: true,
    messages: [msg('old')],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, []);
  sync.hello();
  assert.equal(sent.at(-1).compression, 'gzip');
  sync.reset();
  let recovered;
  const done = new Promise((resolve) => {
    recovered = resolve;
  });
  const broken = Sync.create({
    replica: Replica.create({ indexedDB: undefined }),
    send: (message) => {
      sent.push(message);
      recovered();
    },
  });
  broken.handle({ type: 'sync.compressed', encoding: 'gzip', bytes: 10, data: 'invalid' });
  await done;
  assert.equal(sent.at(-1).type, 'sync.hello');
  assert(!sent.at(-1).compression);
  broken.reset();
});

test('快照换了根目录：本地副本整份作废，不与旧根的 pane 合并；sync.reset 触发重新 hello', () => {
  const replica = Replica.create({ indexedDB: undefined });
  replica.setSnapshot({
    full: true,
    hash: 'a',
    rootDirectory: '/old',
    panes: [{ paneId: 'old-pane' }],
    removed: [],
    order: ['old-pane'],
  });
  replica.put('codex:old', { revision: 'r', messages: [msg('1')] });
  const next = replica.setSnapshot({
    hash: 'b',
    rootDirectory: '/new',
    panes: [{ paneId: 'new-pane' }],
    removed: [],
    order: ['new-pane'],
  });
  assert.deepEqual(
    next.panes.map((p) => p.paneId),
    ['new-pane'],
  );
  assert.equal(replica.get('codex:old'), null);
  const sent = [];
  const sync = Sync.create({ replica, send: (m) => sent.push(m) });
  sync.handle({ type: 'sync.welcome' });
  sync.handle({ type: 'sync.ready' });
  assert.equal(sync.active(), true);
  sync.handle({ type: 'sync.reset' });
  assert.equal(sync.active(), false);
  assert.equal(sent.at(-1).type, 'sync.hello');
});
