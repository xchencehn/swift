'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const Conversation = require('../conversation-state');
const Providers = require('../../public/provider-capabilities');

/**
 * 同步中心：服务端知道每个活着会话的当前正文，变化时只把变化的部分推给已连上的客户端
 * （设计见 docs/LOCAL_FIRST.md）。
 *
 * 客户端连上后先发 `sync.hello`，带上本地每个会话的版本号与快照指纹；这里只补它缺的：
 * 版本相同不发，本地版本在近期保留的版本里就发从那里起的变化，否则发最近一段整体替换。
 * 之后的变化按发生顺序推送。WebSocket 本身保证不乱序、不丢失，断线重连会重新 hello，
 * 所以不需要全局序号或事件回放。
 */

const WINDOW = 60; // 整体替换时给最近多少条
const MAX_TAIL = 200; // 变化的尾巴超过这么多条就改为整体替换
const KEPT_VERSIONS = 8; // 每个会话保留最近几个版本的消息指纹，用于从旧版本算变化
const DEBOUNCE_MS = 16;
const FILES_MIN_MS = 5000; // 同一个会话的文件列表至多隔这么久重算一次
const REFRESH_LISTS_MS = 60000; // 没有变化时文件列表与归档列表的兜底重算间隔（文档本身可能被改过）
const SAFETY_MS = 10000; // 事件与文件监视之外的兜底检查间隔

const fingerprint = (value) =>
  crypto.createHash('sha1').update(JSON.stringify(value)).digest('base64url');

/**
 * 推给客户端的快照只留界面用得到的部分。`scroll` 随终端每输出一行就变，界面不用它，
 * 留着会让快照几乎每秒都「变了」一次。
 */
function slimSnapshot(dashboard) {
  return {
    rootDirectory: dashboard.rootDirectory || '',
    focusedPaneId: dashboard.focusedPaneId || '',
    runtimeId: dashboard.runtimeId || '',
    version: dashboard.version || '',
    protocol: dashboard.protocol || 0,
    focusedWorkspaceId: dashboard.focusedWorkspaceId || '',
    focusedTabId: dashboard.focusedTabId || '',
    tabs: dashboard.tabs || [],
    layouts: dashboard.layouts || [],
    workspaces: dashboard.workspaces || [],
    panes: (dashboard.panes || []).map(({ scroll, ...pane }) => pane),
  };
}

/**
 * 两份快照之间的变化：只列出变了或新增的 pane、消失的 pane，以及 pane 的顺序；
 * 工作区列表变了才带上。会话在工作时几乎每条消息都会改动某个 pane 的时间与状态，
 * 整份推送（约 4 KB）会比正文的变化还大。
 */
function snapshotChange(previous, current) {
  const before = new Map((previous?.panes || []).map((pane) => [pane.paneId, fingerprint(pane)]));
  const panes = current.panes.filter((pane) => before.get(pane.paneId) !== fingerprint(pane));
  const ids = new Set(current.panes.map((pane) => pane.paneId));
  const change = {
    panes,
    removed: [...before.keys()].filter((id) => !ids.has(id)),
    order: current.panes.map((pane) => pane.paneId),
    focusedPaneId: current.focusedPaneId,
    rootDirectory: current.rootDirectory,
  };
  for (const key of [
    'runtimeId',
    'version',
    'protocol',
    'focusedWorkspaceId',
    'focusedTabId',
    'tabs',
    'layouts',
  ]) {
    if (!previous || fingerprint(previous[key] ?? null) !== fingerprint(current[key] ?? null))
      change[key] = current[key];
  }
  if (!previous || fingerprint(previous.workspaces) !== fingerprint(current.workspaces))
    change.workspaces = current.workspaces;
  return change;
}

/**
 * 两个版本之间的变化：最长相同前缀之后的部分。追加、最后一条更新、回滚都是这一种形式。
 * @returns {{ after: string|null, messages: object[], replace: boolean }}
 */
function diff(previous, current, messages) {
  let prefix = 0;
  const limit = Math.min(previous.ids.length, current.ids.length);
  while (
    prefix < limit &&
    previous.ids[prefix] === current.ids[prefix] &&
    previous.hashes[prefix] === current.hashes[prefix]
  )
    prefix += 1;
  const tail = messages.length - prefix;
  if (prefix === 0 || tail > MAX_TAIL)
    return { replace: true, after: null, messages: messages.slice(-WINDOW) };
  return { replace: false, after: current.ids[prefix - 1], messages: messages.slice(prefix) };
}

// The index supplies a bounded trailing window. Match its overlap with the
// previous window so a one-message append remains a one-message update.
function windowDiff(previous, current, messages) {
  if (previous.historyEpoch !== current.historyEpoch)
    return { replace: true, after: null, messages };
  const start = previous.ids.indexOf(current.ids[0]);
  if (start < 0) return { replace: true, after: null, messages };
  let prefix = 0;
  while (
    prefix < current.ids.length &&
    start + prefix < previous.ids.length &&
    current.ids[prefix] === previous.ids[start + prefix] &&
    current.hashes[prefix] === previous.hashes[start + prefix]
  )
    prefix++;
  return prefix
    ? { replace: false, after: current.ids[prefix - 1], messages: messages.slice(prefix) }
    : { replace: true, after: null, messages };
}

class SyncHub {
  /**
   * @param {object} deps
   *   dashboard()            当前快照（lib/sync/dashboard.js）
   *   locate(provider, sessionId, cwd)   原生存档文件
   *   read(file, provider)   ConversationStore 的投影（带缓存，文件没变时几乎不花时间）
   *   watch(file)            让存档变化时触发 poke（lib/transcript-watcher.js）
   *   clients()              当前在线的 WebSocket
   *   send(ws, message)
   */
  constructor({
    dashboard,
    locate,
    read,
    watch = () => {},
    clients,
    send,
    active = () => true,
    log = () => {},
    stat = (file) => fs.promises.stat(file),
    archiveSignature = null,
    files = null,
    history = null,
    now = () => Date.now(),
    databasePath = (provider) => require('../providers/native').databasePath(provider),
    progressive = false,
  }) {
    Object.assign(this, {
      dashboard,
      locate,
      read,
      watchFile: watch,
      clients,
      send,
      active,
      log,
      stat,
      files,
      history,
      now,
      databasePath,
      archiveSignature,
    });
    this.progressive = progressive;
    this.historyList = null;
    this.historyHash = '';
    this.historyAt = 0;
    this.filesTimer = null;
    this.epoch = crypto.randomBytes(6).toString('base64url');
    this.sessions = new Map(); // key → { key, paneId, provider, sessionId, revision, ids, hashes, messages, versions }
    this.snapshot = null;
    this.snapshotHash = '';
    this.timer = null;
    this.running = null;
    this.again = false;
    this.stats = { events: 0, bytes: 0, windowBytes: 0 };
    this.safety = setInterval(() => this.poke(), SAFETY_MS);
    this.safety.unref?.();
    // 验收流量用：推送了多少字节，对照「每次变化都重拉最近 60 条」要多少字节（docs/LOCAL_FIRST.md）。
    this.report = setInterval(() => {
      if (!this.stats.events) return;
      const kb = (n) => (n / 1024).toFixed(1);
      this.log(
        `10 min: ${this.stats.events} session changes, pushed ${kb(this.stats.bytes)} KB, full windows would be ${kb(this.stats.windowBytes)} KB; slowest scan ${this.slowest || 0} ms`,
      );
      this.stats = { events: 0, bytes: 0, windowBytes: 0 };
      this.slowest = 0;
    }, 600000);
    this.report.unref?.();
  }

  close() {
    clearInterval(this.safety);
    clearInterval(this.report);
    clearTimeout(this.timer);
    clearTimeout(this.filesTimer);
  }

  /** 有东西变了（Herdr 事件、存档变化、队列变化）：合并一小段时间后重新核对。 */
  poke() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /**
   * 跑到没有新变化为止。返回的是「当前这一次扫描」结束的时刻，而不是整个循环：
   * 会话一直在工作时循环可以一直转下去，等它结束的人（hello）会被饿住。
   */
  refresh() {
    if (this.running) {
      // 正在扫：再排一次，返回「下一次扫描」结束的时刻，保证调用者看到的是请求之后的状态。
      this.again = true;
      if (!this.upcoming) {
        let done;
        this.upcoming = {
          promise: new Promise((resolve) => {
            done = resolve;
          }),
          done,
        };
      }
      return this.upcoming.promise;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const waiting = this.upcoming;
        this.upcoming = null;
        const started = Date.now();
        this.pass = this.scan().catch((error) => this.log(`refresh failed: ${error.message}`));
        await this.pass;
        waiting?.done();
        this.slowest = Math.max(this.slowest || 0, Date.now() - started);
      } while (this.again);
    })().finally(() => {
      this.running = null;
      // 循环刚结束、这里还没执行的那一刻又有人排了一次：接着跑，不能让它一直等。
      if (this.again || this.upcoming) {
        const waiting = this.upcoming;
        this.upcoming = null;
        this.refresh().then(() => waiting?.done());
      }
    });
    return this.pass;
  }

  async scan() {
    // 根目录已经切走：这个中心不再推送，也不再读存档。
    if (!this.active()) return;
    if (this.progressive && ![...this.clients()].some((ws) => ws.syncReady)) return;
    const dashboard = await this.dashboard();
    const slim = slimSnapshot(dashboard);
    const snapshotHash = fingerprint(slim);
    const snapshotChanged = snapshotHash !== this.snapshotHash;
    if (snapshotChanged) {
      const change = snapshotChange(this.snapshot, slim);
      this.snapshot = slim;
      this.snapshotHash = snapshotHash;
      this.broadcast({ type: 'sync.snapshot', hash: snapshotHash, ...change });
    }
    const live = new Set();
    const interested = new Set([...this.clients()].flatMap((ws) => [...(ws.syncInterest || [])]));
    const panes = [...(dashboard.panes || [])].sort(
      (a, b) =>
        Number(interested.has(`${b.agent?.label}:${b.agent?.session?.value}`)) -
        Number(interested.has(`${a.agent?.label}:${a.agent?.session?.value}`)),
    );
    for (const pane of panes) {
      const capabilities = Providers.get(pane.agent?.label);
      const provider = capabilities.id,
        sessionId = pane.agent?.session?.value;
      if (!capabilities.sync || !sessionId) continue;
      const key = `${provider}:${sessionId}`;
      live.add(key);
      const database = capabilities.archive === 'sqlite';
      const file = database
        ? this.databasePath(provider)
        : await this.locate(provider, sessionId, pane.baseCwd || pane.cwd || '', pane);
      if (!file) continue; // 会话身份已有、存档还没写出来
      this.watchFile(file);
      if (database) this.watchFile(`${file}-wal`);
      // 文件没变就不读。存档合计常超过 ConversationStore 的缓存上限（2026-09-25 实测 15 个会话约 350 MB），
      // 每轮都读会把彼此挤出缓存，没变的大文件也要整份重新解析（单个 0.7–1.3 秒）。
      let signature;
      try {
        const info = await this.stat(file);
        signature =
          provider === 'codex' && this.archiveSignature
            ? `${file}:${await this.archiveSignature(file, provider)}`
            : `${file}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs || ''}`;
        if (database) {
          const wal = await this.stat(`${file}-wal`).catch(() => null);
          signature += wal
            ? `:${wal.ino}:${wal.size}:${wal.mtimeMs}:${wal.ctimeMs || ''}`
            : ':no-wal';
        }
      } catch {
        continue;
      }
      const known = this.sessions.get(key);
      if (known?.signature === signature) {
        known.paneId = pane.paneId;
        continue;
      }
      let transcript;
      try {
        transcript = await this.read(file, provider, pane);
      } catch (error) {
        this.log(`read failed (${provider}): ${error.code || 'ARCHIVE_UNAVAILABLE'}`);
        continue;
      }
      if (!transcript) continue;
      this.update(
        key,
        pane,
        transcript.conversation,
        database || transcript.bounded
          ? {
              revision: transcript.revision,
              hasMore: transcript.hasMore,
              bounded: true,
              indexed: !database,
              total: transcript.total,
              historyEpoch: transcript.historyEpoch,
            }
          : {},
      );
      Object.assign(this.sessions.get(key), { signature, file, filesDirty: true });
    }
    for (const key of this.sessions.keys()) if (!live.has(key)) this.sessions.delete(key);
    // 首轮之后才出现的会话（新建、恢复、pane 里换了身份）要主动推：已连上的客户端手里没有它。
    this.scanned = true;
    this.lists(dashboard, snapshotChanged);
  }

  /**
   * 文件列表与归档列表在后台算，不挡住正文：服务刚重启时要为所有会话算一遍，要好几秒，
   * hello 只等正文与快照，列表算好再推（已连上的客户端 syncReady 为真，照常收到）。
   */
  lists(dashboard, snapshotChanged) {
    if (this.listing) {
      this.listsAgain = {
        dashboard,
        snapshotChanged: snapshotChanged || this.listsAgain?.snapshotChanged,
      };
      return this.listing;
    }
    this.listing = this.scanLists(dashboard, snapshotChanged)
      .catch((error) => this.log(`lists failed: ${error.message}`))
      .finally(() => {
        this.listing = null;
        const again = this.listsAgain;
        this.listsAgain = null;
        if (again) this.lists(again.dashboard, again.snapshotChanged);
      });
    return this.listing;
  }

  /** 文件列表与归档列表：会话变了才重算（每个会话至多 5 秒一次），另有一分钟的兜底。 */
  async scanLists(dashboard, snapshotChanged) {
    const now = this.now();
    if (this.files) {
      let wait = Infinity;
      for (const entry of this.sessions.values()) {
        if (
          this.progressive &&
          ![...this.clients()].some(
            (ws) => ws.syncReady && (!ws.syncInterest || ws.syncInterest.has(entry.key)),
          )
        )
          continue;
        if (!Providers.get(entry.provider).sessionFiles) continue;
        const due = entry.filesDirty || now - (entry.filesAt || 0) >= REFRESH_LISTS_MS;
        if (!due) continue;
        const left = FILES_MIN_MS - (now - (entry.filesAt || 0));
        if (left > 0) {
          wait = Math.min(wait, left);
          continue;
        }
        const pane = (dashboard.panes || []).find((item) => item.paneId === entry.paneId);
        let files;
        try {
          files = await this.files(pane, entry.file);
        } catch (error) {
          this.log(`files failed: ${error.message}`);
          continue;
        }
        Object.assign(entry, { filesAt: this.now(), filesDirty: false });
        const hash = fingerprint(files);
        if (hash === entry.filesHash) continue;
        entry.files = files;
        entry.filesHash = hash;
        this.broadcast(this.filesEvent(entry));
      }
      // 被节流挡下的，到点再扫一次。
      if (wait < Infinity && !this.filesTimer) {
        this.filesTimer = setTimeout(() => {
          this.filesTimer = null;
          this.poke();
        }, wait + 50);
        this.filesTimer.unref?.();
      }
    }
    if (this.history && (snapshotChanged || now - this.historyAt >= REFRESH_LISTS_MS)) {
      this.historyAt = now;
      try {
        const list = await this.history(dashboard);
        const hash = fingerprint(list);
        if (hash !== this.historyHash) {
          this.historyList = list;
          this.historyHash = hash;
          this.broadcast(this.historyEvent());
        }
      } catch (error) {
        this.log(`history failed: ${error.message}`);
      }
    }
  }

  filesEvent(entry) {
    return {
      type: 'sync.files',
      key: entry.key,
      paneId: entry.paneId,
      hash: entry.filesHash,
      files: entry.files,
    };
  }
  historyEvent() {
    return { type: 'sync.history', hash: this.historyHash, ...this.historyList };
  }
  watch(ws, interest) {
    ws.syncInterest = Array.isArray(interest)
      ? new Set(interest.filter((key) => typeof key === 'string' && key.length <= 200).slice(0, 8))
      : null;
    this.poke();
  }

  /** 记下一个会话的新版本；和上一个版本不同就推送变化。 */
  update(
    key,
    pane,
    messages,
    {
      revision = Conversation.historyVersion(messages),
      hasMore = false,
      bounded = false,
      indexed = false,
      total = messages.length,
      historyEpoch,
    } = {},
  ) {
    const known = this.sessions.get(key);
    if (known && known.revision === revision) {
      Object.assign(known, {
        paneId: pane.paneId,
        messages,
        hasMore,
        bounded,
        indexed,
        total,
        historyEpoch,
      });
      return;
    }
    const version = {
      revision,
      ids: messages.map((message) => message.id),
      hashes: messages.map(Conversation.messageFingerprint),
      historyEpoch,
    };
    // 先留住上一个版本：下面会把新版本写进同一个对象。
    const previous = known && {
      revision: known.revision,
      ids: known.ids,
      hashes: known.hashes,
      historyEpoch: known.historyEpoch,
    };
    const entry = known || {
      key,
      provider: pane.agent.label,
      sessionId: pane.agent.session.value,
      versions: [],
    };
    Object.assign(entry, {
      paneId: pane.paneId,
      revision,
      ids: version.ids,
      hashes: version.hashes,
      messages,
      hasMore,
      bounded,
      indexed,
      total,
      historyEpoch,
    });
    entry.versions.push(version);
    if (entry.versions.length > KEPT_VERSIONS) entry.versions.shift();
    this.sessions.set(key, entry);
    // 首轮扫描时第一次见到的会话：客户端 hello 时按版本号补，不在这里推。
    if (!previous) {
      if (this.scanned || this.progressive)
        this.broadcast(
          this.sessionEvent(
            entry,
            { replace: true, after: null, messages: bounded ? messages : messages.slice(-WINDOW) },
            null,
          ),
        );
      return;
    }
    // SQLite windows carry native cursors. Keep the complete bounded window so
    // its first cursor remains usable for older-history pagination.
    const event = this.sessionEvent(
      entry,
      indexed
        ? windowDiff(previous, version, messages)
        : bounded
          ? { replace: true, after: null, messages }
          : diff(previous, version, messages),
      previous.revision,
    );
    const size = Buffer.byteLength(JSON.stringify(event));
    this.stats.events += 1;
    this.stats.bytes += size;
    this.stats.windowBytes += Buffer.byteLength(JSON.stringify(messages.slice(-WINDOW)));
    this.broadcast(event);
  }

  sessionEvent(entry, change, base) {
    return {
      type: 'sync.session',
      key: entry.key,
      paneId: entry.paneId,
      provider: entry.provider,
      sessionId: entry.sessionId,
      base,
      revision: entry.revision,
      historyEpoch: entry.historyEpoch,
      total: entry.total ?? entry.messages.length,
      hasMore: change.replace
        ? entry.hasMore || entry.messages.length > change.messages.length
        : undefined,
      ...change,
    };
  }

  /**
   * 客户端连上后的追平。`sessions` 是本地每个会话的版本号，`snapshot` 是本地快照的指纹。
   * 回应之后这个连接才开始收推送，所以追平与推送之间没有空窗。
   */
  async hello(
    ws,
    { sessions = {}, snapshot = '', files = {}, history = '', interest, compression } = {},
  ) {
    this.watch(ws, interest);
    ws.syncCompression = compression === 'gzip' ? 'gzip' : null;
    const generation = (ws.syncHelloGeneration = (ws.syncHelloGeneration || 0) + 1);
    const current = () => this.active() && ws.syncHelloGeneration === generation;
    const send = async (message) => {
      if (!current()) return false;
      const accepted = await this.send(ws, message);
      return accepted !== false && current();
    };
    ws.syncReady = false;
    if (this.progressive) {
      // Establish topology and live delivery without waiting for every native
      // archive. HTTP can request the selected conversation with priority zero.
      const slim = slimSnapshot(await this.dashboard());
      this.snapshot = slim;
      this.snapshotHash = fingerprint(slim);
    } else await this.refresh();
    if (!current()) return;
    const sentSessions = new Map(),
      sentFiles = new Map();
    // The selected conversation must not sit behind every cached window on
    // a slow link. Other sessions still catch up through the same handshake.
    const entries = [...this.sessions.values()].sort(
      (a, b) =>
        Number(ws.syncInterest?.has(b.key) || false) - Number(ws.syncInterest?.has(a.key) || false),
    );
    const sentSnapshot = this.snapshotHash;
    if (!(await send({ type: 'sync.welcome', epoch: this.epoch }))) return;
    if (
      this.snapshot &&
      snapshot !== this.snapshotHash &&
      !(await send({
        type: 'sync.snapshot',
        hash: this.snapshotHash,
        full: true,
        ...snapshotChange(null, this.snapshot),
      }))
    )
      return;
    for (const entry of entries) {
      const have = typeof sessions[entry.key] === 'string' ? sessions[entry.key] : '';
      const revision = entry.revision;
      sentSessions.set(entry.key, revision);
      if (have === revision) continue;
      const base = have && entry.versions.find((version) => version.revision === have);
      const change =
        entry.indexed && base
          ? windowDiff(base, entry, entry.messages)
          : entry.bounded
            ? { replace: true, after: null, messages: entry.messages }
            : base
              ? diff(base, entry, entry.messages)
              : { replace: true, after: null, messages: entry.messages.slice(-WINDOW) };
      if (!(await send(this.sessionEvent(entry, change, have || null)))) return;
    }
    for (const entry of entries) {
      sentFiles.set(entry.key, entry.filesHash);
      if (
        entry.filesHash &&
        files[entry.key] !== entry.filesHash &&
        !(await send(this.filesEvent(entry)))
      )
        return;
    }
    const sentHistory = this.historyHash;
    if (this.historyList && history !== sentHistory && !(await send(this.historyEvent()))) return;
    // Changes may arrive while the initial windows drain. Queue their latest
    // replacement in the same turn as enabling live updates, without a gap.
    ws.syncReady = true;
    if (this.snapshotHash !== sentSnapshot)
      this.send(ws, {
        type: 'sync.snapshot',
        hash: this.snapshotHash,
        full: true,
        ...snapshotChange(null, this.snapshot),
      });
    for (const entry of this.sessions.values()) {
      if (sentSessions.get(entry.key) !== entry.revision)
        this.send(
          ws,
          this.sessionEvent(
            entry,
            {
              replace: true,
              after: null,
              messages: entry.bounded ? entry.messages : entry.messages.slice(-WINDOW),
            },
            sentSessions.get(entry.key) || null,
          ),
        );
      if (entry.filesHash && sentFiles.get(entry.key) !== entry.filesHash)
        this.send(ws, this.filesEvent(entry));
    }
    if (this.historyList && sentHistory !== this.historyHash) this.send(ws, this.historyEvent());
    this.send(ws, { type: 'sync.ready' });
    if (this.progressive) this.poke();
  }

  broadcast(message) {
    for (const ws of this.clients()) if (ws.syncReady) this.send(ws, message);
  }
}

module.exports = { SyncHub, diff, fingerprint, slimSnapshot, snapshotChange, WINDOW, MAX_TAIL };
