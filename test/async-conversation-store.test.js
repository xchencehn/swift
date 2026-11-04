'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncConversationStore } = require('../lib/async-conversation-store');
const { ConversationStore } = require('../lib/conversation-store');
const record = (id, text) =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] },
  }) + '\n';
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-worker-')),
    file = path.join(dir, 'session.jsonl');
  const store = new AsyncConversationStore(options);
  t.after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, store };
}
test('worker projections preserve append, partial lines, rewrites, native source and control fields', async (t) => {
  const { file, store } = setup(t);
  fs.writeFileSync(file, record('a', '附件：a.png\n文件路径："/tmp/a.png"'));
  const a = await store.read(file, 'codex');
  const expected = await new ConversationStore().read(file, 'codex');
  for (const field of ['conversation', 'archive', 'turnId', 'turnIds', 'status', 'goal'])
    assert.deepEqual(a[field], expected[field]);
  assert.deepEqual((await store.read(file, 'codex', ['images'])).images, expected.images);
  assert.equal(a.messages[0].source, expected.messages[0].source);
  assert.equal(await store.read(file, 'codex'), a);
  fs.appendFileSync(file, record('b', 'new'));
  assert.equal((await store.read(file, 'codex', ['conversation'])).conversation.length, 2);
  assert.equal(a.conversation.length, 1);
  fs.appendFileSync(file, '{"type":');
  await store.read(file, 'codex');
  fs.writeFileSync(file, record('c', 'rewritten'));
  const rewritten = await store.read(file, 'codex');
  assert.equal(rewritten.conversation.length, 1);
  assert.match(JSON.stringify(rewritten.conversation), /rewritten/);
  assert.deepEqual((await store.read(file, 'codex', ['lines'])).lines, [
    record('c', 'rewritten').trim(),
  ]);
});
test('cold archive parsing allows network input while the worker is busy', async (t) => {
  const { file, store } = setup(t);
  fs.writeFileSync(
    file,
    Array.from({ length: 3000 }, (_, i) => record('u' + i, 'x'.repeat(500))).join(''),
  );
  const net = require('node:net'),
    { once } = require('node:events');
  const server = net.createServer((socket) => socket.end('accepted'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  let reading = true,
    acceptedDuringRead = false;
  const pending = store.read(file, 'codex', ['conversation']).finally(() => {
    reading = false;
  });
  const socket = net.createConnection(server.address().port, '127.0.0.1');
  socket.on('data', () => {
    acceptedDuringRead = reading;
  });
  await once(socket, 'close');
  await pending;
  assert(acceptedDuringRead, 'archive work must not prevent the input socket from being serviced');
});
test('failed archive worker rejects pending reads and can recover without replaying input', async (t) => {
  const { file, store } = setup(t);
  fs.writeFileSync(file, record('a', 'ok'));
  await store.read(file, 'codex');
  const worker = store.worker;
  await worker.terminate();
  fs.appendFileSync(file, record('b', 'after restart'));
  assert.equal((await store.read(file, 'codex')).conversation.length, 2);
  await assert.rejects(store.read(file + '.missing', 'codex'), { code: 'ENOENT' });
});
test('an interrupted pending projection rebuilds its worker once and returns the read without changing the archive', async (t) => {
  const failures = [],
    { file, store } = setup(t, { onFailure: (value) => failures.push(value) });
  const content = record('retry-read', 'preserve this native archive');
  fs.writeFileSync(file, content);
  const start = store.start.bind(store);
  let starts = 0;
  store.start = () => {
    const worker = start();
    if (++starts === 1) queueMicrotask(() => worker.terminate());
    return worker;
  };
  assert.equal((await store.read(file, 'codex', ['conversation'])).conversation.length, 1);
  assert.equal(starts, 2);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].pendingReads, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});
test('repeated worker interruption stops after one retry and a diagnostic callback cannot block rejection', async (t) => {
  const { file, store } = setup(t, {
    onFailure: () => {
      throw Error('diagnostic unavailable');
    },
  });
  fs.writeFileSync(file, record('bounded-read', 'unchanged'));
  const start = store.start.bind(store);
  let starts = 0;
  store.start = () => {
    const worker = start();
    starts++;
    queueMicrotask(() => worker.terminate());
    return worker;
  };
  await assert.rejects(store.read(file, 'codex'), { code: 'ARCHIVE_WORKER_FAILED' });
  assert.equal(starts, 2);
  assert.equal(store.reads.size, 0);
  assert.equal(store.inflight.size, 0);
});
test('intentional shutdown rejects an active projection without restarting a worker or reporting a failure', async (t) => {
  const failures = [],
    { file, store } = setup(t, { onFailure: (value) => failures.push(value) });
  fs.writeFileSync(file, record('shutdown-read', 'unchanged'));
  const start = store.start.bind(store);
  let started,
    starts = 0;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  store.start = () => {
    starts++;
    const worker = start();
    started();
    return worker;
  };
  const pending = store.read(file, 'codex');
  pending.catch(() => {});
  await ready;
  await store.close();
  await assert.rejects(pending, { code: 'ARCHIVE_WORKER_FAILED' });
  await assert.rejects(store.read(file, 'codex'), { code: 'ARCHIVE_STORE_CLOSED' });
  assert.equal(starts, 1);
  assert.deepEqual(failures, []);
});
test('worker control projections equal the existing archive parsers', async (t) => {
  const { file, store } = setup(t);
  const context =
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test', effort: 'high' } }) + '\n';
  const question =
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input_async',
        call_id: 'ask-1',
        arguments: JSON.stringify({
          questions: [{ title: 'Which option?', options: ['one', 'two'] }],
        }),
      },
    }) + '\n';
  fs.writeFileSync(file, record('a', 'hello') + context + question);
  const result = await store.read(file, 'codex', ['archivedSettings', 'pendingQuestion']);
  const lines = (await new ConversationStore().read(file, 'codex')).lines;
  assert.deepEqual(
    result.archivedSettings,
    require('../lib/agent-settings').archivedSettings('codex', lines),
  );
  assert.deepEqual(
    result.pendingQuestion,
    require('../lib/agent-questions').pendingQuestion('codex', lines),
  );
  assert.equal(result.pendingQuestion.id, 'ask-1');
});
