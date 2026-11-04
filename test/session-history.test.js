'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { SessionHistory } = require('../lib/session-history');
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-history-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'project with spaces');
  await fs.mkdir(cwd);
  const dir = path.join(home, '.claude/projects/project');
  await fs.mkdir(dir, { recursive: true });
  const write = async (id, extra = {}) =>
    fs.writeFile(
      path.join(dir, id + '.jsonl'),
      [
        {
          type: 'user',
          cwd,
          sessionId: id,
          message: { role: 'user', content: '历史问题 ' + id },
          timestamp: new Date().toISOString(),
          ...extra,
        },
        { type: 'custom-title', customTitle: '原生会话 ' + id },
      ]
        .map(JSON.stringify)
        .join('\n') + '\n',
    );
  return { home, cwd, dir, write, history: new SessionHistory({ home }) };
}
test('历史包含已关闭原生会话，排除运行会话与子 Agent，支持检索分页', async (t) => {
  const { write, history } = await fixture(t);
  await write('closed');
  await write('live');
  await write('side', { isSidechain: true });
  const panes = [{ agent: { label: 'claude', session: { value: 'live' } } }];
  const result = await history.list(panes);
  assert.equal(result.total, 1);
  assert.equal(result.sessions[0].title, '原生会话 closed');
  assert.equal(result.sessions[0].file, undefined);
  assert.equal((await history.list(panes, { query: 'not found' })).total, 0);
  assert.equal((await history.list([], { limit: 1 })).nextOffset, 1);
});
test('关闭记录保留原目录和工作区，重启后恢复；不存在目录与非法标识被拒绝', async (t) => {
  const { home, cwd, write, history } = await fixture(t);
  await write('closed');
  const pane = {
    paneId: 'w:p',
    workspaceId: 'w',
    workspace: '项目',
    cwd,
    agent: { label: 'claude', session: { value: 'closed' } },
  };
  await history.remember(pane);
  const restored = new SessionHistory({ home });
  const entry = await restored.get('claude', 'closed');
  assert.equal(entry.cwd, cwd);
  assert.equal(entry.workspaceId, 'w');
  assert.equal(entry.title, '原生会话 closed');
  await assert.rejects(restored.get('shell', 'closed'), { code: 'INVALID_SESSION' });
  await assert.rejects(restored.get('claude', '../bad'), { code: 'INVALID_SESSION' });
  await fs.rmdir(cwd);
  await assert.rejects(restored.get('claude', 'closed'), { code: 'CWD_NOT_FOUND' });
});
test('Codex 从当前数据库读取会话，不依赖始终为零的 has_user_event 字段', async (t) => {
  const { home, cwd, history } = await fixture(t);
  const { DatabaseSync } = require('node:sqlite');
  await fs.mkdir(path.join(home, '.codex'));
  const db = new DatabaseSync(path.join(home, '.codex/state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,name TEXT,updated_at INTEGER,source TEXT,has_user_event INTEGER)',
  );
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(
    'codex-old',
    cwd,
    '历史标题',
    '',
    100,
    'cli',
    0,
  );
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(
    'subagent',
    cwd,
    '内部子任务',
    '',
    200,
    '{"subagent":"review"}',
    0,
  );
  db.close();
  const result = await history.list([]);
  assert.equal(result.total, 1);
  assert.equal(result.sessions[0].provider, 'codex');
  assert.equal(result.sessions[0].sessionId, 'codex-old');
});
