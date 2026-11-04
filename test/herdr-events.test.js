'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HerdrEvents } = require('../lib/herdr-events.js');

/**
 * 用一个假的 Herdr socket 验证事件通道。
 *
 * 🔑 为什么不对着真实 Herdr 测:那台机器上跑着真实会话,要制造一次状态跳变就得
 * 动别人的 pane;而且「等一个事件自己发生」不可重复。假 server 让我们能精确地
 * 发出该发的那几条,包括那些**不该触发刷新**的(订阅确认、错误帧)。
 */
function withFakeHerdr(handler, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-events-'));
  const sock = path.join(dir, 'herdr.sock');
  const server = net.createServer((connection) => handler(connection));
  return new Promise((resolve, reject) => {
    server.listen(sock, async () => {
      const previous = process.env.HERDR_SOCKET_PATH;
      process.env.HERDR_SOCKET_PATH = sock;
      try {
        await run(sock);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
        else process.env.HERDR_SOCKET_PATH = previous;
        server.close();
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    });
  });
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

test('逐 pane 订阅：pane 集合原样进订阅请求', async () => {
  let request = null;
  await withFakeHerdr(
    (connection) => {
      connection.on('data', (chunk) => {
        request = JSON.parse(String(chunk).trim());
      });
    },
    async () => {
      const events = new HerdrEvents({
        listPaneIds: async () => ['wA:p1', 'wB:p2'],
        onChange: () => {},
      });
      events.start();
      await settle(200);
      events.stop();
    },
  );
  assert.ok(request, '应当发出订阅请求');
  assert.equal(request.method, 'events.subscribe');
  const types = request.params.subscriptions.map((item) => item.type);
  // 🔑 pane.agent_status_changed 没有通配,每个 pane 必须各来一条
  const perPane = request.params.subscriptions.filter(
    (item) => item.type === 'pane.agent_status_changed',
  );
  assert.deepEqual(
    perPane.map((item) => item.pane_id),
    ['wA:p1', 'wB:p2'],
  );
  // pane.created 是「该重订了」的信号,不能漏
  assert.ok(types.includes('pane.created'));
  for (const type of [
    'workspace.renamed',
    'tab.renamed',
    'tab.moved',
    'pane.updated',
    'workspace.focused',
    'layout.updated',
  ]) {
    assert.ok(types.includes(type), `runtime state changes must include ${type}`);
  }
});

test('native event envelope schedules subscription refresh after pane creation', () => {
  let changes = 0,
    refreshes = 0;
  const events = new HerdrEvents({ listPaneIds: async () => [], onChange: () => changes++ });
  events.scheduleResubscribe = () => refreshes++;
  events.consume(`${JSON.stringify({ event: 'pane_created', data: { pane_id: 'pane_2' } })}\n`);
  assert.equal(changes, 1);
  assert.equal(refreshes, 1);
  events.stop();
});

test('订阅确认不算变更，事件才算', async () => {
  let changes = 0;
  await withFakeHerdr(
    (connection) => {
      connection.on('data', () => {
        // 先回订阅确认 —— 它不是变更,不该触发刷新
        connection.write(
          `${JSON.stringify({ id: 'x', result: { type: 'subscription_started' } })}\n`,
        );
        // 再来一条真的事件
        connection.write(
          `${JSON.stringify({ method: 'event', params: { type: 'pane.agent_status_changed', pane_id: 'wA:p1', agent_status: 'working' } })}\n`,
        );
      });
    },
    async () => {
      const events = new HerdrEvents({
        listPaneIds: async () => ['wA:p1'],
        onChange: () => {
          changes += 1;
        },
      });
      events.start();
      await settle(250);
      events.stop();
    },
  );
  assert.equal(changes, 1, '只有那条真事件该触发刷新');
});

test('半行到达也能正确切分（NDJSON 不保证按行到）', async () => {
  let changes = 0;
  await withFakeHerdr(
    (connection) => {
      connection.on('data', () => {
        const line = `${JSON.stringify({ params: { type: 'pane.agent_status_changed' } })}\n`;
        // 故意把一条消息劈成两半分别发出
        connection.write(line.slice(0, 12));
        setTimeout(() => connection.write(line.slice(12)), 40);
      });
    },
    async () => {
      const events = new HerdrEvents({
        listPaneIds: async () => [],
        onChange: () => {
          changes += 1;
        },
      });
      events.start();
      await settle(280);
      events.stop();
    },
  );
  assert.equal(changes, 1, '拼起来才是一条,不该丢也不该重');
});

test('错误帧只记日志，不触发刷新', async () => {
  let changes = 0;
  const logs = [];
  await withFakeHerdr(
    (connection) => {
      connection.on('data', () => {
        connection.write(
          `${JSON.stringify({ id: 'x', error: { code: 'unsupported', message: 'nope' } })}\n`,
        );
      });
    },
    async () => {
      const events = new HerdrEvents({
        listPaneIds: async () => [],
        onChange: () => {
          changes += 1;
        },
        onLog: (message) => logs.push(message),
      });
      events.start();
      await settle(250);
      events.stop();
    },
  );
  assert.equal(changes, 0, '错误不是变更');
  assert.ok(
    logs.some((line) => line.includes('nope')),
    '但要留下痕迹',
  );
});

test('socket 不存在时安静退避，不抛异常', async () => {
  const previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = path.join(os.tmpdir(), 'herdr-events-absent', 'herdr.sock');
  const logs = [];
  const events = new HerdrEvents({
    listPaneIds: async () => [],
    onChange: () => {},
    onLog: (m) => logs.push(m),
  });
  events.start();
  await settle(150);
  events.stop();
  if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = previous;
  // Herdr 没在跑在开发机上很常见,不该把服务端拖垮
  assert.ok(logs.some((line) => line.includes('socket not present')));
});
