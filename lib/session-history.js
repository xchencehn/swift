'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { lastUtterance } = require('./history-recency');
const { CodexLineage, rolloutIdentity } = require('./codex-lineage');
const { displayTitle } = require('./session-metadata');
const { readJson, writeJson } = require('./root-data');
const { withinRoot } = require('./root-scope');
const { apiError } = require('./message-queue');
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9][\w-]{0,199}$/.test(id);
const title = (value) =>
  String(value || '')
    .trim()
    .split('\n')[0]
    .slice(0, 160);
const keyOf = (entry) => `${entry.provider}:${entry.sessionId}`;

class SessionHistory {
  constructor({
    home = os.homedir(),
    file = path.join(home, '.local/state/agent-studio/session-history.json'),
    rootDirectory = '',
    cacheFile = '',
  } = {}) {
    this.home = home;
    this.file = file;
    this.rootDirectory = rootDirectory;
    this.cacheFile = cacheFile;
    this.cache = new Map();
    this.at = 0;
    this.pending = null;
    this.entries = [];
    this.closed = {};
    this.lineage = new CodexLineage();
    this.closed = readJson(file, {});
    if (!this.closed || typeof this.closed !== 'object' || Array.isArray(this.closed))
      throw new Error('会话历史文件格式不正确。');
    if (cacheFile) {
      try {
        const saved = readJson(cacheFile, null);
        if (saved?.version === 1 && Array.isArray(saved.files))
          this.cache = new Map(
            saved.files.filter(
              ([, value]) => value?.entry && withinRoot(rootDirectory, value.entry.cwd),
            ),
          );
      } catch {
        /* Derived cache is rebuilt from native archives. */
      }
    }
  }
  async remember(pane) {
    const provider = String(pane.agent?.label || '').toLowerCase(),
      sessionId = pane.agent?.session?.value;
    if (!['codex', 'claude'].includes(provider) || !validId(sessionId)) return;
    const entry = {
      provider,
      sessionId,
      ...(pane.sessionTitle ? { title: pane.sessionTitle } : {}),
      cwd: pane.cwd || pane.baseCwd,
      workspaceId: pane.workspaceId,
      workspace: pane.workspace,
      closedAt: Date.now(),
    };
    this.closed[keyOf(entry)] = entry;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.saving = (this.saving || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const temp = this.file + '.tmp';
        await fs.writeFile(temp, JSON.stringify(this.closed), { mode: 0o600 });
        await fs.rename(temp, this.file);
      });
    await this.saving;
    this.at = 0;
  }
  async readArchive(file, provider, sessionId) {
    const stat = await fs.stat(file),
      cached = this.cache.get(file);
    const descriptor = provider === 'codex' ? await this.lineage.inspect(file) : null;
    const sourceSignature = descriptor?.segments ? descriptor.signature : null;
    if (
      cached?.mtime === stat.mtimeMs &&
      cached.size === stat.size &&
      cached.sourceSignature === sourceSignature &&
      cached.entry?.lastMessageAt !== undefined
    )
      return cached.entry;
    const handle = await fs.open(file, 'r');
    let raw;
    try {
      const length = Math.min(stat.size, 128 * 1024),
        head = Buffer.alloc(length);
      await handle.read(head, 0, length, 0);
      raw = head.toString('utf8');
      if (stat.size > length) {
        raw = raw.slice(0, raw.lastIndexOf('\n'));
        const tail = Buffer.alloc(length);
        await handle.read(tail, 0, length, stat.size - length);
        const text = tail.toString('utf8');
        raw += '\n' + text.slice(text.indexOf('\n') + 1);
      }
    } finally {
      await handle.close();
    }
    let cwd = '',
      contentTitle = '',
      customTitle = '',
      updatedAt = stat.mtimeMs,
      sidechain = false;
    const inherited = descriptor?.segments
      ? (await this.lineage.read(file, descriptor)).lines
      : null;
    for (const line of inherited || raw.split('\n')) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.isSidechain) sidechain = true;
      if (e.cwd) cwd = e.cwd;
      if (provider === 'codex' && ['session_meta', 'turn_context'].includes(e.type))
        cwd = e.payload?.cwd || cwd;
      if (['custom-title', 'ai-title'].includes(e.type))
        customTitle = title(e.customTitle || e.aiTitle);
      const m =
        provider === 'claude'
          ? e.type === 'user' && !e.isMeta && e.message
          : e.type === 'response_item' && e.payload;
      if (m?.role === 'user') {
        const text =
          typeof m.content === 'string'
            ? m.content
            : (m.content || [])
                .filter((b) => ['text', 'input_text'].includes(b.type))
                .map((b) => b.text || '')
                .join('\n');
        if (!contentTitle && text.trim() && !/^\s*(?:<|# AGENTS\.md|\/)/.test(text))
          contentTitle = title(text);
      }
    }
    const lastMessageAt = await lastUtterance(file, provider);
    const entry =
      !sidechain && path.isAbsolute(cwd)
        ? {
            provider,
            sessionId,
            cwd,
            title: customTitle || contentTitle || '新会话',
            updatedAt,
            lastMessageAt,
            file,
          }
        : null;
    this.cache.set(file, { mtime: stat.mtimeMs, size: stat.size, sourceSignature, entry });
    return entry;
  }
  /** `maxAge`：缓存多久之内算新鲜。用户主动打开归档要看到刚出现的存档，后台推送（lib/sync/hub.js）可以宽一些。 */
  async scan(maxAge = 10000) {
    if (this.pending) return this.pending;
    if (this.at && Date.now() - this.at < maxAge) return this.entries;
    this.pending = this.discover()
      .then((entries) => {
        this.entries = entries.filter(
          (entry) => !this.rootDirectory || withinRoot(this.rootDirectory, entry.cwd),
        );
        if (this.cacheFile) {
          const files = [...this.cache].filter(
            ([, value]) => value.entry && withinRoot(this.rootDirectory, value.entry.cwd),
          );
          writeJson(this.cacheFile, { version: 1, files });
        }
        this.at = Date.now();
        return this.entries;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  async discover() {
    const entries = [],
      files = [];
    const codexRoot = path.join(this.home, '.codex');
    let db,
      indexed = false;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const names = (await fs.readdir(codexRoot))
        .filter((n) => /^state_\d+\.sqlite$/.test(n))
        .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      if (names[0]) {
        db = new DatabaseSync(path.join(codexRoot, names[0]), { readOnly: true });
        const columns = new Set(
          db
            .prepare('PRAGMA table_info(threads)')
            .all()
            .map((c) => c.name),
        );
        const fields = [
          'id',
          'cwd',
          'title',
          'name',
          'updated_at',
          'updated_at_ms',
          'source',
          'rollout_path',
          'has_user_event',
        ].filter((n) => columns.has(n));
        for (const row of db.prepare(`SELECT ${fields.join(',')} FROM threads`).all()) {
          if (
            !validId(row.id) ||
            !path.isAbsolute(row.cwd || '') ||
            /subagent/i.test(row.source || '')
          )
            continue;
          entries.push({
            provider: 'codex',
            sessionId: row.id,
            cwd: row.cwd,
            title: displayTitle(row.name) || displayTitle(row.title) || '新会话',
            updatedAt: row.updated_at_ms || row.updated_at * 1000 || 0,
            file: row.rollout_path,
          });
        }
        indexed = true;
      }
    } catch {
    } finally {
      db?.close();
    }
    const walk = async (dir, provider, recursive = false) => {
      let children;
      try {
        children = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        const file = path.join(dir, child.name);
        if (child.isDirectory() && recursive) await walk(file, provider, true);
        else if (child.isFile() && child.name.endsWith('.jsonl')) {
          const id =
            provider === 'claude'
              ? child.name.slice(0, -6)
              : rolloutIdentity(child.name)?.sessionId;
          if (validId(id) && !id.startsWith('agent-')) files.push({ file, provider, id });
        }
      }
    };
    if (!indexed) {
      await walk(path.join(codexRoot, 'sessions'), 'codex', true);
      await walk(path.join(codexRoot, 'archived_sessions'), 'codex', true);
    }
    const claudeRoot = path.join(this.home, '.claude/projects');
    for (const dir of await fs.readdir(claudeRoot, { withFileTypes: true }).catch(() => []))
      if (dir.isDirectory()) await walk(path.join(claudeRoot, dir.name), 'claude');
    let next = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (next < files.length) {
          const { file, provider, id } = files[next++];
          try {
            const entry = await this.readArchive(file, provider, id);
            if (entry) entries.push(entry);
          } catch {}
        }
      }),
    );
    let cursor = 0;
    const codex = entries.filter(
      (e) =>
        e.provider === 'codex' &&
        e.file &&
        (!this.rootDirectory || withinRoot(this.rootDirectory, e.cwd)),
    );
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < codex.length) {
          const entry = codex[cursor++];
          try {
            entry.lastMessageAt =
              (await this.readArchive(entry.file, 'codex', entry.sessionId))?.lastMessageAt || 0;
          } catch {
            entry.lastMessageAt = 0;
          }
        }
      }),
    );
    return [...new Map(entries.map((e) => [keyOf(e), e])).values()];
  }
  async list(panes, { offset = 0, limit = 100, query = '', rootDirectory = '', maxAge } = {}) {
    const active = new Set(
      panes
        .filter((p) => p.agent?.session?.value)
        .map((p) => `${String(p.agent.label).toLowerCase()}:${p.agent.session.value}`),
    );
    const entries = (await this.scan(maxAge))
      .filter((e) => !active.has(keyOf(e)))
      .map((e) => ({ ...e, ...this.closed[keyOf(e)], file: undefined }));
    const search = String(query).trim().toLowerCase();
    const filtered = entries
      .filter((e) => !rootDirectory || withinRoot(rootDirectory, e.cwd))
      .filter((e) => !search || `${e.title} ${e.cwd} ${e.provider}`.toLowerCase().includes(search))
      .sort(
        (a, b) =>
          (b.lastMessageAt || 0) - (a.lastMessageAt || 0) || keyOf(a).localeCompare(keyOf(b)),
      );
    return {
      sessions: filtered.slice(offset, offset + limit),
      total: filtered.length,
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
    };
  }
  /**
   * 取一条归档条目（含存档文件路径）。
   *
   * ⚠️ 与 `get()` 不同：**不校验原工作目录还在不在**。只读翻看过往记录不需要目录，
   * 那是恢复才需要的前提；在这里一并校验会让一个还能读的存档变成打不开。
   */
  async find(provider, sessionId) {
    if (!['codex', 'claude'].includes(provider) || !validId(sessionId))
      throw apiError(400, 'INVALID_SESSION', '会话标识无效。');
    let entry = (await this.scan()).find(
      (e) => e.provider === provider && e.sessionId === sessionId,
    );
    if (!entry) {
      this.at = 0;
      entry = (await this.scan()).find((e) => e.provider === provider && e.sessionId === sessionId);
    }
    if (!entry) throw apiError(404, 'SESSION_NOT_FOUND', '会话存档不存在。');
    if (entry.file && !(await fs.stat(entry.file).catch(() => null))?.isFile())
      throw apiError(404, 'SESSION_NOT_FOUND', '会话存档已不存在。');
    return { ...entry, ...this.closed[keyOf(entry)] };
  }
  async get(provider, sessionId) {
    const result = await this.find(provider, sessionId);
    // 恢复要在原目录里重开，目录没了就恢复不了 —— 这一条只拦恢复，不拦翻看。
    if (!(await fs.stat(result.cwd).catch(() => null))?.isDirectory())
      throw apiError(409, 'CWD_NOT_FOUND', '原工作目录不存在，无法恢复会话。');
    return result;
  }
}
module.exports = { SessionHistory };
