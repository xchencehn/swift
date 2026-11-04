'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { codexGoal, readCodexGoal, claudeGoal } = require('../lib/agent-goal');
const attachment = (value) =>
  JSON.stringify({
    type: 'attachment',
    isSidechain: false,
    attachment: {
      type: 'goal_status',
      condition: 'Finish the implementation\nValidate all cases.',
      ...value,
    },
  });

test('Codex 使用原生目标状态，包含暂停、恢复、受阻、额度和预算限制', () => {
  for (const [status, label] of Object.entries({
    active: 'Pursuing goal',
    paused: 'Goal paused',
    blocked: 'Goal stalled',
    usageLimited: 'Goal hit usage limits',
    budgetLimited: 'Goal unmet',
    complete: 'Goal achieved',
  })) {
    assert.deepEqual(codexGoal({ objective: 'Full objective', status, tokensUsed: 42 }), {
      provider: 'codex',
      objective: 'Full objective',
      status,
      label,
    });
  }
  assert.equal(codexGoal({ objective: 'x', status: 'usage_limited' }).status, 'usageLimited');
  assert.equal(codexGoal({ objective: 'x', status: 'budget_limited' }).status, 'budgetLimited');
  assert.equal(codexGoal(null), null);
  assert.equal(codexGoal({ objective: 'x', status: 'future' }).label, 'Goal status unavailable');
});
test('Codex 只读查询按会话隔离，WAL 更新后无需消息存档变化即可看到目标修改和清除', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-goal-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(readCodexGoal('a', { home }), null);
  assert.deepEqual(fs.readdirSync(home), []);
  const db = new DatabaseSync(path.join(home, 'goals_1.sqlite'));
  t.after(() => db.close());
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT)',
  );
  const put = db.prepare('INSERT OR REPLACE INTO thread_goals VALUES (?,?,?)');
  put.run('other', 'Other session', 'complete');
  for (const status of [
    'active',
    'paused',
    'active',
    'blocked',
    'usage_limited',
    'budget_limited',
    'complete',
  ]) {
    put.run('a', 'Objective ' + status, status);
    assert.equal(readCodexGoal('a', { home }).objective, 'Objective ' + status);
    assert.equal(readCodexGoal('other', { home }).objective, 'Other session');
  }
  assert.equal(readCodexGoal("a' OR 1=1 --", { home }), null);
  db.exec("DELETE FROM thread_goals WHERE thread_id='a'");
  assert.equal(readCodexGoal('a', { home }), null);
});
test('Claude sentinel 区分开启和清除，不把清除误判为达成', () => {
  const lines = [attachment({ met: false, sentinel: true })];
  assert.equal(claudeGoal(lines).label, 'Goal active');
  lines.push(attachment({ met: false, reason: 'Tests are still running' }));
  assert.equal(claudeGoal(lines).status, 'active');
  lines.push(attachment({ met: true, sentinel: true }));
  assert.equal(claudeGoal(lines), null);
  lines.push(attachment({ met: false, sentinel: true, condition: 'New goal' }));
  assert.equal(claudeGoal(lines).objective, 'New goal');
  lines.push(attachment({ met: true, condition: 'New goal', iterations: 2 }));
  assert.equal(claudeGoal(lines).label, 'Goal achieved');
});
test('Claude 正式达成和无法达成分别显示，普通正文与子 Agent 不覆盖目标', () => {
  const completed = attachment({ met: true });
  const noise = [
    'bad json',
    JSON.stringify({ type: 'assistant', message: { content: 'Goal active: fake' } }),
    JSON.stringify({
      type: 'attachment',
      isSidechain: true,
      attachment: { type: 'goal_status', met: false, condition: 'Other agent' },
    }),
    JSON.stringify({
      type: 'attachment',
      attachment: { type: 'goal_status', condition: 'Malformed' },
    }),
  ];
  assert.equal(claudeGoal([completed, ...noise]).label, 'Goal achieved');
  assert.equal(
    claudeGoal([completed, attachment({ met: false, failed: true })]).label,
    'Goal could not be achieved',
  );
  assert.equal(claudeGoal(noise), null);
});
