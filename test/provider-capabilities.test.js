'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Providers = require('../public/provider-capabilities');
const Native = require('../lib/providers/native');
const { SyncHub } = require('../lib/sync/hub');
const { MessageQueue } = require('../lib/message-queue');

test('提供方读取、同步和控制共用能力声明；未知提供方不授予控制', async () => {
  assert.deepEqual(Native.PROVIDERS, Providers.providers);
  for (const provider of Providers.providers) {
    const cap = Providers.get(provider);
    assert.equal(cap.history, true);
    assert.equal(Providers.sessionKey(provider, 's1'), `${provider}:s1`);
    if (provider !== 'codex' && provider !== 'claude') {
      assert.equal(cap.send, false);
      const pane = {
        paneId: 'p',
        terminalId: 't',
        agent: { label: provider, name: 'agent', session: { value: 's1' } },
      };
      const queue = new MessageQueue({
        getPane: async () => pane,
        readMessages: async () => [],
        send: () => assert.fail('read-only provider was written'),
      });
      await assert.rejects(queue.enqueue({ id: 'm', paneId: 'p', text: 'input' }), {
        code: 'SESSION_UNAVAILABLE',
      });
    }
  }
  assert.equal(Providers.sessionKey('unknown', 's1'), '');
  assert.equal(Providers.get('unknown').send, false);
  assert(Object.isFrozen(Providers.get('codex')));
});

test('八种提供方均可追平；SQLite 检查 WAL 更新并保留原生分页游标', async (t) => {
  let walRevision = 1,
    reads = 0;
  const panes = Providers.providers.map((provider) => ({
    paneId: provider,
    cwd: '/fixture',
    agent: { label: provider, session: { value: provider } },
  }));
  const sent = [],
    watched = [];
  const hub = new SyncHub({
    dashboard: async () => ({ panes, workspaces: [], rootDirectory: '/fixture' }),
    locate: (provider) => `/fixture/${provider}.jsonl`,
    databasePath: (provider) => `/fixture/${provider}.sqlite`,
    stat: async (file) => ({ ino: 1, size: 100, mtimeMs: file.endsWith('-wal') ? walRevision : 1 }),
    read: async (_file, provider) => {
      reads++;
      return {
        conversation: [
          { id: `${provider}:native-cursor`, blocks: [] },
          { id: `${provider}:tail:${walRevision}`, blocks: [] },
        ],
        revision: `${provider}:${walRevision}`,
        hasMore: true,
      };
    },
    watch: (file) => watched.push(file),
    clients: () => [],
    send: (_ws, event) => sent.push(event),
  });
  t.after(() => hub.close());
  await hub.hello({}, {});
  assert.equal(sent.filter((event) => event.type === 'sync.session').length, 8);
  const page = sent.find((event) => event.key === 'opencode:opencode');
  assert.equal(page.messages[0].id, 'opencode:native-cursor');
  assert.equal(page.hasMore, true);
  assert(watched.includes('/fixture/opencode.sqlite-wal'));
  await hub.refresh();
  assert.equal(reads, 8, '未变化的数据库和存档不重读');
  walRevision++;
  await hub.refresh();
  assert.equal(reads, 10, '只重读 WAL 变化的两种 SQLite 提供方');
  const caught = [];
  hub.send = (_ws, event) => caught.push(event);
  await hub.hello({}, { sessions: { 'opencode:opencode': page.revision } });
  const updated = caught.find((event) => event.key === 'opencode:opencode');
  assert.equal(updated.replace, true);
  assert.equal(updated.messages[0].id, 'opencode:native-cursor');
  assert.equal(updated.messages.at(-1).id, 'opencode:tail:2');
});
