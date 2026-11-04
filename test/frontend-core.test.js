'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The browser modules assign to `window`. Load them into a sandbox so their
// behaviour is testable without a page, the same way ui-model.js is used.
function load(...names) {
  // ArrayBuffer 必须来自同一个 realm，否则模块里的 instanceof 判不出二进制帧。
  const context = {
    window: {},
    console,
    URL,
    URLSearchParams,
    AbortSignal,
    Number,
    JSON,
    setTimeout,
    clearTimeout,
    Uint8Array,
    ArrayBuffer,
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const name of names) {
    const file = path.join(__dirname, '..', 'public', 'core', `${name}.js`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return context.window;
}

test('api 客户端附带设备与令牌头，并按基路径拼接', async () => {
  const { StudioApi } = load('api');
  const calls = [];
  const client = StudioApi.create({
    basePath: '/swift',
    deviceId: 'dev-1',
    getToken: () => 'tok-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, value: 1 }) };
    },
  });

  assert.equal(client.path('/api/x'), '/swift/api/x');
  assert.deepEqual(await client.call('/api/x'), { ok: true, value: 1 });
  assert.equal(calls[0].url, '/swift/api/x');
  assert.equal(calls[0].options.headers['x-agent-studio-device-id'], 'dev-1');
  assert.equal(calls[0].options.headers['x-agent-studio-token'], 'tok-1');
  assert.equal(calls[0].options.credentials, 'same-origin');
});

test('没有令牌时不发送令牌头，调用方自定义头得以保留', async () => {
  const { StudioApi } = load('api');
  let sent;
  const client = StudioApi.create({
    deviceId: 'dev-1',
    getToken: () => '',
    fetchImpl: async (url, options) => {
      sent = options.headers;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await client.call('/api/x', { headers: { 'content-type': 'application/json' } });
  assert.equal('x-agent-studio-token' in sent, false);
  assert.equal(sent['content-type'], 'application/json');
});

test('调用方的 signal 与超时同时生效：切走会话时能中止请求', async () => {
  const { StudioApi } = load('api');
  let seen;
  const client = StudioApi.create({
    deviceId: 'd',
    getToken: () => 't',
    timeoutMs: 60000,
    fetchImpl: async (url, options) => {
      seen = options.signal;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  const controller = new AbortController();
  await client.call('/x', { signal: controller.signal });
  assert.equal(seen.aborted, false);
  controller.abort();
  assert.equal(seen.aborted, true);
  await client.call('/x');
  assert.ok(seen instanceof AbortSignal, '不给 signal 时仍有超时');
});

test('失败响应变成带服务端 code 的错误，401 单独识别', async () => {
  const { StudioApi } = load('api');
  const make = (response) =>
    StudioApi.create({ deviceId: 'd', getToken: () => 't', fetchImpl: async () => response });

  await assert.rejects(
    make({ ok: false, status: 401, json: async () => ({}) }).call('/x'),
    (error) => error.code === 'UNAUTHORIZED',
  );
  await assert.rejects(
    make({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, code: 'SESSION_CHANGED', message: '会话已改变。' }),
    }).call('/x'),
    (error) =>
      error.code === 'SESSION_CHANGED' && error.status === 409 && error.message === '会话已改变。',
  );
  // 200 携带 ok:false 同样是失败，这是服务端既有的约定。
  await assert.rejects(
    make({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, code: 'X', message: '不行' }),
    }).call('/x'),
    (error) => error.code === 'X',
  );
});

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  deliver(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  deliverBinary(bytes) {
    this.onmessage?.({ data: bytes.buffer });
  }
  fire(code) {
    this.onclose?.({ code });
  }
}

function socketHarness(overrides = {}) {
  const { StudioSocket } = load('socket');
  FakeSocket.instances = [];
  const events = [];
  const socket = StudioSocket.create({
    url: 'ws://x/api/terminal',
    SocketImpl: FakeSocket,
    onBinary: (bytes) => events.push({ kind: 'binary', length: bytes.length }),
    onMessage: (message) => events.push({ kind: 'message', type: message.type }),
    onState: (state, text) => events.push({ kind: 'state', state, text }),
    ...overrides,
  });
  return { socket, events, instances: FakeSocket.instances };
}

test('连接后分发二进制与 JSON，握手成功本身不算已连接', () => {
  const { socket, events, instances } = socketHarness();
  socket.connect();
  const live = instances.at(-1);
  live.open();
  live.deliverBinary(new Uint8Array([1, 2, 3]));
  live.deliver({ type: 'studio.changed' });
  live.onmessage({ data: '这不是 JSON' });

  assert.deepEqual(
    events,
    [
      { kind: 'state', state: 'connecting', text: '正在连接会话服务…' },
      { kind: 'state', state: 'connected', text: undefined },
      { kind: 'binary', length: 3 },
      { kind: 'message', type: 'studio.changed' },
    ],
    '无法解析的文本被丢弃，不应抛出',
  );
});

test('重连后旧连接的回调一律丢弃，避免过期状态覆盖新连接', () => {
  const { socket, events, instances } = socketHarness();
  socket.connect();
  const stale = instances.at(-1);
  socket.connect();
  const fresh = instances.at(-1);
  assert.notEqual(stale, fresh);
  assert.equal(stale.closed.code, 1000, '旧连接必须被主动关闭');

  const before = events.length;
  stale.deliver({ type: 'studio.changed' });
  stale.deliverBinary(new Uint8Array([9]));
  stale.fire(1006);
  assert.equal(events.length, before, '旧连接的任何回调都不得生效');

  fresh.open();
  fresh.deliver({ type: 'terminal.ready' });
  assert.deepEqual(events.at(-1), { kind: 'message', type: 'terminal.ready' });
});

test('非正常关闭自动重连，主动断开不重连', async () => {
  const { socket, instances } = socketHarness({ reconnectDelayMs: 1 });
  socket.connect();
  instances.at(-1).fire(1006);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instances.length, 2, '异常关闭应重新连接');

  socket.disconnect('用户切换');
  assert.equal(instances.at(-1).closed.reason, '用户切换');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instances.length, 2, '主动断开后不应再建连接');
});

test('未连接时发送被丢弃而不是抛错', () => {
  const { socket, instances } = socketHarness();
  assert.equal(socket.send({ type: 'x' }), false);
  socket.connect();
  assert.equal(socket.send({ type: 'x' }), false, '未 open 前不发送');
  instances.at(-1).open();
  assert.equal(socket.send({ type: 'x' }), true);
  assert.deepEqual(JSON.parse(instances.at(-1).sent[0]), { type: 'x' });
});

test('只有连续序号且当前 pane 无关时才跳过重拉', () => {
  const { StudioStore } = load('store');
  const store = StudioStore.create({});

  // 第一条无从判断是否连续，必须重拉。
  assert.equal(store.skippable({ scope: 'outbox', seq: 5, paneIds: ['p2'] }, 'p1'), false);
  assert.equal(store.cursor, 5);
  assert.equal(store.skippable({ scope: 'outbox', seq: 6, paneIds: ['p2'] }, 'p1'), true);
  assert.equal(
    store.skippable({ scope: 'outbox', seq: 7, paneIds: ['p1'] }, 'p1'),
    false,
    '涉及当前 pane 必须重拉',
  );
  assert.equal(
    store.skippable({ scope: 'outbox', seq: 20, paneIds: ['p2'] }, 'p1'),
    false,
    '序号断档必须重拉',
  );
  assert.equal(store.skippable({ scope: 'outbox', seq: 21, paneIds: ['p2'] }, 'p1'), true);
});

test('无载荷通知与未选中会话一律重拉', () => {
  const { StudioStore } = load('store');
  const store = StudioStore.create({});
  store.advance(1);
  assert.equal(
    store.skippable({ type: 'studio.changed' }, 'p1'),
    false,
    'Herdr 与存档变更没有载荷',
  );
  assert.equal(
    store.skippable({ scope: 'outbox', seq: 2, paneIds: ['p2'] }, ''),
    false,
    '没有选中会话时无从判断',
  );
  assert.equal(store.skippable(null, 'p1'), false);
  assert.equal(store.skippable({ scope: 'outbox', seq: 3 }, 'p1'), false, '缺少 paneIds 不能跳过');
});

test('游标重置后重新等待连续序号', () => {
  const { StudioStore } = load('store');
  const store = StudioStore.create({});
  store.advance(4);
  assert.equal(store.skippable({ scope: 'outbox', seq: 5, paneIds: ['p2'] }, 'p1'), true);
  store.resetCursor();
  assert.equal(store.cursor, 0);
  assert.equal(
    store.skippable({ scope: 'outbox', seq: 6, paneIds: ['p2'] }, 'p1'),
    false,
    '重置后第一条必须重拉',
  );
});

test('订阅收到变更，单个监听器出错不影响其他监听器', () => {
  const { StudioStore } = load('store');
  const state = { chatPaneId: 'p1' };
  const store = StudioStore.create(state);
  const seen = [];
  const stop = store.subscribe(() => {
    throw new Error('监听器故障');
  });
  store.subscribe((change, current) => seen.push({ change, paneId: current.chatPaneId }));

  store.notify({ kind: 'outbox' });
  assert.deepEqual(seen, [{ change: { kind: 'outbox' }, paneId: 'p1' }]);
  stop();
  store.notify({ kind: 'second' });
  assert.equal(seen.length, 2);
  assert.equal(store.state, state, '状态对象保持同一个引用');
});

test('terminal acknowledgements wait for consumer completion in arrival order and ignore retired sockets', async () => {
  let first, second;
  const waiting = [
    new Promise((resolve) => {
      first = resolve;
    }),
    new Promise((resolve) => {
      second = resolve;
    }),
  ];
  const { socket, instances } = socketHarness({ onBinary: () => waiting.shift() });
  socket.connect();
  const live = instances.at(-1);
  live.open();
  live.deliver({ type: 'terminal.flow', streamId: 'one', offset: 1 });
  live.deliverBinary(new Uint8Array([1]));
  live.deliver({ type: 'terminal.flow', streamId: 'one', offset: 2 });
  live.deliverBinary(new Uint8Array([2]));
  second();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(live.sent.length, 0);
  first();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    live.sent.map((value) => JSON.parse(value).offset),
    [1, 2],
  );
  socket.disconnect();
});

test('structured snapshots acknowledge rendering completion and ignore retired connections', async () => {
  let done;
  const pending = new Promise((resolve) => {
    done = resolve;
  });
  const { socket, instances } = socketHarness({ onMessage: () => pending });
  socket.connect();
  const live = instances.at(-1);
  live.open();
  live.deliver({ type: 'terminal.screen', flow: 'snapshot', observerId: 'o', revision: 7 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(live.sent.length, 0);
  done();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(JSON.parse(live.sent[0]), {
    type: 'terminal.screen.ack',
    observerId: 'o',
    revision: 7,
  });
  socket.disconnect();
});
test('a new terminal stream acknowledges independently of a stalled or failed old parser', async () => {
  let failOld;
  const old = new Promise((resolve, reject) => {
    failOld = reject;
  });
  const { socket, instances } = socketHarness({
    onBinary: (bytes) => (bytes[0] === 1 ? old : undefined),
  });
  socket.connect();
  const live = instances.at(-1);
  live.open();
  live.deliver({ type: 'terminal.flow', streamId: 'old', offset: 1 });
  live.deliverBinary(new Uint8Array([1]));
  live.deliver({ type: 'terminal.flow', streamId: 'new', offset: 1 });
  live.deliverBinary(new Uint8Array([2]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(live.sent.map(JSON.parse), [
    { type: 'terminal.ack', streamId: 'new', offset: 1 },
  ]);
  failOld(new Error('Disposed old parser'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(live.closed, undefined);
  socket.disconnect();
});
test('a legacy overload close automatically reconnects instead of permanently pausing', async () => {
  const { socket, instances } = socketHarness({ reconnectDelayMs: 1 });
  socket.connect();
  instances.at(-1).fire(4008);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(instances.length, 2);
  socket.disconnect();
});
test('temporary terminal failures reconnect, while policy or authentication rejection waits for user action', async () => {
  for (const code of [1013, 1008, 4001, 4003]) {
    const { socket, instances } = socketHarness({ reconnectDelayMs: 1 });
    socket.connect();
    instances.at(-1).fire(code);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(instances.length, code === 1013 ? 2 : 1);
    socket.disconnect();
  }
});
test('request deadlines are localized, including timeouts while consuming the response body', async () => {
  const { StudioApi } = load('api');
  for (const body of [false, true]) {
    const client = StudioApi.create({
      deviceId: 'd',
      getToken: () => '',
      timeoutMs: 5,
      fetchImpl: async (_, options) => {
        const pending = () =>
          new Promise((_, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            }),
          );
        return body ? { ok: true, status: 200, json: pending } : pending();
      },
    });
    // Keep the process alive while AbortSignal.timeout's unreferenced timer runs.
    const keep = setTimeout(() => {}, 100);
    try {
      await assert.rejects(
        client.call('/x'),
        (e) => e.code === 'REQUEST_TIMEOUT' && !e.message.includes('signal timed out'),
      );
    } finally {
      clearTimeout(keep);
    }
  }
});
test('invalid successful JSON responses cannot be mistaken for saved settings', async () => {
  const { StudioApi } = load('api');
  const client = StudioApi.create({
    deviceId: 'd',
    getToken: () => '',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('truncated');
      },
    }),
  });
  await assert.rejects(client.call('/x'), { code: 'INVALID_RESPONSE' });
});

test('multiplexed acknowledgements remain ordered per stream when background and foreground interleave', async () => {
  let finish;
  const stalled = new Promise((resolve) => {
    finish = resolve;
  });
  const { socket, instances } = socketHarness({
    onBinary: (bytes) => (bytes[0] === 1 ? stalled : undefined),
  });
  socket.connect();
  const live = instances.at(-1);
  live.open();
  for (const [streamId, subscriptionId, offset, byte] of [
    ['a', 1, 1, 1],
    ['b', 2, 1, 2],
    ['a', 1, 2, 3],
    ['b', 2, 2, 4],
  ]) {
    live.deliver({ type: 'terminal.flow', streamId, subscriptionId, offset });
    live.deliverBinary(new Uint8Array([byte]));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    live.sent.map(JSON.parse).map((row) => [row.streamId, row.offset]),
    [
      ['b', 1],
      ['b', 2],
    ],
  );
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    live.sent.map(JSON.parse).map((row) => [row.streamId, row.offset]),
    [
      ['b', 1],
      ['b', 2],
      ['a', 1],
      ['a', 2],
    ],
  );
  socket.disconnect();
});
