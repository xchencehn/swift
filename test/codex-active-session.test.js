'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { CodexActiveSession } = require('../lib/codex-active-session');
const ID = '01a164b6-3367-76e2-94ff-143fc14c1eb8',
  OLD = '01a164ad-abf0-77c3-b878-88126628ade6';
const pane = { cwd: '/fixture/project' };
const info = {
  foreground_processes: [{ name: 'codex', pid: process.pid, argv: ['codex', 'resume', OLD] }],
};
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-active-codex-')),
    opened = [];
  const directory = path.join(home, 'sessions/2026/10/23');
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
  t.after(() => {
    for (const fd of opened) fs.closeSync(fd);
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  function add(id = ID, patch = {}, mode = 'a') {
    const file = path.join(directory, `rollout-2026-10-23T01-43-44-${id}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id,
          cwd: pane.cwd,
          originator: 'codex-tui',
          source: 'cli',
          thread_source: 'user',
          ...patch,
        },
      }) + '\n',
    );
    db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?)').run(id, file);
    opened.push(fs.openSync(file, mode));
    return file;
  }
  return { home, add, db, active: new CodexActiveSession({ home }) };
}
test('当前进程持有的可写原生存档优先于旧 resume 参数，检查不会修改原件', async (t) => {
  const f = fixture(t),
    file = f.add(),
    before = fs.readFileSync(file),
    rows = f.db.prepare('SELECT * FROM threads').all();
  const active = await f.active.read(pane, info);
  assert.equal(active.sessionId, ID);
  assert.equal(active.file, file);
  assert.match(active.runtime, new RegExp(`^${process.pid}:\\d+$`));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM threads').all(), rows);
});
test('当前进程使用独立账号目录时，身份核验读取同一账号的原生存档', async (t) => {
  const f = fixture(t),
    file = f.add();
  const active = new CodexActiveSession({
    home: '/missing/default/account',
    homes: { read: async () => ({ home: f.home, sqliteHome: f.home }) },
  });
  assert.equal((await active.read(pane, info)).file, file);
  active.homes = { read: async () => ({ home: '/missing/new/account', sqliteHome: f.home }) };
  assert.equal(
    (await active.read(pane, info)).file,
    file,
    'Native shared state retains its current archive after switching account configuration',
  );
  active.homes = { read: async () => null };
  assert.equal(await active.read(pane, info), null);
});
test('当前目录已更新时以原生记录核验可写存档，旧目录不能继续授权', async (t) => {
  const f = fixture(t),
    file = f.add(),
    moved = { cwd: '/fixture/retired/project' };
  f.db.exec('ALTER TABLE threads ADD COLUMN cwd TEXT');
  f.db.prepare('UPDATE threads SET cwd=?').run(moved.cwd);
  const before = fs.readFileSync(file);
  assert.equal((await f.active.read(moved, info)).file, file);
  assert.equal(await f.active.read(pane, info), null);
  assert.equal(await f.active.read({ cwd: '/another/project' }, info), null);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('只读历史、临时线程、辅助线程和未登记存档都不能替换主会话身份', async (t) => {
  for (const variant of ['readonly', 'ephemeral', 'subagent', 'source', 'cwd', 'unknown'])
    await t.test(variant, async (t) => {
      const f = fixture(t),
        patch = { ephemeral: variant === 'ephemeral' };
      if (variant === 'subagent') patch.thread_source = { subagent: { parent_thread_id: OLD } };
      if (variant === 'source') patch.source = 'exec';
      if (variant === 'cwd') patch.cwd = '/another/project';
      f.add(ID, patch, variant === 'readonly' ? 'r' : 'a');
      if (variant === 'unknown') f.db.prepare('DELETE FROM threads').run();
      assert.equal(await f.active.read(pane, info), null);
    });
});
test('多个可写主会话存档或多个 Codex 进程不猜测，当前窗口路径也必须一致', async (t) => {
  const f = fixture(t),
    file = f.add();
  f.add(OLD);
  assert.equal(await f.active.read(pane, info), null);
  assert.equal(
    await f.active.read(pane, {
      foreground_processes: [...info.foreground_processes, { name: 'codex', pid: 2 }],
    }),
    null,
  );
  f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file + '.missing', OLD);
  assert.equal((await f.active.read(pane, info)).sessionId, ID);
  f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file + '.missing', ID);
  assert.equal(await f.active.read(pane, info), null);
});
test('旧写入句柄仍保留时，只有唯一匹配当前终端的存档才可确定身份', async (t) => {
  const f = fixture(t),
    first =
      'The first independently verified current native conversation paragraph identifies the exact active user thread.';
  const second =
    'The second distinct current terminal paragraph verifies the native conversation without trusting a timestamp or descriptor number.';
  const old = f.add(OLD),
    current = f.add();
  const append = (file) =>
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `${first}\n${second}` }],
        },
      }) + '\n',
    );
  append(current);
  f.active.readScreen = async () => `${first}\n${second}`;
  assert.equal((await f.active.read(pane, info)).sessionId, ID);
  append(old);
  assert.equal(
    await f.active.read(pane, info),
    null,
    'Shared historical content does not prove a unique current thread',
  );
});
test('前台 TUI 恢复 vscode 来源的主会话时，可写存档仍证明当前身份', async (t) => {
  const f = fixture(t),
    file = f.add(ID, { source: 'vscode' });
  const before = fs.readFileSync(file);
  assert.equal((await f.active.read(pane, info)).sessionId, ID);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('原生 exec fork 的前台可写存档证明独立会话，普通后台 exec 不构成身份', async (t) => {
  const f = fixture(t);
  f.add(ID, {
    source: 'exec',
    thread_source: 'user',
    forked_from_id: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal((await f.active.read(pane, info)).sessionId, ID);
  f.add(ID, { source: 'exec', thread_source: 'user' });
  assert.equal(await f.active.read(pane, info), null);
});

test('原生主线程身份优先于 Fork 留下的可写存档与临时终端正文', async (t) => {
  const f = fixture(t),
    file = f.add();
  f.add(OLD);
  let observed;
  f.active.native = async (target, operation) => {
    observed = { target, operation };
    return { mainId: ID };
  };
  f.active.readScreen = async () => {
    throw new Error('Primary identity does not depend on visible side text');
  };
  const active = await f.active.read(pane, info);
  assert.equal(active.sessionId, ID);
  assert.equal(active.file, file);
  assert.equal(observed.operation, 'identity');
  assert.equal(observed.target.runtimeId, active.runtime);
  f.active.native = async () => ({ mainId: '00000000-0000-4000-8000-000000000001' });
  await assert.rejects(f.active.read(pane, info), /no verified archive/);
});
