'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  path = require('node:path');
const { once } = require('node:events'),
  WebSocket = require('ws');
const { createTerminalTransport } = require('../lib/terminal-transport');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(20);
  }
  throw new Error('fixture timed out');
}
test(
  'PTY output pauses on consumer credit while control messages remain responsive and an ACK resumes it',
  { timeout: 15000 },
  async () => {
    const server = http.createServer();
    let controls = 0;
    const transport = createTerminalTransport({
      server,
      herdr: {
        bin: path.join(__dirname, '../scripts/testing/raw-terminal-fixture.js'),
        session: 'flow-fixture',
        env: (extra) => ({ ...process.env, ...extra }),
      },
      basePath: '',
      maxInputBytes: 65536,
      isAuthorized: () => true,
      getCwd: () => process.env.HOME,
      onSync: () => controls++,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/terminal?flow=ack`);
    let latest = null,
      bytes = 0,
      acknowledge = false;
    ws.on('message', (data, binary) => {
      if (binary) {
        bytes += data.length;
        if (acknowledge && latest) ws.send(JSON.stringify({ ...latest, type: 'terminal.ack' }));
      } else {
        const frame = JSON.parse(String(data));
        if (frame.type === 'terminal.flow') latest = frame;
      }
    });
    try {
      await once(ws, 'open');
      await until(() => latest != null);
      acknowledge = true;
      ws.send(JSON.stringify({ ...latest, type: 'terminal.ack' }));
      await delay(50);
      acknowledge = false;
      latest = null;
      bytes = 0;
      for (let i = 0; i < 20; i++)
        ws.send(JSON.stringify({ type: 'terminal.input', data: 'x'.repeat(32000) }));
      await until(() => bytes >= 256 * 1024);
      const stoppedAt = bytes;
      await delay(100);
      assert.equal(bytes, stoppedAt);
      assert(bytes < 1024 * 1024);
      ws.send(JSON.stringify({ type: 'sync.ping' }));
      await until(() => controls === 1);
      acknowledge = true;
      ws.send(JSON.stringify({ ...latest, type: 'terminal.ack' }));
      await until(() => bytes > 600000);
      assert.equal(ws.readyState, WebSocket.OPEN);
    } finally {
      ws.terminate();
      transport.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
