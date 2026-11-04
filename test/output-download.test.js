'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { Router } = require('../lib/http/router');
test('download preserves binary bytes and Chinese names, and rejects stale sessions, escaping paths, symlinks and oversized files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '结果 空格.zip'),
    bytes = Buffer.from([0, 255, 128, 80, 75, 3, 4]);
  fs.writeFileSync(file, bytes);
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const router = new Router({
    json,
    sendError: (res, e) => json(res, e.status || 500, { message: e.message }),
  });
  require('../lib/http/routes/doc-files').register(router, {
    currentRoot: () => ({ data: { directory: dir } }),
    exactPane: async () => ({
      paneId: 'p',
      cwd: dir,
      agent: { label: 'codex', session: { value: 's' } },
    }),
    paneTranscriptFile: () => '',
    json,
    apiError: (status, code, message) => Object.assign(new Error(message), { status, code }),
    securityHeaders: (headers) => headers,
    herdr: { dashboard: async () => ({ workspaces: [] }) },
  });
  const server = http.createServer(
    (req, res) => void router.dispatch(req, res, new URL(req.url, 'http://localhost')),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const get = (p, sessionId = 's') =>
    fetch(
      `http://127.0.0.1:${server.address().port}/api/doc-files/download?` +
        new URLSearchParams({ pane: 'p', sessionId, path: p }),
    );
  const response = await get(file);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert(
    response.headers.get('content-disposition').includes(encodeURIComponent(path.basename(file))),
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await get(file, 'replaced')).status, 409);
  assert.equal((await get('/etc/passwd')).status, 404);
  const alias = path.join(dir, 'alias.zip');
  fs.symlinkSync(file, alias);
  assert.equal((await get(alias)).status, 404);
  const big = path.join(dir, 'large.zip'),
    fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  assert.equal((await get(big)).status, 413);
});
test('download names keep Unicode but remove path and control characters and add image extensions', () => {
  const { fileName } = require('../public/files/image-menu');
  assert.equal(fileName('/tmp/结果.zip', 'application/octet-stream'), '结果.zip');
  assert.equal(fileName('../图\u0000', 'image/png'), '图.png');
  assert.equal(fileName('C:\\temp\\photo', 'image/jpeg'), 'photo.jpg');
});
