'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { once } = require('node:events'),
  WebSocket = require('ws');
const { createTerminalTransport } = require('../lib/terminal-transport');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(20);
  }
  throw new Error('PTY fixture timed out');
}
test(
  'Authenticated full terminal preserves control and non-UTF8 bytes, Unicode and PTY dimensions',
  { timeout: 15000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-input-')),
      bin = path.join(directory, 'terminal');
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
process.stdin.setRawMode(true);
process.stdout.write('READY\\r\\n');
process.stdin.on('data', data => process.stdout.write('HEX:' + data.toString('hex') + '\\r\\n'));
process.on('SIGWINCH', () => process.stdout.write('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'));
`,
      { mode: 0o700 },
    );
    const server = http.createServer(),
      transport = createTerminalTransport({
        server,
        herdr: { bin, env: (extra) => ({ ...process.env, ...extra }) },
        basePath: '/swift',
        maxInputBytes: 65536,
        isAuthorized: (_, url) => url.searchParams.get('token') === 'fixture',
        getCwd: () => directory,
      });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `ws://127.0.0.1:${server.address().port}/swift/api/terminal`;
    const rejected = new WebSocket(endpoint);
    rejected.on('error', () => {});
    const refusal = await new Promise((resolve) =>
      rejected.once('unexpected-response', (_, response) => {
        response.resume();
        rejected.terminate();
        resolve(response.statusCode);
      }),
    );
    assert.equal(refusal, 401);
    assert.equal(transport.controllers().length, 0);
    const ws = new WebSocket(endpoint + '?token=fixture&flow=ack');
    let text = '',
      flow;
    ws.on('message', (data, binary) => {
      if (binary) {
        text += data.toString();
        if (flow) ws.send(JSON.stringify({ ...flow, type: 'terminal.ack' }));
      } else {
        const message = JSON.parse(String(data));
        if (message.type === 'terminal.flow') flow = message;
      }
    });
    try {
      await once(ws, 'open');
      await until(() => text.includes('READY'));
      for (const value of [null, [], { type: 'terminal.input', data: { text: 'do not coerce' } }])
        ws.send(JSON.stringify(value));
      ws.send(Buffer.from([0x02, 0xff, 0x80, 0x1b]));
      await until(() => text.includes('HEX:02ff801b'));
      ws.send(JSON.stringify({ type: 'terminal.input', data: '中文\r' }));
      await until(() => text.includes('HEX:e4b8ade696870d'));
      ws.send(JSON.stringify({ type: 'terminal.resize', cols: 88, rows: 27 }));
      await until(() => text.includes('SIZE:88x27'));
      ws.close(1000);
      await once(ws, 'close');
      await until(() => transport.controllers().length === 0);
    } finally {
      ws.terminate();
      transport.close();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
