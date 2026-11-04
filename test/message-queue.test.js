'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MessageQueue } = require('../lib/message-queue');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = {
    pane: {
      paneId: 'w1:p1',
      terminalId: 'term1',
      status: 'working',
      agent: { label: 'codex', session: { value: 'session1' } },
    },
    messages: [],
    calls: [],
    time: 1000,
  };
  const options = {
    file: path.join(dir, 'queue.json'),
    getPane: async () => structuredClone(state.pane),
    readMessages: async () => structuredClone(state.messages),
    send: async (pane, text) => {
      state.calls.push({ paneId: pane.paneId, text });
    },
    readArchive: async () =>
      state.archivedIds === null
        ? null
        : {
            ids: new Set(state.archivedIds ?? state.messages.map((m) => m.id)),
            activeIds: new Set(state.messages.map((m) => m.id)),
          },
    now: () => state.time,
    acknowledgementMs: 100,
  };
  const queue = new MessageQueue(options);
  const add = (id, text = id, retry = false) => queue.enqueue({ id, paneId: 'w1:p1', text, retry });
  const consume = (text) =>
    state.messages.push({
      id: `user-${state.messages.length}`,
      role: 'user',
      blocks: [{ kind: 'text', text }],
    });
  return { queue, options, state, add, consume };
}

test('side 打开后发往主会话的消息通过原生 item_completed 解除等待确认，重启后不重复发送', async (t) => {
  const { parseCodexTranscript } = require('../lib/agent-transcript');
  const { visibleOutbox } = require('../public/ui-model');
  const { queue, options, state } = setup(t);
  const lines = fs
    .readFileSync(path.join(__dirname, 'fixtures/codex-native-steer-receipt.jsonl'), 'utf8')
    .trim()
    .split('\n');
  state.pane.status = 'idle';
  options.send = queue.send = async () => {
    state.calls.push('send');
    return { nativeUserMessageId: 'send-operation', nativeTurnId: 'parent-turn' };
  };
  await queue.submit({ id: 'side-summary', paneId: 'w1:p1', text: 'SIDE_RECEIPT_PROMPT' });
  state.messages = parseCodexTranscript(lines.slice(0, 1));
  state.time += 200;
  await queue.tick();
  assert.equal(queue.items[0].error.code, 'ACK_TIMEOUT');
  const restarted = new MessageQueue(options);
  state.messages = parseCodexTranscript(lines);
  await restarted.tick();
  const item = restarted.list('w1:p1')[0];
  assert.equal(item.status, 'consumed');
  assert.equal(item.consumedMessageId, 'archive-message');
  assert.equal(item.deliveryUncertain, false);
  assert.deepEqual(visibleOutbox([item], state.messages), []);
  await restarted.submit({ id: 'side-summary', paneId: 'w1:p1', text: 'SIDE_RECEIPT_PROMPT' });
  assert.equal(state.calls.length, 1);
});

test('Claude 运行中补充消息的存档解除 ACK_TIMEOUT，重启后不会重发或留在底部', async (t) => {
  const { parseClaudeTranscript, textOnly } = require('../lib/agent-transcript');
  const { visibleOutbox } = require('../public/ui-model');
  const lines = fs
    .readFileSync(path.join(__dirname, 'fixtures/claude-midturn-transcript.jsonl'), 'utf8')
    .trim()
    .split('\n');
  const { queue, options, state, add } = setup(t);
  state.pane.agent.label = 'claude';
  state.time = Date.parse('2026-09-19T20:33:43.920Z');
  state.messages = parseClaudeTranscript(lines.slice(0, 1));
  await add('correction', '请把审查表写入隔离目录。');
  await queue.deliver({ paneId: 'w1:p1', id: 'correction' });
  await queue.tick();
  state.messages = parseClaudeTranscript(lines.slice(0, 5));
  state.time += 61000;
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].error.code, 'ACK_TIMEOUT', '只有原生队列事件不能确认已消费');
  const restarted = new MessageQueue(options);
  state.messages = parseClaudeTranscript(lines);
  // The transcript and queue may arrive in either order at the browser.
  assert.equal(
    visibleOutbox(restarted.list('w1:p1'), textOnly(state.messages)).length,
    1,
    '前端等待服务端确认，不自行用文本认领回执',
  );
  await restarted.tick();
  const item = restarted.list('w1:p1')[0];
  assert.equal(item.status, 'consumed');
  assert.equal(item.consumedMessageId, 'queued-attachment');
  assert.equal(item.deliveryUncertain, false);
  assert.equal(item.error, null);
  assert.deepEqual(visibleOutbox([item], textOnly(state.messages)), []);
  await new MessageQueue(options).tick();
  assert.equal(state.calls.length, 1, '确认迟到也不得重复投递');
});

test('带前导空白的消息照样能确认：终端提交会把两头的空白都去掉', async (t) => {
  const { parseClaudeTranscript, textOnly } = require('../lib/agent-transcript');
  const { visibleOutbox } = require('../public/ui-model');
  const lines = fs
    .readFileSync(path.join(__dirname, 'fixtures/claude-midturn-transcript.jsonl'), 'utf8')
    .trim()
    .split('\n');
  const { queue, state, add } = setup(t);
  state.pane.agent.label = 'claude';
  state.time = Date.parse('2026-09-19T20:33:43.920Z');
  state.messages = parseClaudeTranscript(lines.slice(0, 1));
  // ⚠️ 只去尾的话这条永远确认不了：存档里记下的是去掉前导空白之后的正文，
  // 逐字比对必然不等，60 秒后按 ACK_TIMEOUT 判失败 —— 而消息其实已经送到了。
  // 2026-09-22 在生产上实测到这个现象（队列 `"  这些不要 …"` 对存档 `"这些不要 …"`）。
  await add('correction', '  请把审查表写入隔离目录。  ');
  await queue.deliver({ paneId: 'w1:p1', id: 'correction' });
  await queue.tick();
  state.messages = parseClaudeTranscript(lines);
  await queue.tick();
  const item = queue.list('w1:p1')[0];
  assert.equal(item.status, 'consumed', '前导空白不该让它卡在等待确认');
  assert.equal(item.error, null);
  assert.deepEqual(visibleOutbox([item], textOnly(state.messages)), [], '确认之后页面上不再留一条');
});

test('原生设置菜单占用输入时暂停消息投递，释放后整批发送', async (t) => {
  const { queue, state, add } = setup(t);
  let locked = true;
  queue.inputAvailable = () => !locked;
  await add('a');
  await add('b');
  state.pane.status = 'idle';
  await queue.tick();
  assert.equal(state.calls.length, 0);
  locked = false;
  await queue.tick();
  assert.deepEqual(state.calls, [{ paneId: 'w1:p1', text: 'a\n\nb' }]);
});

test('working/blocked/unknown 默认排队，idle/done 将等待消息整批提交', async (t) => {
  const { queue, state, add, consume } = setup(t);
  await add('a');
  await add('b');
  for (const status of ['working', 'blocked', 'unknown']) {
    state.pane.status = status;
    await queue.tick();
  }
  assert.equal(state.calls.length, 0);
  state.pane.status = 'idle';
  await Promise.all([queue.tick(), queue.tick()]);
  assert.deepEqual(state.calls, [{ paneId: 'w1:p1', text: 'a\n\nb' }]);
  assert.equal(queue.list('w1:p1')[0].status, 'sending');
  await queue.tick();
  assert.equal(state.calls.length, 1, '仍是 idle 不能当成消费确认');
  state.pane.status = 'working';
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].status, 'sending');
  consume('a\n\nb');
  await queue.tick();
  assert.ok(queue.list('w1:p1').every((item) => item.status === 'consumed'));
  assert.ok(queue.list('w1:p1')[0].consumedMessageId);
  await queue.tick();
  assert.equal(state.calls.length, 1);
  state.pane.status = 'done';
  await queue.tick();
  assert.equal(state.calls.length, 1);
});

test('历史相同文本不能确认新消息，刷新后 id 幂等且取消持久化', async (t) => {
  const { queue, state, options, add, consume } = setup(t);
  consume('same');
  await add('a', 'same');
  await add('a', 'same');
  await add('b');
  assert.equal(queue.list('w1:p1').length, 2);
  await assert.rejects(add('a', 'different'), { code: 'MESSAGE_ID_CONFLICT' });
  queue.cancel('w1:p1', 'b');
  assert.equal(new MessageQueue(options).list('w1:p1')[1].status, 'cancelled');
  state.pane.status = 'idle';
  await queue.tick();
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].status, 'sending');
  assert.throws(() => queue.cancel('w1:p1', 'a'), { status: 409 });
  consume('same');
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].status, 'consumed');
  assert.ok(queue.list('w1:p1')[0].consumedMessageId);
  assert.equal(fs.statSync(options.file).mode & 0o777, 0o600);
});

test('重启后保留已成功的原生输入回执，不自动重发，迟到的存档可确认', async (t) => {
  const { queue, options, state, add, consume } = setup(t);
  await add('a');
  await add('b');
  state.pane.status = 'idle';
  await queue.tick();
  const restarted = new MessageQueue(options);
  assert.equal(restarted.list('w1:p1')[0].transportAcceptedAt, 1000);
  await restarted.tick();
  assert.equal(state.calls.length, 1);
  consume('a\n\nb');
  await restarted.tick();
  await restarted.tick();
  assert.equal(state.calls.length, 1);
  assert.ok(restarted.list('w1:p1').every((item) => item.status === 'consumed'));
});

test('会话替换拒绝投递，重新使用旧 id 被拒绝', async (t) => {
  const { queue, state, add } = setup(t);
  await add('a');
  state.pane.agent.session.value = 'replacement';
  state.pane.status = 'idle';
  await queue.tick();
  assert.equal(state.calls.length, 0);
  assert.equal(queue.list('w1:p1')[0].error.code, 'SESSION_CHANGED');
  await assert.rejects(add('a'), { code: 'MESSAGE_ID_CONFLICT' });
  await add('b');
  await queue.tick();
  assert.equal(state.calls[0].text, 'b');
});

test('发送超时和传输失败都保留不确定状态，不自动重试', async (t) => {
  for (const failure of [false, true]) {
    const { queue, options, state, add } = setup(t);
    if (failure)
      queue.send = async () => {
        throw new Error('connection lost');
      };
    await add('a');
    await add('b');
    state.pane.status = 'idle';
    await queue.tick();
    state.time += 200;
    await queue.tick();
    await queue.tick();
    const first = queue.list('w1:p1')[0];
    assert.equal(first.status, 'failed');
    assert.equal(first.deliveryUncertain, true);
    assert.equal(first.error.code, failure ? 'SEND_FAILED' : 'ACK_TIMEOUT');
    assert.equal(queue.list('w1:p1')[1].status, 'failed');
    assert.equal(new MessageQueue(options).list('w1:p1')[0].status, 'failed');
  }
});

test('取消与读取存档并发时不能继续投递；无效输入不能入队', async (t) => {
  const { queue, state, add } = setup(t);
  await add('a');
  state.pane.status = 'idle';
  queue.readMessages = async () => {
    queue.cancel('w1:p1', 'a');
    return [];
  };
  await queue.tick();
  assert.equal(state.calls.length, 0);
  for (const body of [null, [], {}, { id: 'x', paneId: 'w1:p1', text: '\x1b[31m' }]) {
    await assert.rejects(queue.enqueue(body), { status: 400 });
  }
});

test('不同 pane 可独立发送，目标始终来自消息 pane 而不是焦点', async (t) => {
  const { queue, state } = setup(t);
  state.pane.status = 'idle';
  queue.getPane = async (id) => ({ ...structuredClone(state.pane), paneId: id });
  await queue.enqueue({ id: 'a', paneId: 'w1:p1', text: 'first' });
  await queue.enqueue({ id: 'b', paneId: 'w2:p8', text: 'second' });
  await queue.tick();
  assert.deepEqual(state.calls.map((call) => call.paneId).sort(), ['w1:p1', 'w2:p8']);
});

test('存储损坏拒绝加载，存储失败后禁止发送', async (t) => {
  const { queue, options, state, add } = setup(t);
  await add('a');
  state.pane.status = 'idle';
  fs.rmSync(options.file);
  fs.mkdirSync(options.file);
  await assert.rejects(queue.tick(), { code: 'QUEUE_STORAGE_FAILED' });
  assert.equal(state.calls.length, 0);
  await assert.rejects(queue.tick(), { code: 'QUEUE_STORAGE_FAILED' });
  fs.rmSync(options.file, { recursive: true });
  fs.writeFileSync(options.file, 'broken');
  assert.throws(() => new MessageQueue(options));
});

test('只有明确未写入的失败允许同 id 显式重试，不确定的失败保持原记录', async (t) => {
  const { queue, state, add } = setup(t);
  let calls = 0;
  queue.send = async () => {
    calls++;
    throw Object.assign(new Error('connect refused'), { deliveryUncertain: false });
  };
  await add('a');
  state.pane.status = 'idle';
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].retryable, true);
  await queue.tick();
  assert.equal(calls, 1, '没有显式请求不自动重试');
  assert.equal((await add('a')).status, 'failed', '普通重复 POST 不重试');
  assert.equal((await add('a', 'a', true)).status, 'queued');
  queue.send = async () => {
    calls++;
    throw new Error('connection lost after writing');
  };
  await queue.tick();
  assert.equal((await add('a', 'a', true)).status, 'failed');
  await queue.tick();
  assert.equal(calls, 2);
  assert.equal(queue.list('w1:p1')[0].deliveryUncertain, true);
});

test('每次队列状态落盘后立即通知，包括入队、发送、消费和取消', async (t) => {
  const { queue, options, state, add, consume } = setup(t);
  const changes = [];
  queue.onChange = () =>
    changes.push(JSON.parse(fs.readFileSync(options.file)).items.map((item) => item.status));
  await add('a');
  state.pane.status = 'idle';
  await queue.tick();
  consume('a');
  await queue.tick();
  await add('b');
  queue.cancel('w1:p1', 'b');
  assert.deepEqual(changes, [
    ['queued'],
    ['sending'],
    ['sending'],
    ['consumed'],
    ['consumed', 'queued'],
    ['consumed', 'cancelled'],
  ]);
});

test('发送后会话替换仍保留结果不确定，不阻塞新会话，不反复写盘', async (t) => {
  const { queue, state, add } = setup(t);
  await add('a');
  state.pane.status = 'idle';
  await queue.tick();
  state.pane.agent.session.value = 'replacement';
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].deliveryUncertain, true);
  assert.equal(queue.list('w1:p1')[0].orphaned, true);
  let changes = 0;
  queue.onChange = () => {
    changes++;
  };
  await queue.tick();
  assert.equal(changes, 0);
  await add('b');
  await queue.tick();
  assert.equal(state.calls[1].text, 'b');
});

test('首次输入前没有 session：整批发送，session 出现后整队固定并确认消费', async (t) => {
  const { queue, state, add, consume, options } = setup(t);
  state.pane.agent = { label: 'codex', name: 'new-agent', session: null, interactiveReady: true };
  queue.readMessages = async (pane) => {
    assert.ok(pane.agent.session?.value, '无 session 时不读取不存在的归档');
    return structuredClone(state.messages);
  };
  const first = await add('a');
  await add('b');
  assert.equal(first.sessionId, null);
  assert.equal(first.agentName, 'new-agent');
  for (const status of ['working', 'blocked', 'unknown']) {
    state.pane.status = status;
    await queue.tick();
  }
  assert.equal(state.calls.length, 0);
  state.pane.status = 'idle';
  state.pane.agent.interactiveReady = false;
  await queue.tick();
  assert.equal(state.calls.length, 0);
  state.pane.agent.interactiveReady = true;
  state.pane.agent.launchPending = true;
  await queue.tick();
  assert.equal(state.calls.length, 0);
  state.pane.agent.launchPending = false;
  await queue.tick();
  await queue.tick();
  assert.equal(state.calls.length, 1);
  assert.equal(queue.list('w1:p1')[0].status, 'sending');
  assert.equal((await add('a')).status, 'sending');
  state.pane.agent.session = { value: 'created-session' };
  await queue.tick();
  assert.deepEqual(
    queue.list('w1:p1').map((item) => item.sessionId),
    ['created-session', 'created-session'],
  );
  assert.equal(JSON.parse(fs.readFileSync(options.file)).items[1].sessionId, 'created-session');
  assert.equal(state.calls.length, 1, 'session 出现不等于首条已消费');
  consume('a\n\nb');
  await queue.tick();
  assert.ok(queue.list('w1:p1').every((item) => item.consumedMessageId === 'user-0'));
  await queue.tick();
  assert.equal(state.calls.length, 1);
});

test('首次 sending 时重启不重发，迟到的 session 和归档仍可确认', async (t) => {
  const { queue, state, add, consume, options } = setup(t);
  state.pane.runtimeId = 'native-process-instance';
  state.pane.agent = { label: 'codex', name: 'new-agent', session: null };
  state.pane.status = 'done';
  await add('a');
  await add('b');
  await queue.tick();
  const restarted = new MessageQueue(options);
  await restarted.tick();
  assert.equal(state.calls.length, 1);
  assert.equal(restarted.list('w1:p1')[0].transportAcceptedAt, 1000);
  state.pane.agent.session = { value: 'created-session' };
  consume('a\n\nb');
  await restarted.tick();
  assert.equal(restarted.list('w1:p1')[0].status, 'consumed');
  await restarted.tick();
  assert.equal(state.calls.length, 1);
});

test('没有 session 时发送超时保持不确定，后续消息不能越过', async (t) => {
  const { queue, state, add } = setup(t);
  state.pane.agent = { label: 'codex', name: 'new-agent', session: null };
  state.pane.status = 'idle';
  await add('a');
  await add('b');
  await queue.tick();
  state.time += 200;
  await queue.tick();
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].error.code, 'ACK_TIMEOUT');
  assert.equal(queue.list('w1:p1')[0].deliveryUncertain, true);
  assert.equal(state.calls.length, 1);
});

test('首次 session 生成前 terminal、agent 名称或类型变化不得投递旧队列', async (t) => {
  for (const sent of [false, true]) {
    for (const replace of [
      (pane) => {
        pane.terminalId = 'replacement';
      },
      (pane) => {
        pane.agent.name = 'replacement';
      },
      (pane) => {
        pane.agent.label = 'claude';
      },
      (pane) => {
        pane.agent = null;
      },
    ]) {
      const { queue, state, add } = setup(t);
      state.pane.agent = { label: 'codex', name: 'new-agent', session: null };
      await add('a');
      await add('b');
      state.pane.status = 'idle';
      if (sent) await queue.tick();
      replace(state.pane);
      await queue.tick();
      assert.equal(state.calls.length, Number(sent));
      assert.ok(queue.list('w1:p1').every((item) => item.orphaned && item.status === 'failed'));
      assert.equal(queue.list('w1:p1')[0].deliveryUncertain, sent);
    }
  }
});

test('第一条固定 session 时后续也固定，之后替换 session 不能继续发送', async (t) => {
  const { queue, state, add, consume } = setup(t);
  state.pane.agent = { label: 'codex', name: 'new-agent', session: null };
  state.pane.status = 'idle';
  await add('a');
  await add('b');
  await queue.tick();
  state.pane.agent.session = { value: 'first-session' };
  consume('a');
  await queue.tick();
  state.pane.agent.session.value = 'replacement';
  await queue.tick();
  assert.equal(state.calls.length, 1);
  assert.equal(queue.list('w1:p1')[1].error.code, 'SESSION_CHANGED');
});

test('发送前复核时 session 才出现，重新读取历史基线，旧同文消息不算消费', async (t) => {
  const { queue, state, add, consume } = setup(t);
  state.pane.agent = { label: 'codex', name: 'new-agent', session: null };
  state.pane.status = 'idle';
  await add('a');
  let reads = 0;
  queue.getPane = async () => {
    if (++reads === 2) {
      state.pane.agent.session = { value: 'ready-session' };
      consume('a');
    }
    return structuredClone(state.pane);
  };
  await queue.tick();
  assert.equal(state.calls.length, 0);
  await queue.tick();
  await queue.tick();
  assert.equal(state.calls.length, 1);
  assert.equal(queue.list('w1:p1')[0].status, 'sending');
  consume('a');
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].consumedMessageId, 'user-1');
});

test('首次消息仍拒绝 shell、无身份目标和不匹配的显式 sessionId', async (t) => {
  const { queue, state } = setup(t);
  const body = { id: 'a', paneId: 'w1:p1', text: 'hello' };
  state.pane.agent = null;
  await assert.rejects(queue.enqueue(body), { code: 'SESSION_UNAVAILABLE' });
  state.pane.agent = { label: 'codex', session: null };
  await assert.rejects(queue.enqueue(body), { code: 'SESSION_UNAVAILABLE' });
  state.pane.agent.name = 'new-agent';
  await assert.rejects(queue.enqueue({ ...body, sessionId: 'stale-session' }), {
    code: 'SESSION_CHANGED',
  });
  assert.equal((await queue.enqueue({ ...body, sessionId: null })).sessionId, null);
});

test('整批发送保留顺序和单条撤回，新到消息留给下一批，确认不会重复投递', async (t) => {
  const { queue, state, add, consume } = setup(t);
  await add('a', '先检查实现');
  await add('b', '撤回这条');
  await add('c', '还要检查测试');
  queue.cancel('w1:p1', 'b');
  queue.send = async (pane, text) => {
    state.calls.push({ paneId: pane.paneId, text });
    if (state.calls.length === 1) await add('d', '稍后再处理');
  };
  state.pane.status = 'idle';
  await queue.tick();
  assert.equal(state.calls[0].text, '先检查实现\n\n还要检查测试');
  assert.deepEqual(
    queue.list('w1:p1').map((item) => item.status),
    ['sending', 'cancelled', 'sending', 'queued'],
  );
  state.pane.status = 'working';
  consume(state.calls[0].text);
  await queue.tick();
  await queue.tick();
  assert.equal(state.calls.length, 1, '未点击投递的新消息仍可撤回');
  const items = queue.list('w1:p1');
  assert.equal(items[0].consumedMessageId, items[2].consumedMessageId);
  state.pane.status = 'done';
  await queue.tick();
  assert.equal(state.calls[1].text, '稍后再处理');
});

test('读取存档期间撤回批内消息，最终投递不包含它；同文消息仍保留两份', async (t) => {
  const { queue, state, add } = setup(t);
  await add('a', 'same');
  await add('b');
  await add('c', 'same');
  queue.readMessages = async () => {
    queue.cancel('w1:p1', 'b');
    return [];
  };
  state.pane.status = 'done';
  await queue.tick();
  assert.equal(state.calls[0].text, 'same\n\nsame');
});

test('整批确定未写入时可分别撤回或重试，不沿用旧批次文本', async (t) => {
  const { queue, state, add, consume } = setup(t);
  await add('a');
  await add('b');
  state.pane.status = 'done';
  queue.send = async () => {
    throw Object.assign(new Error('refused'), { deliveryUncertain: false });
  };
  await queue.tick();
  assert.ok(queue.list('w1:p1').every((item) => item.retryable));
  queue.cancel('w1:p1', 'a');
  await add('b', 'b', true);
  queue.send = async (pane, text) => {
    state.calls.push(text);
  };
  await queue.tick();
  assert.deepEqual(state.calls, ['b']);
  consume('b');
  await queue.tick();
  assert.deepEqual(
    queue.list('w1:p1').map((item) => item.status),
    ['cancelled', 'consumed'],
  );
});

test('终端删去末尾空白仍确认消费，后面的队列不会被卡住，保留代码内部空白语义', async (t) => {
  const { queue, state, add, consume } = setup(t);
  await add('a', 'first line\n  indented line  \n');
  state.pane.status = 'idle';
  await queue.tick();
  consume('first line\n indented line');
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].status, 'sending', '不能忽略内部缩进差异');
  consume('first line\n  indented line');
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].status, 'consumed');
  await add('b');
  await queue.tick();
  assert.equal(state.calls.length, 2);
});
test('终端已提交的排队消息以时间和唯一回执核对，不重复发出，也不借旧消息消除新消息', async (t) => {
  const { queue, state, add } = setup(t);
  state.pane.status = 'blocked';
  const record = (id, text, ts) =>
    state.messages.push({
      id,
      role: 'user',
      ts: new Date(ts).toISOString(),
      blocks: [{ kind: 'text', text }],
    });
  record('old', 'same', 900);
  await add('a', 'same ');
  await add('b', 'same');
  record('new', 'same', 1100);
  await queue.tick();
  assert.deepEqual(
    queue.list('w1:p1').map((item) => item.status),
    ['consumed', 'queued'],
  );
  assert.equal(queue.list('w1:p1')[0].consumedMessageId, 'new');
  assert.equal(queue.list('w1:p1')[0].consumedAt, 1100);
  assert.equal(state.calls.length, 0);
  state.pane.status = 'idle';
  await queue.tick();
  assert.equal(state.calls[0].text, 'same');
});

test('终端命令在输入回执后完成投递，不等待聊天存档，不与普通消息合并', async (t) => {
  const { queue, state, add, consume, options } = setup(t);
  await add('prompt', '先处理消息');
  await add('command', '/resume');
  await add('later', '下一条');
  state.pane.status = 'idle';
  await queue.tick();
  assert.equal(state.calls[0].text, '先处理消息');
  consume('先处理消息');
  await queue.tick();
  await queue.tick();
  assert.equal(state.calls[1].text, '/resume');
  assert.equal(queue.list('w1:p1')[1].status, 'dispatched');
  assert.equal(queue.list('w1:p1')[1].deliveryUncertain, false);
  state.pane.status = 'blocked';
  await queue.tick();
  assert.equal(state.calls.length, 2);
  const restarted = new MessageQueue(options);
  await restarted.tick();
  assert.equal(state.calls.length, 2);
  state.pane.status = 'idle';
  await restarted.tick();
  assert.equal(state.calls[2].text, '下一条');
});

test('旧命令确认超时以已成功的输入回执恢复，普通消息或未知写入不伪造接收', async (t) => {
  const { queue, state, add, options } = setup(t);
  await add('command', '/resume');
  await add('normal', '普通消息');
  await add('unknown', '/compact');
  for (const [i, item] of queue.items.entries())
    Object.assign(item, {
      status: 'failed',
      deliveryUncertain: true,
      sendingAt: 1000,
      attempts: 1,
      error: { code: i === 2 ? 'RESTART_UNCERTAIN' : 'ACK_TIMEOUT' },
      dispatchText: item.text,
    });
  queue.persist();
  const restarted = new MessageQueue(options);
  assert.deepEqual(
    restarted.list('w1:p1').map((x) => x.status),
    ['dispatched', 'failed', 'failed'],
  );
  await restarted.tick();
  assert.equal(state.calls.length, 0);
  assert.equal(new MessageQueue(options).list('w1:p1')[0].status, 'dispatched');
});

test('命令传输明确失败可重试，结果未知保留待确认，不能当成已接收', async (t) => {
  for (const uncertain of [false, true]) {
    const { queue, state, add } = setup(t);
    await add('command', '/compact');
    state.pane.status = 'idle';
    queue.send = async () => {
      throw Object.assign(new Error('transport failure'), { deliveryUncertain: uncertain });
    };
    await queue.tick();
    assert.equal(queue.list('w1:p1')[0].status, 'failed');
    assert.equal(queue.list('w1:p1')[0].deliveryUncertain, uncertain);
  }
});
test('原生已接收但存档未刷新时，新补充消息立即投递，不等当前轮结束', async (t) => {
  const { queue, state, add, consume, options } = setup(t);
  await add('a', 'first');
  await queue.deliver({ paneId: 'w1:p1', id: 'a' });
  await queue.tick();
  assert.equal(state.calls[0].text, 'first');
  await add('b', 'second');
  await queue.deliver({ paneId: 'w1:p1', id: 'b' });
  await queue.tick();
  assert.deepEqual(
    state.calls.map((x) => x.text),
    ['first', 'second'],
  );
  assert.equal(state.pane.status, 'working');
  state.time += 200;
  await queue.tick();
  const restarted = new MessageQueue(options);
  await restarted.enqueue({ id: 'c', paneId: 'w1:p1', text: 'third' });
  await restarted.deliver({ paneId: 'w1:p1', id: 'c' });
  await restarted.tick();
  assert.equal(state.calls[2].text, 'third', 'ACK_TIMEOUT 不挡住新补充消息');
  consume('first\n\nsecond\n\nthird');
  await restarted.tick();
  assert.ok(restarted.list('w1:p1').every((item) => item.status === 'consumed'));
  await restarted.tick();
  assert.equal(state.calls.length, 3);
});
test('多次发送同文消息必须分别收到存档回执，不能借用第一条的接收记录', async (t) => {
  const { queue, state, add, consume } = setup(t);
  state.pane.status = 'idle';
  await add('a', 'same');
  await queue.tick();
  await add('b', 'same');
  await queue.tick();
  consume('same');
  await queue.tick();
  await queue.tick();
  assert.deepEqual(
    queue.list('w1:p1').map((x) => x.status),
    ['consumed', 'sending'],
  );
  consume('same');
  await queue.tick();
  assert.deepEqual(
    queue.list('w1:p1').map((x) => x.status),
    ['consumed', 'consumed'],
  );
  assert.equal(state.calls.length, 2);
});
test('原生写入结果未知仍阻止后续输入；斜杠命令不能在工作中作为补充消息插入', async (t) => {
  const { queue, state, add } = setup(t);
  state.pane.status = 'idle';
  queue.send = async () => {
    throw new Error('transport lost');
  };
  await add('a');
  await queue.tick();
  await add('b');
  await queue.tick();
  assert.equal(queue.list('w1:p1')[1].status, 'queued');
  const g = setup(t);
  await g.add('slash', '/model');
  await g.queue.tick();
  assert.equal(g.state.calls.length, 0);
  g.state.pane.status = 'idle';
  await g.queue.tick();
  assert.equal(g.state.calls[0].text, '/model');
});

test('Codex 运行时修改目标直接投递，普通排队消息仍可撤回', async (t) => {
  const { queue, state, add, options } = setup(t);
  await add('held', '普通消息等待下一轮');
  const body = {
    id: 'goal',
    paneId: 'w1:p1',
    sessionId: 'session1',
    text: '/goal 根据公开信息审查精度问题\n补充验收说明',
  };
  const result = await queue.submit(body);
  assert.equal(result.status, 'dispatched');
  assert.deepEqual(
    state.calls.map((call) => call.text),
    [body.text],
  );
  assert.equal(queue.list('w1:p1')[0].status, 'queued');
  await queue.submit(body);
  await queue.tick();
  const restarted = new MessageQueue(options);
  await restarted.tick();
  assert.equal(state.calls.length, 1, '已投递 Goal 不等待用户消息存档，也不自动重发');
  assert.equal(queue.cancel('w1:p1', 'held').status, 'cancelled');
});

test('已经排队的 Goal 可以手动投递，原生输入回执不再挡住目标修改', async (t) => {
  const { queue, state, add } = setup(t);
  await add('first', '已送入原生队列');
  await queue.deliver({ paneId: 'w1:p1', id: 'first' });
  await queue.tick();
  await add('goal', '/goal 更新目标');
  await queue.deliver({ paneId: 'w1:p1', id: 'goal' });
  await queue.tick();
  assert.deepEqual(
    state.calls.map((call) => call.text),
    ['已送入原生队列', '/goal 更新目标'],
  );
  assert.equal(queue.list('w1:p1')[1].status, 'dispatched');
});

test('Goal 投递仍检查交互状态、会话身份与未知写入，不放开其他斜杠命令', async (t) => {
  for (const status of ['blocked', 'unknown']) {
    const { queue, state, add } = setup(t);
    state.pane.status = status;
    await add('goal', '/goal 更新目标');
    await queue.tick();
    assert.equal(state.calls.length, 0);
    await assert.rejects(queue.deliver({ paneId: 'w1:p1', id: 'goal' }), {
      code: 'AGENT_NOT_READY',
    });
  }
  const { queue, state, add } = setup(t);
  await add('goal', '/goal 更新目标');
  await assert.rejects(queue.deliver({ paneId: 'w1:p1', id: 'goal', sessionId: 'wrong' }), {
    code: 'SESSION_CHANGED',
  });
  for (const text of ['/model', '/goalish 修改', '/goal:custom 修改']) {
    await add(text, text);
    await assert.rejects(queue.deliver({ paneId: 'w1:p1', id: text }), {
      code: 'COMMAND_REQUIRES_IDLE',
    });
  }
  state.pane.agent.label = 'claude';
  await add('claude', '/goal 修改');
  await assert.rejects(queue.deliver({ paneId: 'w1:p1', id: 'claude' }), {
    code: 'COMMAND_REQUIRES_IDLE',
  });
  const pending = setup(t);
  pending.state.pane.status = 'idle';
  pending.queue.send = async () => {
    throw new Error('partial write');
  };
  await pending.add('unknown');
  await pending.queue.tick();
  pending.state.pane.status = 'working';
  const result = await pending.queue.submit({
    id: 'goal',
    paneId: 'w1:p1',
    text: '/goal 更新目标',
  });
  assert.equal(result.status, 'queued');
  assert.equal(pending.queue.list('w1:p1')[0].deliveryUncertain, true);
});
test('投递只选择指定消息，可越过尚未投递的排队消息；其余消息仍可撤回', async (t) => {
  const { queue, state, add } = setup(t);
  await add('a', 'keep queued');
  await add('b', 'deliver this');
  await add('c', 'also queued');
  await queue.tick();
  assert.equal(state.calls.length, 0);
  await queue.deliver({ id: 'b', paneId: 'w1:p1', sessionId: 'session1' });
  await queue.tick();
  assert.deepEqual(
    state.calls.map((x) => x.text),
    ['deliver this'],
  );
  assert.deepEqual(
    queue.list('w1:p1').map((x) => x.status),
    ['queued', 'sending', 'queued'],
  );
  assert.equal(queue.cancel('w1:p1', 'a').text, 'keep queued');
  await assert.rejects(queue.deliver({ id: 'b', paneId: 'w1:p1' }), { status: 409 });
  state.pane.status = 'blocked';
  await assert.rejects(queue.deliver({ id: 'c', paneId: 'w1:p1' }), { code: 'AGENT_NOT_READY' });
  state.pane.status = 'working';
  await assert.rejects(queue.deliver({ id: 'c', paneId: 'w1:p1', sessionId: 'wrong' }), {
    code: 'SESSION_CHANGED',
  });
});

test('提交就是发送：空闲和忙碌都在返回前完成原生投递，重复提交仍然幂等', async (t) => {
  const { queue, state } = setup(t);
  state.pane.status = 'idle';
  const body = { id: 'direct', paneId: 'w1:p1', text: 'direct' };
  const sent = await queue.submit(body);
  assert.equal(sent.status, 'sending');
  assert.ok(sent.transportAcceptedAt != null);
  assert.equal(state.calls.length, 1);
  await queue.submit(body);
  assert.equal(state.calls.length, 1);
  state.pane.status = 'working';
  const busy = await queue.submit({ ...body, id: 'busy' });
  assert.equal(busy.status, 'sending', '忙碌时不再停在队列里等第二次点击');
  assert.deepEqual(
    state.calls.map((call) => call.text),
    ['direct', 'direct'],
  );
  // 还不能发的目标(blocked、输入被占用)仍然排队,并且可以取消。
  state.pane.status = 'blocked';
  const waiting = await queue.submit({ ...body, id: 'waiting', text: 'waiting' });
  assert.equal(waiting.status, 'queued');
  assert.equal(state.calls.length, 2);
  assert.equal(queue.cancel('w1:p1', 'waiting').status, 'cancelled');
});

test('被放弃的分支没有回复也应移除，并且不挡住后续投递', async (t) => {
  const { queue, state, add, consume } = setup(t);
  state.pane.status = 'idle';
  await add('branch', '会被丢掉的这条');
  await queue.tick();
  consume('会被丢掉的这条');
  await queue.tick();
  const confirmed = queue.list('w1:p1')[0];
  assert.equal(confirmed.status, 'consumed');
  const archivedId = confirmed.consumedMessageId;
  assert.ok(archivedId);

  // 那一支被放弃：有效历史里没有它了，但存档文件里仍然留着这条记录。
  state.messages = [];
  state.archivedIds = [archivedId];
  await add('next', '后面又发的一条');
  await queue.tick();
  const discarded = queue.list('w1:p1').find((item) => item.id === 'branch');
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.error, null);
  assert.equal(discarded.retryable, false);
  assert.equal(discarded.consumedMessageId, archivedId, '投递回执不能因回滚而丢失');
  // 用户已经在终端里回退掉了那一支，之后发的消息属于新分支，不能被它挡住。
  await add('after', '再后面的一条');
  await queue.tick();
  assert.deepEqual(
    state.calls.map((call) => call.text),
    ['会被丢掉的这条', '后面又发的一条', '再后面的一条'],
  );
  assert.equal(queue.list('w1:p1').find((item) => item.id === 'branch').status, 'discarded');
  await add('branch', '会被丢掉的这条', true);
  await queue.tick();
  assert.equal(state.calls.length, 3, '旧客户端的重试不能复活被回滚的消息');
});

test('被放弃的分支已有回复时使用同一个终态，不再画气泡', async (t) => {
  const { visibleOutbox } = require('../public/ui-model');
  const { queue, state, add, consume } = setup(t);
  state.pane.status = 'idle';
  await add('answered', '回退前已经答过的这条');
  await queue.tick();
  consume('回退前已经答过的这条');
  await queue.tick();
  const confirmed = queue.list('w1:p1')[0];
  assert.equal(confirmed.status, 'consumed');
  const archivedId = confirmed.consumedMessageId;
  // 终端里回退到这条之前：它和它的回复都留在存档里，却都不在有效历史里。
  state.messages = [];
  state.archivedIds = [archivedId];
  await add('next', '回退之后发的一条');
  await queue.tick();
  const item = queue.list('w1:p1').find((entry) => entry.id === 'answered');
  assert.equal(item.status, 'discarded');
  assert.equal(item.consumedMessageId, archivedId);
  assert.ok(item.historyDiscardedAt);
  assert.deepEqual(visibleOutbox([item], []), [], '和那一支上的其它记录一样，页面上不再显示');
  assert.deepEqual(
    state.calls.map((call) => call.text),
    ['回退前已经答过的这条', '回退之后发的一条'],
    '新分支的消息照常投递',
  );
});

test('存档里连记录都没有了当作历史被压缩，不反过来报成没发出去', async (t) => {
  const { queue, state, add, consume } = setup(t);
  state.pane.status = 'idle';
  await add('compacted', '很久以前的一条');
  await queue.tick();
  consume('很久以前的一条');
  await queue.tick();
  assert.equal(queue.list('w1:p1')[0].status, 'consumed');
  // 压缩之后有效历史和存档里都没有它了。
  state.messages = [];
  state.archivedIds = [];
  await add('later', '新的一条');
  await queue.tick();
  assert.equal(queue.list('w1:p1').find((item) => item.id === 'compacted').status, 'consumed');
});

test('旧弃用失败记录在重启时持久化迁移，重试和重复提交都不会重新投递', async (t) => {
  const { options, state } = setup(t);
  const base = {
    paneId: 'w1:p1',
    terminalId: 'term1',
    agent: 'codex',
    sessionId: 'session1',
    text: 'old',
    updatedAt: 1,
  };
  fs.writeFileSync(
    options.file,
    JSON.stringify({
      version: 1,
      items: [
        {
          ...base,
          id: 'failed',
          status: 'failed',
          retryable: true,
          consumedMessageId: null,
          error: { code: 'HISTORY_DISCARDED', message: 'old error' },
        },
        {
          ...base,
          id: 'answered',
          status: 'consumed',
          consumedMessageId: 'native-old',
          historyDiscardedAt: 0,
        },
        {
          ...base,
          id: 'real-failure',
          status: 'failed',
          retryable: true,
          error: { code: 'SEND_FAILED' },
        },
      ],
    }),
  );
  const queue = new MessageQueue(options);
  assert.deepEqual(
    queue.list('w1:p1').map((item) => item.status),
    ['discarded', 'discarded', 'failed'],
  );
  assert.equal(queue.list('w1:p1')[1].historyDiscardedAt, 0);
  const restarted = new MessageQueue(options);
  for (const id of ['failed', 'answered']) {
    const result = await restarted.submit({ id, paneId: 'w1:p1', text: 'old', retry: true });
    assert.equal(result.status, 'discarded');
    assert.equal(result.retryable, false);
    assert.equal(result.error, null);
  }
  assert.equal(state.calls.length, 0);
  assert.equal(restarted.list('w1:p1')[1].consumedMessageId, 'native-old');
});

test('完整历史复核不会混淆压缩、读取失败、会话替换和原生历史恢复', async (t) => {
  const { queue, state, add, consume } = setup(t);
  state.pane.status = 'idle';
  await add('message');
  await queue.tick();
  consume('message');
  await queue.tick();
  const item = queue.items[0],
    id = item.consumedMessageId;
  const active = structuredClone(state.messages);
  state.messages = [];
  state.archivedIds = null;
  await queue.recheckConsumed('w1:p1', state.pane, []);
  assert.equal(item.status, 'consumed');
  state.archivedIds = [];
  await queue.recheckConsumed('w1:p1', state.pane, []);
  assert.equal(item.status, 'consumed');
  state.archivedIds = [id];
  // 会话被换掉的标志是原生会话 ID 变了，不是 terminalId 变了 ——
  // 后者在运行时热交接时必然变化，而交接并不中断 Agent。
  state.pane.agent.session.value = 'session2';
  await queue.recheckConsumed('w1:p1', state.pane, []);
  assert.equal(item.status, 'consumed', '换了会话的 pane 不该重新解释旧会话的回执');
  state.pane.agent.session.value = 'session1';
  state.messages = active;
  await queue.recheckConsumed('w1:p1', state.pane, []);
  assert.equal(item.status, 'consumed', '两次读取之间恢复的有效记录不能被弃用');
  state.messages = [];
  item.consumedRechecked = true; // Older queues used a permanent one-shot flag.
  await queue.recheckConsumed('w1:p1', state.pane, []);
  assert.equal(item.status, 'discarded');
  state.messages = active;
  await queue.recheckConsumed('w1:p1', state.pane, active);
  assert.equal(item.status, 'discarded', '原生恢复后的消息由正文显示，旧发送记录仍不重发');
});

test('运行时热交接换掉 terminalId 时，未投递的消息不作废', async (t) => {
  // 实测：`server.live_handoff` 给每个 pane 换新的 terminalId，但 shell 与
  // 前台进程的 PID 都不变，Agent 没有中断。此前这里会把交接当成会话替换，
  // 把队列里还没投递的消息全部标成 failed/orphaned。
  const { queue, state, add } = setup(t);
  state.pane.status = 'working';
  await add('交接期间排队的一条');
  const item = queue.items[0];
  assert.equal(item.status, 'queued');

  state.pane.terminalId = 'term-after-handoff';
  state.pane.status = 'idle';
  await queue.tick();

  assert.notEqual(item.status, 'failed', '交接不是会话替换，消息不能作废');
  assert.equal(item.orphaned, undefined);
  assert.equal(state.calls.length, 1, '交接之后这条消息应当照常投递');
  assert.equal(state.calls[0].text, '交接期间排队的一条');
});

test('原生会话 ID 或进程身份对不上才算换了会话', async (t) => {
  const { queue, state, add } = setup(t);
  state.pane.status = 'working';
  await add('目标已经换掉');
  const item = queue.items[0];

  // 会话 ID 变了：无论 terminalId 是否相同，都不能再投递。
  state.pane.agent.session.value = 'session-other';
  state.pane.status = 'idle';
  await queue.tick();
  assert.equal(item.status, 'failed');
  assert.equal(item.orphaned, true);
  assert.equal(item.retryable, false, '换了会话不能自动重发');
  assert.equal(state.calls.length, 0);
});

test('Claude 把长粘贴包成 <pasted_content> 时照样能确认，带附件的也一样', async (t) => {
  const { parseClaudeTranscript, textOnly } = require('../lib/agent-transcript');
  const { visibleOutbox } = require('../public/ui-model');
  const { queue, state, add } = setup(t);
  state.pane.agent.label = 'claude';
  state.time = Date.parse('2026-09-23T07:45:50.000Z');
  const sent =
    '选中文字后 拖动怎么禁用 \n\n附件：image.png\n文件路径："/tmp/agent-studio/attachments/a/image.png"';
  await add('paste', sent);
  await queue.deliver({ paneId: 'w1:p1', id: 'paste' });
  await queue.tick();
  // 2026-09-23 Claude Code 2.1.280 实测的存档写法。
  const content = `\n\n<pasted_content id="45e5">\n${sent}\n</pasted_content id="45e5">\n`;
  state.messages = parseClaudeTranscript([
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-09-23T07:45:56.000Z',
      message: { role: 'user', content },
    }),
  ]);
  await queue.tick();
  const item = queue.list('w1:p1')[0];
  assert.equal(item.status, 'consumed', '包了一层标签也要能确认');
  assert.deepEqual(
    visibleOutbox(
      [{ ...item, authoritative: false, consumedMessageId: null, status: 'sending' }],
      textOnly(state.messages),
    ),
    [],
    '页面按原文也能对上',
  );
});

test('pending queue limits reject new work but preserve idempotent receipts and completed history', async (t) => {
  const { queue, add } = setup(t);
  for (let i = 0; i < 32; i++) await add(`bounded-${i}`);
  assert.equal((await add('bounded-0')).id, 'bounded-0');
  await assert.rejects(
    () => add('overflow'),
    (error) => error.status === 429 && error.code === 'QUEUE_LIMIT',
  );
  assert.equal(queue.items.length, 32);
  queue.items[0].status = 'consumed';
  await add('replacement');
  assert.equal(queue.items.length, 33);
  assert.equal(queue.items[0].status, 'consumed');
});
