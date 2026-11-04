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
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { trimOutput } = require('./tool-output.js');
const { MAX_TURNS, toolSummary } = require('./transcript-records.js');
const MAX_PAGE_PROMPTS = MAX_TURNS / 2;
const OPENCODE_WINDOW_BYTES = 16 * 1024 * 1024;
const NOTICE_CHARS = 16_000;
const BUSY_TIMEOUT_MS = 250;
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9]{1,64}$/;
const OPENCODE_TOOL_REF = /^(msg_[A-Za-z0-9]{1,64}):(\d{1,4})$/;
const OPENCODE_IMAGE_REF = /^opencode:(msg_[A-Za-z0-9]{1,64}):(\d{1,3})$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : null);
const count = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const iso = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
const skillName = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n<>]/.test(value)
    ? value
    : null;
const cut = (value) =>
  value.length > NOTICE_CHARS ? `${value.slice(0, NOTICE_CHARS)}\n… trimmed` : value;
function opencodeDatabasePath(env = process.env, home = homedir()) {
  const named = env['OPENCODE_DB'];
  if (named === ':memory:') return null;
  const data = join(env['XDG_DATA_HOME'] || join(home, '.local', 'share'), 'opencode');
  return named ? resolve(data, named) : join(data, 'opencode.db');
}
function opencodeSessionId(pane) {
  const session = pane.agent_session;
  if (
    session?.agent !== 'opencode' ||
    session.source !== 'herdr:opencode' ||
    session.kind !== 'id' ||
    !SESSION_ID.test(session.value)
  )
    return null;
  return session.value;
}
function rowImages(type, data) {
  const images = [];
  const add = (value) => {
    const file = record(value);
    const uri =
      typeof file.uri === 'string' ? /^data:([\w.+/-]+);base64,(.*)$/s.exec(file.uri) : null;
    const type = uri?.[1] ?? file.mime;
    const base64 = uri?.[2] ?? (record(file.source).type === 'inline' ? file.data : undefined);
    if (
      typeof type === 'string' &&
      IMAGE_TYPES.has(type) &&
      typeof base64 === 'string' &&
      base64.length > 0
    )
      images.push({
        media_type: type,
        data: base64,
      });
  };
  if (type === 'user') (Array.isArray(data.files) ? data.files : []).forEach(add);
  if (type === 'assistant') {
    for (const block of (Array.isArray(data.content) ? data.content : []).map(record)) {
      if (block.type !== 'tool') continue;
      for (const item of (Array.isArray(record(block.state).content)
        ? record(block.state).content
        : []
      ).map(record))
        if (item.type === 'file') add(item);
    }
  }
  return images;
}
function toolText(state) {
  if (state.status === 'error') return text(record(state.error).message) ?? '';
  return (Array.isArray(state.content) ? state.content : [])
    .map(record)
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}
function toolSkill(name, input, status) {
  if (name !== 'skill') return null;
  const skill = skillName(input.id) ?? skillName(input.name);
  if (skill === null) return null;
  return {
    name: skill,
    evidence: 'invocation',
    status: status === 'completed' ? 'loaded' : status === 'error' ? 'failed' : 'requested',
  };
}
function unwrap(body) {
  const match = /^<(shell|subagent)\b[^>]*>\n?([\s\S]*?)\n*<\/\1>\s*$/.exec(body.trim());
  return (match?.[2] ?? body).trim();
}
function opencodeRecord(id, type, data) {
  const time = record(data.time);
  if (type === 'user') {
    const images = rowImages(type, data).map((image, index) => ({
      kind: 'image',
      media_type: image.media_type,
      ref: `opencode:${id}:${index}`,
    }));
    const prompt = text(record(data.metadata).displayText) ?? text(data.text);
    const skills = (Array.isArray(data.skills) ? data.skills : []).map(record).flatMap((skill) => {
      const name = skillName(skill.name) ?? skillName(skill.id);
      return name === null
        ? []
        : [
            {
              kind: 'skill',
              skill: {
                name,
                evidence: 'instructions',
                status: 'loaded',
              },
            },
          ];
    });
    const parts = [
      ...images,
      ...(prompt === null
        ? []
        : [
            {
              kind: 'text',
              text: prompt,
            },
          ]),
      ...skills,
    ];
    return parts.length === 0
      ? null
      : {
          role: 'user',
          ts: iso(time.created),
          parts,
        };
  }
  if (type === 'assistant') {
    const parts = [];
    let image = 0;
    (Array.isArray(data.content) ? data.content : []).forEach((value, index) => {
      const block = record(value);
      if (block.type === 'text' && text(block.text) !== null)
        parts.push({
          kind: 'text',
          text: block.text,
        });
      else if (block.type === 'reasoning' && text(block.text) !== null)
        parts.push({
          kind: 'thinking',
          text: block.text,
        });
      else if (block.type === 'tool' && typeof block.name === 'string') {
        const state = record(block.state);
        const input = record(state.input);
        const skill = toolSkill(block.name, input, state.status);
        const summary = toolSummary(block.name, input);
        const part = {
          kind: 'tool',
          name: block.name,
          id: `${id}:${index}`,
          summary:
            skill?.name ??
            (summary === block.name && typeof input.query === 'string'
              ? input.query.slice(0, 120)
              : summary),
          input: JSON.stringify(input, null, 2),
          output: '',
        };
        if (skill !== null) part.skill = skill;
        trimOutput(part, toolText(state), `${id}:${index}`);
        const exit = record(state.metadata).exit;
        if (state.status === 'error' || (typeof exit === 'number' && exit !== 0)) part.error = true;
        const files = (Array.isArray(state.content) ? state.content : [])
          .map(record)
          .filter((item) => item.type === 'file');
        const shown =
          files.length === 0
            ? []
            : rowImages('assistant', {
                content: [block],
              });
        if (shown.length > 0)
          part.images = shown.map((found) => ({
            media_type: found.media_type,
            ref: `opencode:${id}:${image++}`,
          }));
        parts.push(part);
      }
    });
    const error = record(data.error);
    if (error.type !== 'aborted' && text(error.message) !== null)
      parts.push({
        kind: 'text',
        text: `Error: ${error.message}`,
      });
    const end = iso(time.completed) ?? iso(time.streamed) ?? iso(time.created);
    return {
      role: 'assistant',
      ts: iso(time.created),
      end,
      parts,
      stop: data.finish === 'stop',
    };
  }
  if (type === 'idle')
    return {
      role: 'idle',
    };
  if (type === 'shell' && typeof data.command === 'string') {
    const output = record(data.output).output;
    const printed =
      typeof output === 'string' && output.length > 0 ? `\n${output.replace(/[\r\n]+$/, '')}` : '';
    return {
      role: 'user',
      ts: iso(time.created),
      parts: [
        {
          kind: 'notice',
          text: cut(`$ ${data.command}${printed}`),
          source: 'shell',
        },
      ],
    };
  }
  if (type === 'synthetic') {
    const metadata = record(data.metadata);
    if (metadata.source === 'shell' && metadata.jobID === undefined) return null;
    const body = typeof data.text === 'string' ? unwrap(data.text) : '';
    const label = text(data.description)?.trim() ?? null;
    const shown =
      label !== null && body.length > 0 && body !== label ? `${label}\n${body}` : (label ?? body);
    if (shown.length === 0) return null;
    const source = text(metadata.source) ?? text(metadata.notice) ?? 'synthetic';
    return {
      role: 'user',
      ts: iso(time.created),
      parts: [
        {
          kind: 'notice',
          text: cut(shown),
          source,
        },
      ],
    };
  }
  if (type === 'compaction' && data.status === 'completed' && text(data.summary) !== null) {
    return {
      role: 'user',
      ts: iso(time.created),
      parts: [
        {
          kind: 'compact',
          text: data.summary,
        },
      ],
    };
  }
  return null;
}
function opencodeTurns(records) {
  const turns = [];
  let settled = false;
  for (const entry of records) {
    if (entry === null) continue;
    if (entry.role === 'idle') {
      settled = true;
      continue;
    }
    if (entry.role === 'user') {
      turns.push({
        role: 'user',
        ts: entry.ts,
        parts: [...entry.parts],
      });
      settled = false;
      continue;
    }
    let turn = turns[turns.length - 1];
    if (turn === undefined || turn.role !== 'assistant' || settled) {
      turn = {
        role: 'assistant',
        ts: entry.ts,
        parts: [],
      };
      turns.push(turn);
    }
    turn.parts.push(...entry.parts);
    if (entry.end !== null) turn.end_ts = entry.end;
    settled = entry.stop;
  }
  return turns.filter((turn) => turn.parts.length > 0);
}
function pageStart(rows, floor, widen, window = OPENCODE_WINDOW_BYTES) {
  let bytes = 0;
  let prompts = 0;
  let earliest;
  let newer;
  for (const row of rows) {
    bytes += row.size;
    if (bytes > (widen && earliest === undefined ? 4 * window : window))
      return earliest ?? newer ?? row.seq;
    if (row.type === 'user') {
      earliest = row.seq;
      if (++prompts === MAX_PAGE_PROMPTS) return row.seq;
    }
    newer = row.seq;
  }
  return floor;
}
const newestRecords = new Map();
const answers = new Map();
function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}
function forgetOpencodeState() {
  newestRecords.clear();
  answers.clear();
  settings.clear();
}
const opencodeReadKey = (path, sessionId) => `${path}\0${sessionId}`;
function forgetOpencodeRead(key) {
  newestRecords.delete(key);
  for (const map of [answers, settings])
    for (const entry of [...map.keys()]) if (entry.startsWith(`${key}\0`)) map.delete(entry);
}
function openStore(path) {
  try {
    const db = new Database(path, {
      readonly: true,
      create: false,
    });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch {
    return null;
  }
}
function withStore(path, read) {
  const db = openStore(path);
  if (db === null) return null;
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function unusable(error) {
  return (
    error instanceof Error &&
    (/no such (table|column)/.test(error.message) || error.code === 'SQLITE_NOTADB')
  );
}
function busy(error) {
  const code = error?.code;
  return (
    typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  );
}
function sessionView(db, sessionId) {
  const session = db.query('SELECT revert FROM session_v2 WHERE id = ?').get(sessionId);
  if (session === null) return null;
  const stats = db
    .query(
      'SELECT count(*) AS count, max(seq) AS last, max(time_updated) AS updated FROM session_message WHERE session_id = ?',
    )
    .get(sessionId);
  let end = (stats.last ?? -1) + 1;
  let revert = null;
  try {
    revert = session.revert === null ? null : JSON.parse(session.revert);
  } catch {}
  const boundary = record(revert).messageID;
  if (typeof boundary === 'string') {
    const row = db
      .query('SELECT seq FROM session_message WHERE session_id = ? AND id = ?')
      .get(sessionId, boundary);
    if (row !== null) end = row.seq;
  }
  const historyId = `opencode-${sessionId}${end > (stats.last ?? -1) ? '' : `-r${end.toString(36)}`}`;
  return {
    end,
    historyId,
    signature: `${historyId}:${stats.count}:${stats.last}:${stats.updated}`,
  };
}
const settings = new Map();
function sessionMetadata(db, key, sessionId, end, measure) {
  const data = db.query('SELECT data FROM session_message WHERE id = ? AND session_id = ?');
  const sizeOf = db.query(ROW_QUERIES[measure].size);
  let setting = null;
  let usage = null;
  let compacted = false;
  for (const row of db
    .query(
      "SELECT id, type, time_updated AS updated FROM session_message WHERE session_id = ? AND type IN ('assistant', 'model-switched', 'compaction') AND seq < ? ORDER BY seq DESC",
    )
    .iterate(sessionId, end)) {
    let known = settings.get(`${key}\0${row.id}`);
    const size = sizeOf.get(row.id, sessionId)?.size ?? 0;
    if (known?.updated !== row.updated || known.size !== size) {
      const found = data.get(row.id, sessionId);
      const parsed = found === null ? {} : parseData(found.data);
      const model = record(parsed.model);
      known = {
        updated: row.updated,
        size,
        model: text(model.id),
        variant: text(model.variant),
        tokens: parsed.tokens === undefined ? null : record(parsed.tokens),
        completed: parsed.status === 'completed',
      };
      remember(settings, `${key}\0${row.id}`, known, 256);
    }
    if (row.type === 'compaction') {
      if (known.completed && usage === null) compacted = true;
    } else {
      setting ??= {
        model: known.model,
        variant: known.variant,
      };
      if (row.type === 'assistant' && known.tokens !== null && !compacted) usage ??= known.tokens;
    }
    if (setting !== null && (usage !== null || compacted)) break;
  }
  const metadata = {
    model: setting?.model ?? null,
    reasoning_effort:
      setting?.variant !== null && setting?.variant !== undefined && setting.variant !== 'default'
        ? setting.variant
        : null,
  };
  if (usage !== null) {
    const cache = record(usage.cache);
    const used =
      count(usage.input) +
      count(usage.output) +
      count(usage.reasoning) +
      count(cache.read) +
      count(cache.write);
    if (used > 0)
      metadata.context = {
        used,
        window: null,
      };
  }
  return metadata;
}
function parseData(data) {
  try {
    return record(JSON.parse(data));
  } catch {
    return {};
  }
}
function cursorOf(db, sessionId, historyId, cursor, end) {
  const separator = cursor.lastIndexOf(':');
  const offset = Number(cursor.slice(separator + 1));
  if (
    separator <= 0 ||
    cursor.slice(0, separator) !== historyId ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > end
  )
    return null;
  if (offset === 0) return offset;
  return db
    .query('SELECT seq FROM session_message WHERE session_id = ? AND seq = ?')
    .get(sessionId, offset) === null
    ? null
    : offset;
}
const OPENCODE_ROW_SIZE = {
  octets: 'octet_length(data)',
  bytes: 'length(CAST(data AS BLOB))',
};
let supported = null;
function supportedRowSize(db) {
  if (supported === null) {
    try {
      db.query("SELECT octet_length('')").get();
      supported = OPENCODE_ROW_SIZE.octets;
    } catch {
      supported = OPENCODE_ROW_SIZE.bytes;
    }
  }
  return supported;
}
const ROW_QUERIES = {
  [OPENCODE_ROW_SIZE.octets]: {
    page: 'SELECT id, seq, type, time_updated AS updated, octet_length(data) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq',
    pageDescending:
      'SELECT id, seq, type, time_updated AS updated, octet_length(data) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC',
    size: 'SELECT octet_length(data) AS size FROM session_message WHERE id = ? AND session_id = ?',
  },
  [OPENCODE_ROW_SIZE.bytes]: {
    page: 'SELECT id, seq, type, time_updated AS updated, length(CAST(data AS BLOB)) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq',
    pageDescending:
      'SELECT id, seq, type, time_updated AS updated, length(CAST(data AS BLOB)) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC',
    size: 'SELECT length(CAST(data AS BLOB)) AS size FROM session_message WHERE id = ? AND session_id = ?',
  },
};
function opencodeConversation(path, sessionId, page = {}, rowSize) {
  if (!SESSION_ID.test(sessionId))
    return {
      kind: 'unavailable',
      reason: 'no_session_id',
    };
  const key = opencodeReadKey(path, sessionId);
  const cacheKey = `${key}\0${page.before ?? ''}\0${page.since ?? ''}\0${page.from ?? ''}`;
  try {
    const answer = withStore(path, (db) => {
      const view = sessionView(db, sessionId);
      if (view === null)
        return {
          kind: 'unavailable',
          reason: 'session_not_found',
        };
      const cached = answers.get(cacheKey);
      if (cached?.signature === view.signature) return cached.answer;
      const end = view.end;
      const measure = rowSize ?? supportedRowSize(db);
      const descending = (from, to) =>
        db.query(ROW_QUERIES[measure].pageDescending).iterate(sessionId, from, to);
      let start;
      let to = end;
      if (page.before !== undefined) {
        const before = cursorOf(db, sessionId, view.historyId, page.before, end);
        const floor =
          page.since === undefined ? 0 : cursorOf(db, sessionId, view.historyId, page.since, end);
        if (before === null || floor === null || floor > before)
          return {
            kind: 'history_changed',
          };
        start = before === floor ? floor : pageStart(descending(floor, before), floor, true);
        to = before;
      } else {
        const held =
          page.from === undefined ? null : cursorOf(db, sessionId, view.historyId, page.from, end);
        if (page.from !== undefined && held === null)
          return {
            kind: 'history_changed',
          };
        const newest = pageStart(descending(0, end), 0, false);
        start = held !== null && held >= newest ? held : newest;
      }
      const records = [];
      if (page.before === undefined) {
        const known = newestRecords.get(key) ?? new Map();
        const kept = new Map();
        const data = db.query('SELECT data FROM session_message WHERE id = ? AND session_id = ?');
        for (const row of db.query(ROW_QUERIES[measure].page).iterate(sessionId, start, to)) {
          let entry = known.get(row.id);
          if (entry?.updated !== row.updated || entry.size !== row.size) {
            const found = data.get(row.id, sessionId);
            entry = {
              updated: row.updated,
              size: row.size,
              record:
                found === null ? null : opencodeRecord(row.id, row.type, parseData(found.data)),
            };
          }
          kept.set(row.id, entry);
          records.push(entry.record);
        }
        remember(newestRecords, key, kept, 8);
      } else {
        for (const row of db
          .query(
            'SELECT id, type, data FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq',
          )
          .iterate(sessionId, start, to))
          records.push(opencodeRecord(row.id, row.type, parseData(row.data)));
      }
      const result = {
        kind: 'page',
        turns: opencodeTurns(records),
        metadata: sessionMetadata(db, key, sessionId, to, measure),
        cursor: start > 0 ? `${view.historyId}:${start}` : null,
        history_id: view.historyId,
        signature: view.signature,
      };
      remember(
        answers,
        cacheKey,
        {
          signature: view.signature,
          answer: result,
        },
        32,
      );
      return result;
    });
    return (
      answer ?? {
        kind: 'unavailable',
        reason: 'transcript_missing',
      }
    );
  } catch (error) {
    if (unusable(error))
      return {
        kind: 'unavailable',
        reason: 'transcript_missing',
      };
    if (busy(error))
      return (
        answers.get(cacheKey)?.answer ?? {
          kind: 'unavailable',
          reason: 'store_busy',
        }
      );
    throw error;
  }
}
function sessionRow(db, sessionId, id) {
  const view = db.query('SELECT revert FROM session_v2 WHERE id = ?').get(sessionId);
  if (view === null) return null;
  const row = db
    .query('SELECT seq, type, data FROM session_message WHERE id = ? AND session_id = ?')
    .get(id, sessionId);
  if (row === null) return null;
  let revert = null;
  try {
    revert = view.revert === null ? null : JSON.parse(view.revert);
  } catch {}
  const boundary = record(revert).messageID;
  if (typeof boundary === 'string') {
    const hidden = db
      .query('SELECT seq FROM session_message WHERE session_id = ? AND id = ?')
      .get(sessionId, boundary);
    if (hidden !== null && row.seq >= hidden.seq) return null;
  }
  return {
    type: row.type,
    data: parseData(row.data),
  };
}
function readRow(path, sessionId, id, read) {
  if (!SESSION_ID.test(sessionId) || !MESSAGE_ID.test(id)) return null;
  try {
    return withStore(path, (db) => {
      const row = sessionRow(db, sessionId, id);
      return row === null ? null : read(row);
    });
  } catch (error) {
    if (unusable(error) || busy(error)) return null;
    throw error;
  }
}
function opencodeToolOutput(path, sessionId, ref) {
  const match = OPENCODE_TOOL_REF.exec(ref);
  if (match === null) return null;
  return readRow(path, sessionId, match[1], (row) => {
    if (row.type !== 'assistant' || !Array.isArray(row.data.content)) return null;
    const block = record(row.data.content[Number(match[2])]);
    return block.type === 'tool' ? toolText(record(block.state)) : null;
  });
}
function opencodeImage(path, sessionId, ref) {
  const match = OPENCODE_IMAGE_REF.exec(ref);
  if (match === null) return null;
  return readRow(path, sessionId, match[1], (row) => {
    const image = rowImages(row.type, row.data)[Number(match[2])];
    return image === undefined
      ? null
      : {
          mediaType: image.media_type,
          bytes: new Uint8Array(Buffer.from(image.data, 'base64')),
        };
  });
}

module.exports = {
  OPENCODE_WINDOW_BYTES,
  OPENCODE_TOOL_REF,
  OPENCODE_IMAGE_REF,
  opencodeDatabasePath,
  opencodeSessionId,
  opencodeRecord,
  opencodeTurns,
  pageStart,
  forgetOpencodeState,
  opencodeReadKey,
  forgetOpencodeRead,
  OPENCODE_ROW_SIZE,
  opencodeConversation,
  opencodeToolOutput,
  opencodeImage,
};
