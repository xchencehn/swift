'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { DocumentPreview } = require('../lib/document-preview');
const { safeFile, listable } = require('../lib/doc-files');

test('Office 转换去重缓存，并在源文件变化时拒绝旧页码版本；临时副本始终清理', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-preview-unit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, '中文 空格.docx');
  await fs.writeFile(file, 'fixture');
  let conversions = 0;
  const directories = new Set();
  const preview = new DocumentPreview({
    run: async (directory, program) => {
      directories.add(directory);
      if (program.endsWith('libreoffice')) {
        conversions++;
        await fs.writeFile(path.join(directory, 'input.pdf'), '%PDF-fixture');
        return '';
      }
      if (program.endsWith('pdfinfo')) return 'Pages: 2\n';
      await fs.writeFile(path.join(directory, 'page.png'), 'page');
      return '';
    },
  });
  const original = safeFile(root, file);
  const [first, duplicate] = await Promise.all([preview.get(original), preview.get(original)]);
  assert.strictEqual(first, duplicate);
  assert.equal(conversions, 1);
  assert.equal(first.pages, 2);
  assert.equal((await preview.page(original, 2, first.version)).toString(), 'page');
  await assert.rejects(preview.page(original, 3, first.version), { code: 'BAD_PAGE' });
  await assert.rejects(preview.page(original, 1.1, first.version), { code: 'BAD_PAGE' });
  await fs.writeFile(file, 'changed fixture');
  const changed = safeFile(root, file);
  await assert.rejects(preview.page(changed, 1, first.version), { code: 'FILE_CHANGED' });
  const stale = new DocumentPreview();
  await assert.rejects(stale.get(original), { code: 'FILE_CHANGED' });
  for (const directory of directories) await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('转换缺失或失败可以重试，缓存与输入有界，不把二进制当文本', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-preview-unit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'test.pdf');
  await fs.writeFile(file, '%PDF-fixture');
  let failed = true,
    directory;
  const preview = new DocumentPreview({
    maxBytes: 1,
    run: async (dir) => {
      directory = dir;
      if (failed) throw new Error('fixture failure');
      return 'Pages: 1\n';
    },
  });
  await assert.rejects(preview.get(safeFile(root, file)), /fixture failure/);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.equal(preview.cache.size, 0);
  failed = false;
  await preview.get(safeFile(root, file));
  assert.equal(preview.cache.size, 0);
  assert.equal(preview.bytes, 0);
  const huge = await fs.open(file, 'w');
  await huge.truncate(32 * 1024 * 1024 + 1);
  await huge.close();
  await assert.rejects(preview.get(safeFile(root, file)), { code: 'TOO_LARGE' });
  for (const ext of ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'MP4', 'mp3', 'pdf', 'png'])
    assert(listable('x.' + ext));
  assert(!listable('measurements.csv'));
  assert(!listable('code.js'));
});

test('拒绝转换输出的符号链接，避免转换器引导宿主读取其他文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-preview-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'input.docx'),
    outside = path.join(root, 'unrelated');
  await fs.writeFile(original, 'fixture');
  await fs.writeFile(outside, 'fixture-private');
  const preview = new DocumentPreview({
    run: async (directory) => {
      await fs.symlink(outside, path.join(directory, 'input.pdf'));
      return '';
    },
  });
  await assert.rejects(preview.get(safeFile(root, original)), { code: 'PREVIEW_FAILED' });
  assert.equal(preview.cache.size, 0);
});

test('容器预览服务只传递本次文档副本，并使用独立认证和原位输出', async (t) => {
  const http = require('node:http');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-preview-helper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = path.join(root, 'key');
  await fs.writeFile(key, 'fixture-key', { mode: 0o600 });
  await fs.writeFile(path.join(root, 'input.docx'), 'fixture-input');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const bytes of req) chunks.push(bytes);
    calls.push({
      url: req.url,
      authorization: req.headers.authorization,
      request: JSON.parse(Buffer.concat(chunks)),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: Buffer.from('fixture-pdf').toString('base64'), text: '' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const previous = [
    process.env.SWIFT_PREVIEW_HELPER_URL,
    process.env.SWIFT_PREVIEW_HELPER_KEY_FILE,
  ];
  process.env.SWIFT_PREVIEW_HELPER_URL = 'http://127.0.0.1:' + server.address().port;
  process.env.SWIFT_PREVIEW_HELPER_KEY_FILE = key;
  const globalAgent = http.globalAgent;
  http.globalAgent = new http.Agent();
  http.globalAgent.addRequest = () => {
    throw new Error('Private preview used the global proxy agent');
  };
  try {
    await require('../lib/document-preview').helper(root, '/usr/bin/libreoffice', [
      '/work/input.docx',
    ]);
    assert.equal(await fs.readFile(path.join(root, 'input.pdf'), 'utf8'), 'fixture-pdf');
    assert.equal(calls[0].url, '/run');
    assert.equal(calls[0].authorization, 'Bearer fixture-key');
    assert.deepEqual(calls[0].request, {
      command: 'libreoffice',
      extension: '.docx',
      input: Buffer.from('fixture-input').toString('base64'),
    });
    await assert.rejects(require('../lib/document-preview').helper(root, '/bin/sh', []), {
      code: 'PREVIEW_UNAVAILABLE',
    });
  } finally {
    http.globalAgent = globalAgent;
    for (const [index, name] of [
      'SWIFT_PREVIEW_HELPER_URL',
      'SWIFT_PREVIEW_HELPER_KEY_FILE',
    ].entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  }
});
