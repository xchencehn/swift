'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { check, readRelease } = require('../lib/server-updates');
const release = {
  version: '0.20.0',
  filename: 'swift-0.20.0-server.tar.gz',
  sha256: 'a'.repeat(64),
};
test('server update compares releases and keeps downloads in the official server channel', async () => {
  const update = await check({ version: '0.19.9', read: async () => release });
  assert.equal(update.available, true);
  assert.equal(update.currentVersion, '0.19.9');
  assert.equal(
    update.downloadUrl,
    'https://150.158.39.216:8002/desktop/swift-0.20.0-server.tar.gz',
  );
  for (const version of ['0.20.0', '0.20.1', '1.0.0'])
    assert.equal((await check({ version, read: async () => release })).available, false);
});
test('server update rejects malformed versions, another artifact and invalid checksums', async () => {
  for (const data of [
    { ...release, version: '../0.20.0' },
    { ...release, filename: 'client.exe' },
    { ...release, sha256: 'invalid' },
  ])
    await assert.rejects(check({ read: async () => data }), /清单无效/);
});
test('server update uses the existing HTTPS proxy without sending application credentials', async () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 21) || (major === 24 && minor < 5)) return;
  const http = require('node:http');
  const server = http.createServer();
  let received;
  server.on('connect', (request, socket) => {
    received = { target: request.url, token: request.headers['x-agent-studio-token'] };
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const keys = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.HTTPS_PROXY = process.env.https_proxy = `http://127.0.0.1:${server.address().port}`;
    process.env.NO_PROXY = process.env.no_proxy = '';
    await assert.rejects(readRelease());
    assert.deepEqual(received, { target: '150.158.39.216:8002', token: undefined });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await new Promise((resolve) => server.close(resolve));
  }
});
