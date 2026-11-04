'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CodexProcessHomes, CodexArchiveLocator } = require('../lib/codex-process-home');
const { locateTranscript } = require('../lib/agent-transcript');
const { readCodexGoal } = require('../lib/agent-goal');
const ID = '01a1769e-9204-74d2-bae7-e0c37e14efd7';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-process-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proc = path.join(root, 'proc');
  const stat = (pid, start) =>
    `${pid} (codex worker) S ${Array(18).fill('0').join(' ')} ${start} 0\n`;
  function processAt(pid, environment, start = 123) {
    const directory = path.join(proc, String(pid));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'stat'), stat(pid, start));
    fs.writeFileSync(
      path.join(directory, 'environ'),
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}\0`)
        .join(''),
    );
    return {
      directory,
      pane: {
        paneId: `p${pid}`,
        terminalId: `t${pid}`,
        runtimeId: `${pid}:${start}`,
        cwd: '/fixture/project',
        agent: { label: 'codex', session: { value: ID } },
      },
      info: { foreground_processes: [{ name: 'codex', pid }] },
    };
  }
  function account(name, separateSqlite = false, retainedArchive = false) {
    const home = path.join(root, name),
      sqliteHome = separateSqlite ? path.join(root, `${name}-state`) : home;
    fs.mkdirSync(path.join(home, 'sessions/2026/10/26'), { recursive: true });
    fs.mkdirSync(sqliteHome, { recursive: true });
    const directory = path.join(retainedArchive ? sqliteHome : home, 'sessions/2026/10/26');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `rollout-2026-10-26T05-11-06-${ID}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: ID, cwd: '/fixture/project', originator: 'codex-tui', source: 'cli' },
      }) + '\n',
    );
    const db = new DatabaseSync(path.join(sqliteHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(ID, '/fixture/project', file);
    db.close();
    const goals = new DatabaseSync(path.join(sqliteHome, 'goals_1.sqlite'));
    goals.exec('CREATE TABLE thread_goals (thread_id TEXT, objective TEXT, status TEXT)');
    goals.prepare('INSERT INTO thread_goals VALUES (?, ?, ?)').run(ID, name, 'active');
    goals.close();
    return { home, sqliteHome, file };
  }
  return { root, proc, stat, processAt, account, homes: new CodexProcessHomes({ proc }) };
}
test('原生进程只提供目录白名单，缓存仍校验 PID 启动时刻', async (t) => {
  const f = fixture(t),
    native = f.processAt(123, {
      HOME: f.root,
      CODEX_HOME: path.join(f.root, 'account'),
      API_KEY: 'private-value',
    });
  const result = await f.homes.read(native.pane, native.info);
  assert.deepEqual(result, {
    home: path.join(f.root, 'account'),
    sqliteHome: path.join(f.root, 'account'),
    runtime: '123:123',
  });
  assert(!JSON.stringify([...f.homes.cache]).includes('private-value'));
  fs.writeFileSync(path.join(native.directory, 'stat'), f.stat(123, 124));
  assert.equal(await f.homes.read(native.pane, native.info), null);
  assert.equal(
    (await f.homes.read({ ...native.pane, runtimeId: '123:124' }, native.info)).runtime,
    '123:124',
  );
});
test('缺失、相对目录与多个原生进程不会授予目录；HOME 可推导默认目录', async (t) => {
  const f = fixture(t),
    native = f.processAt(124, { HOME: f.root });
  assert.equal((await f.homes.read(native.pane, native.info)).home, path.join(f.root, '.codex'));
  assert.equal(
    await f.homes.read(native.pane, {
      foreground_processes: [...native.info.foreground_processes, { name: 'codex', pid: 125 }],
    }),
    null,
  );
  for (const [pid, environment] of [
    [126, {}],
    [127, { CODEX_HOME: 'relative' }],
    [128, { CODEX_HOME: '/bad\npath' }],
  ]) {
    const invalid = f.processAt(pid, environment);
    assert.equal(await f.homes.read(invalid.pane, invalid.info), null);
  }
});
test('相同目录和会话编号按实际进程选择各自账号存档，不复用其他终端的 HOME', async (t) => {
  const f = fixture(t),
    first = f.account('first'),
    second = f.account('second', true);
  const a = f.processAt(201, { CODEX_HOME: first.home }),
    b = f.processAt(202, { CODEX_HOME: second.home, CODEX_SQLITE_HOME: second.sqliteHome });
  const locator = new CodexArchiveLocator({
    homes: f.homes,
    locate: locateTranscript,
    herdr: { readProcessInfo: async (id) => (id === a.pane.paneId ? a.info : b.info) },
  });
  assert.equal(await locator.locate(a.pane), first.file);
  assert.equal(await locator.locate(b.pane), second.file);
  assert.equal(await locator.locate(a.pane), first.file);
  assert.equal(
    readCodexGoal(ID, { home: (await locator.context(b.pane)).sqliteHome }).objective,
    'second',
  );
  const moved = { ...b.pane, cwd: '/other/project' };
  assert.equal(await locator.locate(moved), null);
  fs.rmSync(second.file);
  assert.equal(
    await locator.locate(b.pane),
    null,
    'A missing authoritative archive never falls back to another account',
  );
});
test('切换账号保留共享原生状态时，当前记录可引用 CODEX_SQLITE_HOME 中的原存档', async (t) => {
  const f = fixture(t),
    account = f.account('retained', true, true);
  const native = f.processAt(301, {
    CODEX_HOME: account.home,
    CODEX_SQLITE_HOME: account.sqliteHome,
  });
  const locator = new CodexArchiveLocator({
    homes: f.homes,
    locate: locateTranscript,
    herdr: { readProcessInfo: async () => native.info },
  });
  assert.equal(await locator.locate(native.pane), account.file);
  const { CodexSessionDiscovery } = require('../lib/codex-session-discovery');
  assert(
    (
      await new CodexSessionDiscovery({ home: account.sqliteHome, archiveHome: account.home }).read(
        { sessionId: ID, cwd: native.pane.cwd, file: account.file },
      )
    ).file === account.file,
  );
});

test('进程持有的当前存档可证明移动目录后的身份，缓存继续核对文件与启动时刻', async (t) => {
  const f = fixture(t),
    account = f.account('moved'),
    native = f.processAt(401, { CODEX_HOME: account.home });
  const pane = { ...native.pane, cwd: '/fixture/moved-project' },
    descriptors = path.join(native.directory, 'fd'),
    descriptor = path.join(descriptors, '7');
  fs.mkdirSync(descriptors);
  fs.symlinkSync(account.file, descriptor);
  const locator = new CodexArchiveLocator({
    homes: f.homes,
    locate: locateTranscript,
    herdr: { readProcessInfo: async () => native.info },
  });
  assert.equal(locateTranscript('codex', ID, pane.cwd, f.root, { codexHome: account.home }), null);
  assert.equal(await locator.locate(pane), account.file);
  assert.equal(await locator.locate(pane), account.file);
  fs.unlinkSync(descriptor);
  assert.equal(await locator.locate(pane), null, '目录和会话名称不能替代正在持有的存档');
  fs.symlinkSync(account.file, descriptor);
  fs.writeFileSync(path.join(native.directory, 'stat'), f.stat(401, 124));
  assert.equal(await locator.locate(pane), null, '复用 PID 不复用旧进程的绑定');
});

test('进程文件描述符不能替代原生当前窗口或存档身份校验', async (t) => {
  const f = fixture(t),
    account = f.account('current'),
    native = f.processAt(402, { CODEX_HOME: account.home }),
    pane = { ...native.pane, cwd: '/fixture/moved-project' },
    descriptors = path.join(native.directory, 'fd');
  fs.mkdirSync(descriptors);
  fs.symlinkSync(account.file, path.join(descriptors, '7'));
  const context = await f.homes.read(pane, native.info);
  assert.equal(await f.homes.archive(pane, context), account.file);
  const next = path.join(path.dirname(account.file), `rollout-next-${ID}.jsonl`);
  fs.copyFileSync(account.file, next);
  const db = new DatabaseSync(path.join(account.sqliteHome, 'state_5.sqlite'));
  try {
    db.prepare('UPDATE threads SET rollout_path=?').run(next);
    assert.equal(await f.homes.archive(pane, context), null, '旧窗口不能冒充当前存档');
    fs.symlinkSync(next, path.join(descriptors, '8'));
    assert.equal(await f.homes.archive(pane, context), next);
    fs.writeFileSync(
      next,
      JSON.stringify({ type: 'session_meta', payload: { id: 'other' } }) + '\n',
    );
    assert.equal(await f.homes.archive(pane, context), null);
  } finally {
    db.close();
  }
});
