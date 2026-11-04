'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  path = require('node:path'),
  { once } = require('node:events'),
  WebSocket = require('ws');
const { createTerminalTransport } = require('../lib/terminal-transport');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(20);
  }
  throw new Error('structured fixture timed out');
}
test(
  'real structured observer survives a suspended renderer, sends no terminal bytes and resumes the latest status',
  { timeout: 15000 },
  async () => {
    const server = http.createServer();
    let controls = 0;
    const transport = createTerminalTransport({
      server,
      herdr: {
        bin: path.join(__dirname, '../scripts/testing/structured-observer-fixture.js'),
        session: 'structured-fixture',
        env: (extra) => ({ ...process.env, ...extra }),
      },
      basePath: '',
      maxInputBytes: 65536,
      isAuthorized: () => true,
      getCwd: () => process.env.HOME,
      onSync: () => {
        controls++;
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/api/terminal?observe=1&screen=structured&flow=ack`,
    );
    const frames = [],
      binary = [];
    let bytes = 0;
    ws.on('message', (data, isBinary) => {
      bytes += data.length;
      if (isBinary) binary.push(data.length);
      else frames.push(JSON.parse(String(data)));
    });
    try {
      await once(ws, 'open');
      ws.send(
        JSON.stringify({
          type: 'terminal.observe',
          terminalId: 'fixture-terminal',
          binding: 'p:s',
          requestId: 'request',
        }),
      );
      await until(() => frames.some((f) => f.type === 'terminal.screen'));
      const initial = frames.find((f) => f.type === 'terminal.screen');
      await delay(2250);
      assert.equal(ws.readyState, WebSocket.OPEN);
      assert.equal(frames.filter((f) => f.type === 'terminal.screen').length, 1);
      assert.deepEqual(binary, []);
      assert(bytes < 2000, 'only projected state, not full VT redraws, should reach the browser');
      ws.send(JSON.stringify({ type: 'sync.ping' }));
      await until(() => controls > 0);
      ws.send(
        JSON.stringify({
          type: 'terminal.screen.ack',
          observerId: initial.observerId,
          revision: initial.revision,
        }),
      );
      await until(() => frames.filter((f) => f.type === 'terminal.screen').length === 2);
      const pausedBytes = bytes;
      const latest = frames.filter((f) => f.type === 'terminal.screen').at(-1);
      assert(latest.revision > initial.revision + 5);
      assert.equal(latest.requestId, 'request');
      assert.deepEqual(latest.rows, []);
      assert(latest.projection.recognized);
      const fs = require('node:fs');
      const out = path.join(
        __dirname,
        '../artifacts/tasks/021-chat-scroll-focus/network-integration.json',
      );
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        JSON.stringify(
          {
            ok: true,
            suspendedMs: 2250,
            screenFramesWhileSuspended: 1,
            binaryFrames: binary.length,
            wireBytesThroughResume: pausedBytes,
            revisionDelta: latest.revision - initial.revision,
            connectionOpen: ws.readyState === WebSocket.OPEN,
          },
          null,
          2,
        ),
      );
    } finally {
      ws.terminate();
      transport.close();
      await new Promise((r) => server.close(r));
    }
  },
);
