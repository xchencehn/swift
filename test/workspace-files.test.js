'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { WorkspaceFiles } = require('../lib/workspace-files');
async function tree(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-workspace-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('目录只列一层、目录优先、自然排序，重复并发读取复用结果且目录变化使缓存失效', async (t) => {
  const root = await tree(t),
    files = new WorkspaceFiles();
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'folder/nested.md'), '# 不应读到');
  for (const name of ['file10.txt', 'file2.txt', '.hidden', 'auth.json'])
    await fs.writeFile(path.join(root, name), 'fixture');
  const [a, b] = await Promise.all([files.list(root), files.list(root)]);
  assert.equal(a, b);
  assert.deepEqual(
    a.entries.map((entry) => entry.name),
    ['folder', '.hidden', 'auth.json', 'file2.txt', 'file10.txt'],
  );
  assert.equal(a.entries.find((entry) => entry.name === 'auth.json').type, 'other');
  const previous = await fs.stat(root);
  await fs.writeFile(path.join(root, 'new.md'), '# 新文件');
  // 文件系统时间戳可能在同一时钟刻度内不变；明确推进元数据，验证缓存失效条件。
  await fs.utimes(root, previous.atime, new Date(previous.mtimeMs + 1000));
  const fresh = await files.list(root);
  assert.notEqual(fresh.revision, a.revision);
  assert(fresh.entries.some((entry) => entry.name === 'new.md'));
  assert.equal(files.pending.size, 0);
});
test('数量上限、空目录、目录删除和非目录有明确结果', async (t) => {
  const root = await tree(t),
    files = new WorkspaceFiles({ maxEntries: 1, ttlMs: 0 });
  assert.deepEqual((await files.list(root)).entries, []);
  await fs.writeFile(path.join(root, 'a.md'), '# A');
  await fs.writeFile(path.join(root, 'b.md'), '# B');
  const listing = await files.list(root);
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.truncated, true);
  await assert.rejects(files.list(root, path.join(root, 'a.md')), { code: 'NOT_DIRECTORY' });
  await assert.rejects(files.list(root, path.join(root, 'missing')), { code: 'NOT_FOUND' });
});
test('越界、符号链接和私人配置不能绕过根目录，内部目录链接可以列出', async (t) => {
  const root = await tree(t),
    outside = await tree(t),
    files = new WorkspaceFiles();
  await fs.writeFile(path.join(outside, 'outside.md'), '# 外部');
  await fs.mkdir(path.join(root, 'docs'));
  await fs.symlink(outside, path.join(root, 'escape'));
  await fs.symlink(path.join(root, 'docs'), path.join(root, 'internal'));
  await fs.writeFile(path.join(root, 'auth.json'), 'fixture-secret');
  await fs.symlink(path.join(root, 'auth.json'), path.join(root, 'alias.md'));
  await assert.rejects(files.list(root, outside), { code: 'OUTSIDE_ROOT' });
  await assert.rejects(files.list(root, path.join(root, 'escape')), { code: 'OUTSIDE_ROOT' });
  assert.equal((await files.list(root, path.join(root, 'internal'))).entries.length, 0);
  await assert.rejects(files.content(root, path.join(root, 'auth.json')), { code: 'PRIVATE_FILE' });
  await assert.rejects(files.content(root, path.join(root, 'alias.md')), { code: 'PRIVATE_FILE' });
  await assert.rejects(files.content(root, path.join(root, '../outside.md')), {
    code: 'OUTSIDE_ROOT',
  });
  await assert.rejects(files.content(root, 'relative.md'), { code: 'INVALID_PATH' });
});
test('有界 UTF-8 读取不割断中文，二进制不显示为文本，HTML 拒绝截断', async (t) => {
  const root = await tree(t),
    files = new WorkspaceFiles();
  const write = (name, content) => fs.writeFile(path.join(root, name), content);
  await write('large.md', '中'.repeat(180000));
  await write('binary.bin', Buffer.from([0, 1, 2]));
  await write('broken.txt', Buffer.from([255, 254]));
  await write('page.html', 'x'.repeat(8 * 1024 * 1024 + 1));
  await write('guide.markdown', '# 完整扩展名');
  const large = await files.content(root, path.join(root, 'large.md'));
  assert.equal(large.kind, 'markdown');
  assert.equal(large.truncated, true);
  assert(!large.text.includes('\ufffd'));
  assert(Buffer.byteLength(large.text) <= 512 * 1024);
  assert.equal((await files.content(root, path.join(root, 'binary.bin'))).kind, 'binary');
  assert.equal((await files.content(root, path.join(root, 'broken.txt'))).kind, 'binary');
  assert.equal((await files.content(root, path.join(root, 'guide.markdown'))).kind, 'markdown');
  await assert.rejects(files.content(root, path.join(root, 'page.html')), { code: 'TOO_LARGE' });
});
test('版本核验后原子保存 UTF-8 文本，保留 BOM、换行与执行权限，也能保存空文件', async (t) => {
  const root = await tree(t),
    files = new WorkspaceFiles(),
    file = path.join(root, 'script.js');
  await fs.writeFile(file, '\ufeff// 中文\r\n', { mode: 0o755 });
  const before = await files.content(root, file);
  assert.equal(before.editable, true);
  assert.equal(before.text, '\ufeff// 中文\r\n');
  assert.match(before.revision, /^[a-f0-9]{64}$/);
  const saved = await files.write(root, file, '\ufeff// 已修改\r\n', before.revision);
  assert.equal(await fs.readFile(file, 'utf8'), '\ufeff// 已修改\r\n');
  assert.notEqual(saved.revision, before.revision);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
  assert.equal((await files.write(root, file, '', saved.revision)).text, '');
  assert.equal((await fs.stat(file)).size, 0);
});
test('外部修改和并发保存拒绝覆盖，临时文件和保存锁均被回收', async (t) => {
  const root = await tree(t),
    files = new WorkspaceFiles(),
    file = path.join(root, 'guide.md');
  await fs.writeFile(file, '# 原件');
  const original = await files.content(root, file);
  await fs.writeFile(file, '# 外部修改');
  await assert.rejects(files.write(root, file, '# 网页修改', original.revision), {
    code: 'FILE_CHANGED',
  });
  assert.equal(await fs.readFile(file, 'utf8'), '# 外部修改');
  const current = await files.content(root, file);
  const attempts = await Promise.allSettled(
    ['# A', '# B'].map((text) => files.write(root, file, text, current.revision)),
  );
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert(
    ['FILE_BUSY', 'FILE_CHANGED'].includes(
      attempts.find((result) => result.status === 'rejected').reason.code,
    ),
  );
  assert.equal(files.writing.size, 0);
  assert.deepEqual(await fs.readdir(root), ['guide.md']);
});
test('保存前再次核验根目录，路径、凭据、二进制和无效文本保护继续生效', async (t) => {
  const root = await tree(t),
    outside = await tree(t),
    files = new WorkspaceFiles(),
    file = path.join(root, 'guide.md');
  await fs.writeFile(file, '# 原件');
  const original = await files.content(root, file);
  await assert.rejects(
    files.write(root, file, '# 新内容', original.revision, () => {
      throw Object.assign(new Error('根目录已改变'), { code: 'ROOT_CHANGED' });
    }),
    { code: 'ROOT_CHANGED' },
  );
  assert.equal(await fs.readFile(file, 'utf8'), '# 原件');
  assert.deepEqual(await fs.readdir(root), ['guide.md']);
  await fs.writeFile(path.join(root, 'auth.json'), 'private');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1]));
  await fs.writeFile(path.join(outside, 'outside.md'), '# 外部');
  await fs.symlink(outside, path.join(root, 'escape'));
  const revision = 'a'.repeat(64);
  for (const [target, code] of [
    ['auth.json', 'PRIVATE_FILE'],
    ['binary.bin', 'UNSUPPORTED_FILE'],
    ['escape/outside.md', 'OUTSIDE_ROOT'],
  ])
    await assert.rejects(files.write(root, path.join(root, target), 'changed', revision), { code });
  await assert.rejects(files.write(root, file, '\ud800', revision), { code: 'INVALID_TEXT' });
  await assert.rejects(files.write(root, file, 'x\0y', revision), { code: 'INVALID_TEXT' });
  await assert.rejects(files.write(root, file, 'text', ''), { code: 'INVALID_REVISION' });
  assert.equal(await fs.readFile(path.join(outside, 'outside.md'), 'utf8'), '# 外部');
});
test('截断预览不能直接保存，显式完整读取取得版本，8 MiB 上限不被绕过', async (t) => {
  const root = await tree(t),
    files = new WorkspaceFiles(),
    file = path.join(root, 'large.md');
  await fs.writeFile(file, '中文'.repeat(100000));
  const preview = await files.content(root, file);
  assert.equal(preview.truncated, true);
  assert.equal(preview.editable, true);
  assert.equal(preview.revision, undefined);
  const full = await files.content(root, file, { full: true });
  assert.equal(full.truncated, false);
  assert.equal(full.text, '中文'.repeat(100000));
  const saved = await files.write(root, file, full.text + '\n结尾', full.revision);
  assert(saved.text.endsWith('结尾'));
  await fs.writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1));
  assert.equal((await files.content(root, file)).editable, false);
  await assert.rejects(files.content(root, file, { full: true }), { code: 'TOO_LARGE' });
  await assert.rejects(files.write(root, file, 'x'.repeat(8 * 1024 * 1024 + 1), saved.revision), {
    code: 'TOO_LARGE',
  });
});
