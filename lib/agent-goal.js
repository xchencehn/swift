'use strict';
const { parseLine } = require('./json-lines');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Native Codex ThreadGoalStatus -> TUI footer wording, without token counters
// or slash-command hints. The agent's turn status does not determine goal status.
const CODEX_LABELS = {
  active: 'Pursuing goal',
  paused: 'Goal paused',
  blocked: 'Goal stalled',
  usageLimited: 'Goal hit usage limits',
  budgetLimited: 'Goal unmet',
  complete: 'Goal achieved',
};
function codexGoal(value) {
  if (!value || typeof value.objective !== 'string' || !value.objective.trim()) return null;
  const status =
    { usage_limited: 'usageLimited', budget_limited: 'budgetLimited' }[value.status] ||
    value.status;
  return {
    provider: 'codex',
    objective: value.objective,
    status: CODEX_LABELS[status] ? status : 'unknown',
    label: CODEX_LABELS[status] || 'Goal status unavailable',
  };
}

// Read Codex's persisted source of truth, including standalone terminal sessions.
// Read-only queries see WAL updates even when the transcript has not changed.
// No database is created, migrated, or written by this frontend.
function readCodexGoalRecord(
  threadId,
  {
    home = process.env.CODEX_SQLITE_HOME ||
      process.env.CODEX_HOME ||
      path.join(os.homedir(), '.codex'),
  } = {},
) {
  if (!threadId) return null;
  let names;
  try {
    names = fs.readdirSync(home);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const name = names
    .filter((n) => /^goals_\d+\.sqlite$/.test(n))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (!name) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, name), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM thread_goals WHERE thread_id = ?').get(threadId) || null;
  } finally {
    db.close();
  }
}
function readCodexGoal(threadId, options) {
  return codexGoal(readCodexGoalRecord(threadId, options));
}

// Claude Code 2.1.261 persists attachment.goal_status. A sentinel with met=true
// means clear, NOT success; real success has met=true without a sentinel.
function claudeGoal(lines) {
  let goal = null;
  for (const raw of lines) {
    let entry;
    try {
      entry = typeof raw === 'string' ? parseLine(raw) : raw;
    } catch {
      continue;
    }
    if (entry?.type !== 'attachment' || entry.isSidechain) continue;
    const value = entry.attachment;
    if (
      value?.type !== 'goal_status' ||
      typeof value.condition !== 'string' ||
      !value.condition.trim()
    )
      continue;
    if (value.sentinel && value.met === true) {
      goal = null;
      continue;
    }
    if (typeof value.met !== 'boolean') continue;
    const status = value.failed === true ? 'blocked' : value.met ? 'complete' : 'active';
    goal = {
      provider: 'claude',
      objective: value.condition,
      status,
      label:
        status === 'complete'
          ? 'Goal achieved'
          : status === 'blocked'
            ? 'Goal could not be achieved'
            : 'Goal active',
    };
  }
  return goal;
}
module.exports = { codexGoal, readCodexGoal, readCodexGoalRecord, claudeGoal };
