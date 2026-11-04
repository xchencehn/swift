'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CodexSessionDiscovery } = require('../lib/codex-session-discovery');
const { locateTranscript } = require('../lib/agent-transcript');

const ID = '01a1245b-e0b9-7073-bdc6-d91149d2872e';
const WINDOW = '01a1245b-e0c2-7922-ba82-a89e922e8457';
const OTHER = '01a124ac-8394-7ec3-a9e1-ae7e2e42e067';
const first =
  'The existing conversation is processing a native tool result with a unique project reference and the exact historical context.';
const second =
  'Another independent native output line identifies this conversation without needing to send anything into its terminal.';
const pane = { baseCwd: '/fixture/project', agentTitle: 'Native investigation | project' };

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.codex'),
    dir = path.join(root, 'sessions', '2026', '10', '10');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, rollout_path TEXT, originator TEXT)',
  );
  t.after(() => db.close());
  function add(id = ID, window = WINDOW, texts = [first, second]) {
    const file = path.join(
      dir,
      `rollout-2026-10-10T16-00-00-${id}${window ? '_' + window : ''}.jsonl`,
    );
    const records = [
      {
        type: 'session_meta',
        payload: {
          id,
          cwd: pane.baseCwd,
          originator: 'codex-tui',
          history_mode: 'paginated',
          context_window: { window_id: window },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          output: [{ type: 'input_text', text: JSON.stringify({ output: texts.join('\n') }) }],
        },
      },
    ];
    fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
    db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?, ?, ?, ?)').run(
      id,
      'Native investigation',
      pane.baseCwd,
      file,
      'codex-tui',
    );
    return file;
  }
  return { home, root, dir, db, add, discovery: new CodexSessionDiscovery({ home: root }) };
}

test('普通启动依据原生名称及两段独立内容关联当前窗口，读取不会修改存档或数据库', async (t) => {
  const f = fixture(t),
    file = f.add();
  const archive = fs.readFileSync(file),
    before = f.db.prepare('SELECT * FROM threads').all();
  const found = await f.discovery.discover(pane, `• ${first}\n└ ${second}`);
  assert.equal(found.sessionId, ID);
  assert.equal(found.evidence.anchors, 2);
  assert.equal(locateTranscript('codex', ID, pane.baseCwd, f.home), file);
  assert.deepEqual(fs.readFileSync(file), archive);
  assert.deepEqual(f.db.prepare('SELECT * FROM threads').all(), before);
});
test('当前目录改变后身份发现沿用原生目录，仍须唯一内容证明并拒绝旧候选', async (t) => {
  const f = fixture(t),
    file = f.add(),
    moved = { ...pane, baseCwd: '/fixture/retired/project' };
  const before = fs.readFileSync(file);
  f.db.prepare('UPDATE threads SET cwd=?').run(moved.baseCwd);
  const found = await f.discovery.discover(moved, `${first}\n${second}`);
  assert.equal(found.sessionId, ID);
  assert.equal(found.file, file);
  assert.equal(await f.discovery.discover(moved, first), null);
  assert.equal(await f.discovery.read({ sessionId: ID, cwd: pane.baseCwd, file }), null);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('名称和目录相同仍不足以绑定，内容不匹配、单一片段和多个候选都拒绝关联', async (t) => {
  const f = fixture(t);
  f.add();
  assert.equal(await f.discovery.discover(pane, 'No native transcript evidence'), null);
  assert.equal(await f.discovery.discover(pane, first), null);
  f.add(OTHER);
  assert.equal(await f.discovery.discover(pane, `${first}\n${second}`), null);
  assert.equal(
    await f.discovery.discover({ ...pane, baseCwd: '/other/project' }, `${first}\n${second}`),
    null,
  );
});

test('共享 daemon 的主会话允许内容核验，临时及辅助会话不能替换主会话', async (t) => {
  const f = fixture(t),
    file = f.add(),
    original = fs.readFileSync(file, 'utf8').split('\n');
  for (const patch of [
    { source: 'vscode', thread_source: 'user' },
    { ephemeral: true },
    { thread_source: { subagent: {} } },
    { source: 'exec' },
  ]) {
    const meta = JSON.parse(original[0]);
    Object.assign(meta.payload, patch);
    fs.writeFileSync(file, [JSON.stringify(meta), ...original.slice(1)].join('\n'));
    assert.equal(
      Boolean(await f.discovery.discover(pane, `${first}\n${second}`)),
      patch.source === 'vscode',
    );
  }
});

test('原生当前窗口改变后立即读取新路径，旧文件存在也不能替代缺失或错误的当前窗口', (t) => {
  const f = fixture(t),
    old = f.add(ID, null),
    current = f.add();
  assert.equal(locateTranscript('codex', ID, pane.baseCwd, f.home), current);
  fs.unlinkSync(current);
  assert(fs.existsSync(old));
  assert.equal(locateTranscript('codex', ID, pane.baseCwd, f.home), null);
  f.add();
  fs.writeFileSync(
    current,
    JSON.stringify({ type: 'session_meta', payload: { id: OTHER, cwd: pane.baseCwd } }) + '\n',
  );
  assert.equal(locateTranscript('codex', ID, pane.baseCwd, f.home), null);
  f.add();
  assert.equal(locateTranscript('codex', ID, '/wrong/cwd', f.home), null);
});

test('数据库路径逃逸或符号链接逃逸不读取，系统提示也不能作为身份依据', async (t) => {
  const f = fixture(t),
    file = f.add();
  const outside = path.join(f.home, path.basename(file));
  fs.copyFileSync(file, outside);
  fs.unlinkSync(file);
  fs.symlinkSync(outside, file);
  assert.equal(locateTranscript('codex', ID, pane.baseCwd, f.home), null);
  assert.equal(await f.discovery.discover(pane, `${first}\n${second}`), null);
  fs.unlinkSync(file);
  f.add(ID, WINDOW, []);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'response_item',
      payload: {
        role: 'developer',
        content: [{ type: 'input_text', text: `${first}\n${second}` }],
      },
    }) + '\n',
  );
  assert.equal(await f.discovery.discover(pane, `${first}\n${second}`), null);
});

test('Fork 继承的历史不能将子会话重新绑定到父会话，父子后续消息分别匹配', async (t) => {
  const f = fixture(t),
    parent = f.add(ID, null);
  const records = fs
    .readFileSync(parent, 'utf8')
    .trim()
    .split('\n')
    .map((line, ordinal) => ({ ...JSON.parse(line), ordinal }));
  fs.writeFileSync(parent, records.map(JSON.stringify).join('\n') + '\n');
  const prefix = fs.readFileSync(parent);
  const child = f.add(OTHER, null, []);
  const meta = JSON.parse(fs.readFileSync(child, 'utf8').split('\n')[0]);
  meta.ordinal = records.length;
  Object.assign(meta.payload, { source: 'exec', thread_source: 'user', forked_from_id: ID });
  meta.payload.history_base = {
    thread_id: ID,
    end_ordinal_exclusive: records.length,
    end_byte_offset: prefix.length,
  };
  fs.writeFileSync(child, JSON.stringify(meta) + '\n');
  const childPane = { ...pane, agent: { label: 'codex', session: { value: OTHER } } };
  assert.equal(
    await f.discovery.discover(childPane, `${first}\n${second}`),
    null,
    'Inherited content matches both sessions and cannot identify the parent as the child',
  );
  const parentOnly = [
    'The parent continues its original independent investigation after the snapshot without changing the forked conversation.',
    'A second parent-only result proves that new source messages do not appear in the independent child history.',
  ];
  const childOnly = [
    'The child sends an independent new request after the fork and receives an answer belonging only to its own conversation.',
    'A second child-only result verifies that messages are delivered into the new session without modifying the source session.',
  ];
  const append = (file, ordinal, texts) =>
    fs.appendFileSync(
      file,
      JSON.stringify({
        ordinal,
        type: 'event_msg',
        payload: { type: 'agent_message', message: texts.join('\n') },
      }) + '\n',
    );
  append(parent, records.length, parentOnly);
  append(child, records.length + 1, childOnly);
  assert.equal((await f.discovery.discover(childPane, childOnly.join('\n'))).sessionId, OTHER);
  assert.equal((await f.discovery.discover(pane, parentOnly.join('\n'))).sessionId, ID);
  const childRecord = await f.discovery.read({ sessionId: OTHER, cwd: pane.baseCwd, file: child });
  assert(!childRecord.texts.some((text) => text.includes(parentOnly[0])));
  assert(childRecord.texts.some((text) => text.includes(first)));
  meta.payload.history_base.thread_id = '33333333-3333-4333-8333-333333333333';
  fs.writeFileSync(child, JSON.stringify(meta) + '\n');
  assert.equal(
    await f.discovery.discover(childPane, `${first}\n${second}`),
    null,
    'An unreadable inherited prefix cannot make the parent a unique match',
  );
});
