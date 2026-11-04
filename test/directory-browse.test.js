'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listDirectory, createDirectory, crumbs } = require('../lib/directory-browse');

async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-dir-'));
  await fs.mkdir(path.join(root, 'beta'));
  await fs.mkdir(path.join(root, 'alpha'));
  await fs.mkdir(path.join(root, '.hidden'));
  await fs.writeFile(path.join(root, 'note.txt'), 'x');
  return root;
}

test('只列目录,文件不是候选项', async () => {
  const root = await sandbox();
  const result = await listDirectory(root);
  const names = result.entries.map((entry) => entry.name);
  assert.deepEqual(names, ['.hidden', 'alpha', 'beta']);
  assert.ok(!names.includes('note.txt'));
});

test('隐藏目录照常返回,只做标记', async () => {
  const root = await sandbox();
  const hidden = (await listDirectory(root)).entries.find((entry) => entry.name === '.hidden');
  // .config / .claude 这些恰恰是常要进的地方,藏掉反而碍事
  assert.equal(hidden.hidden, true);
});

test('面包屑是从根到当前的完整祖先链', async () => {
  const root = await sandbox();
  const chain = crumbs(root);
  assert.equal(chain[0].path, path.parse(root).root);
  assert.equal(chain[chain.length - 1].path, root);
  // 每一级都能跳过去
  for (const crumb of chain) assert.ok(path.isAbsolute(crumb.path));
});

test('不给路径就从 home 开始', async () => {
  const result = await listDirectory();
  assert.equal(result.path, os.homedir());
});

test('相对路径拒绝 —— 它会按服务进程的工作目录解析,不是用户以为的位置', async () => {
  await assert.rejects(
    () => listDirectory('workdir'),
    (error) => error.code === 'BAD_PATH',
  );
});

test('不存在的目录与文件都报错,不返回空列表', async () => {
  const root = await sandbox();
  await assert.rejects(
    () => listDirectory(path.join(root, '并不存在')),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => listDirectory(path.join(root, 'note.txt')),
    (e) => e.code === 'NOT_DIRECTORY',
  );
});

test('根目录的 parent 是 null,不会自己指向自己', async () => {
  const result = await listDirectory(path.parse(os.homedir()).root);
  assert.equal(result.parent, null);
});

test('新建子目录只能建一级,带分隔符的一律拒绝', async () => {
  const root = await sandbox();
  const made = await createDirectory(root, '新建目录');
  assert.equal(made, path.join(root, '新建目录'));
  assert.ok((await fs.stat(made)).isDirectory());
  for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', '../逃逸']) {
    await assert.rejects(
      () => createDirectory(root, bad),
      (e) => e.code === 'BAD_NAME',
    );
  }
});
