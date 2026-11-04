'use strict';
const { parseLine } = require('./json-lines');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StringDecoder } = require('node:string_decoder');
const { locateTranscript } = require('./agent-transcript');
const { shortPhrase } = require('./session-naming');

function placeholderTitle(value) {
  return /^(新会话|临时会话)(?:\s*\|.*)?$/.test(value || '');
}
function displayTitle(value) {
  const title = String(value || '').trim();
  if (/^(codex|claude)-[a-z0-9]{8,}$/i.test(title) || /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(title))
    return '';
  return title.split('\n')[0].slice(0, 160);
}
function readEntry(state, entry, provider) {
  if (provider === 'codex' && entry.type === 'session_meta' && entry.payload?.history_base)
    state.hasHistoryBase = true;
  if (
    provider === 'codex' &&
    entry.type === 'event_msg' &&
    entry.payload?.type === 'thread_rolled_back'
  )
    state.rebuild = true;
  if (
    provider === 'claude' &&
    !entry.isSidechain &&
    entry.uuid &&
    Object.hasOwn(entry, 'parentUuid')
  ) {
    if (state.lastUuid && entry.parentUuid !== state.lastUuid) state.rebuild = true;
    state.lastUuid = entry.uuid;
  }
  if (provider === 'claude') {
    if (entry.type === 'custom-title') state.customTitle = displayTitle(entry.customTitle);
    if (entry.type === 'ai-title') state.aiTitle = displayTitle(entry.aiTitle);
  }
  if (
    provider === 'codex' &&
    entry.type === 'event_msg' &&
    entry.payload?.type === 'user_message'
  ) {
    const at = Date.parse(entry.timestamp || '');
    if (Number.isFinite(at)) state.lastMessageAt = Math.max(state.lastMessageAt || 0, at);
  }
  const message =
    provider === 'codex'
      ? entry.type === 'response_item' && entry.payload
      : ['user', 'assistant'].includes(entry.type) &&
        !entry.isMeta &&
        !entry.isSidechain &&
        entry.message;
  if (!message || !['user', 'assistant'].includes(message.role)) return;
  const kinds = message.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (Array.isArray(kinds) && !kinds.includes('user.text')) return;
  const text =
    typeof message.content === 'string'
      ? message.content
      : (message.content || [])
          .filter((block) => ['text', 'input_text', 'output_text'].includes(block.type))
          .map((block) => block.text || '')
          .join('\n');
  if (
    !text.trim() ||
    /^\s*<(?:environment_context|permissions|INSTRUCTIONS|system-reminder|task-notification)\b/.test(
      text,
    ) ||
    /^# AGENTS\.md instructions/.test(text)
  )
    return;
  if (message.role === 'user' && !state.contentTitle && !/^\s*\//.test(text))
    state.contentTitle = displayTitle(text).slice(0, 120);
  const timestamp = Date.parse(entry.timestamp || '');
  if (Number.isFinite(timestamp))
    state.lastMessageAt = Math.max(state.lastMessageAt || 0, timestamp);
}

class SessionMetadata {
  constructor({ home = os.homedir(), locate = locateTranscript } = {}) {
    this.home = home;
    this.locate = locate;
    this.files = new Map();
    this.paths = new Map();
    this.inflight = new Map();
    this.cachedPanes = new Map();
    this.pendingPanes = new Map();
    this.refreshing = null;
  }
  async scan(file, provider) {
    if (this.inflight.has(file)) return this.inflight.get(file);
    const promise = this.read(file, provider).finally(() => this.inflight.delete(file));
    this.inflight.set(file, promise);
    return promise;
  }
  async read(file, provider) {
    const stat = await fs.promises.stat(file);
    let state = this.files.get(file);
    if (
      !state ||
      stat.size < state.offset ||
      state.ino !== stat.ino ||
      (stat.size === state.offset && state.mtime !== stat.mtimeMs)
    ) {
      state = { offset: 0, tail: '', decoder: new StringDecoder('utf8'), ino: stat.ino };
      if (this.files.size >= 128) this.files.delete(this.files.keys().next().value);
      this.files.set(file, state);
    }
    if (stat.size > state.offset) {
      // Scan once, then consume only appended bytes. Tool output never changes
      // recency; bounded line buffering prevents huge tool results exhausting RAM.
      const stream = fs.createReadStream(file, { start: state.offset, end: stat.size - 1 });
      for await (const chunk of stream) {
        state.offset += chunk.length;
        state.tail += state.decoder.write(chunk);
        let end;
        while ((end = state.tail.indexOf('\n')) >= 0) {
          const line = state.tail.slice(0, end);
          state.tail = state.tail.slice(end + 1);
          if (!state.skip) {
            try {
              readEntry(state, JSON.parse(line), provider);
            } catch {}
          }
          state.skip = false;
        }
        if (state.tail.length > 2 * 1024 * 1024) {
          state.tail = '';
          state.skip = true;
        }
      }
    }
    const inheritedSignature =
      state.hasHistoryBase && this.conversations
        ? await this.conversations.sourceSignature(file, provider)
        : null;
    if (state.rebuild || (inheritedSignature && inheritedSignature !== state.inheritedSignature)) {
      const lines = this.conversations
        ? (await this.conversations.read(file, provider, ['lines'])).lines
        : require('./conversation-state').effectiveLines(
            provider,
            (await fs.promises.readFile(file, 'utf8')).split('\n'),
          );
      const metadata = {};
      for (const raw of lines) {
        try {
          readEntry(metadata, parseLine(raw), provider);
        } catch {}
      }
      for (const key of [
        'customTitle',
        'aiTitle',
        'contentTitle',
        'lastMessageAt',
        'activity',
        'lastUuid',
      ])
        state[key] = metadata[key];
      state.rebuild = false;
    }
    state.inheritedSignature = inheritedSignature;
    state.mtime = stat.mtimeMs;
    return state;
  }
  codexTitles(ids) {
    const titles = new Map();
    if (!ids.length) return titles;
    let db;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const root = path.join(this.home, '.codex');
      const file = fs
        .readdirSync(root)
        .filter((name) => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
      if (!file) throw new Error('Codex state database unavailable');
      db = new DatabaseSync(path.join(root, file), { readOnly: true });
      const query = db.prepare('SELECT name, title FROM threads WHERE id = ?');
      for (const id of ids) {
        const row = query.get(id);
        if (row)
          titles.set(
            id,
            (placeholderTitle(row.name) ? '' : displayTitle(row.name)) || displayTitle(row.title),
          );
      }
    } catch {
      try {
        for (const line of fs
          .readFileSync(path.join(this.home, '.codex', 'session_index.jsonl'), 'utf8')
          .split('\n')) {
          try {
            const item = JSON.parse(line);
            if (ids.includes(item.id)) titles.set(item.id, displayTitle(item.thread_name));
          } catch {}
        }
      } catch {}
    } finally {
      db?.close();
    }
    return titles;
  }
  async enrich(dashboard, queued = []) {
    if (!this.readBackground) return this.readDashboard(dashboard, queued);
    // Archive discovery is optional display metadata. Never put its process
    // queries or file reads in front of native topology, terminal entry or input.
    for (const pane of dashboard.panes) {
      const key = JSON.stringify([
        dashboard.runtimeId,
        pane.paneId,
        pane.terminalId,
        pane.agent?.label,
        pane.agent?.name,
        pane.agent?.session?.value,
        pane.baseCwd || pane.cwd,
        pane.agentTitle,
      ]);
      this.pendingPanes.set(key, { ...pane });
      const cached = this.cachedPanes.get(key);
      this.decorate(pane, new Map(), {}, queued);
      if (cached)
        Object.assign(pane, cached, {
          lastMessageAt: Math.max(pane.lastMessageAt, cached.lastMessageAt),
        });
    }
    if (!this.refreshing) {
      // Yield before the initial SQLite title lookup as well as async discovery.
      this.refreshing = new Promise((resolve) => setImmediate(resolve))
        .then(async () => {
          const pending = this.pendingPanes;
          this.pendingPanes = new Map();
          const panes = [...pending.values()];
          await this.readDashboard({ panes });
          let changed = false;
          for (const [key, pane] of pending) {
            const value = {
              sessionTitle: pane.sessionTitle,
              sessionFullTitle: pane.sessionFullTitle,
              lastMessageAt: pane.lastMessageAt,
            };
            changed ||= JSON.stringify(this.cachedPanes.get(key)) !== JSON.stringify(value);
            this.cachedPanes.delete(key);
            this.cachedPanes.set(key, value);
          }
          while (this.cachedPanes.size > 256)
            this.cachedPanes.delete(this.cachedPanes.keys().next().value);
          if (changed) this.onChange?.();
        })
        .catch(() => {})
        .finally(() => {
          this.refreshing = null;
        });
    }
    return dashboard;
  }
  decorate(pane, titles, metadata, queued = []) {
    const provider = pane.agent?.label,
      sessionId = pane.agent?.session?.value;
    const candidates = [titles.get(sessionId), metadata.customTitle, metadata.aiTitle];
    const title = candidates.find((value) => value && !placeholderTitle(value));
    const agentTitle = pane.agent ? displayTitle(pane.agentTitle || '') : '';
    const namedAgent =
      placeholderTitle(agentTitle) ||
      ['codex', 'claude', 'Claude Code', 'Codex'].includes(agentTitle)
        ? ''
        : agentTitle;
    const full = title || namedAgent || metadata.contentTitle || agentTitle;
    pane.sessionFullTitle = placeholderTitle(full) ? '' : full;
    pane.sessionTitle = shortPhrase(pane.sessionFullTitle) || full;
    if (placeholderTitle(pane.sessionTitle)) pane.sessionTitle = '新会话';
    pane.lastMessageAt = metadata.lastMessageAt || 0;
    for (const message of queued) {
      if (
        message.paneId === pane.paneId &&
        message.agent === provider &&
        message.terminalId === pane.terminalId &&
        message.sessionId === (sessionId || null) &&
        (sessionId || message.agentName === pane.agent?.name) &&
        !['cancelled', 'failed'].includes(message.status)
      )
        pane.lastMessageAt = Math.max(pane.lastMessageAt, Number(message.createdAt) || 0);
    }
  }
  async readDashboard(dashboard, queued = []) {
    const panes = dashboard.panes;
    const titles = this.codexTitles(
      panes
        .filter((p) => p.agent?.label === 'codex')
        .map((p) => p.agent.session?.value)
        .filter(Boolean),
    );
    // Keep IO concurrency bounded when several large archives are first opened.
    let next = 0;
    const worker = async () => {
      while (next < panes.length) {
        const pane = panes[next++],
          provider = pane.agent?.label,
          sessionId = pane.agent?.session?.value;
        let metadata = {};
        if (sessionId && ['claude', 'codex'].includes(provider)) {
          const key = `${provider}:${sessionId}:${pane.baseCwd || pane.cwd}`;
          let file = this.paths.get(key);
          if (provider === 'codex' || !file || !fs.existsSync(file)) {
            try {
              file = await this.locate(
                provider,
                sessionId,
                pane.baseCwd || pane.cwd,
                this.home,
                pane,
              );
            } catch {
              file = null;
            }
            if (!file && provider === 'claude' && /^[\w-]+$/.test(sessionId)) {
              // A session may have changed cwd since its archive was created.
              try {
                const root = path.join(this.home, '.claude', 'projects');
                file = fs
                  .readdirSync(root)
                  .map((dir) => path.join(root, dir, `${sessionId}.jsonl`))
                  .find((candidate) => fs.existsSync(candidate));
              } catch {}
            }
            if (file) {
              if (this.paths.size >= 128) this.paths.delete(this.paths.keys().next().value);
              this.paths.set(key, file);
            }
          }
          if (file && this.readBackground) {
            try {
              metadata = await this.readBackground(file, provider);
            } catch {}
          } else if (file) {
            try {
              metadata = await this.scan(file, provider);
            } catch {}
          }
        }
        this.decorate(pane, titles, metadata, queued);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, panes.length) }, worker));
    return dashboard;
  }
}
module.exports = { SessionMetadata, readEntry, displayTitle };
