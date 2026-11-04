// Adapted from devswha/herdr-web-ui at 685293e0a7b912f28b3e19af7e07ae335cfb45e0.
// Copyright (c) 2026 devswha. MIT; see public/vendor/herdr-web-ui/LICENSE.
const { DatabaseSync } = require('node:sqlite');
class Database extends DatabaseSync {
  constructor(file) {
    super(file, { readOnly: true });
  }
  query(sql) {
    const statement = this.prepare(sql),
      get = statement.get.bind(statement);
    statement.get = (...values) => get(...values) ?? null;
    return statement;
  }
}
const { createHash, randomUUID } = require('node:crypto');
const { homedir } = require('node:os');
const { join } = require('node:path');
const MAX_NODES = 5000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const PROCESS_SALT = randomUUID();
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const text = (value) => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '');
const boundedOutput = (value) =>
  value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n… trimmed` : value;
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const parse = (value) => {
  try {
    return record(JSON.parse(value ?? ''));
  } catch {
    return {};
  }
};
const toolContent = (value) =>
  Array.isArray(value)
    ? boundedOutput(
        value
          .map((block) => {
            const content = record(record(block).content).text;
            return typeof content === 'string' ? content : '';
          })
          .filter(Boolean)
          .join('\n'),
      )
    : boundedOutput(typeof value === 'string' ? value : '');
const stamp = (value) => {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
class DevinHistoryChanged extends Error {
  constructor() {
    super('Devin history changed');
    this.name = 'DevinHistoryChanged';
  }
}
class DevinHistoryUnavailable extends Error {
  constructor() {
    super('Devin history is unavailable');
    this.name = 'DevinHistoryUnavailable';
  }
}
const histories = new Map();
const cursor = (id, epoch, revision, node) => JSON.stringify([id, epoch, revision, node]);
const nodeCursor = (value, id, epoch, revision) => {
  if (!value) return null;
  let decoded;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new DevinHistoryChanged();
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    decoded[0] !== id ||
    decoded[1] !== epoch ||
    decoded[2] !== revision ||
    !Number.isSafeInteger(decoded[3]) ||
    decoded[3] < 0
  )
    throw new DevinHistoryChanged();
  return decoded[3];
};
function defaultDevinDbPath() {
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'devin',
    'cli',
    'sessions.db',
  );
}
function forgetDevinState(sessionId, cwd, dbPath) {
  if (sessionId === undefined || cwd === undefined) histories.clear();
  else histories.delete(JSON.stringify([dbPath ?? defaultDevinDbPath(), sessionId, cwd]));
}
function devinConversation(sessionId, cwd, options = {}, dbPath = defaultDevinDbPath()) {
  let db = null;
  try {
    db = new Database(dbPath, {
      readonly: true,
      create: false,
    });
    db.exec('BEGIN');
    const session = db
      .query(
        'SELECT main_chain_id, model FROM sessions WHERE id = ? AND working_directory = ? AND hidden = 0',
      )
      .get(sessionId, cwd);
    if (!session) throw new DevinHistoryUnavailable();
    if (session.main_chain_id !== null && !Number.isSafeInteger(session.main_chain_id))
      throw new DevinHistoryUnavailable();
    const chain =
      session.main_chain_id === null
        ? []
        : db
            .query(
              `
      WITH RECURSIVE ancestry(node_id, parent_node_id, chat_message, created_at, depth, bytes) AS (
        SELECT node_id, parent_node_id,
          CASE WHEN length(CAST(coalesce(chat_message, '') AS BLOB)) <= ${MAX_BYTES} THEN chat_message ELSE NULL END,
          created_at, 1, length(CAST(coalesce(chat_message, '') AS BLOB))
        FROM message_nodes WHERE node_id = ? AND session_id = ?
        UNION ALL
        SELECT n.node_id, n.parent_node_id,
          CASE WHEN a.bytes + length(CAST(coalesce(n.chat_message, '') AS BLOB)) <= ${MAX_BYTES} THEN n.chat_message ELSE NULL END,
          n.created_at, a.depth + 1,
          a.bytes + length(CAST(coalesce(n.chat_message, '') AS BLOB))
        FROM message_nodes n JOIN ancestry a ON n.node_id = a.parent_node_id AND n.session_id = ?
        WHERE a.depth < ${MAX_NODES + 1} AND a.bytes <= ${MAX_BYTES}
      ) SELECT * FROM ancestry
    `,
            )
            .all(session.main_chain_id, sessionId, sessionId)
            .reverse();
    if (
      chain.length &&
      (chain[0].parent_node_id !== null || chain.length > MAX_NODES || chain[0].bytes > MAX_BYTES)
    )
      throw new DevinHistoryUnavailable();
    if (session.main_chain_id !== null && !chain.length) throw new DevinHistoryUnavailable();
    const ids = chain.map((node) => node.node_id);
    if (
      chain.some(
        (node) =>
          !Number.isSafeInteger(node.node_id) ||
          (node.parent_node_id !== null && !Number.isSafeInteger(node.parent_node_id)),
      )
    )
      throw new DevinHistoryUnavailable();
    if (new Set(ids).size !== ids.length) throw new DevinHistoryUnavailable();
    const key = JSON.stringify([dbPath, sessionId, cwd]);
    const previous = histories.get(key);
    const replacement =
      previous &&
      (ids.length < previous.nodes.length || previous.nodes.some((id, index) => ids[index] !== id));
    const revision = (previous?.revision ?? 0) + (replacement ? 1 : 0);
    const epoch = previous?.epoch ?? `${PROCESS_SALT}:${randomUUID()}`;
    histories.delete(key);
    histories.set(key, {
      nodes: ids,
      revision,
      epoch,
    });
    if (histories.size > 64) histories.delete(histories.keys().next().value);
    const history_id = createHash('sha256')
      .update(key)
      .update(PROCESS_SALT)
      .update(epoch)
      .update(String(revision))
      .digest('hex');
    const before = nodeCursor(options.before, sessionId, epoch, revision);
    const since = nodeCursor(options.since, sessionId, epoch, revision);
    const from = nodeCursor(options.from, sessionId, epoch, revision);
    const positions = new Map(ids.map((id, index) => [id, index]));
    for (const boundary of [before, since, from])
      if (boundary !== null && !positions.has(boundary)) throw new DevinHistoryChanged();
    const calls = new Set();
    for (const node of chain) {
      const message = parse(node.chat_message);
      if (message.role === 'assistant' && Array.isArray(message.tool_calls))
        for (const raw of message.tool_calls) {
          const id = text(record(raw).id);
          if (id) calls.add(id);
        }
    }
    const callIds = [...calls];
    let stateBytes = 0;
    for (let i = 0; i < callIds.length; i += 250) {
      const batch = callIds.slice(i, i + 250);
      const size = db
        .query(
          `SELECT coalesce(sum(length(CAST(coalesce(tool_call_json, '') AS BLOB)) + length(CAST(coalesce(tool_call_update_json, '') AS BLOB))), 0) AS bytes FROM tool_call_state WHERE session_id = ? AND tool_call_id IN (${batch.map(() => '?').join(',')})`,
        )
        .get(sessionId, ...batch);
      stateBytes += size?.bytes ?? 0;
      if (stateBytes > MAX_BYTES) throw new DevinHistoryUnavailable();
    }
    const states = [];
    for (let i = 0; i < callIds.length; i += 250) {
      const batch = callIds.slice(i, i + 250);
      states.push(
        ...db
          .query(
            `SELECT tool_call_id, tool_call_json, tool_call_update_json FROM tool_call_state WHERE session_id = ? AND tool_call_id IN (${batch.map(() => '?').join(',')})`,
          )
          .all(sessionId, ...batch),
      );
    }
    const updates = new Map(states.map((state) => [state.tool_call_id, state]));
    const hash = createHash('sha256')
      .update(history_id)
      .update(String(session.main_chain_id))
      .update(JSON.stringify(session.model));
    for (const node of chain) hash.update(JSON.stringify(node));
    for (const state of states.sort((a, b) => a.tool_call_id.localeCompare(b.tool_call_id)))
      hash.update(JSON.stringify(state));
    const version = hash.digest('hex');
    const turns = [];
    const pending = new Map();
    const metadata = {
      model: session.model,
      reasoning_effort: null,
    };
    for (const node of chain) {
      const message = parse(node.chat_message);
      const role = message.role;
      if (role === 'system') continue;
      const meta = record(message.metadata);
      if (typeof meta.generation_model === 'string') metadata.model = text(meta.generation_model);
      if (typeof meta.reasoning_effort === 'string')
        metadata.reasoning_effort = text(meta.reasoning_effort);
      const sent =
        typeof meta.created_at === 'string' && ZONED_ISO.test(meta.created_at)
          ? new Date(meta.created_at)
          : null;
      const ts =
        sent !== null && Number.isFinite(sent.getTime())
          ? sent.toISOString()
          : stamp(node.created_at);
      if (role === 'tool') {
        const part = pending.get(text(message.tool_call_id));
        if (part) {
          if (typeof message.content === 'string' && message.content)
            part.output = toolContent(message.content);
          if (message.is_error === true || message.error === true) part.error = true;
        }
        continue;
      }
      if (role !== 'user' && role !== 'assistant') continue;
      const parts = [];
      const thinking = text(
        typeof message.thinking === 'string' ? message.thinking : record(message.thinking).thinking,
      );
      if (role === 'assistant' && thinking)
        parts.push({
          kind: 'thinking',
          text: thinking,
        });
      if (text(message.content))
        parts.push({
          kind: 'text',
          text: text(message.content),
        });
      if (role === 'assistant' && Array.isArray(message.tool_calls))
        for (const rawCall of message.tool_calls) {
          const call = record(rawCall);
          if (!text(call.name)) continue;
          const id = text(call.id);
          if (id && pending.has(id)) continue;
          const state = updates.get(id);
          const update = parse(state?.tool_call_update_json ?? null);
          const saved = parse(state?.tool_call_json ?? null);
          const args = call.arguments ?? saved.rawInput;
          const input =
            typeof args === 'string'
              ? text(args)
              : args === undefined
                ? ''
                : JSON.stringify(args).slice(0, MAX_TEXT);
          const part = {
            kind: 'tool',
            name: text(call.name),
            id,
            summary: text(update.title) || text(saved.title) || text(call.name),
            input,
            output: toolContent(update.content),
            ...(update.status === 'error' || update.status === 'failed'
              ? {
                  error: true,
                }
              : {}),
          };
          parts.push(part);
          if (id) pending.set(id, part);
        }
      if (parts.length) {
        const last = turns.at(-1);
        if (role === 'assistant' && last?.turn.role === 'assistant') {
          last.turn.parts.push(...parts);
          last.turn.end_ts = ts ?? undefined;
        } else
          turns.push({
            node: node.node_id,
            turn: {
              role,
              ts,
              parts,
            },
          });
      }
    }
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100) || 100));
    const page = turns
      .filter(
        ({ node }) =>
          (before === null || positions.get(node) < positions.get(before)) &&
          (since === null || positions.get(node) >= positions.get(since)) &&
          (from === null || positions.get(node) >= positions.get(from)),
      )
      .slice(-limit);
    const first = page[0]?.node;
    const pageCursor =
      first === undefined || (from === null && first === turns[0]?.node)
        ? null
        : from !== null && first === from
          ? options.from
          : cursor(sessionId, epoch, revision, first);
    return {
      source: 'devin-transcript',
      turns: page.map(({ turn }) => turn),
      metadata,
      cursor: pageCursor,
      history_id,
      version,
    };
  } catch (error) {
    if (error instanceof DevinHistoryChanged || error instanceof DevinHistoryUnavailable)
      throw error;
    throw new DevinHistoryUnavailable();
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

module.exports = {
  DevinHistoryChanged,
  DevinHistoryUnavailable,
  defaultDevinDbPath,
  forgetDevinState,
  devinConversation,
};
