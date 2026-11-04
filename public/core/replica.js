/**
 * 本地副本：每个会话最近一段正文与版本号、快照，存在 IndexedDB 里（设计见 docs/LOCAL_FIRST.md）。
 *
 * 界面从这里画：启动时不等网络，选中会话时不发请求。服务端推来的变化（lib/sync/hub.js）
 * 经 `applyDelta` 应用到这里；接不上就返回 null，由调用方要求重新追平。
 * 打不开 IndexedDB（隐私模式、被清理）时只存在内存里，功能不变，只是不跨启动。
 *
 * 会话的键是原生身份 `provider:sessionId`，与服务端同一个键；pane 移动后 id 会变，键不变。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('../session-sync'));
  else root.StudioReplica = factory(root.StudioSessionSync);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (protocol) {
  'use strict';
  const { applyDelta, applySnapshot, LIMIT } = protocol;

  const DB = 'agent-studio-replica',
    VERSION = 1;

  function create({
    indexedDB = globalThis.indexedDB,
    now = () => Date.now(),
    databaseName = DB,
    onPersistenceChange = () => {},
    retryDelays = [800, 2000, 5000],
  } = {}) {
    const sessions = new Map();
    const files = new Map(); // key → { hash, files }：会话文件页的列表
    let history = null; // { hash, sessions, nextOffset }：归档列表
    let snapshot = null,
      db = null,
      rootDirectory = '';
    const dirty = new Map(),
      metaDirty = new Map();
    let snapshotDirty = 0,
      generation = 0,
      resetGeneration = 0,
      timer = null,
      writing = null,
      failures = 0;
    let persistenceState = 'memory',
      persistenceError = null;
    const pending = () =>
      dirty.size + metaDirty.size + (snapshotDirty ? 1 : 0) + (resetGeneration ? 1 : 0);
    const mark = (map, key) => {
      map.set(key, ++generation);
      schedule();
    };
    function report(state, error = null) {
      const changed =
        state !== persistenceState || (error?.name || '') !== (persistenceError?.name || '');
      persistenceState = state;
      persistenceError = error;
      if (changed) onPersistenceChange(persistence());
    }
    function persistence() {
      return {
        state: persistenceState,
        error: persistenceError?.name || null,
        pending: pending(),
        failures,
      };
    }

    function openDb() {
      return new Promise((resolve) => {
        if (!indexedDB) return resolve(null);
        let request,
          finished = false;
        const done = (value) => {
          if (finished) {
            value?.close();
            return;
          }
          finished = true;
          clearTimeout(timeout);
          resolve(value);
        };
        const timeout = setTimeout(() => done(null), 2000);
        try {
          request = indexedDB.open(databaseName, VERSION);
        } catch {
          return done(null);
        }
        request.onupgradeneeded = () => {
          const d = request.result;
          if (!d.objectStoreNames.contains('sessions'))
            d.createObjectStore('sessions', { keyPath: 'key' });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        };
        request.onsuccess = () => done(request.result);
        request.onerror = () => done(null);
        request.onblocked = () => done(null);
      });
    }
    function readStored() {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(['sessions', 'meta'], 'readonly');
          const records = tx.objectStore('sessions').getAll();
          const keys = tx.objectStore('meta').getAllKeys();
          const values = tx.objectStore('meta').getAll();
          tx.oncomplete = () =>
            resolve({
              records: records.result,
              meta: Object.fromEntries(keys.result.map((key, i) => [key, values.result[i]])),
            });
          tx.onabort = () => {
            report('error', tx.error);
            resolve(null);
          };
          tx.onerror = () => {};
        } catch (error) {
          report('error', error);
          resolve(null);
        }
      });
    }

    /** 读出上次存下的全部内容。`root` 与上次不同时整份作废（切了根目录）。 */
    async function load(root) {
      db = db || (await openDb());
      if (!db) {
        rootDirectory = root || rootDirectory;
        report('memory');
        return;
      }
      if (resetGeneration && (!root || root === rootDirectory)) return;
      // Read root and records in the same transaction; never combine different roots.
      const saved = await readStored();
      if (!saved) return;
      const { records, meta } = saved;
      if (!pending()) report('saved');
      if (root && meta.rootDirectory && meta.rootDirectory !== root) {
        clear(root);
        return;
      }
      rootDirectory = root || meta.rootDirectory || '';
      for (const record of records) {
        // Persisted cache values can be missing or from an older schema. They
        // must not abort startup before the live connection is established.
        if (
          !record ||
          typeof record.key !== 'string' ||
          !record.key ||
          !Array.isArray(record.messages)
        )
          continue;
        if (!sessions.has(record.key) && !dirty.has(record.key)) sessions.set(record.key, record);
      }
      if (!snapshot && meta.snapshot) snapshot = meta.snapshot;
      for (const [name, value] of Object.entries(meta))
        if (name.startsWith('files:') && !files.has(name.slice(6))) files.set(name.slice(6), value);
      if (!history && meta.history) history = meta.history;
      if (pending()) schedule();
    }

    function clear(root = '') {
      sessions.clear();
      files.clear();
      history = null;
      snapshot = null;
      rootDirectory = root;
      dirty.clear();
      metaDirty.clear();
      snapshotDirty = 0;
      resetGeneration = ++generation;
      schedule();
    }

    function schedule(delay = 800) {
      if (timer || !db || writing || failures > retryDelays.length) return;
      if (!failures) report('pending');
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
      timer.unref?.();
    }

    /** Only a committed transaction removes the versions it actually wrote. */
    function flush() {
      clearTimeout(timer);
      timer = null;
      if (writing) return writing;
      if (!db || !pending()) return Promise.resolve(false);
      const sessionVersions = new Map(dirty),
        metaVersions = new Map(metaDirty);
      const snapshotVersion = snapshotDirty,
        resetVersion = resetGeneration;
      const records = [...sessionVersions.keys()].map((key) => [key, sessions.get(key)]);
      const metadata = [...metaVersions.keys()].map((name) => [
        name,
        name === 'history' ? history : files.get(name.slice(6)),
      ]);
      const savedSnapshot = snapshot,
        savedRoot = rootDirectory;
      report('pending');
      const transaction = new Promise((resolve) => {
        let tx,
          settled = false;
        const failed = (error) => {
          if (settled) return;
          settled = true;
          failures++;
          report('error', error || new Error('IndexedDB transaction failed'));
          resolve(false);
        };
        try {
          tx = db.transaction(['sessions', 'meta'], 'readwrite');
          tx.onabort = () => failed(tx.error);
          tx.onerror = () => {
            /* Abort reports the final transaction result. */
          };
          tx.oncomplete = () => {
            if (settled) return;
            settled = true;
            for (const [key, version] of sessionVersions)
              if (dirty.get(key) === version) dirty.delete(key);
            for (const [key, version] of metaVersions)
              if (metaDirty.get(key) === version) metaDirty.delete(key);
            if (snapshotDirty === snapshotVersion) snapshotDirty = 0;
            if (resetGeneration === resetVersion) resetGeneration = 0;
            failures = 0;
            report(pending() ? 'pending' : 'saved');
            resolve(true);
          };
          const store = tx.objectStore('sessions'),
            meta = tx.objectStore('meta');
          if (resetVersion) {
            store.clear();
            meta.clear();
          }
          // Fallback servers may never send a snapshot; every write still binds its root.
          meta.put(savedRoot, 'rootDirectory');
          for (const [key, value] of records) {
            if (value) store.put(value);
            else store.delete(key);
          }
          if (snapshotVersion) meta.put(savedSnapshot, 'snapshot');
          for (const [name, value] of metadata) {
            if (value) meta.put(value, name);
            else meta.delete(name);
          }
        } catch (error) {
          if (tx) {
            try {
              tx.abort();
            } catch {}
          }
          failed(error);
        }
      });
      writing = transaction.finally(() => {
        writing = null;
        if (pending() && failures <= retryDelays.length)
          schedule(failures ? retryDelays[failures - 1] : 800);
      });
      return writing;
    }

    function put(key, record) {
      sessions.set(key, {
        key,
        revision: record.revision || '',
        messages: (record.messages || []).slice(-LIMIT),
        hasMore: Boolean(record.hasMore) || (record.messages || []).length > LIMIT,
        lastMessageAt: record.lastMessageAt || 0,
        at: now(),
      });
      mark(dirty, key);
      return sessions.get(key);
    }
    function drop(key) {
      if (sessions.delete(key)) {
        mark(dirty, key);
      }
    }

    /** 应用一次正文变化；接不上返回 null，调用方应丢掉这个会话的版本并重新追平。 */
    function apply(event) {
      const local = sessions.get(event.key) || null;
      const messages = applyDelta(local, event);
      if (!messages) return null;
      const hasMore = event.replace
        ? Boolean(event.hasMore)
        : Boolean(local?.hasMore) || messages.length >= LIMIT;
      return put(event.key, {
        revision: event.revision,
        messages,
        hasMore,
        lastMessageAt: local?.lastMessageAt || 0,
      });
    }

    function setSnapshot(change) {
      // 换了根目录：本地的全部内容属于另一个根，先清掉，再按这一份重建（不能和旧根的 pane 合并）。
      if (change.rootDirectory && rootDirectory && change.rootDirectory !== rootDirectory)
        clear(change.rootDirectory);
      snapshot = applySnapshot(snapshot, change);
      rootDirectory = snapshot.rootDirectory || rootDirectory;
      snapshotDirty = ++generation;
      schedule();
      return snapshot;
    }

    function setFiles(key, event) {
      files.set(key, { hash: event.hash, files: event.files || [] });
      mark(metaDirty, `files:${key}`);
      return files.get(key);
    }
    function setHistory(event) {
      history = {
        hash: event.hash,
        sessions: event.sessions || [],
        nextOffset: event.nextOffset ?? null,
      };
      mark(metaDirty, 'history');
      return history;
    }
    /** hello 用：本地每个会话文件列表的指纹。 */
    function fileHashes() {
      const result = {};
      for (const [key, value] of files) if (value?.hash) result[key] = value.hash;
      return result;
    }

    /** hello 用：本地每个会话的版本号。 */
    function revisions() {
      const result = {};
      for (const [key, record] of sessions) if (record.revision) result[key] = record.revision;
      return result;
    }

    return {
      load,
      clear,
      flush,
      put,
      drop,
      apply,
      revisions,
      get: (key) => sessions.get(key) || null,
      files: (key) => files.get(key) || null,
      setFiles,
      fileHashes,
      history: () => history,
      setHistory,
      snapshot: () => snapshot,
      setSnapshot,
      snapshotHash: () => snapshot?.hash || '',
      keys: () => [...sessions.keys()],
      durable: () => Boolean(db),
      rootDirectory: () => rootDirectory,
      persistence,
      retry: () => {
        failures = 0;
        return flush();
      },
    };
  }

  return { create, applyDelta, applySnapshot, LIMIT };
});
