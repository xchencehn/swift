'use strict';
const assert = require('node:assert/strict');
const http = require('node:http'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { once } = require('node:events'),
  { execFileSync, spawn } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { createHttp } = require('../../lib/http');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-token-java-'));
  const auth = createHttp({
    tokens: ['fixture-direct-token', 'fixture-android-token'],
    maxBodyBytes: 1024,
  });
  let redirectVisits = 0,
    requests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert(!url.searchParams.has('token'), 'HTTP credential entered URL');
    requests++;
    if (url.pathname === '/sink') {
      redirectVisits++;
      return res.end('redirected');
    }
    if (url.pathname !== '/swift/trusted/api/config' && !auth.requireAuth(req, res, url)) return;
    if (url.pathname === '/swift/redirect/api/config') {
      res.writeHead(302, { location: '/sink' });
      return res.end();
    }
    if (url.pathname === '/swift/html/api/config') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html>wrong service</html>');
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      url.pathname === '/swift/large/api/config'
        ? 'x'.repeat(1024 * 1024 + 1)
        : JSON.stringify({ ok: true }),
    );
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!auth.isAuthorized(req, new URL(req.url, 'http://localhost'))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(data)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    execFileSync('javac', [
      '-d',
      temp,
      path.join(
        __dirname,
        '../../android/app/src/connection/java/io/agentstudio/connection/TokenConnection.java',
      ),
      path.join(__dirname, 'fixtures/TokenClient.java'),
    ]);
    const base = `http://127.0.0.1:${server.address().port}/swift`;
    const child = spawn('java', ['-cp', temp, 'TokenClient', base], { stdio: 'inherit' });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(redirectVisits, 0);
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/terminal', {
      headers: { 'x-agent-studio-token': 'fixture-direct-token' },
    });
    await once(ws, 'open');
    ws.send('isolated-terminal-input');
    const [body] = await once(ws, 'message');
    assert.equal(body.toString(), 'isolated-terminal-input');
    ws.close();
    await once(ws, 'close');
    await new Promise((resolve, reject) => {
      const denied = new WebSocket(base.replace(/^http/, 'ws') + '/api/terminal', {
        headers: { 'x-agent-studio-token': 'wrong-token' },
      });
      denied.on('open', () => reject(Error('Invalid WebSocket token accepted')));
      denied.on('error', (e) => (/401/.test(e.message) ? resolve() : reject(e)));
    });
    console.log(
      `PASS: HTTP requests=${requests}, redirect credentials not forwarded, WebSocket token accepted/rejected`,
    );
  } finally {
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
