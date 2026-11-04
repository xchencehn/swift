'use strict';
// Schema and captured fixture from herdr-web-ui 685293e0 (MIT).
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const { devinConversation, DevinHistoryUnavailable } = require('../lib/providers/upstream/devin');
const {
  opencodeConversation,
  opencodeToolOutput,
  forgetOpencodeState,
} = require('../lib/providers/upstream/opencode');
const { messagesFromTurns } = require('../lib/providers/native');
test('Devin captured native archive remains read-only and binds history to the visible session and directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-native-db-')),
    file = path.join(dir, 'devin.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = require('./fixtures/herdr-web-ui/devin-3000.11.3-session.json'),
    db = new DatabaseSync(file);
  for (const table of ['sessions', 'message_nodes', 'tool_call_state']) {
    const rows = fixture[table],
      keys = Object.keys(rows[0]);
    db.exec(
      `CREATE TABLE ${table} (${keys.map((k) => `"${k}" ${/^(?:row_id|node_id|parent_node_id|main_chain_id|hidden|created_at)$/.test(k) ? 'INTEGER' : 'TEXT'}`).join(',')})`,
    );
    const statement = db.prepare(`INSERT INTO ${table} VALUES (${keys.map(() => '?').join(',')})`);
    for (const row of rows)
      statement.run(...keys.map((k) => (typeof row[k] === 'boolean' ? Number(row[k]) : row[k])));
  }
  db.close();
  const before = digest(file);
  const session = fixture.sessions[0],
    page = devinConversation(session.id, session.working_directory, { limit: 200 }, file);
  assert(page.turns.length >= 6);
  assert(
    messagesFromTurns('devin', page.turns, session.id).some((m) =>
      m.blocks.some((b) => b.kind === 'tool'),
    ),
  );
  assert.throws(() => devinConversation(session.id, '/other', {}, file), DevinHistoryUnavailable);
  assert.equal(digest(file), before);
});
test('OpenCode reads current WAL rows, observes in-place tool updates and excludes reverted conversation rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-opencode-db-')),
    file = path.join(dir, 'opencode.db');
  t.after(() => {
    forgetOpencodeState();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE session_v2(id text PRIMARY KEY,revert text);
 CREATE TABLE session_message(id text PRIMARY KEY,session_id text,type text,seq integer,time_created integer,time_updated integer,data text);
 CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);`);
  db.prepare('INSERT INTO session_v2 VALUES (?,NULL)').run('ses_test');
  const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  const stamp = Date.parse('2026-10-10T00:00:00Z');
  add.run(
    'msg_user1',
    'ses_test',
    'user',
    1,
    stamp,
    stamp,
    JSON.stringify({ time: { created: stamp }, text: 'question' }),
  );
  const answer = (output) =>
    JSON.stringify({
      time: { created: stamp + 1 },
      content: [
        { type: 'text', text: 'answer' },
        {
          type: 'tool',
          name: 'read',
          state: {
            status: 'completed',
            input: { path: 'a' },
            content: [{ type: 'text', text: output }],
          },
        },
      ],
      finish: 'stop',
    });
  add.run(
    'msg_answer1',
    'ses_test',
    'assistant',
    2,
    stamp + 1,
    stamp + 1,
    answer('x'.repeat(5000)),
  );
  const first = opencodeConversation(file, 'ses_test');
  assert.equal(first.kind, 'page');
  assert.equal(first.turns.length, 2);
  const tools = messagesFromTurns('opencode', first.turns)
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === 'tool');
  assert.equal(tools[0].id, 'msg_answer1:1');
  assert(tools[0].result.truncated);
  assert.equal(opencodeToolOutput(file, 'ses_test', tools[0].id), 'x'.repeat(5000));
  db.prepare('UPDATE session_message SET data=?, time_updated=? WHERE id=?').run(
    answer('new result'),
    stamp + 2,
    'msg_answer1',
  );
  const next = opencodeConversation(file, 'ses_test');
  assert.notEqual(next.signature, first.signature);
  assert(JSON.stringify(next).includes('new result'));
  db.prepare('UPDATE session_v2 SET revert=? WHERE id=?').run(
    JSON.stringify({ messageID: 'msg_answer1' }),
    'ses_test',
  );
  const reverted = opencodeConversation(file, 'ses_test');
  assert.equal(reverted.kind, 'page');
  assert(!JSON.stringify(reverted.turns).includes('answer'));
  assert.equal(opencodeToolOutput(file, 'ses_test', 'msg_answer1:1'), null);
});
