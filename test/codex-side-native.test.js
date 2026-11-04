'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { messages } = require('../lib/codex-side-native');
test('native side projection removes inherited context and hidden boundary, and preserves stable real item ids', () => {
  const result = messages({
    id: 'side',
    turns: [
      {
        id: 't1',
        items: [
          {
            type: 'userMessage',
            id: 'main',
            content: [{ type: 'text', text: 'private inherited prompt' }],
          },
          {
            type: 'userMessage',
            id: 'boundary',
            content: [{ type: 'text', text: 'Side conversation boundary.\nPolicy' }],
          },
          { type: 'userMessage', id: 'u', content: [{ type: 'text', text: '真正的临时问题' }] },
          { type: 'reasoning', id: 'r', summary: ['思考'], content: [] },
          { type: 'agentMessage', id: 'a', text: '临时回答' },
          {
            type: 'commandExecution',
            id: 'tool',
            command: 'pwd',
            status: 'completed',
            aggregatedOutput: '/test',
            exitCode: 0,
          },
        ],
      },
    ],
  });
  assert.equal(result.length, 4);
  assert.equal(result[0].blocks[0].text, '真正的临时问题');
  assert.equal(result[0].id, 'side:t1:u');
  assert.equal(result[1].blocks[0].kind, 'thinking');
  assert.equal(result[3].blocks[0].name, 'exec_command');
  assert.equal(result[3].blocks[0].result.text, '/test');
  assert(!JSON.stringify(result).includes('private inherited'));
});
test('same-process native IPC coalesces readonly requests and decodes fragmented Unicode', async (t) => {
  const fs = require('node:fs/promises'),
    net = require('node:net');
  const { processStart } = require('../lib/codex-restart');
  const { request } = require('../lib/codex-side-native');
  const runtimeId = await processStart(process.pid),
    socketPath = `/tmp/swift-codex-${runtimeId.replace(':', '-')}.sock`;
  let calls = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('\n')) return;
      calls++;
      const body = JSON.parse(input);
      const bytes = Buffer.from(
        JSON.stringify({
          version: 1,
          mainId: body.mainId,
          sideId: 'side',
          data: { text: '中文临时回答' },
        }) + '\n',
      );
      // Deliberately divide a UTF-8 code point at the transport boundary.
      const at = bytes.indexOf(Buffer.from('中')) + 1;
      socket.write(bytes.subarray(0, at));
      setTimeout(() => socket.end(bytes.subarray(at)), 10);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  await fs.chmod(socketPath, 0o600);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(socketPath, { force: true });
  });
  const pane = { runtimeId, agent: { session: { value: 'main' } } };
  const result = await Promise.all([request(pane), request(pane)]);
  assert.equal(calls, 1);
  assert.equal(result[0].data.text, '中文临时回答');
  assert.deepEqual(result[0], result[1]);
});
test('live side raw response items use the existing transcript parser for tools and Unicode', () => {
  const result = messages({
    id: 'side',
    extra: {
      swiftSideItems: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '临时问题\n第二行' }],
        },
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
        },
        { type: 'function_call_output', call_id: 'call-1', output: '/fixture/project' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '临时回答' }],
        },
      ],
    },
  });
  assert.equal(result[0].blocks[0].text, '临时问题\n第二行');
  const tool = result.flatMap((message) => message.blocks).find((block) => block.kind === 'tool');
  assert.equal(tool.id, 'call-1');
  assert.equal(tool.name, 'exec_command');
  assert.equal(tool.result.text, '/fixture/project');
  assert(result.every((message) => message.id.startsWith('side:')));
  assert.deepEqual(
    messages({
      id: 'side',
      extra: { swiftSideItems: [] },
      turns: [{ items: [{ type: 'agentMessage', text: 'inherited' }] }],
    }),
    [],
  );
});
test('side tool details can recover full output from the same native items', () => {
  const output = '真实工具输出'.repeat(1000),
    thread = {
      id: 'side',
      extra: {
        swiftSideItems: [
          {
            type: 'function_call',
            call_id: 'long-tool',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
          { type: 'function_call_output', call_id: 'long-tool', output },
        ],
      },
    };
  const tool = (options) =>
    messages(thread, options)
      .flatMap((message) => message.blocks)
      .find((block) => block.kind === 'tool');
  assert(tool().result.truncated);
  assert.equal(tool({ toolTextLimit: Infinity }).result.text, output);
});
