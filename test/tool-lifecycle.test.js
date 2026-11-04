'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCodexTranscript,
  parseClaudeTranscript,
  textOnly,
} = require('../lib/agent-transcript');
const call = (id, name, input) => ({
  type: 'response_item',
  payload: { type: 'function_call', call_id: id, name, arguments: input },
});
const result = (id, output) => ({
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: id, output },
});
const rows = (entries) =>
  textOnly(parseCodexTranscript(entries.map(JSON.stringify), { toolTextLimit: 32 }))
    .flatMap((m) => m.blocks)
    .flatMap((b) => b.items || []);
test('部分输出不是结束，等待返回退出码后原命令和等待行一起结束', () => {
  const entries = [
    call('start', 'functions.exec', 'tools.exec_command({cmd:"sleep 2"})'),
    result('start', [
      { type: 'input_text', text: 'Script completed\nOutput:' },
      {
        type: 'input_text',
        text: JSON.stringify({ output: 'x'.repeat(3000), session_id: 42, exit_code: null }),
      },
    ]),
  ];
  assert.equal(rows(entries)[0].running, true);
  entries.push(
    call('wait1', 'functions.write_stdin', '{"session_id":42}'),
    result('wait1', { session_id: 42, output: 'partial' }),
  );
  assert.deepEqual(
    rows(entries).map((t) => t.running),
    [true, true],
  );
  entries.push(call('wait2', 'functions.write_stdin', '{"session_id":42}'));
  assert.deepEqual(
    rows(entries).map((t) => t.running),
    [true, true, true],
  );
  entries.push(result('wait2', { exit_code: 1, output: 'failed' }));
  assert.deepEqual(
    rows(entries).map((t) => t.running),
    [false, false, false],
  );
  assert.ok(rows(entries).every((t) => t.failed));
});
test('cell 等待和 process 等待独立，多个后台命令未全部完成时不打勾', () => {
  const entries = [
    call('start', 'functions.exec', ''),
    result('start', 'Script running with cell ID cell-a'),
    call('cellwait', 'functions.wait', '{"cell_id":"cell-a"}'),
    result('cellwait', [
      { type: 'text', text: 'Script completed\nOutput:' },
      { type: 'text', text: '{"session_id":1,"output":""}\n{"session_id":2,"output":""}' },
    ]),
  ];
  assert.deepEqual(
    rows(entries).map((t) => t.running),
    [true, true],
  );
  entries.push(
    call('w1', 'functions.exec', 'text(await tools.write_stdin({session_id:1}))'),
    result('w1', { exit_code: 0, output: '' }),
  );
  assert.equal(rows(entries)[0].running, true);
  entries.push(
    call('w2', 'functions.write_stdin', '{"session_id":2}'),
    result('w2', { exit_code: 0, output: '' }),
  );
  assert.ok(rows(entries).every((t) => !t.running));
});
test('普通输出里的进程样例不作为运行状态，同一进程号重新使用不污染历史', () => {
  const entries = [
    call('a', 'exec_command', '{}'),
    result('a', { session_id: 42, output: '' }),
    call('w', 'write_stdin', '{"session_id":42}'),
    result('w', { exit_code: 0, output: '{"session_id":999,"output":"example"}' }),
    call('b', 'exec_command', '{}'),
    result('b', { session_id: 42, output: '' }),
  ];
  assert.deepEqual(
    rows(entries).map((t) => t.running),
    [false, false, true],
  );
});
test('Claude 后台命令等待原生 task-notification 后才结束', () => {
  const entries = [
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'sleep 2' } }],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Running in background' }],
      },
      toolUseResult: { backgroundTaskId: 'task-a' },
    },
  ];
  const get = () =>
    textOnly(parseClaudeTranscript(entries.map(JSON.stringify)))[0].blocks[0].items[0];
  assert.equal(get().running, true);
  entries.push({
    type: 'user',
    message: {
      content:
        '<task-notification><task-id>task-a</task-id><status>completed</status></task-notification>',
    },
  });
  assert.equal(get().running, false);
  assert.equal(get().failed, false);
});

test('本轮结束后缺失退出记录不再转圈，也不误报成功；后续等待能恢复并确认状态', () => {
  const entries = [
    call('start', 'exec_command', '{}'),
    result('start', { session_id: 42, output: 'partial' }),
  ];
  assert.equal(rows(entries)[0].running, true);
  entries.push({ type: 'event_msg', payload: { type: 'task_complete' } });
  assert.equal(rows(entries)[0].running, false);
  assert.equal(rows(entries)[0].statusUnknown, true);
  entries.push(call('wait', 'write_stdin', '{"session_id":42}'));
  assert.equal(rows(entries)[0].running, true);
  assert.equal(rows(entries)[0].statusUnknown, false);
  entries.push(result('wait', { exit_code: 0, output: 'done' }));
  assert.equal(rows(entries)[0].running, false);
  assert.equal(rows(entries)[0].statusUnknown, false);
});
test('历史缺失工具结果在明确最终回答后不保持运行状态', () => {
  const entries = [
    call('start', 'exec_command', '{}'),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Done' }],
      },
    },
  ];
  assert.equal(rows(entries)[0].running, false);
  assert.equal(rows(entries)[0].statusUnknown, true);
});
