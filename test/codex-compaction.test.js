'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  parseCodexTranscript,
  createCodexTranscriptParser,
  textOnly,
} = require('../lib/agent-transcript');
const { effectiveLines } = require('../lib/conversation-state');
const raw = (value) => JSON.stringify(value);
const message = (text) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});
// Codex 0.164.0's persisted ItemCompletedEvent; IDs/texts are fixture values.
const completed = (id = 'compaction-fixture', patch = {}) => ({
  type: 'event_msg',
  timestamp: '2026-10-24T08:48:58.312Z',
  payload: {
    type: 'item_completed',
    thread_id: 'fixture-thread',
    turn_id: 'fixture-turn',
    item: { type: 'ContextCompaction', id },
    started_at_ms: 1792831600594,
    completed_at_ms: 1792831743594,
    ...patch,
  },
});
const checkpoint = {
  type: 'compacted',
  timestamp: '2026-10-24T08:48:58.287Z',
  payload: {
    message: 'INTERNAL SUMMARY MUST NOT BECOME A MESSAGE',
    replacement_history: [{ type: 'message', role: 'user', content: [] }],
  },
};

test('Codex 压缩完成记录按顺序显示原生耗时，压缩前后的消息均保留', () => {
  const messages = textOnly(
    parseCodexTranscript([message('压缩前的消息'), completed(), message('压缩后的消息')].map(raw)),
  );
  assert.deepEqual(
    messages.map((m) => m.blocks[0].text),
    ['压缩前的消息', 'Context compacted · 2m 23s', '压缩后的消息'],
  );
  assert.equal(messages[1].kind, 'compacted');
  assert.equal(messages[1].ts, '2026-10-24T08:48:58.312Z');
  assert.equal(new Set(messages.map((m) => m.id)).size, messages.length);
});

test('压缩检查点与完成事件只显示一条，增量补充耗时不改变 ID 或旧快照', () => {
  const parser = createCodexTranscriptParser();
  parser.write([raw(message('之前')), raw(checkpoint)]);
  const before = parser.snapshot({ shared: true }),
    marker = before.at(-1);
  assert.equal(marker.blocks[0].text, 'Context compacted');
  parser.write([raw(completed())]);
  const after = parser.snapshot({ shared: true });
  assert.equal(after.filter((m) => m.kind === 'compacted').length, 1);
  assert.equal(after.at(-1).id, marker.id);
  assert.equal(after.at(-1).blocks[0].text, 'Context compacted · 2m 23s');
  assert.equal(marker.blocks[0].text, 'Context compacted');
  assert.strictEqual(before[0], after[0]);
  assert(!JSON.stringify(after).includes('INTERNAL SUMMARY'));
  parser.write([
    raw(completed()),
    raw({ type: 'event_msg', payload: { type: 'context_compacted' } }),
  ]);
  assert.equal(parser.snapshot().filter((m) => m.kind === 'compacted').length, 1);
});

test('旧记录没有计时只显示完成状态，无效时间和启动事件不能编造耗时', () => {
  for (const patch of [
    { started_at_ms: undefined },
    { completed_at_ms: 0 },
    { started_at_ms: null },
    { started_at_ms: '1792831600594' },
    { completed_at_ms: -1 },
    { started_at_ms: 200, completed_at_ms: 100 },
    { completed_at_ms: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const result = parseCodexTranscript([raw(completed('older', patch))]);
    assert.equal(result[0].blocks[0].text, 'Context compacted');
  }
  assert.equal(
    parseCodexTranscript([raw(completed('starting', { type: 'item_started' }))]).length,
    0,
  );
  assert.equal(
    parseCodexTranscript([raw({ type: 'compacted', payload: { message: 'internal' } })])[0]
      .blocks[0].text,
    'Context compacted',
  );
  assert.equal(
    parseCodexTranscript([raw({ type: 'event_msg', payload: { type: 'context_compacted' } })])[0]
      .blocks[0].text,
    'Context compacted',
  );
});

test('检查点与完成收据之间的输出以及旧回执重放都不重复新增记录', () => {
  const mixed = [checkpoint, message('完成收据到达前的输出'), completed()];
  const result = parseCodexTranscript(mixed.map(raw));
  assert.equal(result.filter((m) => m.kind === 'compacted').length, 1);
  assert.equal(result[0].blocks[0].text, 'Context compacted · 2m 23s');
  assert.equal(result[1].blocks[0].text, '完成收据到达前的输出');
  const replay = [
    checkpoint,
    completed('first'),
    { ...checkpoint, timestamp: '2026-10-24T09:00:00Z' },
    completed('first'),
    completed('second'),
  ];
  assert.equal(
    parseCodexTranscript(replay.map(raw)).filter((m) => m.kind === 'compacted').length,
    2,
  );
});

test('多次压缩独立显示，事件 ID 防重复且原生回滚移除被回退轮次的记录', () => {
  const events = [
    message('之前'),
    completed('one'),
    completed('one'),
    message('之间'),
    completed('two'),
    message('之后'),
  ];
  assert.equal(
    parseCodexTranscript(events.map(raw)).filter((m) => m.kind === 'compacted').length,
    2,
  );
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'first' } },
    message('保留'),
    completed('first'),
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'second' } },
    message('撤销'),
    completed('second'),
    { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
  ];
  const result = parseCodexTranscript(effectiveLines('codex', records.map(raw)));
  assert.equal(result.filter((m) => m.kind === 'compacted').length, 1);
  assert(!JSON.stringify(result).includes('撤销'));
});

test('原生耗时格式与终端一致，正常消息提及 Context compacted 不被改写', () => {
  for (const [ms, expected] of [
    [0, '0s'],
    [59999, '59s'],
    [60000, '1m 00s'],
    [3601000, '1h 00m 01s'],
  ]) {
    const result = parseCodexTranscript([
      raw(completed('duration', { started_at_ms: 1000, completed_at_ms: 1000 + ms })),
    ]);
    assert.equal(result[0].blocks[0].text, 'Context compacted · ' + expected);
  }
  assert.equal(
    parseCodexTranscript([raw(message('代码里的 Context compacted 仍是正常文本'))])[0].kind,
    undefined,
  );
});
