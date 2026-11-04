'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RootSettings } = require('../lib/root-settings');
const { scopeDashboard, withinRoot } = require('../lib/root-scope');
const { SessionHistory } = require('../lib/session-history');

test('根目录持久化；无效路径和保存失败不改变当前目录', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-root-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'settings.json'),
    first = path.join(temp, 'first'),
    second = path.join(temp, 'second');
  fs.mkdirSync(second);
  const settings = new RootSettings({ directory: first, file });
  const otherFile = path.join(temp, 'other-server.json');
  const otherServer = new RootSettings({ directory: first, file: otherFile });
  assert.equal(settings.update(second), second);
  assert.equal(new RootSettings({ directory: first, file }).directory, second);
  assert.equal(otherServer.directory, first);
  assert.equal(new RootSettings({ directory: first, file: otherFile }).directory, first);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const invalid of ['', '../first', {}, '/missing-herdr-directory', file]) {
    assert.throws(() => settings.update(invalid), { code: 'INVALID_ROOT_DIRECTORY' });
    assert.equal(settings.directory, second);
  }
  settings.file = path.join(file, 'cannot-save.json');
  assert.throws(() => settings.update(first));
  assert.equal(settings.directory, second);
});

test('根目录隔离历史数据而不改变 Herdr 布局，cd 与空工作区不丢失，文件范围仍拒绝外部符号链接', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a', 'outside'));
  assert.equal(withinRoot(path.join(root, 'a'), path.join(root, 'a', 'outside')), false);
  const dashboard = {
    focusedPaneId: 'b',
    panes: [
      { paneId: 'a', workspaceId: 'wa', cwd: path.join(root, 'a', 'child') },
      { paneId: 'b', workspaceId: 'wb', cwd: path.join(root, 'b') },
      { paneId: 'similar', workspaceId: 'wb', cwd: path.join(root, 'abc') },
    ],
    workspaces: [
      { workspaceId: 'wa' },
      { workspaceId: 'wb' },
      { workspaceId: 'empty', cwd: path.join(root, 'a') },
    ],
  };
  const a = scopeDashboard(dashboard, path.join(root, 'a'));
  assert.deepEqual(
    a.panes.map((p) => p.paneId),
    ['a', 'b', 'similar'],
  );
  assert.equal(a.focusedPaneId, 'b');
  assert.deepEqual(
    a.workspaces.map((w) => w.workspaceId),
    ['wa', 'wb', 'empty'],
  );
  const empty = scopeDashboard(dashboard, path.join(root, 'empty'));
  assert.deepEqual(empty.panes, dashboard.panes);
  assert.deepEqual(empty.workspaces, dashboard.workspaces);
  assert.equal(dashboard.panes.length, 3);
});

test('历史继续使用原生存档解析，按根目录过滤后再分页', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-history-root-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude/projects/fixture');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, cwd] of [
    ['inside-one', '/projects/a'],
    ['outside', '/projects/ab'],
    ['inside-two', '/projects/a/nested'],
  ]) {
    fs.writeFileSync(
      path.join(dir, id + '.jsonl'),
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: '内容 ' + id } }) +
        '\n',
    );
  }
  const history = new SessionHistory({ home });
  const first = await history.list([], { rootDirectory: '/projects/a', limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, 1);
  const second = await history.list([], { rootDirectory: '/projects/a', offset: 1, limit: 1 });
  assert.equal(second.nextOffset, null);
  assert.notEqual(first.sessions[0].sessionId, second.sessions[0].sessionId);
  assert.equal((await history.list([], { rootDirectory: '/empty' })).total, 0);
});
