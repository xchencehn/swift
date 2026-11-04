'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const { spawn } = require('node:child_process'),
  { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
(async () => {
  const server = http.createServer(),
    wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-close-')),
    id = 'd'.repeat(64);
  fs.writeFileSync(
    path.join(directory, 'connections.json'),
    JSON.stringify({
      profiles: [
        {
          id,
          name: 'isolated',
          mode: 'direct',
          address: `http://127.0.0.1:${server.address().port}/`,
          remote_base: '',
        },
      ],
      active: id,
    }),
  );
  const child = spawn('desktop/target/debug/desktop-fixture', [directory], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const results = [];
  try {
    const [line] = await once(child.stdout, 'data'),
      ready = JSON.parse(String(line));
    const response = await fetch(ready.bootstrap, { redirect: 'manual' }),
      cookie = response.headers.get('set-cookie').split(';')[0];
    for (const mode of [1000, 1012, 1008, 4001, 'terminate']) {
      let upstream;
      wss.once('connection', (socket) => {
        upstream = socket;
      });
      const socket = new WebSocket(
        ready.origin.replace('http', 'ws') + '/e/' + id + '/api/terminal?observe=1',
        { headers: { cookie, origin: ready.origin } },
      );
      await once(socket, 'open');
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(5000) });
      if (mode === 'terminate') upstream.terminate();
      else upstream.close(mode, 'fixture reason');
      const [code, reason] = await closed;
      assert.equal(code, mode === 'terminate' ? 1011 : mode);
      if (mode !== 'terminate') assert.equal(String(reason), 'fixture reason');
      results.push({ upstream: mode, downstream: code, reason: String(reason) });
    }
    fs.mkdirSync('artifacts/testing/desktop-reconnect', { recursive: true });
    fs.writeFileSync(
      'artifacts/testing/desktop-reconnect/close-codes.json',
      JSON.stringify(results, null, 2),
    );
    console.log('PASS real Rust gateway close propagation:', JSON.stringify(results));
  } finally {
    child.kill('SIGINT');
    for (const socket of wss.clients) socket.terminate();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
