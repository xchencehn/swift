'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CodexSessionDiscovery } = require('../lib/codex-session-discovery');

test('超过64MiB的当前存档仍参与身份核验，不能把另一会话误判为唯一候选', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-large-identity-'));
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir);
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, rollout_path TEXT, originator TEXT)',
  );
  const current = '01a1805f-7f19-7120-8fe8-804822a67458',
    other = '01a18142-68fc-7340-8668-d6b462e1e977';
  const pane = { cwd: '/fixture/project', agentTitle: 'Same native title | project' };
  const shared = [
    'Both independent sessions can print this shared tool result while running in the same project directory.',
    'A second shared result must not identify the smaller conversation merely because the current archive exceeds a size limit.',
  ];
  const unique = [
    'Only the large current conversation contains this independently verified result from its latest terminal output.',
    'Another current conversation result confirms the correct identity without trusting a title or its old launch arguments.',
  ];
  const record = (texts) =>
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: texts.join('\n') },
    }) + '\n';
  for (const id of [current, other]) {
    const file = path.join(dir, `rollout-2026-10-29T00-00-00-${id}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id,
          cwd: pane.cwd,
          source: 'vscode',
          originator: 'codex-tui',
          thread_source: 'user',
        },
      }) + '\n',
    );
    if (id === current) fs.truncateSync(file, 70 * 1024 * 1024);
    fs.appendFileSync(file, '\n' + record(shared) + (id === current ? record(unique) : ''));
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(
      id,
      'Same native title',
      pane.cwd,
      file,
      'codex-tui',
    );
  }
  const discovery = new CodexSessionDiscovery({ home });
  assert.equal(await discovery.discover(pane, shared.join('\n')), null);
  assert.equal((await discovery.discover(pane, unique.join('\n'))).sessionId, current);
});
