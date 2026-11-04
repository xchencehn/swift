'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  effectiveLines,
  historyWindow,
  binding,
  assertIdentity,
  archiveIndex,
} = require('../lib/conversation-state');
const { parseTranscript, textOnly } = require('../lib/agent-transcript');
const { MessageQueue } = require('../lib/message-queue');
const { elapsedTime } = require('../public/ui-model');
const encode = (values) => values.map(JSON.stringify);
const user = (text, id) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text }] },
});
const start = (id) => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } });
const done = { type: 'event_msg', payload: { type: 'task_complete' } };
const rollback = (n) => ({
  type: 'event_msg',
  payload: { type: 'thread_rolled_back', num_turns: n },
});
test('Codex 回滚多个轮次、回空和新分支不会复活消息与工具', () => {
  const original = [
    start('a'),
    user('first', 'a'),
    done,
    start('b'),
    user('removed', 'b'),
    {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'old-tool', name: 'exec', arguments: 'old' },
    },
    done,
  ];
  const rolled = encode([...original, rollback(1)]);
  assert.deepEqual(
    textOnly(parseTranscript('codex', rolled)).map((m) => m.id),
    ['a'],
  );
  const branch = parseTranscript(
    'codex',
    encode([...original, rollback(1), start('c'), user('new', 'c'), done]),
  );
  assert.deepEqual(
    branch.map((m) => m.id),
    ['a', 'c'],
  );
  assert.deepEqual(parseTranscript('codex', encode([...original, rollback(2)])), []);
});
test('Claude 选择当前父链，排除旧分支和 sidechain，保留同链工具回传', () => {
  const entry = (uuid, parentUuid, text) => ({
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content: text },
  });
  const lines = encode([
    entry('a', null, 'first'),
    entry('b', 'a', 'old'),
    entry('c', 'a', 'new'),
    { ...entry('side', 'b', 'side'), isSidechain: true },
  ]);
  assert.deepEqual(
    parseTranscript('claude', lines).map((m) => m.id),
    ['a', 'c'],
  );
});
test('60→200 后的刷新范围连续；回滚为空；失效分页拒绝；消息 ID 不随删除重用', () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({
    id: `m${i}`,
    role: 'user',
    blocks: [{ kind: 'text', text: String(i) }],
  }));
  assert.equal(historyWindow(messages, { from: 'm0' }).messages.length, 200);
  const page = historyWindow(messages.slice(0, 60));
  assert.throws(() => historyWindow(messages, { before: 'm30', revision: page.historyRevision }), {
    code: 'HISTORY_CHANGED',
  });
  assert.deepEqual(historyWindow([], { from: 'm0' }).messages, []);
  const old = parseTranscript('codex', encode([user('old')]));
  const next = parseTranscript('codex', encode([user('new')]));
  assert.notEqual(old[0].id, next[0].id);
});
test('会话和 terminal 替换使旧控制身份失效', () => {
  const pane = { paneId: 'p', terminalId: 't', agent: { label: 'codex', session: { value: 's' } } };
  const expected = { binding: binding(pane) };
  assertIdentity(pane, expected, true);
  assert.throws(() => assertIdentity({ ...pane, terminalId: 'new' }, expected, true), {
    code: 'SESSION_CHANGED',
  });
  assert.throws(() => assertIdentity(pane, {}, true), { code: 'IDENTITY_REQUIRED' });
});
test('停止后重发相同文本，通过 native client_id 确认第二次，不认领第一次', async () => {
  const pane = {
    paneId: 'p',
    terminalId: 't',
    status: 'idle',
    agent: { label: 'codex', session: { value: 's' } },
  };
  const messages = [],
    operations = [];
  const queue = new MessageQueue({
    file: null,
    getPane: async () => pane,
    readMessages: async () => messages,
    send: async (_pane, _text, id) => {
      operations.push(id);
      return { nativeUserMessageId: id, nativeTurnId: 'turn' };
    },
  });
  await queue.submit({ id: 'first', paneId: 'p', text: 'same' });
  queue.interrupted(pane);
  await queue.submit({ id: 'second', paneId: 'p', text: 'same' });
  messages.push(
    ...parseTranscript(
      'codex',
      encode([
        user('same', 'native-message'),
        {
          type: 'event_msg',
          payload: { type: 'user_message', client_id: operations[1], message: 'same' },
        },
      ]),
    ),
  );
  await queue.tick();
  const [a, b] = queue.list('p');
  assert.equal(a.status, 'failed');
  assert.equal(b.status, 'consumed');
  assert.equal(b.consumedMessageId, 'native-message');
});
test('PTY 相同文本跨停止边界时保持未知，不猜测回执', async () => {
  const pane = {
    paneId: 'p',
    terminalId: 't',
    status: 'idle',
    agent: { label: 'claude', session: { value: 's' } },
  };
  const messages = [];
  const queue = new MessageQueue({
    file: null,
    getPane: async () => pane,
    readMessages: async () => messages,
    send: async () => {},
  });
  await queue.submit({ id: 'first', paneId: 'p', text: 'same' });
  queue.interrupted(pane);
  await queue.submit({ id: 'second', paneId: 'p', text: 'same' });
  messages.push({
    id: 'unknown-receipt',
    role: 'user',
    ts: new Date().toISOString(),
    blocks: [{ kind: 'text', text: 'same' }],
  });
  await queue.tick();
  assert.equal(queue.list('p')[1].status, 'sending');
});
test('历史时间按天和小时显示，只有不足一小时显示分钟', () => {
  const now = 1e12;
  assert.equal(elapsedTime(now - 27 * 3600000, now), '1d 3h');
  assert.equal(elapsedTime(now - 119 * 60000, now), '1h');
  assert.equal(elapsedTime(now - 59 * 60000, now), '59min');
});

test('真实 Codex 与 Claude 本地模型存档固定原生字段和分支行为', () => {
  const fs = require('node:fs'),
    path = require('node:path');
  const read = (name) =>
    fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n');
  const codex = parseTranscript('codex', read('codex-native-rollback.jsonl'));
  assert.equal(codex.filter((m) => m.role === 'user').length, 2);
  assert.deepEqual(
    codex.filter((m) => m.role === 'user').map((m) => m.operationId),
    ['probe-operation-1', 'probe-operation-2'],
  );
  const claude = JSON.stringify(parseTranscript('claude', read('claude-native-branch.jsonl')));
  assert(claude.includes('NATIVE_CLAUDE_NEW_BRANCH'));
  assert(!claude.includes('NATIVE_CLAUDE_USER_2'));
  assert(!claude.includes('NATIVE_CLAUDE_USER_3'));
});
test('停止暂停待发队列，新发送独立执行，旧消息只能手动恢复', async () => {
  // blocked 的目标发不出去,消息因此留在队列里 —— 这正是「停止」要暂停的那一批。
  const pane = {
    paneId: 'p',
    terminalId: 't',
    status: 'blocked',
    agent: { label: 'claude', session: { value: 's' } },
  };
  const calls = [];
  const queue = new MessageQueue({
    file: null,
    getPane: async () => pane,
    readMessages: async () => [],
    send: async (_, text) => calls.push(text),
  });
  await queue.submit({ id: 'old', paneId: 'p', text: 'old' });
  queue.interrupted(pane);
  pane.status = 'idle';
  await queue.submit({ id: 'new', paneId: 'p', text: 'new' });
  assert.deepEqual(calls, ['new']);
  assert.equal(queue.list('p')[0].paused, true);
  await queue.deliver({ paneId: 'p', id: 'old', sessionId: 's' });
  await queue.tick();
  assert.deepEqual(calls, ['new', 'old']);
});
test('原始存档索引包含弃用分支，支持原生 ID 和无 ID 的 Codex 消息', () => {
  const claude = encode([
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '第一问' } },
    {
      type: 'attachment',
      uuid: 'a1',
      parentUuid: 'u1',
      attachment: { type: 'queued_command', prompt: '运行中补的一句' },
    },
    {
      type: 'assistant',
      uuid: 'r1',
      parentUuid: 'a1',
      message: { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'r1',
      message: { role: 'user', content: '没答就被回退掉的第二问' },
    },
    {
      type: 'user',
      uuid: 'u3',
      parentUuid: 'r1',
      message: { role: 'user', content: '回退后的新分支' },
    },
  ]);
  const index = archiveIndex(claude);
  assert.ok(
    ['u1', 'a1', 'r1', 'u2', 'u3'].every((id) => index.ids.has(id)),
    '原始行里的记录一个都不少',
  );
  const codex = encode([
    start('t1'),
    user('第一问', 'm1'),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        id: 'm1r',
        content: [{ type: 'output_text', text: '答' }],
      },
    },
    done,
    start('t2'),
    user('回滚掉的第二问', 'm2'),
    rollback(1),
    start('t3'),
    user('新分支', 'm3'),
    done,
  ]);
  const codexIndex = archiveIndex(codex);
  assert.ok(['m1', 'm1r', 'm2', 'm3'].every((id) => codexIndex.ids.has(id)));
  const legacy = encode([user('没有原生 ID')]);
  const message = parseTranscript('codex', legacy)[0];
  assert.ok(archiveIndex(legacy).ids.has(message.id), '索引和正文必须使用相同的稳定 ID');
});
