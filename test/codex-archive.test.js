'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { currentArchive, validateArchive } = require('../lib/codex-archive');
const { locateTranscript } = require('../lib/agent-transcript');
const ID = '01a16b68-2e81-7e13-a82c-0eda218fddf5';
const OLD = '/fixture/worktrees/scatter',
  CURRENT = '/fixture/retired-worktrees/scatter';

function fixture(t, withCwd = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-archive-cwd-'));
  const root = path.join(home, '.codex'),
    directory = path.join(root, 'sessions/2026/10/24');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-10-24T08-55-52-${ID}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: OLD } }) + '\n',
  );
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  db.exec(
    `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT${withCwd ? ', cwd TEXT' : ''})`,
  );
  db.prepare(`INSERT INTO threads VALUES (?, ?${withCwd ? ', ?' : ''})`).run(
    ...[ID, file, ...(withCwd ? [CURRENT] : [])],
  );
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, root, file, db };
}

test('原生当前目录改变后仍读取同一会话存档，不改写启动目录或数据库', (t) => {
  const f = fixture(t),
    bytes = fs.readFileSync(f.file),
    rows = f.db.prepare('SELECT * FROM threads').all();
  assert.deepEqual(currentArchive(f.root, ID, CURRENT), { known: true, file: f.file });
  assert.equal(locateTranscript('codex', ID, CURRENT, f.home), f.file);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.deepEqual(f.db.prepare('SELECT * FROM threads').all(), rows);
  assert.equal(validateArchive(f.root, f.file, ID, CURRENT), null, '仅存档头不能证明新的当前目录');
});

test('原生当前目录与请求不符时拒绝，即使请求等于存档启动目录', (t) => {
  const f = fixture(t);
  for (const cwd of [OLD, '/another/project']) {
    assert.deepEqual(currentArchive(f.root, ID, cwd), { known: true, file: null });
    assert.equal(locateTranscript('codex', ID, cwd, f.home), null);
  }
});

test('原生配置可以共享 sessions 目录，但目录中的单个链接仍不能指向外部存档', (t) => {
  const f = fixture(t),
    linked = path.join(f.home, 'linked-home');
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(f.root, 'sessions'), path.join(linked, 'sessions'));
  assert.equal(validateArchive(linked, f.file, ID, OLD), f.file);
  const outside = path.join(f.home, path.basename(f.file));
  fs.copyFileSync(f.file, outside);
  fs.unlinkSync(f.file);
  fs.symlinkSync(outside, f.file);
  assert.equal(validateArchive(linked, f.file, ID, OLD), null);
});

test('目录改变不放宽会话 ID、当前窗口及允许存档路径的检查', async (t) => {
  for (const variant of ['id', 'missing', 'escape', 'symlink'])
    await t.test(variant, (t) => {
      const f = fixture(t);
      if (variant === 'id')
        fs.writeFileSync(
          f.file,
          JSON.stringify({ type: 'session_meta', payload: { id: 'other-session', cwd: OLD } }) +
            '\n',
        );
      if (variant === 'missing')
        f.db.prepare('UPDATE threads SET rollout_path=?').run(f.file + '.missing');
      if (['escape', 'symlink'].includes(variant)) {
        const outside = path.join(f.home, path.basename(f.file));
        fs.copyFileSync(f.file, outside);
        if (variant === 'escape') f.db.prepare('UPDATE threads SET rollout_path=?').run(outside);
        else {
          fs.unlinkSync(f.file);
          fs.symlinkSync(outside, f.file);
        }
      }
      assert.deepEqual(currentArchive(f.root, ID, CURRENT), { known: true, file: null });
      assert.equal(locateTranscript('codex', ID, CURRENT, f.home), null);
    });
});

test('缺少原生当前目录的旧数据库继续要求存档目录一致', async (t) => {
  for (const variant of ['absent', 'null', 'empty'])
    await t.test(variant, (t) => {
      const f = fixture(t, variant !== 'absent');
      if (variant !== 'absent')
        f.db.prepare('UPDATE threads SET cwd=?').run(variant === 'null' ? null : '');
      assert.deepEqual(currentArchive(f.root, ID, OLD), { known: true, file: f.file });
      assert.deepEqual(currentArchive(f.root, ID, CURRENT), { known: true, file: null });
    });
});
