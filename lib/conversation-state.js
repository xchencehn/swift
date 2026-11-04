'use strict';
const { parseLine, lineId } = require('./json-lines');
const crypto = require('node:crypto');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableId = lineId;
const conflict = (code, message) => Object.assign(new Error(message), { status: 409, code });

// Native journals are event logs, not display histories. Resolve their history
// semantics before projecting messages, tools, settings, questions or files.
function effectiveEntries(provider, lines) {
  const entries = lines.flatMap((raw, index) => {
    try {
      return [{ entry: parseLine(raw), raw, index }];
    } catch {
      return [];
    }
  });
  if (provider === 'codex') {
    const result = [],
      starts = [];
    let explicitTurn = false;
    for (const record of entries) {
      const e = record.entry,
        p = e.payload || {};
      if (e.type === 'event_msg' && p.type === 'thread_rolled_back') {
        const count = Math.min(starts.length, Math.max(0, Number(p.num_turns) || 0));
        if (count) result.length = starts.splice(starts.length - count)[0];
        explicitTurn = false;
        continue;
      }
      if (e.type === 'event_msg' && p.type === 'task_started') {
        starts.push(result.length);
        explicitTurn = true;
      }
      // Older journals may have no task_started. Metadata-only user messages
      // must not count as turns; queued steering belongs to its active turn.
      if (
        !explicitTurn &&
        e.type === 'response_item' &&
        p.type === 'message' &&
        p.role === 'user'
      ) {
        const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
        if (!kinds || kinds.some((k) => ['user.text', 'user.image'].includes(k)))
          starts.push(result.length);
      }
      result.push(record);
      if (e.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(p.type))
        explicitTurn = false;
    }
    return result;
  }
  if (provider === 'claude') {
    const main = entries.filter((r) => !r.entry.isSidechain);
    const chained = main.filter((r) => r.entry.uuid && Object.hasOwn(r.entry, 'parentUuid'));
    if (!chained.length) return main;
    const byId = new Map(chained.map((r) => [r.entry.uuid, r]));
    const keep = new Set();
    let current = chained
      .filter((r) => ['user', 'assistant', 'attachment', 'system'].includes(r.entry.type))
      .at(-1);
    while (current && !keep.has(current.entry.uuid)) {
      keep.add(current.entry.uuid);
      current = byId.get(current.entry.parentUuid || current.entry.logicalParentUuid);
    }
    return main.filter((r) => !byId.has(r.entry.uuid) || keep.has(r.entry.uuid));
  }
  if (['pi', 'omp', 'omo', 'gjc'].includes(provider)) {
    const chained = entries.filter(
      (r) => typeof r.entry.id === 'string' && Object.hasOwn(r.entry, 'parentId'),
    );
    if (!chained.length) return entries;
    const byId = new Map(chained.map((r) => [r.entry.id, r])),
      keep = new Set();
    let current = chained.at(-1);
    while (current) {
      if (keep.has(current.entry.id)) return entries.filter((r) => !byId.has(r.entry.id));
      keep.add(current.entry.id);
      const parent = current.entry.parentId;
      if (parent == null) break;
      current = byId.get(parent);
      if (!current) return entries.filter((r) => !byId.has(r.entry.id));
    }
    return entries.filter((r) => !byId.has(r.entry.id) || keep.has(r.entry.id));
  }
  return entries;
}
function effectiveLines(provider, lines) {
  return effectiveEntries(provider, lines).map((r) => r.raw);
}
function identity(pane) {
  return {
    paneId: pane.paneId,
    terminalId: pane.terminalId || null,
    runtimeId: pane.runtimeId || null,
    provider: pane.agent?.label || null,
    sessionId: pane.agent?.session?.value || null,
  };
}
function binding(pane) {
  return hash(identity(pane));
}
function assertIdentity(pane, expected, required = false) {
  if (required && !expected?.binding) throw conflict('IDENTITY_REQUIRED', '请刷新会话后重试。');
  if (
    (expected?.binding && expected.binding !== binding(pane)) ||
    (Object.hasOwn(expected || {}, 'sessionId') &&
      (expected.sessionId || null) !== (pane.agent?.session?.value || null))
  )
    throw conflict('SESSION_CHANGED', '目标会话已改变，请刷新后重试。');
}
// 存档缓存每个文件版本只产出一份 conversation 数组，同一个数组的版本号只算一次。
const versions = new WeakMap(),
  messageVersions = new WeakMap();
function messageFingerprint(message) {
  if (!Object.isFrozen(message)) return hash(message);
  if (!messageVersions.has(message)) messageVersions.set(message, hash(message));
  return messageVersions.get(message);
}
function historyVersion(messages) {
  let version = versions.get(messages);
  if (!version) {
    version = hash(messages.map(messageFingerprint));
    versions.set(messages, version);
  }
  return version;
}
// Refresh returns one authoritative contiguous range. The oldest retained ID
// extends the range across any reconnect gap. A missing anchor means replacement.
function historyWindow(messages, { limit = 60, before, from, revision } = {}) {
  const historyRevision = historyVersion(messages);
  if (before && revision && revision !== historyRevision)
    throw conflict('HISTORY_CHANGED', '历史已变化，请重新读取。');
  let end = messages.length;
  if (before) {
    end = messages.findIndex((m) => m.id === before);
    if (end < 0) throw conflict('HISTORY_CHANGED', '历史位置已失效，请重新读取。');
  }
  const anchor = !before && from ? messages.findIndex((m) => m.id === from) : -1;
  const start = anchor >= 0 ? Math.min(anchor, Math.max(0, end - limit)) : Math.max(0, end - limit);
  return {
    historyRevision,
    total: messages.length,
    hasMore: start > 0,
    replace: !before,
    messages: messages.slice(start, end),
  };
}
function turnToken(provider, lines) {
  const entries = effectiveEntries(provider, lines);
  if (provider === 'codex') {
    let turn = null;
    for (const { entry: e } of entries) {
      if (e.type === 'event_msg' && e.payload?.type === 'task_started') turn = e.payload.turn_id;
      if (e.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(e.payload?.type))
        turn = null;
    }
    return turn;
  }
  const user = entries
    .filter(
      ({ entry: e }) =>
        e.type === 'user' &&
        !e.isMeta &&
        (typeof e.message?.content === 'string' ||
          e.message?.content?.some((b) => b.type === 'text')),
    )
    .at(-1);
  return user?.entry.uuid || null;
}
// Read raw records, including abandoned branches. Reply presence says nothing
// about current branch membership. Keep IDs consistent with transcript parsing.
function archiveIndex(lines) {
  const ids = new Set();
  for (const raw of lines) {
    let e;
    try {
      e = parseLine(raw);
    } catch {
      continue;
    }
    if (!e) continue;
    const p = e.payload || {};
    for (const value of [e.uuid, e.id, p.id, e.attachment?.source_uuid])
      if (typeof value === 'string' && value) ids.add(value);
    if (e.type === 'response_item' && p.type === 'message' && !p.id && p.role)
      ids.add(`${p.role}-${stableId(raw)}`);
  }
  return { ids };
}
module.exports = {
  messageFingerprint,
  effectiveEntries,
  effectiveLines,
  identity,
  binding,
  assertIdentity,
  historyWindow,
  historyVersion,
  turnToken,
  archiveIndex,
  stableId,
};
