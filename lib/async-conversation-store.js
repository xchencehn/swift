'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ConversationStore } = require('./conversation-store');
const FIELDS = ['messages', 'conversation', 'archive', 'turnIds', 'turnId', 'status', 'goal'];
function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  Object.freeze(value);
}
const signature = (stat) =>
  stat.lineageSignature || [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

class AsyncConversationStore extends ConversationStore {
  constructor({ onFailure = () => {}, indexFile } = {}) {
    super();
    this.worker = null;
    this.reads = new Map();
    this.cache = new Map();
    this.nextId = 0;
    this.inflight = new Map();
    this.onFailure = onFailure;
    this.closed = false;
    const { ArchiveWorkerClient } = require('./archive-worker-client');
    this.windows = new ArchiveWorkerClient('conversation-index-worker.js', { file: indexFile });
    this.background = new ArchiveWorkerClient('archive-background-worker.js');
    this.pageReads = new Map();
    this.backgroundReads = new Map();
    this.backgroundCache = new Map();
  }
  async page(file, provider, options = {}, priority = 0) {
    const version = await this.sourceSignature(file, provider);
    const key = JSON.stringify([file, provider, version, options]);
    if (this.pageReads.has(key)) return this.pageReads.get(key);
    const pending = this.windows
      .request({ file, provider, options }, priority)
      .then((result) => {
        for (const message of result.messages || []) freeze(message);
        return result;
      })
      .finally(() => this.pageReads.delete(key));
    this.pageReads.set(key, pending);
    return pending;
  }
  async backgroundRead(kind, file, provider, cwd) {
    const version = await this.sourceSignature(file, provider),
      key = JSON.stringify([kind, file, provider, cwd, version]);
    if (this.backgroundCache.has(key)) return this.backgroundCache.get(key);
    if (this.backgroundReads.has(key)) return this.backgroundReads.get(key);
    const pending = this.background
      .request({ kind, file, provider, cwd }, kind === 'metadata' ? 10 : 20)
      .then((value) => {
        this.backgroundCache.set(key, value);
        while (this.backgroundCache.size > 128)
          this.backgroundCache.delete(this.backgroundCache.keys().next().value);
        return value;
      })
      .finally(() => this.backgroundReads.delete(key));
    this.backgroundReads.set(key, pending);
    return pending;
  }
  start() {
    if (this.closed)
      throw Object.assign(new Error('原生存档解析器已关闭。'), { code: 'ARCHIVE_STORE_CLOSED' });
    if (this.worker) return this.worker;
    const worker = (this.worker = new Worker(path.join(__dirname, 'conversation-worker.js')));
    const failed = (error, exitCode) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (!this.closed)
        try {
          this.onFailure({ workerError: error?.code, exitCode, pendingReads: this.reads.size });
        } catch {
          /* Diagnostics cannot prevent read recovery. */
        }
      for (const job of this.reads.values())
        job.reject(
          Object.assign(new Error('原生存档解析暂时中断，请重试读取。'), {
            code: 'ARCHIVE_WORKER_FAILED',
            cause: error,
          }),
        );
      this.reads.clear();
    };
    worker.on('error', failed);
    worker.on('exit', (code) => failed(new Error(`Archive worker exited: ${code}`), code));
    worker.on('message', ({ id, result, error, version, bytes }) => {
      const job = this.reads.get(id);
      if (!job) return;
      this.reads.delete(id);
      if (!this.reads.size) worker.unref();
      if (error) return job.reject(Object.assign(new Error(error.message), error));
      // Match the original store's immutable Codex snapshots and hidden source.
      for (const field of ['messages', 'conversation'])
        for (const message of result[field] || []) {
          if (Object.hasOwn(message, 'source'))
            Object.defineProperty(message, 'source', { enumerable: false });
          if (job.provider === 'codex') freeze(message);
        }
      job.resolve({ result, version, bytes });
    });
    worker.unref();
    return worker;
  }
  async read(file, provider, fields = FIELDS) {
    if (this.closed)
      throw Object.assign(new Error('原生存档解析器已关闭。'), { code: 'ARCHIVE_STORE_CLOSED' });
    const key = JSON.stringify([file, provider, fields]);
    const required = signature(await this.sourceVersion(file, provider));
    const cached = this.cache.get(key);
    if (cached?.signature === required) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.value;
    }
    const flightKey = `${key}:${required}`;
    if (this.inflight.has(flightKey)) return this.inflight.get(flightKey);
    const pending = this.load(file, provider, fields, key).finally(() =>
      this.inflight.delete(flightKey),
    );
    this.inflight.set(flightKey, pending);
    return pending;
  }
  async load(file, provider, fields, key) {
    let snapshot;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        snapshot = await new Promise((resolve, reject) => {
          const worker = this.start(),
            id = ++this.nextId;
          this.reads.set(id, { resolve, reject, provider });
          worker.ref();
          try {
            worker.postMessage({ id, file, provider, fields });
          } catch (error) {
            this.reads.delete(id);
            if (!this.reads.size) worker.unref();
            reject(error);
          }
        });
        break;
      } catch (error) {
        // This repeats only an archive projection, before its caller receives
        // data. It cannot replay a native message, rewind or control key.
        if (error.code !== 'ARCHIVE_WORKER_FAILED' || this.closed || attempt) throw error;
      }
    }
    const { result, version, bytes } = snapshot;
    // Keep at most one version of each projection, within a bounded total.
    // Raw control lines may be large and are deliberately not cached here.
    if (!fields.includes('lines')) {
      this.cache.delete(key);
      if (bytes <= 16 * 1024 * 1024)
        this.cache.set(key, { signature: signature(version), value: result, bytes });
      let total = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      while (this.cache.size > 32 || total > 64 * 1024 * 1024) {
        const [oldest, entry] = this.cache.entries().next().value;
        this.cache.delete(oldest);
        total -= entry.bytes;
      }
    }
    return result;
  }
  async close() {
    this.closed = true;
    await Promise.all([this.windows.close(), this.background.close()]);
    const worker = this.worker;
    if (worker) await worker.terminate();
    this.cache.clear();
  }
}
module.exports = { AsyncConversationStore };
