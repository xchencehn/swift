'use strict';

// Rebuildable, private display index. Native journals remain authoritative.
// Raw tool output and encrypted reasoning are never retained by this reader.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');
const {
  createCodexTranscriptParser,
  createClaudeTranscriptParser,
  textOnly,
} = require('./agent-transcript');
const Conversation = require('./conversation-state');
const { CodexLineage } = require('./codex-lineage');
const { archivedStatus } = require('./chat-status');
const { claudeGoal } = require('./agent-goal');
const { readEntry } = require('./session-metadata');

const signature = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const PREVIEW = 512,
  TOOLS_PER_MESSAGE = 16,
  PAGE_BYTES = 192 * 1024;
const preview = (part) =>
  part?.text?.length > PREVIEW
    ? {
        ...part,
        text: part.text.slice(0, PREVIEW),
        truncated: true,
        fullLength: part.fullLength || part.text.length,
      }
    : part;
const projected = (message) =>
  textOnly([message], { mergeTools: false }).map((value) => ({
    ...value,
    blocks: value.blocks.map((block) =>
      block.kind === 'tools'
        ? {
            ...block,
            items: block.items.map((item) => ({
              ...item,
              input: preview(item.input),
              result: preview(item.result),
            })),
          }
        : block,
    ),
  }))[0];
const changed = () =>
  Object.assign(new Error('历史已变化，请重新读取。'), { code: 'HISTORY_CHANGED', status: 409 });

class ConversationIndex {
  constructor({ file = ':memory:' } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.lineage = new CodexLineage();
    this.states = new Map();
    if (file !== ':memory:') fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS archives (source TEXT PRIMARY KEY, signature TEXT NOT NULL, state BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation (source TEXT NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL, item TEXT NOT NULL,
        PRIMARY KEY(source,position));
      CREATE INDEX IF NOT EXISTS conversation_id ON conversation(source,id);
      CREATE INDEX IF NOT EXISTS conversation_users ON conversation(source,position) WHERE json_extract(item,'$.role')='user';
      CREATE TABLE IF NOT EXISTS archive_ids (source TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(source,id));`);
    this.upsert = this.db.prepare(
      'INSERT INTO conversation VALUES(?,?,?,?) ON CONFLICT(source,position) DO UPDATE SET id=excluded.id,item=excluded.item',
    );
    this.addId = this.db.prepare('INSERT OR IGNORE INTO archive_ids VALUES(?,?)');
    this.stats = { bytesRead: 0, recordsRead: 0, rebuilds: 0, checkpoints: 0 };
  }
  parser(provider, state) {
    return provider === 'codex'
      ? createCodexTranscriptParser({
          state,
          maxToolsPerMessage: TOOLS_PER_MESSAGE,
          toolImages: false,
        })
      : createClaudeTranscriptParser({ state, toolImages: false });
  }
  async descriptor(file, provider) {
    if (provider === 'codex') {
      const descriptor = await this.lineage.inspect(file);
      return {
        ...descriptor,
        signature: descriptor.segments ? descriptor.signature : signature(descriptor.version),
      };
    }
    const version = await fs.promises.stat(file);
    return { version, signature: signature(version) };
  }
  // Read complete lines and remember the exact byte boundary. A partial last
  // record is retried on append; UTF-8 is decoded only after joining its bytes.
  async feed(file, start, end, consume) {
    if (end <= start) return start;
    let fragments = [],
      length = 0,
      offset = start;
    for await (const chunk of fs.createReadStream(file, {
      start,
      end: end - 1,
      highWaterMark: 64 * 1024,
    })) {
      this.stats.bytesRead += chunk.length;
      let at = 0,
        newline;
      while ((newline = chunk.indexOf(10, at)) >= 0) {
        const part = chunk.subarray(at, newline);
        fragments.push(part);
        length += part.length;
        const raw = (fragments.length === 1 ? part : Buffer.concat(fragments, length)).toString(
          'utf8',
        );
        offset += length + 1;
        fragments = [];
        length = 0;
        if (raw) {
          this.stats.recordsRead++;
          consume(raw);
        }
        at = newline + 1;
      }
      if (at < chunk.length) {
        const part = chunk.subarray(at);
        fragments.push(part);
        length += part.length;
      }
    }
    return offset;
  }
  raw(state, raw, { canonical = false } = {}) {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return;
    }
    const payload = entry.payload || {};
    const sequence = ++state.sequence;
    for (const id of [entry.uuid, entry.id, payload.id, entry.attachment?.source_uuid])
      if (typeof id === 'string' && id) this.addId.run(state.key, id);
    if (entry.type === 'response_item' && payload.type === 'message' && !payload.id && payload.role)
      this.addId.run(state.key, `${payload.role}-${Conversation.stableId(raw)}`);
    if (!canonical) {
      if (
        state.provider === 'codex' &&
        entry.type === 'event_msg' &&
        payload.type === 'thread_rolled_back'
      )
        state.rebuild = true;
      if (
        state.provider === 'claude' &&
        !entry.isSidechain &&
        entry.uuid &&
        Object.hasOwn(entry, 'parentUuid')
      ) {
        if (
          state.lastUuid &&
          entry.parentUuid !== state.lastUuid &&
          entry.logicalParentUuid !== state.lastUuid
        )
          state.rebuild = true;
        state.lastUuid = entry.uuid;
      }
    }
    readEntry(state.metadata, entry, state.provider);
    if (
      entry.type === 'turn_context' ||
      (entry.type === 'event_msg' && payload.type === 'token_count') ||
      (state.provider === 'claude' &&
        entry.type === 'assistant' &&
        typeof entry.message?.model === 'string')
    ) {
      // One latest record per status source; no unbounded token-event history.
      const slim =
        entry.type === 'turn_context'
          ? {
              type: entry.type,
              timestamp: entry.timestamp,
              payload: Object.fromEntries(
                ['model', 'effort', 'reasoning_effort', 'cwd'].map((key) => [key, payload[key]]),
              ),
            }
          : state.provider === 'claude'
            ? {
                type: entry.type,
                timestamp: entry.timestamp,
                message: { model: entry.message.model },
              }
            : entry;
      state.statusRecords[entry.type === 'event_msg' ? 'usage' : 'settings'] = JSON.stringify(slim);
    }
    if (state.provider === 'codex' && entry.type === 'response_item') {
      if (
        payload.type === 'function_call' &&
        /(?:^|\.)request_user_input(?:_async)?$/.test(payload.name || '')
      ) {
        state.questionCalls.add(payload.call_id);
        state.controlRecords.push([sequence, raw]);
      } else if (
        (payload.type === 'function_call_output' && state.questionCalls.has(payload.call_id)) ||
        (payload.type === 'message' &&
          payload.role === 'user' &&
          payload.content?.some((part) =>
            part.text?.includes('<send_user_message_question_reply>'),
          ))
      )
        state.controlRecords.push([sequence, raw]);
    }
    if (state.provider === 'claude' && !entry.isSidechain) {
      const content = entry.message?.content;
      if (
        entry.type === 'user' &&
        (typeof content === 'string' || content?.some((part) => part.type === 'text'))
      )
        state.lastUser = [sequence, raw];
      if (typeof content === 'string' && content.startsWith('<local-command-stdout>'))
        state.controlRecords.push([sequence, raw]);
      if (Array.isArray(content)) {
        const relevant = content.filter(
          (part) =>
            (part.type === 'tool_use' && part.name === 'AskUserQuestion') ||
            (part.type === 'tool_result' && state.questionCalls.has(part.tool_use_id)),
        );
        for (const part of relevant) if (part.type === 'tool_use') state.questionCalls.add(part.id);
        if (relevant.length)
          state.controlRecords.push([
            sequence,
            JSON.stringify({ ...entry, message: { ...entry.message, content: relevant } }),
          ]);
      }
    }
    if (state.provider === 'codex' && entry.type === 'event_msg') {
      if (payload.type === 'task_started') {
        state.turnId = payload.turn_id;
        state.turnIds.add(payload.turn_id);
      }
      if (['task_complete', 'turn_aborted'].includes(payload.type)) state.turnId = null;
    }
    if (state.provider === 'claude') {
      if (
        entry.type === 'attachment' &&
        entry.attachment?.type === 'goal_status' &&
        !entry.isSidechain
      )
        state.goal = claudeGoal([raw]);
      if (
        entry.type === 'user' &&
        !entry.isMeta &&
        (typeof entry.message?.content === 'string' ||
          entry.message?.content?.some((block) => block.type === 'text'))
      )
        state.turnId = entry.uuid || null;
    }
    if (!entry.isSidechain) state.parser.write([raw]);
  }
  fresh(key, file, provider, epoch = 0) {
    this.stats.rebuilds++;
    return {
      key,
      file,
      provider,
      projectionVersion: 2,
      offset: 0,
      stat: null,
      parser: this.parser(provider),
      epoch,
      revision: hash(`empty:${epoch}`),
      metadata: {},
      statusRecords: {},
      turnIds: new Set(),
      turnId: null,
      goal: null,
      sequence: 0,
      controlRecords: [],
      questionCalls: new Set(),
    };
  }
  async boundary(file, offset) {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(offset, 256));
      await handle.read(buffer, 0, buffer.length, offset - buffer.length);
      return buffer;
    } finally {
      await handle.close();
    }
  }
  async update(file, provider) {
    const key = hash(`${provider}:${file}`),
      descriptor = await this.descriptor(file, provider),
      stat = descriptor.version;
    let state = this.states.get(key);
    if (!state) {
      const row = this.db.prepare('SELECT signature,state FROM archives WHERE source=?').get(key);
      if (row) {
        try {
          state = v8.deserialize(row.state);
          state.parser = this.parser(provider, state.checkpoint);
          delete state.checkpoint;
        } catch {
          /* A derived cache from an incompatible runtime is rebuilt. */
        }
      }
    }
    // Older projections clipped envelopes before extracting readable results.
    if (state && state.projectionVersion !== 2) state = null;
    // Some filesystems give several rapid writes the same timestamp. Verify
    // the committed boundary even on a stat cache hit, as on append recovery.
    if (
      state?.signature === descriptor.signature &&
      (await this.boundary(file, state.offset)).equals(state.boundary)
    ) {
      this.remember(key, state);
      return state;
    }
    const append =
      state &&
      !descriptor.segments &&
      state.stat?.ino === stat.ino &&
      stat.size > state.stat.size &&
      (await this.boundary(file, state.offset)).equals(state.boundary);
    if (!append) state = this.fresh(key, file, provider, (state?.epoch || 0) + 1);
    this.db.exec('BEGIN');
    try {
      if (!append) {
        this.db.prepare('DELETE FROM conversation WHERE source=?').run(key);
        this.db.prepare('DELETE FROM archive_ids WHERE source=?').run(key);
      }
      if (descriptor.segments) {
        const inherited = await this.lineage.read(file, descriptor);
        for (const id of Conversation.archiveIndex(inherited.lines).ids) this.addId.run(key, id);
        for (const raw of Conversation.effectiveLines(provider, inherited.lines))
          this.raw(state, raw, { canonical: true });
        state.offset = stat.size;
      } else
        state.offset = await this.feed(file, state.offset, stat.size, (raw) =>
          this.raw(state, raw),
        );
      if (state.rebuild) {
        // Branch changes are rare and may invalidate arbitrary earlier tools.
        // Use the existing canonical history resolver for this rebuild only.
        const text = await fs.promises.readFile(file, 'utf8'),
          end = text.lastIndexOf('\n') + 1;
        const raw = text.slice(0, end).split('\n').filter(Boolean);
        const effective = Conversation.effectiveLines(provider, raw);
        state = this.fresh(key, file, provider, state.epoch + 1);
        this.db.prepare('DELETE FROM conversation WHERE source=?').run(key);
        for (const line of effective) this.raw(state, line, { canonical: true });
        state.offset = Buffer.byteLength(text.slice(0, end));
        state.lastUuid = effective
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return {};
            }
          })
          .findLast((entry) => entry.uuid && !entry.isSidechain)?.uuid;
      }
      let revision = state.revision;
      for (const { index, message } of state.parser.changes().sort((a, b) => a.index - b.index)) {
        const value = projected(message);
        const previous = this.db
          .prepare('SELECT item FROM conversation WHERE source=? AND position=?')
          .get(key, index);
        if (!value) {
          if (previous) {
            this.db
              .prepare('DELETE FROM conversation WHERE source=? AND position=?')
              .run(key, index);
            revision = hash(`${revision}:${index}:removed`);
          }
          continue;
        }
        const item = JSON.stringify(value);
        if (item === previous?.item) continue;
        this.upsert.run(key, index, value.id, item);
        revision = hash(`${revision}:${index}:${item}`);
      }
      Object.assign(state, {
        signature: descriptor.signature,
        stat: { ino: stat.ino, size: stat.size },
        revision,
        boundary: await this.boundary(file, state.offset),
        status: archivedStatus(provider, Object.values(state.statusRecords)),
      });
      const { parser, ...stored } = state;
      const checkpoint = v8.serialize({ ...stored, checkpoint: parser.checkpoint() });
      state.retainedBytes = checkpoint.byteLength * 3;
      this.db
        .prepare(
          'INSERT INTO archives VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET signature=excluded.signature,state=excluded.state',
        )
        .run(key, descriptor.signature, checkpoint);
      this.stats.checkpoints++;
      this.db.exec('COMMIT');
      this.remember(key, state);
      return state;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.states.delete(key);
      throw error;
    }
  }
  remember(key, state) {
    this.states.delete(key);
    this.states.set(key, state);
    // Checkpoints allow cache eviction without rereading a hundred-MiB journal.
    let bytes = [...this.states.values()].reduce(
      (sum, value) => sum + (value.retainedBytes || 0),
      0,
    );
    while (this.states.size && (this.states.size > 4 || bytes > 64 * 1024 * 1024)) {
      const oldest = this.states.keys().next().value;
      bytes -= this.states.get(oldest).retainedBytes || 0;
      this.states.delete(oldest);
    }
  }
  async page(
    file,
    provider,
    {
      limit = 60,
      before,
      from,
      revision,
      historyEpoch,
      windowless = false,
      receiptIds = [],
      controls = false,
      navigation = false,
      around,
    } = {},
  ) {
    if (!['codex', 'claude'].includes(provider)) {
      this.fallback ||= new (require('./conversation-store').ConversationStore)();
      const value = await this.fallback.read(file, provider);
      return {
        ...Conversation.historyWindow(value.conversation, { limit, before, from, revision }),
        status: value.status,
        goal: value.goal,
      };
    }
    const state = await this.update(file, provider),
      key = state.key;
    if (
      (before || around) &&
      ((historyEpoch != null && Number(historyEpoch) !== state.epoch) ||
        (revision && revision !== state.revision && historyEpoch == null))
    )
      throw changed();
    const locate = (id) =>
      this.db
        .prepare(
          'SELECT position FROM conversation WHERE source=? AND id=? ORDER BY position LIMIT 1',
        )
        .get(key, id)?.position;
    const target = around ? locate(around) : null;
    if (around && target == null) throw changed();
    const end = before ? locate(before) : around ? target + limit : Number.MAX_SAFE_INTEGER;
    if (end == null) throw changed();
    const total = this.db
      .prepare('SELECT COUNT(*) AS count FROM conversation WHERE source=?')
      .get(key).count;
    if (navigation) {
      const rows = this.db
        .prepare(
          "SELECT id,substr(coalesce(json_extract(item,'$.blocks[0].text'),''),1,640) AS text FROM conversation WHERE source=? AND json_extract(item,'$.role')='user' AND position<? ORDER BY position DESC LIMIT 500",
        )
        .all(key, end);
      return {
        historyRevision: state.revision,
        historyEpoch: state.epoch,
        navigation: rows.reverse().map((row) => {
          return { id: row.id, text: row.text };
        }),
        hasMore: rows.length === 500,
        messages: [],
      };
    }
    let rows = windowless
      ? []
      : around
        ? this.db
            .prepare(
              'SELECT position,item FROM conversation WHERE source=? AND position>=? ORDER BY position ASC LIMIT ?',
            )
            .all(key, target, limit)
            .reverse()
        : this.db
            .prepare(
              'SELECT position,item FROM conversation WHERE source=? AND position<? ORDER BY position DESC LIMIT ?',
            )
            .all(key, end, limit);
    const anchor = !windowless && !before && from ? locate(from) : null;
    if (anchor != null)
      rows = this.db
        .prepare(
          'SELECT position,item FROM conversation WHERE source=? AND position>=? ORDER BY position DESC',
        )
        .all(key, anchor);
    if (anchor == null) {
      let bytes = 0;
      if (around) rows.reverse();
      rows = rows.filter((row, index) => {
        bytes += Buffer.byteLength(row.item);
        return !index || bytes <= PAGE_BYTES;
      });
      if (around) rows.reverse();
    }
    const start = rows.at(-1)?.position;
    const hasMore = windowless
      ? total > limit
      : start != null &&
        Boolean(
          this.db
            .prepare('SELECT 1 FROM conversation WHERE source=? AND position<? LIMIT 1')
            .get(key, start),
        );
    const active = receiptIds.length ? new Set(state.parser.ids()) : new Set();
    const ids = new Set(
      receiptIds.filter((id) =>
        this.db.prepare('SELECT 1 FROM archive_ids WHERE source=? AND id=?').get(key, id),
      ),
    );
    const controlLines = controls
      ? [...state.controlRecords, ...(state.lastUser ? [state.lastUser] : [])]
          .sort((a, b) => a[0] - b[0])
          .map((record) => record[1])
      : [];
    if (controls && state.statusRecords.settings) controlLines.push(state.statusRecords.settings);
    return {
      historyRevision: state.revision,
      historyEpoch: state.epoch,
      total,
      hasMore,
      replace: !before,
      ...(windowless
        ? { windowless: true }
        : { messages: rows.reverse().map((row) => JSON.parse(row.item)) }),
      status: state.status,
      goal: state.goal,
      turnId: state.turnId,
      turnIds: [...state.turnIds],
      ...(controls
        ? {
            controlLines,
            questionState:
              provider === 'codex'
                ? require('./questions/codex').questionState(controlLines)
                : undefined,
          }
        : {}),
      receipts: {
        messages: receiptIds.filter((id) => active.has(id)).map((id) => ({ id })),
        archive: { ids, activeIds: new Set(receiptIds.filter((id) => active.has(id))) },
      },
    };
  }
  close() {
    this.db.close();
  }
}
module.exports = { ConversationIndex, PAGE_BYTES, TOOLS_PER_MESSAGE };
