'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Boot = require('../public/core/boot');
const Drafts = require('../public/chat/drafts');

test('并列 Pane 页面交替保存与删除不会覆盖其他会话草稿', () => {
  const entries = new Map(),
    storage = {
      getItem: (key) => entries.get(key),
      setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key),
    };
  const a = { agent: { label: 'codex', session: { value: 'a' } } },
    b = { agent: { label: 'claude', session: { value: 'b' } } };
  const left = Drafts.create({ storage }),
    right = Drafts.create({ storage });
  left.load('/root');
  right.load('/root');
  left.set(a, 'A');
  right.set(b, 'B');
  left.set(a, 'A2');
  assert.equal(right.get(a), 'A2');
  assert.equal(left.get(b), 'B');
  left.set(a, '');
  right.set(b, 'B2');
  const restored = Drafts.create({ storage });
  restored.load('/root');
  assert.equal(restored.get(a), '');
  assert.equal(restored.get(b), 'B2');
});

test('旧版草稿仍可读取，删除后的旧草稿不会在重载时重新出现', () => {
  const pane = { agent: { label: 'codex', session: { value: 'old' } } },
    id = Drafts.identity(pane);
  const entries = new Map([
    [
      'agentStudioDrafts::/root',
      JSON.stringify({ version: 1, drafts: [{ identity: id, text: '旧版草稿' }] }),
    ],
  ]);
  const storage = {
    getItem: (key) => entries.get(key),
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  const first = Drafts.create({ storage });
  first.load('/root');
  assert.equal(first.get(pane), '旧版草稿');
  first.set(pane, '');
  const second = Drafts.create({ storage });
  second.load('/root');
  assert.equal(second.get(pane), '');
});

test('草稿按机器、根目录和原生身份持久化；pane 复用不取出其他会话草稿', () => {
  const entries = new Map();
  const storage = {
    getItem: (key) => entries.get(key),
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  const pane = { paneId: 'p', agent: { label: 'codex', session: { value: 's1' } } };
  const first = Drafts.create({ storage, namespace: '/machine-a' });
  first.load('/root');
  assert.equal(first.set(pane, '未发送的中文草稿'), true);
  const second = Drafts.create({ storage, namespace: '/machine-a' });
  second.load('/root');
  assert.equal(second.get(pane), '未发送的中文草稿');
  assert.equal(second.get({ ...pane, agent: { label: 'codex', session: { value: 's2' } } }), '');
  second.load('/other-root');
  assert.equal(second.get(pane), '');
  second.load('/root');
  assert.equal(second.get(pane), '未发送的中文草稿');
  const other = Drafts.create({ storage, namespace: '/machine-b' });
  other.load('/root');
  assert.equal(other.get(pane), '');
  second.set(pane, '');
  assert.equal(second.get(pane), '');
});

test('草稿保存失败保留内存内容，并向界面报告持久化失败', () => {
  const errors = [];
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    },
  };
  const drafts = Drafts.create({ storage, onError: (error) => errors.push(error) });
  const pane = { paneId: 'p', terminalId: 't', agent: { label: 'claude' } };
  drafts.load('/r');
  assert.equal(drafts.set(pane, '不能丢掉'), false);
  assert.equal(drafts.get(pane), '不能丢掉');
  drafts.load('/other');
  drafts.load('/r');
  assert.equal(drafts.get(pane), '不能丢掉');
  assert.deepEqual(errors, ['QuotaExceededError']);
});

test('存储满时只释放启动缓存，重试保存并保留其他草稿和设置', () => {
  const entries = new Map([
    ['agentStudioBoot:/e/a', 'cache'],
    ['agentStudioDrafts:other', 'keep'],
    ['studioPrefs', 'keep'],
  ]);
  const errors = [];
  const storage = {
    get length() {
      return entries.size;
    },
    key: (i) => [...entries.keys()][i],
    getItem: (key) => entries.get(key),
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => {
      if (entries.has('agentStudioBoot:/e/a'))
        throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      entries.set(key, value);
    },
  };
  const pane = { agent: { label: 'codex', session: { value: 'quota' } } };
  const drafts = Drafts.create({ storage, onError: (error) => errors.push(error) });
  drafts.load('/r');
  assert.equal(drafts.set(pane, '保存当前草稿'), true);
  assert.equal(entries.has('agentStudioBoot:/e/a'), false);
  assert.equal(entries.get('agentStudioDrafts:other'), 'keep');
  assert.equal(entries.get('studioPrefs'), 'keep');
  const restored = Drafts.create({ storage });
  restored.load('/r');
  assert.equal(restored.get(pane), '保存当前草稿');
  assert.deepEqual(errors, []);
});

test('空草稿删除存储项且未初始化根目录不误报存储故障', () => {
  const entries = new Map(),
    errors = [];
  let writes = 0;
  const storage = {
    getItem: (key) => entries.get(key),
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => {
      writes++;
      entries.set(key, value);
    },
  };
  const pane = { agent: { label: 'codex', session: { value: 'empty' } } };
  const drafts = Drafts.create({ storage, onError: (error) => errors.push(error) });
  assert.equal(drafts.set(pane, ''), false);
  drafts.load('/r');
  assert.equal(drafts.set(pane, ''), true);
  assert.equal(writes, 0);
  drafts.set(pane, 'draft');
  drafts.set(pane, 'draft');
  assert.equal(writes, 1);
  drafts.set(pane, '');
  assert.equal(entries.size, 0);
  assert.deepEqual(errors, []);
});

test('另一窗口删除草稿后，不从已过期的内存副本恢复文字', () => {
  const entries = new Map();
  const storage = {
    getItem: (key) => entries.get(key),
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  const pane = { agent: { label: 'codex', session: { value: 'shared' } } };
  const left = Drafts.create({ storage }),
    right = Drafts.create({ storage });
  left.load('/r');
  right.load('/r');
  left.set(pane, 'old');
  right.set(pane, 'new');
  left.set(pane, '');
  assert.equal(right.get(pane), '');
});

test('持续失败保持错误，成功重试才解除；损坏旧草稿报告读取错误', () => {
  const errors = [];
  let saved = 0,
    fail = true;
  const storage = {
    getItem: () => null,
    setItem: () => {
      if (fail) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    },
  };
  const pane = { agent: { label: 'codex', session: { value: 'retry' } } };
  const drafts = Drafts.create({
    storage,
    onError: (name, operation) => errors.push([name, operation]),
    onSaved: () => saved++,
  });
  drafts.load('/r');
  drafts.set(pane, 'a');
  drafts.set(pane, 'ab');
  assert.equal(errors.length, 2);
  assert.equal(saved, 0);
  assert.equal(drafts.get(pane), 'ab');
  fail = false;
  assert.equal(drafts.flush(), true);
  assert.equal(saved, 1);
  assert.equal(drafts.error(), '');
  const broken = Drafts.create({
    storage: { getItem: () => '{broken' },
    onError: (name, operation) => errors.push([name, operation]),
  });
  broken.load('/r');
  assert.deepEqual(errors.at(-1), ['SyntaxError', 'read']);
});

test('离线启动先读取副本，不等待配置；恢复配置后才启用连接', async () => {
  const events = [],
    scheduled = [];
  const saved = { rootDirectory: '/r', panes: [{ paneId: 'p' }] };
  let connected = false;
  const replica = { load: async (root) => events.push(['load', root]), snapshot: () => saved };
  const boot = Boot.create({
    replica,
    paintLegacy: () => events.push(['legacy']),
    renderCached: () => events.push(['paint']),
    loadConfig: async () => {
      events.push(['request']);
      if (!connected) throw new TypeError('offline');
      return { rootDirectory: '/r' };
    },
    applyConfig: () => events.push(['config']),
    connect: () => events.push(['connect']),
    unauthorized: () => assert.fail('network failure was treated as authentication failure'),
    offline: (cached) => assert.equal(cached, true),
    schedule: (callback) => {
      scheduled.push(callback);
      return 1;
    },
    cancel: () => {},
  });
  await boot.start();
  assert(
    events.findIndex(([event]) => event === 'paint') <
      events.findIndex(([event]) => event === 'request'),
  );
  assert.equal(
    events.some(([event]) => event === 'connect'),
    false,
  );
  connected = true;
  await boot.verify();
  assert.equal(events.at(-1)[0], 'connect');
  boot.stop();
});

test('认证拒绝与断网分别处理，认证拒绝不自动重试或连接', async () => {
  let rejected = 0;
  const boot = Boot.create({
    replica: { load: async () => {}, snapshot: () => null },
    renderCached: () => {},
    loadConfig: async () => {
      throw Object.assign(new Error('revoked'), { code: 'UNAUTHORIZED' });
    },
    applyConfig: () => assert.fail(),
    connect: () => assert.fail(),
    unauthorized: () => rejected++,
    offline: () => assert.fail(),
    schedule: () => assert.fail('unauthorized access must not be retried'),
  });
  await boot.start();
  assert.equal(rejected, 1);
  boot.stop();
});
