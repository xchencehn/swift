'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { sendPaneMessage, sendPaneAnswer } = require('../lib/herdr-input');

test('问题自填粘贴使用指定 Herdr socket，不退回调用者的 Session', async (t) => {
  const target = await endpoint(t, () => ({ result: { type: 'input_sent' } }));
  const previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = path.join(path.dirname(target.socketFile), 'wrong-session.sock');
  try {
    await require('../lib/herdr-input').pastePaneText('fixture:p1', '中文自填', {
      socketFile: target.socketFile,
    });
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous;
  }
  assert.deepEqual(
    target.seen.map(({ method, params }) => ({ method, params })),
    [{ method: 'pane.send_input', params: { pane_id: 'fixture:p1', text: '中文自填', keys: [] } }],
  );
});

test('socket 未连接是明确未投递，写入后断线/超时必须是不确定', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketFile = path.join(dir, 'missing.sock');
  await assert.rejects(sendPaneMessage('p', 'text', { socketFile }), { deliveryUncertain: false });
  for (const timeout of [false, true]) {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        if (!timeout) socket.destroy();
      });
      socket.on('error', () => {});
    });
    server.listen(socketFile);
    await once(server, 'listening');
    await assert.rejects(sendPaneMessage('p', 'text', { socketFile, timeoutMs: 40 }), {
      deliveryUncertain: true,
    });
    await new Promise((resolve) => server.close(resolve));
  }
});

async function endpoint(t, respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-submit-'));
  const socketFile = path.join(dir, 'herdr.sock'),
    seen = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.trim());
      seen.push(request);
      socket.end(JSON.stringify({ id: request.id, ...respond(request) }) + '\n');
    });
  });
  server.listen(socketFile);
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { socketFile, seen };
}

test('普通聊天用 agent.prompt 一次提交多行文本，不靠焦点或画面补回车', async (t) => {
  const { socketFile, seen } = await endpoint(t, () => ({
    result: { type: 'agent', agent: { agent_status: 'working' } },
  }));
  await sendPaneMessage('w1:p2', '第一行\n第二行', { socketFile });
  assert.deepEqual(
    seen.map(({ method, params }) => ({ method, params })),
    [{ method: 'agent.prompt', params: { target: 'w1:p2', text: '第一行\n第二行' } }],
  );
});

for (const code of [
  'agent_blocked',
  'agent_not_ready',
  'agent_not_found',
  'agent_not_running',
  'method_not_found',
  'agent_prompt_stalled',
  'timeout',
]) {
  test(`Herdr ${code} 保留投递边界，不降级为 raw input`, async (t) => {
    const { socketFile, seen } = await endpoint(t, () => ({ error: { code, message: code } }));
    await assert.rejects(sendPaneMessage('w1:p2', 'test', { socketFile }), {
      code,
      deliveryUncertain: ['agent_not_running', 'agent_prompt_stalled', 'timeout'].includes(code),
    });
    assert.equal(seen.length, 1);
  });
}

test('已明确回答的问题保留定向粘贴路径，blocked 不走普通 prompt，Enter 只提交一次', async (t) => {
  const { socketFile, seen } = await endpoint(t, (request) => ({
    result:
      request.method === 'pane.read'
        ? { read: { text: '\x1b[0m❯ 自由文本答案\x1b[0m\n' } }
        : { type: 'input_sent' },
  }));
  await sendPaneAnswer('p', '自由文本答案', { socketFile });
  assert.deepEqual(
    seen.map((item) => item.method),
    ['pane.send_input', 'pane.read', 'agent.send_keys'],
  );
  assert.deepEqual(seen.at(-1).params, { target: 'p', keys: ['enter'] });
});

test('问题文本已粘贴后 Agent 消失仍是不确定，不重放文本或 Enter', async (t) => {
  const { socketFile, seen } = await endpoint(t, (request) =>
    request.method === 'agent.send_keys'
      ? { error: { code: 'agent_not_ready', message: 'replaced' } }
      : {
          result:
            request.method === 'pane.read'
              ? { read: { text: '\x1b[0m❯ answer\x1b[0m\n' } }
              : { type: 'input_sent' },
        },
  );
  await assert.rejects(sendPaneAnswer('p', 'answer', { socketFile }), {
    code: 'agent_not_ready',
    deliveryUncertain: true,
  });
  assert.equal(seen.length, 3);
});

test('问题提交前身份复核失败时保留已写入的不确定性，禁止向替换会话按 Enter', async (t) => {
  const { socketFile, seen } = await endpoint(t, (request) => ({
    result:
      request.method === 'pane.read'
        ? { read: { text: '\x1b[0m❯ answer\x1b[0m\n' } }
        : { type: 'input_sent' },
  }));
  await assert.rejects(
    sendPaneAnswer('p', 'answer', {
      socketFile,
      beforeSubmit() {
        throw Object.assign(new Error('session replaced'), { deliveryUncertain: false });
      },
    }),
    { deliveryUncertain: true },
  );
  assert.deepEqual(
    seen.map((item) => item.method),
    ['pane.send_input', 'pane.read'],
  );
});
