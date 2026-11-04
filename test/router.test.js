'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../lib/http/router');

function harness() {
  const sent = [];
  const router = new Router({
    json: (res, status, body) => sent.push({ kind: 'json', status, body }),
    sendError: (res, error) =>
      sent.push({ kind: 'error', code: error.code, message: error.message }),
  });
  return { router, sent };
}
const request = (method, pathname) => [{ method }, {}, new URL(`http://x${pathname}`)];

test('按方法与路径精确分发，未注册的路径交回调用方', async () => {
  const { router, sent } = harness();
  router.get('/api/a', (req, res, url) =>
    sent.push({ kind: 'hit', route: 'get-a', query: url.searchParams.get('q') }),
  );
  router.post('/api/a', () => sent.push({ kind: 'hit', route: 'post-a' }));

  assert.equal(await router.dispatch(...request('GET', '/api/a?q=1')), true);
  assert.equal(await router.dispatch(...request('POST', '/api/a')), true);
  assert.equal(
    await router.dispatch(...request('GET', '/api/missing')),
    false,
    '未注册的路径不由路由器应答',
  );
  assert.deepEqual(sent, [
    { kind: 'hit', route: 'get-a', query: '1' },
    { kind: 'hit', route: 'post-a' },
  ]);
});

test('已知路径上的未知方法返回 405，而不是 404', async () => {
  const { router, sent } = harness();
  router.get('/api/a', () => {});
  assert.equal(await router.dispatch(...request('DELETE', '/api/a')), true);
  assert.deepEqual(sent, [
    {
      kind: 'json',
      status: 405,
      body: { ok: false, code: 'METHOD_NOT_ALLOWED', message: '不支持这个请求方法。' },
    },
  ]);
});

test('处理函数抛错统一走错误响应，同步和异步都覆盖', async () => {
  const { router, sent } = harness();
  router.get('/api/sync', () => {
    throw Object.assign(new Error('同步失败'), { code: 'SYNC' });
  });
  router.get('/api/async', async () => {
    throw Object.assign(new Error('异步失败'), { code: 'ASYNC' });
  });
  await router.dispatch(...request('GET', '/api/sync'));
  await router.dispatch(...request('GET', '/api/async'));
  assert.deepEqual(sent, [
    { kind: 'error', code: 'SYNC', message: '同步失败' },
    { kind: 'error', code: 'ASYNC', message: '异步失败' },
  ]);
});

test('一个处理函数可注册到多个路径与多个方法', async () => {
  const { router, sent } = harness();
  router.add(['GET', 'POST'], ['/api/x', '/api/x/detail'], (req, res, url) =>
    sent.push({ method: req.method, path: url.pathname }),
  );
  for (const [method, path] of [
    ['GET', '/api/x'],
    ['POST', '/api/x'],
    ['GET', '/api/x/detail'],
  ]) {
    assert.equal(await router.dispatch(...request(method, path)), true);
  }
  assert.deepEqual(sent, [
    { method: 'GET', path: '/api/x' },
    { method: 'POST', path: '/api/x' },
    { method: 'GET', path: '/api/x/detail' },
  ]);
});

test('重复注册同一方法与路径立即报错，避免静默覆盖', () => {
  const { router } = harness();
  router.get('/api/a', () => {});
  assert.throws(() => router.get('/api/a', () => {}), /重复注册路由：GET \/api\/a/);
  router.post('/api/a', () => {});
});

test('实际装配覆盖既有接口，且没有重复注册', (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-router-'));
  Object.assign(process.env, {
    SWIFT_ROOT_DIR: root,
    SWIFT_SETTINGS_FILE: path.join(root, 'settings.json'),
    SWIFT_DATA_DIR: path.join(root, 'data'),
    HERDR_SOCKET_PATH: path.join(root, 'fixture.sock'),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { server } = require('../server');
  const { apiPaths } = require('../server');
  assert(Array.isArray(apiPaths), '服务端应导出已注册的路径以便核对');
  for (const path of [
    '/api/messages',
    '/api/messages/deliver',
    '/api/messages/interrupt',
    '/api/events',
    '/api/snapshot',
    '/api/transcript',
    '/api/transcript/search',
    '/api/config',
    '/api/settings',
    '/api/profile',
    '/api/profile/image',
    '/api/health',
    '/api/history',
    '/api/history/resume',
    '/api/agent-settings',
    '/api/agent-catalog',
    '/api/session-files',
    '/api/fs/list',
    '/api/workspaces/create',
    '/api/panes/move',
  ]) {
    assert(apiPaths.includes(path), `缺少路由 ${path}`);
  }
  assert.equal(new Set(apiPaths).size, apiPaths.length, '路径不应重复');
  server.close();
});
