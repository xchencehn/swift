'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConversationIndex, PAGE_BYTES, TOOLS_PER_MESSAGE } = require('../lib/conversation-index');
const { AsyncConversationStore } = require('../lib/async-conversation-store');
const { parseTranscript, textOnly } = require('../lib/agent-transcript');
const { questionState } = require('../lib/questions/codex');
const json = JSON.stringify,
  lines = (values) => values.map(json).join('\n') + '\n';
const user = (id, text = id) => ({
  type: 'response_item',
  payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] },
});
const event = (type, rest = {}) => ({ type: 'event_msg', payload: { type, ...rest } });
const call = (id, input = 'npm test') => ({
  type: 'response_item',
  payload: { type: 'function_call', call_id: id, name: 'exec_command', arguments: input },
});
const result = (id, output) => ({
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: id, output },
});
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-display-index-'));
  const file = path.join(dir, 'archive.jsonl'),
    cache = path.join(dir, 'index.sqlite');
  let index = new ConversationIndex({ file: cache });
  t.after(() => {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    file,
    dir,
    cache,
    get index() {
      return index;
    },
    restart() {
      index.close();
      index = new ConversationIndex({ file: cache });
      return index;
    },
  };
}
const tools = (page) =>
  page.messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.kind === 'tools')
    .flatMap((block) => block.items);
test('display pages preserve stable IDs and return the contiguous history selected by native IDs', async (t) => {
  const f = setup(t),
    records = Array.from({ length: 140 }, (_, i) => user(`u${i}`));
  fs.writeFileSync(f.file, lines(records));
  const page = await f.index.page(f.file, 'codex');
  assert.equal(page.total, 140);
  assert.equal(page.messages[0].id, 'u80');
  assert(page.hasMore);
  const before = await f.index.page(f.file, 'codex', {
    before: 'u80',
    limit: 40,
    revision: page.historyRevision,
  });
  assert.deepEqual(
    before.messages.map((message) => message.id),
    records.slice(40, 80).map((record) => record.payload.id),
  );
  assert.deepEqual(page.messages, textOnly(parseTranscript('codex', records.map(json))).slice(-60));
  const joined = await f.index.page(f.file, 'codex', { from: 'u40' });
  assert.equal(joined.messages.length, 100);
  const prepare = f.index.db.prepare.bind(f.index.db);
  f.index.db.prepare = (sql) => {
    assert(!/SELECT position,item FROM conversation/.test(sql), '只读状态不应读取正文行');
    return prepare(sql);
  };
  const state = await f.index.page(f.file, 'codex', { from: 'u0', windowless: true });
  assert.equal(state.total, 140);
  assert(!state.messages);
  f.index.db.prepare = prepare;
  await assert.rejects(f.index.page(f.file, 'codex', { before: 'missing' }), {
    code: 'HISTORY_CHANGED',
  });
});
test('appends read only the new byte range and never commit an incomplete UTF-8 record', async (t) => {
  const f = setup(t);
  fs.writeFileSync(f.file, lines([user('old')]));
  const first = await f.index.page(f.file, 'codex'),
    previous = { ...f.index.stats };
  const raw = Buffer.from(lines([user('new', '中文新消息')])),
    split = raw.indexOf(Buffer.from('中')) + 1;
  fs.appendFileSync(f.file, raw.subarray(0, split));
  assert.equal((await f.index.page(f.file, 'codex')).total, 1);
  fs.appendFileSync(f.file, raw.subarray(split));
  const next = await f.index.page(f.file, 'codex');
  assert.equal(next.total, 2);
  assert.equal(next.messages[1].blocks[0].text, '中文新消息');
  assert.equal(first.total, 1);
  assert.notEqual(first.historyRevision, next.historyRevision);
  assert.equal(f.index.stats.rebuilds, previous.rebuilds);
  assert.equal(f.index.stats.bytesRead - previous.bytesRead, split + raw.length);
  await assert.rejects(
    f.index.page(f.file, 'codex', { before: 'new', revision: first.historyRevision }),
    { code: 'HISTORY_CHANGED' },
  );
  const older = await f.index.page(f.file, 'codex', {
    before: 'new',
    revision: first.historyRevision,
    historyEpoch: first.historyEpoch,
  });
  assert.deepEqual(
    older.messages.map((message) => message.id),
    ['old'],
    'append-only changes cannot invalidate a stable older-history anchor',
  );
});
test('persisted projections and parser checkpoints survive restart without a full native reread', async (t) => {
  const f = setup(t);
  fs.writeFileSync(
    f.file,
    lines([
      user('old'),
      call('background'),
      result('background', { session_id: 71, output: 'running' }),
    ]),
  );
  await f.index.page(f.file, 'codex');
  f.restart();
  const cached = await f.index.page(f.file, 'codex');
  assert.equal(f.index.stats.bytesRead, 0);
  assert.equal(tools(cached)[0].running, true);
  const append = lines([
    call('wait', '{"session_id":71}'),
    result('wait', { session_id: 71, exit_code: 2, output: 'finished' }),
  ]);
  fs.appendFileSync(f.file, append);
  const next = await f.index.page(f.file, 'codex');
  assert.equal(f.index.stats.bytesRead, Buffer.byteLength(append));
  assert.equal(tools(next)[0].running, false);
  assert.equal(tools(next)[0].failed, true);
  assert.equal(tools(cached)[0].running, true);
});
test('evicted conversation checkpoints resume after appends without rereading old records', async (t) => {
  const f = setup(t);
  fs.writeFileSync(f.file, lines([user('original')]));
  await f.index.page(f.file, 'codex');
  for (let i = 0; i < 5; i++) {
    const other = path.join(f.dir, `other-${i}.jsonl`);
    fs.writeFileSync(other, lines([user(`other-${i}`)]));
    await f.index.page(other, 'codex');
  }
  const before = f.index.stats.bytesRead,
    append = lines([user('new')]);
  fs.appendFileSync(f.file, append);
  assert.deepEqual(
    (await f.index.page(f.file, 'codex')).messages.map((message) => message.id),
    ['original', 'new'],
  );
  assert.equal(f.index.stats.bytesRead - before, Buffer.byteLength(append));
});
test('paginated Codex history retains parent IDs and invalidates a changed ancestor', async (t) => {
  const f = setup(t),
    id = '11111111-1111-4111-8111-111111111111',
    branch = '22222222-2222-4222-8222-222222222222';
  const dir = path.join(f.dir, 'sessions/2026/10/28');
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, `rollout-2026-10-28T01-02-03-${id}.jsonl`),
    b = path.join(dir, `rollout-2026-10-28T01-02-04-${id}_${branch}.jsonl`);
  const meta = (base) => ({
    ordinal: base?.end_ordinal_exclusive || 0,
    type: 'session_meta',
    payload: { id, history_mode: 'paginated', ...(base ? { history_base: base } : {}) },
  });
  const first = { ...user('inherited', 'original'), ordinal: 1 };
  const prefix = lines([meta(), first]);
  fs.writeFileSync(a, prefix + lines([{ ...user('discarded'), ordinal: 2 }]));
  fs.writeFileSync(
    b,
    lines([
      meta({ thread_id: id, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(prefix) }),
      { ...user('edited'), ordinal: 3 },
    ]),
  );
  assert.deepEqual(
    (await f.index.page(b, 'codex')).messages.map((message) => message.id),
    ['inherited', 'edited'],
  );
  fs.writeFileSync(
    a,
    lines([
      meta(),
      {
        ...first,
        payload: { ...first.payload, content: [{ type: 'input_text', text: 'replaced' }] },
      },
    ]) + lines([{ ...user('discarded'), ordinal: 2 }]),
  );
  assert.equal((await f.index.page(b, 'codex')).messages[0].blocks[0].text, 'replaced');
});
test('same-length rewrites, inode changes, truncation and rollback invalidate old pages and preserve receipt membership', async (t) => {
  const f = setup(t),
    records = [
      event('task_started', { turn_id: 't1' }),
      user('u1'),
      event('task_complete'),
      event('task_started', { turn_id: 't2' }),
      user('u2'),
    ];
  fs.writeFileSync(f.file, lines(records));
  const first = await f.index.page(f.file, 'codex');
  fs.appendFileSync(f.file, lines([event('thread_rolled_back', { num_turns: 1 })]));
  const rollback = await f.index.page(f.file, 'codex', { receiptIds: ['u1', 'u2'] });
  assert.deepEqual(
    rollback.messages.map((message) => message.id),
    ['u1'],
  );
  assert(rollback.receipts.archive.ids.has('u2'));
  assert(!rollback.receipts.archive.activeIds.has('u2'));
  assert(rollback.historyEpoch > first.historyEpoch);
  await assert.rejects(
    f.index.page(f.file, 'codex', { before: 'u1', historyEpoch: first.historyEpoch }),
    { code: 'HISTORY_CHANGED' },
  );
  fs.appendFileSync(
    f.file,
    lines([event('thread_rolled_back', { num_turns: 0 })]) + json(user('u3')),
  );
  assert.equal(
    (await f.index.page(f.file, 'codex')).total,
    1,
    'a branch rebuild must not commit a valid but unterminated last record',
  );
  fs.appendFileSync(f.file, '\n');
  assert.equal((await f.index.page(f.file, 'codex')).total, 2);
  fs.writeFileSync(f.file, lines([user('x1')]));
  const rewrite = await f.index.page(f.file, 'codex');
  fs.writeFileSync(f.file, lines([user('y1')]));
  assert.notEqual((await f.index.page(f.file, 'codex')).historyRevision, rewrite.historyRevision);
  fs.renameSync(f.file, f.file + '.old');
  fs.writeFileSync(f.file, lines([user('z1')]));
  assert.equal((await f.index.page(f.file, 'codex')).messages[0].id, 'z1');
});
test('Claude tool results, background completion, branch changes, model and native questions remain canonical', async (t) => {
  const f = setup(t),
    records = [
      { type: 'user', uuid: 'u', parentUuid: null, message: { content: 'hello' } },
      {
        type: 'assistant',
        uuid: 'a',
        parentUuid: 'u',
        message: {
          model: 'claude-test',
          content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'test' } }],
        },
      },
      {
        type: 'user',
        uuid: 'r',
        parentUuid: 'a',
        toolUseResult: { backgroundTaskId: 'bg' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'background' }] },
      },
    ];
  fs.writeFileSync(f.file, lines(records));
  assert.equal(tools(await f.index.page(f.file, 'claude'))[0].running, true);
  f.restart();
  const done = {
    type: 'user',
    uuid: 'done',
    parentUuid: 'r',
    message: {
      content:
        '<task-notification><task-id>bg</task-id><status>completed</status></task-notification>',
    },
  };
  fs.appendFileSync(f.file, lines([done]));
  const complete = await f.index.page(f.file, 'claude');
  assert.equal(tools(complete)[0].running, false);
  assert.equal(complete.status.model, 'claude-test');
  fs.appendFileSync(
    f.file,
    lines([
      {
        type: 'assistant',
        uuid: 'branch',
        parentUuid: 'u',
        message: { content: [{ type: 'text', text: 'new branch' }] },
      },
    ]),
  );
  const branch = await f.index.page(f.file, 'claude');
  assert.deepEqual(
    branch.messages.map((message) => message.id),
    ['u', 'branch'],
  );
  assert(!tools(branch).length);
});
test('control observations return question receipts and settings without raw tool output', async (t) => {
  const f = setup(t),
    ask = {
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'ask',
        name: 'request_user_input_async',
        arguments: json({ questions: [{ title: 'Choose', options: ['one', 'two'] }] }),
      },
    };
  const records = [
    { type: 'turn_context', payload: { model: 'gpt-test', effort: 'high', cwd: '/project' } },
    user('u'),
    call('large'),
    result('large', 'UNRELATED_OUTPUT'.repeat(2000)),
    ask,
    result('ask', '{"accepted":true}'),
  ];
  fs.writeFileSync(f.file, lines(records));
  const page = await f.index.page(f.file, 'codex', { windowless: true, controls: true });
  assert(!page.messages);
  assert.equal(page.status.model, 'gpt-test');
  assert.deepEqual(page.questionState, questionState(records.map(json)));
  assert(!json(page).includes('UNRELATED_OUTPUT'));
  assert.equal(page.questionState.pending.id, 'ask');
});
test('a single hours-long tool run has bounded message groups and a byte-budgeted page without lost calls', async (t) => {
  const f = setup(t),
    records = [user('u')];
  for (let i = 0; i < 180; i++)
    records.push(call(`t${i}`, 'x'.repeat(1800)), result(`t${i}`, 'y'.repeat(4096)));
  fs.writeFileSync(f.file, lines(records));
  let page = await f.index.page(f.file, 'codex'),
    all = tools(page);
  assert(Buffer.byteLength(json(page.messages)) < PAGE_BYTES + 4096);
  assert(
    page.messages.every((message) =>
      message.blocks
        .filter((block) => block.kind === 'tools')
        .every((block) => block.items.length <= TOOLS_PER_MESSAGE),
    ),
  );
  while (page.hasMore) {
    page = await f.index.page(f.file, 'codex', { before: page.messages[0].id });
    all = tools(page).concat(all);
  }
  assert.deepEqual(
    all.map((tool) => tool.id),
    Array.from({ length: 180 }, (_, i) => `t${i}`),
  );
});
test('worker page transport returns one page without using the full-history worker', async (t) => {
  const f = setup(t),
    store = new AsyncConversationStore({ indexFile: f.cache + '.worker' });
  t.after(() => store.close());
  fs.writeFileSync(
    f.file,
    lines(Array.from({ length: 500 }, (_, i) => user(`u${i}`, 'body'.repeat(200)))),
  );
  const page = await store.page(f.file, 'codex', { limit: 5 });
  assert.equal(page.messages.length, 5);
  assert.equal(page.total, 500);
  assert.equal(store.reads.size, 0, 'a display page must not use the legacy full-history worker');
});

test('tool preview extracts readable output before raw clipping and persists across restarts', async (t) => {
  const f = setup(t);
  const raw = JSON.stringify([
    { type: 'input_text', text: 'Script completed\nWall time 1 seconds\nOutput:\n' },
    {
      type: 'input_text',
      text: JSON.stringify({
        exit_code: 1,
        output: 'source code\n'.repeat(700) + 'ERROR: connection refused\nTotals: 1 failed',
      }),
    },
  ]);
  fs.writeFileSync(f.file, lines([user('question'), call('large'), result('large', raw)]));
  const first = await f.index.page(f.file, 'codex'),
    item = tools(first)[0];
  assert(item.result.truncated);
  assert(item.result.text.length <= 512);
  assert.match(item.result.preview, /ERROR: connection refused/);
  assert.match(item.result.preview, /退出码：1/);
  assert.doesNotMatch(item.result.preview, /input_text|wall_time_seconds/);
  assert(item.result.preview.length < 3000);
  f.restart();
  const restored = tools(await f.index.page(f.file, 'codex'))[0];
  assert.equal(f.index.stats.bytesRead, 0);
  assert.equal(restored.result.preview, item.result.preview);
});

test('message navigation returns bounded user previews and loads a target window without reading the journal again', async (t) => {
  const f = setup(t);
  fs.writeFileSync(
    f.file,
    lines(Array.from({ length: 140 }, (_, i) => user('nav-' + i, '问题' + i + '长'.repeat(900)))),
  );
  const tail = await f.index.page(f.file, 'codex');
  const bytes = f.index.stats.bytesRead;
  const outline = await f.index.page(f.file, 'codex', { navigation: true });
  assert.equal(outline.navigation.length, 140);
  assert.equal(outline.navigation[0].id, 'nav-0');
  assert(outline.navigation.every((m) => m.text.length <= 640));
  assert.deepEqual(outline.messages, []);
  const target = await f.index.page(f.file, 'codex', {
    around: 'nav-2',
    limit: 20,
    historyEpoch: tail.historyEpoch,
  });
  assert(target.messages.some((m) => m.id === 'nav-2'));
  assert(target.messages.length <= 20);
  assert.equal(f.index.stats.bytesRead, bytes);
  await assert.rejects(f.index.page(f.file, 'codex', { around: 'missing' }), {
    code: 'HISTORY_CHANGED',
  });
});

test('a jump near the end retains its target even when preceding messages exceed the page byte budget', async (t) => {
  const f = setup(t);
  fs.writeFileSync(
    f.file,
    lines(Array.from({ length: 20 }, (_, i) => user('large-' + i, '内容'.repeat(20000)))),
  );
  const target = await f.index.page(f.file, 'codex', { around: 'large-19' });
  assert.deepEqual(
    target.messages.map((m) => m.id),
    ['large-19'],
  );
});
