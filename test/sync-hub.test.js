'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SyncHub, diff, fingerprint, slimSnapshot, snapshotChange } = require('../lib/sync/hub');

const msg = (id, text = id) => ({ id, role: 'assistant', blocks: [{ kind: 'text', text }] });
const version = (messages) => ({
  ids: messages.map((m) => m.id),
  hashes: messages.map(fingerprint),
});

test('client interest and native archive watching use separate callbacks', async (t) => {
  const watched = [],
    ws = { syncReady: true };
  const pane = { paneId: 'p', agent: { label: 'codex', session: { value: 's' } } };
  const hub = new SyncHub({
    dashboard: async () => ({ panes: [pane] }),
    locate: () => '/tmp/s.jsonl',
    watch: (file) => watched.push(file),
    stat: async () => ({ ino: 1, size: 1, mtimeMs: 1 }),
    read: async () => ({ conversation: [] }),
    clients: () => [ws],
    send: () => {},
  });
  t.after(() => hub.close());
  await hub.hello(ws, { interest: ['codex:s'] });
  assert.deepEqual([...ws.syncInterest], ['codex:s']);
  assert.deepEqual(watched, ['/tmp/s.jsonl']);
});

test('progressive hello becomes ready while an unrelated native archive is blocked', async (t) => {
  let release, began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const blocked = new Promise((resolve) => {
      release = resolve;
    }),
    messages = [],
    ws = { syncReady: true };
  const pane = { paneId: 'p', agent: { label: 'codex', session: { value: 's' } } };
  const hub = new SyncHub({
    progressive: true,
    dashboard: async () => ({ panes: [pane] }),
    locate: () => 'file',
    stat: async () => ({ ino: 1, size: 1, mtimeMs: 1 }),
    read: async () => {
      began();
      await blocked;
      return { conversation: [msg('m')] };
    },
    clients: () => [ws],
    send: (_ws, event) => messages.push(event),
  });
  t.after(() => hub.close());
  const scanning = hub.refresh();
  await started;
  await Promise.race([
    hub.hello(ws),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('hello waited for history')), 1000).unref(),
    ),
  ]);
  assert(ws.syncReady);
  assert(messages.some((event) => event.type === 'sync.ready'));
  release();
  await scanning;
  assert(messages.some((event) => event.type === 'sync.session' && event.messages[0]?.id === 'm'));
});

test('sliding indexed windows emit an append delta and retain the complete native total', (t) => {
  const events = [],
    ws = { syncReady: true },
    pane = { paneId: 'p', agent: { label: 'codex', session: { value: 's' } } };
  const hub = new SyncHub({
    dashboard: async () => ({ panes: [] }),
    clients: () => [ws],
    send: (_ws, event) => events.push(event),
  });
  t.after(() => hub.close());
  hub.update('codex:s', pane, [msg('1'), msg('2'), msg('3')], {
    indexed: true,
    bounded: true,
    revision: 'a',
    historyEpoch: 1,
    total: 100,
  });
  hub.update('codex:s', pane, [msg('2'), msg('3'), msg('4')], {
    indexed: true,
    bounded: true,
    revision: 'b',
    historyEpoch: 1,
    total: 101,
  });
  assert.equal(events.at(-1).after, '3');
  assert.equal(events.at(-1).replace, false);
  assert.equal(events.at(-1).total, 101);
  assert.deepEqual(events.at(-1).messages, [msg('4')]);
  hub.update('codex:s', pane, [msg('2')], {
    indexed: true,
    bounded: true,
    revision: 'c',
    historyEpoch: 2,
    total: 1,
  });
  assert.equal(events.at(-1).replace, true);
});

test('selected history precedes other bootstrap windows and preserves changes during sending', async (t) => {
  let release, began;
  const blocked = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      began = resolve;
    }),
    events = [],
    ws = { syncReady: false },
    panes = ['background', 'selected'].map((id) => ({
      paneId: id,
      agent: { label: 'codex', session: { value: id } },
    }));
  const hub = new SyncHub({
    progressive: true,
    dashboard: async () => ({ panes }),
    clients: () => [ws],
    send: async (_ws, event) => {
      events.push(event);
      if (event.type === 'sync.session' && event.key === 'codex:background') {
        began();
        await blocked;
      }
    },
  });
  t.after(() => hub.close());
  for (const pane of panes) hub.update(`codex:${pane.paneId}`, pane, [msg('initial')]);
  const pending = hub.hello(ws, { interest: ['codex:selected'] });
  await started;
  assert.equal(events.find((event) => event.type === 'sync.session').key, 'codex:selected');
  hub.update('codex:selected', panes[1], [msg('initial'), msg('new')]);
  release();
  await pending;
  assert.equal(events.at(-1).type, 'sync.ready');
  assert.equal(
    events
      .filter((event) => event.key === 'codex:selected')
      .at(-1)
      .messages.at(-1).id,
    'new',
  );
});

test('变化是最长相同前缀之后的部分：追加、最后一条更新、回滚', () => {
  const a = [msg('1'), msg('2'), msg('3')];
  assert.deepEqual(diff(version(a), version([...a, msg('4')]), [...a, msg('4')]), {
    replace: false,
    after: '3',
    messages: [msg('4')],
  });
  const edited = [msg('1'), msg('2'), msg('3', '改过')];
  assert.deepEqual(diff(version(a), version(edited), edited), {
    replace: false,
    after: '2',
    messages: [msg('3', '改过')],
  });
  const rolled = [msg('1')];
  assert.deepEqual(diff(version(a), version(rolled), rolled), {
    replace: false,
    after: '1',
    messages: [],
  });
});

test('前缀为空或尾巴太长时整体替换，只给最近 60 条', () => {
  const old = [msg('a')];
  const fresh = Array.from({ length: 100 }, (_, i) => msg(`n${i}`));
  const change = diff(version(old), version(fresh), fresh);
  assert.equal(change.replace, true);
  assert.equal(change.messages.length, 60);
  assert.equal(change.messages[0].id, 'n40');
  const grown = [msg('a'), ...Array.from({ length: 250 }, (_, i) => msg(`m${i}`))];
  assert.equal(diff(version(old), version(grown), grown).replace, true, '尾巴超过 200 条');
});

test('快照只推变了的 pane，工作区列表变了才带上；滚动位置不算变化', () => {
  const base = {
    rootDirectory: '/r',
    focusedPaneId: 'p1',
    workspaces: [{ workspaceId: 'w1' }],
    panes: [
      { paneId: 'p1', status: 'idle', scroll: { max_offset_from_bottom: 1 } },
      { paneId: 'p2', status: 'idle' },
    ],
  };
  const scrolled = {
    ...base,
    panes: [{ ...base.panes[0], scroll: { max_offset_from_bottom: 9 } }, base.panes[1]],
  };
  assert.equal(fingerprint(slimSnapshot(base)), fingerprint(slimSnapshot(scrolled)));
  const next = slimSnapshot({
    ...base,
    panes: [
      { paneId: 'p1', status: 'working' },
      { paneId: 'p3', status: 'idle' },
    ],
  });
  const change = snapshotChange(slimSnapshot(base), next);
  assert.deepEqual(
    change.panes.map((p) => p.paneId),
    ['p1', 'p3'],
  );
  assert.deepEqual(change.removed, ['p2']);
  assert.deepEqual(change.order, ['p1', 'p3']);
  assert.equal('workspaces' in change, false);
});

function fixture() {
  const state = {
    conversation: [msg('1'), msg('2')],
    panes: [{ paneId: 'p1', agent: { label: 'codex', session: { value: 's1' } }, cwd: '/r' }],
  };
  const clients = new Set(),
    sent = [];
  const hub = new SyncHub({
    dashboard: async () => ({
      rootDirectory: '/r',
      focusedPaneId: '',
      workspaces: [],
      panes: state.panes,
    }),
    locate: () => '/r/s1.jsonl',
    read: async () => ({ conversation: state.conversation }),
    stat: async () => ({
      ino: 1,
      size: JSON.stringify(state.conversation).length,
      mtimeMs: state.conversation.length,
    }),
    clients: () => clients,
    send: (ws, message) => sent.push([ws, message]),
  });
  return {
    state,
    clients,
    sent,
    hub,
    of: (ws) => sent.filter(([w]) => w === ws).map(([, m]) => m),
  };
}

test('hello 只补客户端缺的：同版本不发，已知版本发变化，未知版本整体替换', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  const ws = { id: 'a' };
  f.clients.add(ws);
  await f.hub.hello(ws, {});
  const first = f.of(ws);
  assert.deepEqual(
    first.map((m) => m.type),
    ['sync.welcome', 'sync.snapshot', 'sync.session', 'sync.ready'],
  );
  const session = first[2];
  assert.equal(session.key, 'codex:s1');
  assert.equal(session.replace, true);
  assert.equal(session.messages.length, 2);
  const revision = session.revision;

  // 同一版本、同一快照：只有握手。
  const same = { id: 'b' };
  await f.hub.hello(same, { sessions: { 'codex:s1': revision }, snapshot: first[1].hash });
  assert.deepEqual(
    f.of(same).map((m) => m.type),
    ['sync.welcome', 'sync.ready'],
  );

  // 之后追加一条：已连上的客户端收到只含新消息的变化。
  f.state.conversation = [msg('1'), msg('2'), msg('3')];
  await f.hub.refresh();
  const pushed = f
    .of(ws)
    .filter((m) => m.type === 'sync.session')
    .at(-1);
  assert.deepEqual(
    { after: pushed.after, ids: pushed.messages.map((m) => m.id), base: pushed.base },
    { after: '2', ids: ['3'], base: revision },
  );

  // 离开期间错过了这一条的客户端：按它手里的旧版本补变化，而不是整段。
  const late = { id: 'c' };
  await f.hub.hello(late, { sessions: { 'codex:s1': revision } });
  const caught = f.of(late).find((m) => m.type === 'sync.session');
  assert.deepEqual(
    { replace: caught.replace, after: caught.after, ids: caught.messages.map((m) => m.id) },
    { replace: false, after: '2', ids: ['3'] },
  );

  // 服务端不认识的版本：整体替换。
  const stranger = { id: 'd' };
  await f.hub.hello(stranger, { sessions: { 'codex:s1': 'unknown' } });
  assert.equal(f.of(stranger).find((m) => m.type === 'sync.session').replace, true);
});

test('没发过 hello 的连接收不到推送；会话关闭后不再跟踪', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  const silent = { id: 'old-client' };
  f.clients.add(silent);
  await f.hub.refresh();
  f.state.conversation = [msg('1'), msg('2'), msg('3')];
  await f.hub.refresh();
  assert.equal(f.of(silent).length, 0);
  f.state.panes = [];
  await f.hub.refresh();
  assert.equal(f.hub.sessions.size, 0);
});

test('存档文件没变就不读：大小、修改时间与 inode 都相同时跳过', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  let reads = 0;
  const read = f.hub.read;
  f.hub.read = async (...args) => {
    reads += 1;
    return read(...args);
  };
  await f.hub.refresh();
  await f.hub.refresh();
  await f.hub.refresh();
  assert.equal(reads, 1);
  f.state.conversation = [msg('1'), msg('2'), msg('3')];
  await f.hub.refresh();
  assert.equal(reads, 2);
});

test('文件列表与归档列表：变了才推，每个会话 5 秒内不重算，hello 只补指纹不同的', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  let clock = 100000,
    computed = 0;
  const lists = {
    files: [{ path: '/r/a.md' }],
    history: { sessions: [{ sessionId: 'old' }], nextOffset: null },
  };
  Object.assign(f.hub, {
    now: () => clock,
    files: async () => {
      computed += 1;
      return lists.files;
    },
    history: async () => lists.history,
  });
  const ws = { id: 'a' };
  f.clients.add(ws);
  await f.hub.hello(ws, {});
  // hello 不等列表：列表在后台算好再推给已连上的客户端。
  assert.equal(f.of(ws).at(-1).type, 'sync.ready');
  await f.hub.listing;
  const first = f.of(ws);
  const files = first.find((m) => m.type === 'sync.files'),
    history = first.find((m) => m.type === 'sync.history');
  assert.deepEqual(files.files, lists.files);
  assert.equal(files.key, 'codex:s1');
  assert.deepEqual(history.sessions, lists.history.sessions);
  // 会话变了但距上次重算不到 5 秒：先不算。
  f.state.conversation = [msg('1'), msg('2'), msg('3')];
  clock += 1000;
  await f.hub.refresh();
  await f.hub.listing;
  assert.equal(computed, 1);
  // 过了 5 秒：重算；列表内容没变就不推。
  clock += 5000;
  await f.hub.refresh();
  await f.hub.listing;
  assert.equal(computed, 2);
  assert.equal(f.of(ws).filter((m) => m.type === 'sync.files').length, 1);
  // 列表真的变了：推一次。
  lists.files = [{ path: '/r/a.md' }, { path: '/r/b.md' }];
  f.state.conversation = [msg('1'), msg('2'), msg('3'), msg('4')];
  clock += 6000;
  await f.hub.refresh();
  await f.hub.listing;
  assert.equal(
    f
      .of(ws)
      .filter((m) => m.type === 'sync.files')
      .at(-1).files.length,
    2,
  );
  // 已有同样指纹的客户端 hello 时不再收到列表。
  const same = { id: 'b' };
  await f.hub.hello(same, {
    files: { 'codex:s1': f.hub.sessions.get('codex:s1').filesHash },
    history: f.hub.historyHash,
    sessions: { 'codex:s1': f.hub.sessions.get('codex:s1').revision },
    snapshot: f.hub.snapshotHash,
  });
  await f.hub.listing;
  assert.deepEqual(
    f.of(same).map((m) => m.type),
    ['sync.welcome', 'sync.ready'],
  );
});

test('首轮之后才出现的会话（新建或 pane 换了身份）主动推整段；旧身份不再跟踪', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  const ws = { id: 'a' };
  f.clients.add(ws);
  await f.hub.hello(ws, {});
  // 同一个 pane 里恢复了另一个会话：身份变了。
  f.state.panes = [
    { paneId: 'p1', agent: { label: 'codex', session: { value: 's2' } }, cwd: '/r' },
  ];
  f.state.conversation = [msg('x1')];
  await f.hub.refresh();
  const pushed = f
    .of(ws)
    .filter((m) => m.type === 'sync.session')
    .at(-1);
  assert.deepEqual(
    { key: pushed.key, replace: pushed.replace, ids: pushed.messages.map((m) => m.id) },
    { key: 'codex:s2', replace: true, ids: ['x1'] },
  );
  assert.deepEqual([...f.hub.sessions.keys()], ['codex:s2']);
});

test('根目录切走的中心不再扫描与推送', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  let active = true;
  f.hub.active = () => active;
  const ws = { id: 'a' };
  f.clients.add(ws);
  await f.hub.hello(ws, {});
  const before = f.sent.length;
  active = false;
  f.state.conversation = [msg('1'), msg('2'), msg('3')];
  await f.hub.refresh();
  assert.equal(f.sent.length, before);
});

test('bootstrap send completion cannot lose changes before enabling live updates', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  await f.hub.refresh();
  const ws = {};
  f.clients.add(ws);
  const entry = f.hub.sessions.get('codex:s1');
  Object.assign(entry, { filesHash: 'files-old', files: [{ path: '/r/old.md' }] });
  f.hub.historyHash = 'history-old';
  f.hub.historyList = { sessions: [{ sessionId: 'old' }] };
  const original = f.hub.send;
  let changed = false;
  f.hub.send = async (socket, event) => {
    original(socket, structuredClone(event));
    if (event.type === 'sync.history' && !changed) {
      changed = true;
      f.state.conversation = [msg('1'), msg('2'), msg('new')];
      f.state.panes[0].status = 'working';
      await f.hub.refresh();
      const latest = f.hub.sessions.get('codex:s1');
      Object.assign(latest, { filesHash: 'files-new', files: [{ path: '/r/new.md' }] });
      f.hub.historyHash = 'history-new';
      f.hub.historyList = { sessions: [{ sessionId: 'new' }] };
    }
    return true;
  };
  await f.hub.hello(ws);
  const events = f.of(ws);
  assert.equal(events.at(-1).type, 'sync.ready');
  assert.equal(
    events
      .filter((e) => e.type === 'sync.session')
      .at(-1)
      .messages.at(-1).id,
    'new',
  );
  assert.equal(events.filter((e) => e.type === 'sync.snapshot').at(-1).panes[0].status, 'working');
  assert.equal(events.filter((e) => e.type === 'sync.files').at(-1).files[0].path, '/r/new.md');
  assert.equal(events.filter((e) => e.type === 'sync.history').at(-1).sessions[0].sessionId, 'new');
});

test('a newer hello supersedes a bootstrap paused on transport completion', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  let release,
    blocked = false;
  const original = f.hub.send;
  f.hub.send = (ws, event) => {
    original(ws, event);
    if (!blocked && event.type === 'sync.welcome') {
      blocked = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return true;
  };
  const ws = {};
  const first = f.hub.hello(ws);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await f.hub.hello(ws);
  const before = f.sent.length;
  release(true);
  await first;
  assert.equal(f.sent.length, before, 'retired bootstrap must not publish another window or ready');
  assert.equal(f.of(ws).filter((event) => event.type === 'sync.ready').length, 1);
});

test('switching root while bootstrap waits prevents old-root content from resuming', async (t) => {
  const f = fixture();
  t.after(() => f.hub.close());
  let release,
    active = true;
  f.hub.active = () => active;
  const original = f.hub.send;
  f.hub.send = (ws, event) => {
    original(ws, event);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const ws = {},
    pending = f.hub.hello(ws);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  active = false;
  release(true);
  await pending;
  assert.deepEqual(
    f.of(ws).map((event) => event.type),
    ['sync.welcome'],
  );
  assert.equal(ws.syncReady, false);
});
