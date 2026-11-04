'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const allowed = {
  source: new Set(['screen', 'prewrite', 'archive']),
  thread: new Set(['main', 'side', 'unknown']),
  inputTarget: new Set([
    'composer',
    'question',
    'menu',
    'form',
    'authentication',
    'confirmation',
    'unknown',
  ]),
  reason: new Set([
    'native-modal',
    'composer-not-visible',
    'footer-not-visible',
    'model-not-visible',
    'input-context-unconfirmed',
    'confirmation',
  ]),
  kind: new Set([
    'goal-resume',
    'goal-replace',
    'approval',
    'model-settings',
    'authentication',
    'directory-trust',
    'selection',
    'form',
    'configuration',
    'help',
    'warnings',
  ]),
  code: new Set([
    'SIDE_UNKNOWN',
    'SIDE_ACTIVE',
    'QUESTION_PENDING',
    'SESSION_CHANGED',
    'ARCHIVE_WORKER_FAILED',
  ]),
  workerError: new Set([
    'ERR_WORKER_OUT_OF_MEMORY',
    'ERR_WORKER_NOT_RUNNING',
    'ERR_WORKER_INIT_FAILED',
  ]),
  placeholder: new Set(['main', 'side', 'none']),
};
const member = (name, value) => (allowed[name].has(value) ? value : '');
const hash = (value) =>
  typeof value === 'string' && value
    ? createHash('sha256').update(value).digest('hex').slice(0, 20)
    : '';
const dimension = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : undefined;
const evidence = (value) =>
  value && typeof value === 'object'
    ? {
        composerVisible:
          typeof value.composerVisible === 'boolean' ? value.composerVisible : undefined,
        styled: typeof value.styled === 'boolean' ? value.styled : undefined,
        modelVisible: typeof value.modelVisible === 'boolean' ? value.modelVisible : undefined,
        placeholder: member('placeholder', value.placeholder),
        footerRows: dimension(value.footerRows),
        sampleRows: dimension(value.sampleRows),
      }
    : undefined;

// Revalidate persisted records too: a file from an older version (or a damaged
// line) must never turn the authenticated diagnostics API into a raw log reader.
function storedEvent(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !allowed.source.has(value.source) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id || '') ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at || '') ||
    !Number.isFinite(Date.parse(value.at))
  )
    return null;
  const result = { id: value.id, at: value.at };
  for (const key of ['source', 'thread', 'inputTarget', 'reason', 'kind', 'code'])
    result[key] = member(key, value[key]);
  for (const key of ['target', 'terminal', 'request'])
    result[key] = /^[a-f0-9]{20}$/.test(value[key] || '') ? value[key] : '';
  for (const key of ['revision', 'cols', 'rows']) result[key] = dimension(value[key]);
  if (value.source === 'archive') {
    result.workerError = member('workerError', value.workerError);
    result.exitCode = dimension(value.exitCode);
    result.pendingReads = dimension(value.pendingReads);
  }
  if (value.evidence) result.evidence = evidence(value.evidence);
  return result;
}

// Deliberately accepts only enumerated state and hashed bindings. Native text,
// titles, answers, paths and arbitrary errors never enter this log.
class NativeDiagnostics {
  constructor({
    file,
    limit = 256,
    maxBytes = 512 * 1024,
    repeatMs = 30000,
    clock = Date.now,
  } = {}) {
    Object.assign(this, { file, limit, maxBytes, repeatMs, clock });
    this.events = [];
    this.states = new Map();
    this.pending = Promise.resolve();
    this.queued = 0;
    this.dropped = 0;
    this.failures = 0;
    this.readFailures = 0;
  }
  observe(value = {}) {
    const facts = value.interaction || {};
    const event = {
      source: member('source', value.source),
      target: hash(value.binding || value.terminalId || value.paneId),
      terminal: hash(value.terminalId),
      request: hash(value.requestId),
      thread: member('thread', facts.thread),
      inputTarget: member('inputTarget', facts.inputTarget),
      reason: member('reason', facts.reason),
      kind: member('kind', facts.modal?.kind),
      code: member('code', value.code),
      revision: dimension(value.revision),
      cols: dimension(value.cols),
      rows: dimension(value.rows),
      ...(facts.evidence ? { evidence: evidence(facts.evidence) } : {}),
      ...(value.source === 'archive'
        ? {
            workerError: member('workerError', value.workerError),
            exitCode: dimension(value.exitCode),
            pendingReads: dimension(value.pendingReads),
          }
        : {}),
    };
    const key = `${event.source}:${event.target}:${event.source === 'prewrite' ? event.request : ''}`,
      now = this.clock();
    const signature = JSON.stringify([
      event.thread,
      event.inputTarget,
      event.reason,
      event.kind,
      event.code,
      event.workerError,
      event.exitCode,
      event.evidence,
    ]);
    const previous = this.states.get(key);
    if (previous?.signature === signature && now - previous.time < this.repeatMs)
      return previous.id;
    event.id = randomUUID();
    event.at = new Date(now).toISOString();
    this.states.set(key, { signature, time: now, id: event.id });
    if (this.states.size > this.limit) this.states.delete(this.states.keys().next().value);
    this.events.push(event);
    if (this.events.length > this.limit) this.events.shift();
    if (this.file) {
      if (this.queued >= 64) {
        this.dropped++;
        return event.id;
      }
      this.queued++;
      this.pending = this.pending
        .then(async () => {
          await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
          const size = (
            await fs.stat(this.file).catch((error) => {
              if (error.code === 'ENOENT') return { size: 0 };
              throw error;
            })
          ).size;
          if (size >= this.maxBytes) await fs.rename(this.file, this.file + '.1');
          await fs.appendFile(this.file, JSON.stringify(event) + '\n', { mode: 0o600 });
        })
        .catch(() => {
          this.failures++;
        })
        .finally(() => {
          this.queued--;
        });
    }
    return event.id;
  }
  recent(limit = 100) {
    const count = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, this.limit)) : 100;
    return {
      events: count ? this.events.slice(-count).map((event) => ({ ...event })) : [],
      dropped: this.dropped,
      writeFailures: this.failures,
    };
  }
  async readRecent(limit = 100) {
    const count = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, this.limit)) : 100;
    const events = new Map(),
      history = { filesRead: 0, invalidRecords: 0, truncatedFiles: 0 };
    if (this.file && count)
      for (const file of [this.file + '.1', this.file]) {
        let handle;
        try {
          handle = await fs.open(file, 'r');
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('Diagnostics history is not a regular file');
          // Read a bounded tail, even if an external writer replaced the file.
          const bytes = Math.min(stat.size, this.maxBytes + 8192),
            start = stat.size - bytes;
          const buffer = Buffer.alloc(bytes);
          const { bytesRead } = await handle.read(buffer, 0, bytes, start);
          let text = buffer.subarray(0, bytesRead).toString('utf8');
          history.filesRead++;
          if (start) {
            history.truncatedFiles++;
            const newline = text.indexOf('\n');
            text = newline < 0 ? '' : text.slice(newline + 1);
          }
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let value;
            try {
              value = storedEvent(JSON.parse(line));
            } catch {
              /* A partial append is not a complete record. */
            }
            if (value) {
              events.set(value.id, value);
              if (events.size > this.limit) events.delete(events.keys().next().value);
            } else history.invalidRecords++;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') this.readFailures++;
        } finally {
          await handle?.close().catch(() => {});
        }
      }
    // Include not-yet-flushed current events without waiting on disk writes in
    // the native input path, and deduplicate records already read from disk.
    const current = this.recent(this.limit);
    for (const event of current.events) events.set(event.id, event);
    return {
      ...current,
      events: count ? [...events.values()].slice(-count) : [],
      readFailures: this.readFailures,
      history,
    };
  }
  async flush() {
    await this.pending;
  }
}
module.exports = { NativeDiagnostics };
