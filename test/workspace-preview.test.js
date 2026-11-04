'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const { Router } = require('../lib/http/router');
const { json, securityHeaders } = require('../lib/http');
const { apiError } = require('../lib/message-queue');
test('文件页分页预览复用文档服务，并核验根目录、私人文件和文件类型', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-preview-route-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['sample.pdf', 'sample.docx', 'notes.md', 'private.key'])
    await fs.writeFile(path.join(directory, name), 'fixture');
  let root = directory,
    changeRoot = false;
  const documentPreview = {
    async get(file) {
      assert(file.ino && file.dev && file.size === 7);
      assert(['pdf', 'word'].includes(file.kind));
      if (changeRoot) root = path.dirname(directory);
      return { pages: 2, version: 'fixture-v1' };
    },
    async page(file, page, version) {
      assert.equal(page, 2);
      assert.equal(version, 'fixture-v1');
      return Buffer.from('png-fixture');
    },
    async text(file, page, version) {
      assert.equal(page, 2);
      assert.equal(version, 'fixture-v1');
      return '第二页';
    },
  };
  const router = new Router({
    json,
    sendError: (res, error) => json(res, error.status || 500, { code: error.code }),
  });
  require('../lib/http/routes/workspace-files').register(router, {
    currentRoot: () => ({ data: { directory: root } }),
    json,
    securityHeaders,
    apiError,
    documentPreview,
  });
  const server = http.createServer((req, res) =>
    router.dispatch(req, res, new URL(req.url, 'http://fixture')),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (action, name, extra = {}) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/api/workspace-files/${action}?` +
        new URLSearchParams({ root: directory, path: path.join(directory, name), ...extra }),
    );
  for (const name of ['sample.pdf', 'sample.docx'])
    assert.deepEqual(await (await get('preview', name)).json(), {
      ok: true,
      pages: 2,
      version: 'fixture-v1',
    });
  assert.equal(
    await (await get('page', 'sample.pdf', { page: 2, version: 'fixture-v1' })).text(),
    'png-fixture',
  );
  assert.deepEqual(
    await (await get('text', 'sample.pdf', { page: 2, version: 'fixture-v1' })).json(),
    { ok: true, text: '第二页' },
  );
  assert.equal((await get('preview', 'private.key')).status, 403);
  assert.equal((await get('preview', 'notes.md')).status, 415);
  assert.equal((await get('preview', '../outside.pdf')).status, 403);
  changeRoot = true;
  assert.equal((await get('preview', 'sample.pdf')).status, 409);
});
