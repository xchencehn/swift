'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Database } = require('../lib/store/database');
const { EventLog } = require('../lib/store/events');
const { MessageStore } = require('../lib/store/message-store');
const { MessageQueue } = require('../lib/message-queue');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function open(t, dir, name = 'studio.sqlite') {
  const database = new Database(path.join(dir, 'state', name));
  t.after(() => database.close());
  const events = new EventLog(database);
  return { database, events, store: new MessageStore(database, events) };
}
const item = (id, paneId = 'p1', fields = {}) => ({
  id,
  paneId,
  text: id,
  status: 'queued',
  updatedAt: 1000,
  ...fields,
});

test('一万条历史回执中修改一条只写一行，保留其他记录且不重复序列化', (t) => {
  const { database, store } = open(t, scratch(t));
  const items = Array.from({ length: 10000 }, (_, i) =>
    item(`m${i}`, 'p1', { status: 'consumed' }),
  );
  store.save(items);
  database.exec(
    "CREATE TABLE writes(kind TEXT); CREATE TRIGGER changed AFTER UPDATE ON messages BEGIN INSERT INTO writes VALUES('updated'); END; CREATE TRIGGER deleted AFTER DELETE ON messages BEGIN INSERT INTO writes VALUES('deleted'); END;",
  );
  items[0].toJSON = () => {
    throw Error('Historical receipt should not be serialized again');
  };
  items[9999].text = '新的内容'; // Timestamp deliberately stays unchanged.
  const result = store.save(items, { changedIds: ['m9999'] });
  assert.equal(result.upserted, 1);
  assert.equal(result.removed, 0);
  assert.deepEqual(
    database
      .prepare('SELECT kind FROM writes')
      .all()
      .map((row) => row.kind),
    ['updated'],
  );
  assert.equal(store.load().length, 10000);
  assert.equal(store.load().at(-1).text, '新的内容');
});

test('外层事务回滚不推进内存快照，事务内连续保存与随后重试仍然正确', (t) => {
  const { database, store } = open(t, scratch(t));
  const rows = [item('a'), item('b')];
  store.save(rows);
  assert.throws(
    () =>
      database.transaction(() => {
        rows[0].text = 'A';
        store.save(rows, { changedIds: ['a'] });
        rows[1].text = 'B';
        store.save(rows, { changedIds: ['b'] });
        throw Error('rollback fixture');
      }),
    /rollback fixture/,
  );
  assert.deepEqual(
    store.load().map((row) => row.text),
    ['a', 'b'],
  );
  assert.equal(store.save(rows).upserted, 2);
  assert.deepEqual(
    store.load().map((row) => row.text),
    ['A', 'B'],
  );
  database.transaction(() => {
    rows[0].text = 'C';
    store.save(rows, { changedIds: ['a'] });
    rows[1].text = 'D';
    store.save(rows, { changedIds: ['b'] });
  });
  assert.equal(store.save(rows).upserted, 0);
  assert.deepEqual(
    store.load().map((row) => row.text),
    ['C', 'D'],
  );
});

test('数据库启用 WAL 与完整同步，迁移可重复执行且不重建已有数据', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'state', 'studio.sqlite');
  const first = new Database(file);
  assert.equal(first.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(first.prepare('PRAGMA synchronous').get().synchronous, 2);
  // 版本随迁移增长，断言它等于最后一条迁移，而不是写死某个数字。
  const { MIGRATIONS } = require('../lib/store/database');
  const latest = MIGRATIONS.at(-1).version;
  assert.equal(first.prepare('PRAGMA user_version').get().user_version, latest);
  first.exec("INSERT INTO messages VALUES('keep','p1',1,0,'{}')");
  first.close();

  const second = new Database(file);
  t.after(() => second.close());
  assert.equal(second.prepare('PRAGMA user_version').get().user_version, latest);
  assert.equal(second.prepare('SELECT COUNT(*) c FROM messages').get().c, 1, '重开不应重建表');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('状态与事件在同一事务提交，失败时一起回滚', (t) => {
  const { database, events, store } = open(t, scratch(t));
  store.save([item('a')]);
  assert.equal(events.latest(), 1);

  assert.throws(
    () =>
      database.transaction(() => {
        database.exec("INSERT INTO messages VALUES('x','p1',1,9,'{}')");
        events.append({ type: 'messages.changed' });
        throw new Error('中途失败');
      }),
    /中途失败/,
  );
  assert.equal(events.latest(), 1, '回滚后事件不应留下');
  assert.equal(
    database.prepare('SELECT COUNT(*) c FROM messages').get().c,
    1,
    '回滚后状态不应留下',
  );
});

test('保存返回递增序号，事件载荷只包含实际变化的 pane', (t) => {
  const { events, store } = open(t, scratch(t));
  const first = store.save([item('a', 'p1'), item('b', 'p2')]);
  assert.equal(first.seq, 1);
  assert.deepEqual(first.paneIds.sort(), ['p1', 'p2']);
  assert.deepEqual(events.since(0).events[0].payload.paneIds.sort(), ['p1', 'p2']);

  const second = store.save([item('a', 'p1'), item('b', 'p2', { updatedAt: 2000 })]);
  assert.equal(second.seq, 2);
  assert.deepEqual(second.paneIds, ['p2'], '未变化的 pane 不应出现');

  const third = store.save([item('a', 'p1')]);
  assert.deepEqual(third.paneIds, ['p2'], '删除也算该 pane 变化');
  assert.equal(third.seq, 3);
  assert.deepEqual(
    store.load().map((value) => value.id),
    ['a'],
  );
});

test('游标返回其后的事件，超出保留窗口要求重新取快照', (t) => {
  const { database, store } = open(t, scratch(t));
  const events = new EventLog(database, { retain: 3 });
  const small = new MessageStore(database, events);
  for (let i = 0; i < 6; i++) small.save([item(`m${i}`)]);

  assert.equal(events.latest(), 6);
  assert.equal(events.oldest(), 4, '保留窗口之外的事件应被裁掉');
  assert.deepEqual(
    events.since(4).events.map((value) => value.seq),
    [5, 6],
  );
  assert.equal(events.since(4).reset, false);
  assert.equal(events.since(1).reset, true, '落后过多必须重新同步');
  assert.equal(events.since(99).reset, true, '超前的游标同样无效');
  assert.equal(events.since(6).events.length, 0);
  assert.equal(store.load().length, 1);
});

test('首次启动导入 JSON 队列，保留原文件且不重复导入', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'messages.json');
  const saved = [item('kept', 'p1', { status: 'consumed' }), item('later', 'p2')];
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: saved }));

  const { events, store } = open(t, dir);
  assert.equal(store.importFrom(file), 2);
  assert.deepEqual(
    store.load().map((value) => value.id),
    ['kept', 'later'],
  );
  assert.equal(events.since(0).events[0].type, 'messages.imported');
  assert(fs.existsSync(file), '原 JSON 必须保留为备份');

  assert.equal(store.importFrom(file), 0, '已有数据时不应再次导入');
  assert.equal(store.load().length, 2);
});

test('队列改用存储后不再写 JSON，重启从存储恢复并保留回执', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'messages.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: [] }));
  const { store } = open(t, dir);
  const pane = {
    paneId: 'p1',
    terminalId: 't1',
    cwd: '/x',
    agent: { label: 'codex', name: 'a1', status: 'idle', session: { value: 's1' } },
  };
  const options = {
    store,
    file,
    getPane: async () => pane,
    getPanes: async () => [pane],
    readMessages: async () => [],
    send: async () => ({ ok: true }),
  };

  const queue = new MessageQueue(options);
  await queue.enqueue({ id: 'm1', paneId: 'p1', text: '你好' });
  assert.equal(queue.seq > 0, true, '持久化应返回事件序号');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items, [], 'JSON 备份不应再被写入');
  assert.deepEqual(
    queue.persisted().map((value) => value.id),
    ['m1'],
  );

  const restarted = new MessageQueue(options);
  assert.deepEqual(
    restarted.items.map((value) => value.id),
    ['m1'],
  );
  assert.equal(restarted.items[0].sessionId, 's1');
});

test('存储失败后队列失败即停，不再继续投递', async (t) => {
  const dir = scratch(t);
  const { database, store } = open(t, dir);
  const pane = {
    paneId: 'p1',
    terminalId: 't1',
    cwd: '/x',
    agent: { label: 'codex', name: 'a1', status: 'idle', session: { value: 's1' } },
  };
  const queue = new MessageQueue({
    store,
    getPane: async () => pane,
    getPanes: async () => [pane],
    readMessages: async () => [],
    send: async () => ({ ok: true }),
  });
  await queue.enqueue({ id: 'm1', paneId: 'p1', text: '你好' });

  database.close();
  await assert.rejects(
    queue.enqueue({ id: 'm2', paneId: 'p1', text: '第二条' }),
    /QUEUE_STORAGE_FAILED|无法持久化/,
  );
  assert.equal(queue.storageError.code, 'QUEUE_STORAGE_FAILED');
  await assert.rejects(queue.enqueue({ id: 'm3', paneId: 'p1', text: '第三条' }), /无法持久化/);
});

test('没有存储也没有文件时保持内存队列，不落盘', async (t) => {
  const pane = {
    paneId: 'side',
    terminalId: 't1',
    cwd: '/x',
    agent: { label: 'codex', name: 'a1', status: 'idle', session: { value: 's1' } },
  };
  let notified = 0;
  const queue = new MessageQueue({
    getPane: async () => pane,
    getPanes: async () => [pane],
    readMessages: async () => [],
    send: async () => ({ ok: true }),
    onChange: () => {
      notified++;
    },
  });
  await queue.enqueue({ id: 'm1', paneId: 'side', text: '临时' });
  assert.equal(queue.items.length, 1);
  assert.deepEqual(queue.persisted(), []);
  assert(notified > 0, '内存队列仍要通知变化');
});
