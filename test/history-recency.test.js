'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { lastUtterance, reverseLines } = require('../lib/history-recency');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-recency-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'session.jsonl');
}
test('倒序读取保留跨块中文和长行，跳过最后发言后的工具记录', async (t) => {
  const file = await fixture(t),
    at = '2026-09-20T01:00:00Z';
  const lines = [
    JSON.stringify({
      type: 'assistant',
      uuid: 'a',
      parentUuid: null,
      timestamp: at,
      message: { role: 'assistant', content: [{ type: 'text', text: '中文'.repeat(40000) }] },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'tool',
      parentUuid: 'a',
      timestamp: '2026-09-20T02:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(200000) }],
      },
    }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n');
  const reverse = [];
  for await (const line of reverseLines(file)) if (line) reverse.push(line);
  assert.deepEqual(reverse, [...lines].reverse());
  assert.equal(await lastUtterance(file, 'claude'), Date.parse(at));
});
test('末尾 Codex 回滚必须使用有效历史时间，不能使用删除轮次和文件修改时间', async (t) => {
  const file = await fixture(t),
    at = '2026-09-20T01:00:00Z';
  const turn = (id, timestamp) => [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
    {
      type: 'response_item',
      timestamp,
      payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text: id }] },
    },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  await fs.writeFile(
    file,
    [
      ...turn('a', at),
      ...turn('b', '2026-09-20T02:00:00Z'),
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    ]
      .map(JSON.stringify)
      .join('\n'),
  );
  assert.equal(await lastUtterance(file, 'codex'), Date.parse(at));
});
