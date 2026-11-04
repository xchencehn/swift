'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const http = require('node:http'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { once } = require('node:events'),
  WebSocket = require('ws');
const { createTerminalTransport } = require('../lib/terminal-transport');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (screen) => screen.rows.map((row) => row.map((span) => span.text).join('')).join('\n');
async function until(check) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await delay(20);
  }
  throw new Error('observer fixture timed out');
}

test(
  '只读观察发布完整 VT 快照，重绑与重连不复用旧观察连接，退出前保留最后一帧',
  { timeout: 15000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-observer-'));
    const bin = path.join(dir, 'herdr-fixture');
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
const id = process.argv[process.argv.indexOf('observe') + 1];
const frame = (data, full = false) => process.stdout.write(JSON.stringify({type:'terminal.frame', encoding:'ansi', full, bytes:Buffer.from(data).toString('base64')})+'\\n');
process.stdin.on('data', () => frame('UNEXPECTED INPUT'));
frame('\\x1b[H'+id+' 中A\\x1b[6n', true);
if (id === 'w1:ended') {
  setTimeout(() => { frame('\\x1b[2J\\x1b[HFinal connection failure'); process.stdout.write(JSON.stringify({type:'terminal.closed'})+'\\n'); }, 60);
} else {
  setTimeout(() => frame('\\x1b[1;'+(id.length+4)+'HB'), 60);
}
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const server = http.createServer();
    const transport = createTerminalTransport({
      server,
      herdr: { bin, env: (extra) => ({ ...process.env, ...extra }) },
      basePath: '',
      maxInputBytes: 65536,
      isAuthorized: () => true,
      getCwd: () => dir,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `ws://127.0.0.1:${server.address().port}/api/terminal?observe=1`;
    const sockets = [];
    async function connect() {
      const messages = [],
        ws = new WebSocket(url);
      sockets.push(ws);
      ws.on('message', (raw, binary) => {
        if (!binary) messages.push(JSON.parse(String(raw)));
      });
      await once(ws, 'open');
      await until(() => messages.some((m) => m.type === 'terminal.ready'));
      return {
        ws,
        messages,
        observe: (terminalId, binding) =>
          ws.send(JSON.stringify({ type: 'terminal.observe', terminalId, binding })),
      };
    }
    try {
      const first = await connect();
      first.observe('w1:p1', 'pane:session-A');
      await until(() =>
        first.messages.some((m) => m.type === 'terminal.screen' && text(m).includes('中B')),
      );
      const full = first.messages.find((m) => m.type === 'terminal.observe.full');
      const screen = first.messages.findLast((m) => m.type === 'terminal.screen');
      assert.equal(screen.observerId, full.observerId);
      assert.equal(screen.binding, 'pane:session-A');
      assert.equal(text(screen), 'w1:p1 中B');
      assert.equal(screen.projection.recognized, false);
      first.ws.send(JSON.stringify({ type: 'terminal.input', data: 'forbidden probe' }));
      await delay(80);
      assert(
        !first.messages.some((m) => m.type === 'terminal.screen' && text(m).includes('UNEXPECTED')),
      );

      first.observe('w1:p1', 'pane:session-B');
      await until(() =>
        first.messages.some((m) => m.type === 'terminal.screen' && m.binding === 'pane:session-B'),
      );
      const rebound = first.messages.findLast((m) => m.type === 'terminal.observe.full');
      assert.notEqual(rebound.observerId, full.observerId);
      const boundary = first.messages.indexOf(rebound);
      await delay(120);
      assert(
        first.messages
          .slice(boundary)
          .filter((m) => m.type === 'terminal.screen')
          .every((m) => m.observerId === rebound.observerId),
      );

      first.ws.close();
      await once(first.ws, 'close');
      const second = await connect();
      second.observe('w1:ended', 'pane:session-C');
      await until(() => second.messages.some((m) => m.type === 'terminal.observe.ended'));
      const end = second.messages.find((m) => m.type === 'terminal.observe.ended');
      const last = second.messages.findLast((m) => m.type === 'terminal.screen');
      assert.notEqual(last.observerId, rebound.observerId);
      assert.equal(end.observerId, last.observerId);
      assert.equal(last.binding, 'pane:session-C');
      assert.equal(text(last), 'Final connection failure');
      assert(second.messages.indexOf(last) < second.messages.indexOf(end));
      await until(() => [...transport.clients].every((ws) => !ws.observer));
    } finally {
      for (const ws of sockets) ws.terminate();
      transport.close();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
