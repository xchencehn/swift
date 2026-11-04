'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConversationStore } = require('../lib/conversation-store');

test('a new request observes an append made while an older read is still in flight', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-pending-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl'),
    store = new ConversationStore();
  const record = (text) =>
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }) + '\n';
  fs.writeFileSync(file, record('older snapshot'));
  const read = store.readFile.bind(store);
  let started, release;
  const ready = new Promise((r) => {
      started = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  let first = true;
  store.readFile = async (...args) => {
    const result = await read(...args);
    if (first) {
      first = false;
      started();
      await gate;
    }
    return result;
  };
  const previous = store.read(file, 'codex');
  await ready;
  fs.appendFileSync(file, record('new image record'));
  const current = store.read(file, 'codex');
  release();
  await previous;
  assert(JSON.stringify((await current).messages).includes('new image record'));
});

const user = (uuid, parentUuid, text) =>
  JSON.stringify({
    type: 'user',
    uuid,
    parentUuid,
    timestamp: '2026-09-24T00:00:00Z',
    message: { role: 'user', content: text },
  });
const texts = (value) =>
  value.conversation.map((message) => message.blocks.map((block) => block.text).join(''));

test('Codex 追加复用未变化消息，控制投影按需计算且不改变旧版本', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'codex.jsonl'),
    store = new ConversationStore();
  const line = (id, text) =>
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] },
    }) + '\n';
  fs.writeFileSync(file, line('a', '旧内容'));
  const first = await store.read(file, 'codex');
  assert.equal(typeof Object.getOwnPropertyDescriptor(first, 'archive').get, 'function');
  fs.appendFileSync(file, line('b', '新内容'));
  const second = await store.read(file, 'codex');
  assert.equal(second.conversation[0], first.conversation[0]);
  assert(Object.isFrozen(second.conversation[0]));
  assert.equal(first.conversation.length, 1);
  assert(second.archive.ids.has('b'));
  assert.equal(Object.getOwnPropertyDescriptor(second, 'archive').get, undefined);
  assert.equal(store.bytes, fs.statSync(file).size * 3);
  assert.deepEqual(
    second.conversation,
    (await new ConversationStore().read(file, 'codex')).conversation,
  );
});

test('存档追加时只读新增部分，结果与整份重读一致；写到一半的行等写完再算；被改写就整份重读', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const store = new ConversationStore();
  fs.writeFileSync(file, user('a', null, '第一条') + '\n');
  assert.deepEqual(texts(await store.read(file, 'claude')), ['第一条']);

  const second = user('b', 'a', '第二条');
  fs.appendFileSync(file, second.slice(0, 20));
  assert.deepEqual(texts(await store.read(file, 'claude')), ['第一条'], '半行不算');
  fs.appendFileSync(file, second.slice(20) + '\n');
  const appended = await store.read(file, 'claude');
  assert.deepEqual(texts(appended), ['第一条', '第二条']);
  assert.deepEqual(texts(appended), texts(await new ConversationStore().read(file, 'claude')));

  fs.writeFileSync(file, user('x', null, '改写后') + '\n' + user('y', 'x', '更长的一条') + '\n');
  assert.deepEqual(texts(await store.read(file, 'claude')), ['改写后', '更长的一条']);
});
