'use strict';

// Read-only support for Codex 0.163 paginated rollout history. A history_base
// thread_id names an immutable rollout UUID, not the logical session whose
// current rollout is selected by state_N.sqlite.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { StringDecoder } = require('node:string_decoder');
const crypto = require('node:crypto');

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const NAME = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`,
  'i',
);
const RECORD_TYPES = new Set([
  'session_meta',
  'response_item',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
  'compacted',
  'turn_context',
  'world_state',
  'realtime_item',
  'token_usage_record',
  'retained_context',
  'security_risk_score',
  'event_msg',
]);
const SIGNATURE = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const invalid = (detail) => fail('ARCHIVE_LINEAGE_INVALID', `Codex 历史引用无效：${detail}。`);

function rolloutIdentity(file) {
  const match = NAME.exec(path.basename(file));
  return match
    ? { sessionId: match[1].toLowerCase(), rolloutId: (match[2] || match[1]).toLowerCase() }
    : null;
}
function managedHome(file) {
  let current = path.dirname(path.resolve(file));
  while (current !== path.dirname(current)) {
    if (['sessions', 'archived_sessions'].includes(path.basename(current)))
      return path.dirname(current);
    current = path.dirname(current);
  }
  return null;
}
function historyBase(value) {
  if (value == null) return null;
  if (
    !value ||
    !new RegExp(`^${UUID}$`, 'i').test(value.thread_id) ||
    !Number.isSafeInteger(value.end_ordinal_exclusive) ||
    value.end_ordinal_exclusive < 1 ||
    !Number.isSafeInteger(value.end_byte_offset) ||
    value.end_byte_offset < 1
  )
    throw invalid('截断位置不是安全的正整数或 UUID');
  return {
    thread_id: value.thread_id.toLowerCase(),
    end_ordinal_exclusive: value.end_ordinal_exclusive,
    end_byte_offset: value.end_byte_offset,
  };
}
function signature(segments) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        segments.map((segment) => [
          segment.file,
          segment.version,
          segment.rolloutId,
          segment.startOrdinal,
          segment.end,
        ]),
      ),
    )
    .digest('hex');
}

async function* bytes(file) {
  const input = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  const decoded = file.endsWith('.zst') ? input.pipe(zlib.createZstdDecompress()) : input;
  // pipe() does not forward input errors to the decoder.
  if (decoded !== input) input.on('error', (error) => decoded.destroy(error));
  try {
    for await (const chunk of decoded) yield chunk;
  } finally {
    decoded.destroy();
    input.destroy();
  }
}
async function head(file, maxBytes) {
  const decoder = new StringDecoder('utf8');
  let text = '',
    length = 0;
  for await (const chunk of bytes(file)) {
    const end = chunk.indexOf(10),
      part = end < 0 ? chunk : chunk.subarray(0, end);
    length += part.length;
    if (length > maxBytes) throw fail('ARCHIVE_LIMIT', 'Codex 存档元数据超过读取上限。', 413);
    text += decoder.write(part);
    if (end >= 0) return text + decoder.end();
  }
  return text + decoder.end();
}
async function readPrefix(file, end, budget) {
  const chunks = [];
  let count = 0;
  for await (const chunk of bytes(file)) {
    const available = end == null ? chunk.length : Math.min(chunk.length, end - count);
    if (available > budget - count)
      throw fail('ARCHIVE_LIMIT', 'Codex 历史引用超过读取上限。', 413);
    if (available) chunks.push(chunk.subarray(0, available));
    count += available;
    if (end != null && count === end) break;
  }
  if (end != null && count !== end) throw invalid('截断字节位置超过源文件');
  const buffer = Buffer.concat(chunks, count);
  if (end != null && buffer.at(-1) !== 10) throw invalid('截断字节位置不在完整 JSONL 行的边界');
  return buffer;
}

class CodexLineage {
  constructor({
    maxBytes = 256 * 1024 * 1024,
    maxSegments = 128,
    maxEntries = 200000,
    maxMetaBytes = 2 * 1024 * 1024,
    maxRetainedBytes = 64 * 1024 * 1024,
  } = {}) {
    this.maxBytes = maxBytes;
    this.maxSegments = maxSegments;
    this.maxEntries = maxEntries;
    this.maxMetaBytes = maxMetaBytes;
    this.metadata = new Map();
    this.locations = new Map();
    this.payloads = new Map();
    this.retainedBytes = 0;
    this.maxRetainedBytes = maxRetainedBytes;
  }
  remember(key, value) {
    const previous = this.payloads.get(key);
    if (previous) {
      this.retainedBytes -= previous.bytes;
      this.payloads.delete(key);
    }
    if (value.bytes > this.maxRetainedBytes) return;
    while (
      this.payloads.size &&
      (this.payloads.size >= 128 || this.retainedBytes + value.bytes > this.maxRetainedBytes)
    ) {
      const [oldest, entry] = this.payloads.entries().next().value;
      this.payloads.delete(oldest);
      this.retainedBytes -= entry.bytes;
    }
    this.payloads.set(key, value);
    this.retainedBytes += value.bytes;
  }
  async meta(file) {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw invalid('引用目标不是普通文件');
    const version = SIGNATURE(stat),
      cached = this.metadata.get(file);
    if (cached?.version === version) return cached;
    let value;
    try {
      value = JSON.parse(await head(file, this.maxMetaBytes));
    } catch (error) {
      if (error.code === 'ARCHIVE_LIMIT') throw error;
      // Legacy inputs are still handled by the original single-file reader.
      value = null;
    }
    const result = {
      version,
      stat,
      record: value,
      meta: value?.type === 'session_meta' ? value.payload : null,
    };
    if (this.metadata.size >= 512) this.metadata.delete(this.metadata.keys().next().value);
    this.metadata.set(file, result);
    return result;
  }
  async inside(home, file) {
    const realHome = await fs.promises.realpath(home),
      realFile = await fs.promises.realpath(file);
    const relative = path.relative(realHome, realFile);
    if (
      !/^(?:sessions|archived_sessions)[/\\]/.test(relative) ||
      relative.split(path.sep).includes('..')
    )
      throw invalid('引用目标位于 Codex 管理目录以外');
    return realFile;
  }
  async find(home, rolloutId) {
    const key = `${home}:${rolloutId}`,
      cached = this.locations.get(key);
    if (cached) {
      try {
        const file = await this.inside(home, cached);
        if (
          (await fs.promises.stat(file)).isFile() &&
          rolloutIdentity(file)?.rolloutId === rolloutId
        )
          return file;
      } catch {}
      this.locations.delete(key);
    }
    // Only the exact immutable ID is considered. A logical thread's latest
    // file, file mtime and SQLite current pointers are irrelevant here.
    const found = new Set();
    let entries = 0;
    for (const name of ['sessions', 'archived_sessions']) {
      const stack = [path.join(home, name)];
      while (stack.length) {
        let children;
        try {
          children = await fs.promises.readdir(stack.pop(), { withFileTypes: true });
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        for (const child of children) {
          if (++entries > this.maxEntries)
            throw fail('ARCHIVE_LIMIT', 'Codex 历史文件搜索超过上限。', 413);
          const file = path.join(child.parentPath, child.name);
          if (child.isDirectory()) {
            stack.push(file);
            continue;
          }
          // No symlink traversal: immutable references must remain in the
          // managed directory even if an archive is moved while it is read.
          if (!child.isFile() || rolloutIdentity(file)?.rolloutId !== rolloutId) continue;
          found.add(await this.inside(home, file));
        }
      }
    }
    // Compression can leave a plain + .zst representation of the same file.
    // Select plain when both share one canonical basename, as Codex does.
    const paths = [...found],
      bases = new Set(paths.map((file) => file.replace(/\.zst$/, '')));
    if (bases.size > 1) throw invalid('同一 immutable rollout UUID 对应多个文件');
    const result = paths.find((file) => !file.endsWith('.zst')) || paths[0];
    if (!result) throw invalid(`缺少源 rollout ${rolloutId}`);
    if (this.locations.size >= 1024) this.locations.delete(this.locations.keys().next().value);
    this.locations.set(key, result);
    return result;
  }
  async inspect(file) {
    const first = await this.meta(file);
    // A standalone legacy journal needs neither filename inference nor a
    // directory scan. A paginated standalone journal is also a single file.
    if (first.meta?.history_base == null)
      return { signature: first.version, segments: null, file, version: first.stat };
    const home = managedHome(file),
      initial = rolloutIdentity(file);
    if (!home || !initial) throw invalid('当前分片没有标准存档路径');
    const requestedSession = first.meta?.id;
    const seen = new Set(),
      segments = [];
    let current = file,
      end = null;
    while (true) {
      if (segments.length >= this.maxSegments)
        throw fail('ARCHIVE_LIMIT', 'Codex 历史引用层数超过上限。', 413);
      current = await this.inside(home, current);
      const identity = rolloutIdentity(current);
      if (!identity || seen.has(identity.rolloutId)) throw invalid('历史引用存在循环或文件名无效');
      seen.add(identity.rolloutId);
      const info = await this.meta(current),
        meta = info.meta;
      if (!meta || meta.history_mode !== 'paginated')
        throw invalid('源存档缺少 paginated 会话元数据');
      if (
        !segments.length &&
        (meta.id !== requestedSession ||
          identity.sessionId !== String(requestedSession).toLowerCase())
      )
        throw invalid('当前分片属于其他会话');
      const base = historyBase(meta.history_base),
        startOrdinal = base ? base.end_ordinal_exclusive + 1 : 1;
      if (!Number.isSafeInteger(startOrdinal)) throw invalid('源 ordinal 超出安全整数范围');
      // SessionMeta is at initialOrdinal; payload records start immediately
      // after it. The actual lines carry explicit ordinal values.
      const initialOrdinal = base ? base.end_ordinal_exclusive : 0;
      if (info.record.ordinal !== initialOrdinal)
        throw invalid('SessionMeta 的 ordinal 与继承位置不一致');
      if (end && end.end_ordinal_exclusive < startOrdinal)
        throw invalid('截断 ordinal 位于源分片有效范围之前');
      segments.push({
        file: current,
        rolloutId: identity.rolloutId,
        startOrdinal,
        end,
        version: info.version,
        stat: info.stat,
      });
      if (!base) break;
      end = base;
      current = await this.find(home, base.thread_id);
    }
    segments.reverse();
    return { file, home, segments, signature: signature(segments), version: first.stat };
  }
  async read(file, descriptor) {
    const before = descriptor || (await this.inspect(file));
    if (!before.segments) return null;
    let used = 0,
      headMeta;
    const lines = [];
    for (const segment of before.segments) {
      const key = JSON.stringify([segment.file, segment.end]),
        cached = this.payloads.get(key);
      if (cached?.version === segment.version) {
        if (cached.bytes > this.maxBytes - used)
          throw fail('ARCHIVE_LIMIT', 'Codex 历史引用超过读取上限。', 413);
        used += cached.bytes;
        for (const line of cached.lines) lines.push(line);
        if (segment === before.segments.at(-1)) headMeta = cached.meta;
        this.payloads.delete(key);
        this.payloads.set(key, cached);
        continue;
      }
      const buffer = await readPrefix(
        segment.file,
        segment.end?.end_byte_offset,
        this.maxBytes - used,
      );
      used += buffer.length;
      const payloads = [];
      let metadata,
        nextOrdinal = segment.startOrdinal;
      // The final current-file record may still be being written. Commit only
      // complete lines, as the native paginated projection does.
      const complete = buffer.subarray(0, buffer.lastIndexOf(10) + 1);
      for (const raw of complete.toString('utf8').split('\n').filter(Boolean)) {
        let record;
        try {
          record = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!RECORD_TYPES.has(record.type)) continue;
        if (record.type === 'session_meta') {
          if (metadata !== undefined) throw invalid('同一分片包含多条 SessionMeta');
          metadata = raw;
          if (segment === before.segments.at(-1)) headMeta = raw;
          continue;
        }
        const ordinal = record.ordinal;
        // Official paginated readers skip missing/invalid ordinals. Never
        // derive ordinals from line counts, message counts, or JSON reencoding.
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) continue;
        if (segment.end && ordinal >= segment.end.end_ordinal_exclusive)
          throw invalid('截断字节范围包含 exclusive ordinal 以后的记录');
        if (ordinal < nextOrdinal) continue;
        nextOrdinal = ordinal + 1;
        lines.push(raw);
        payloads.push(raw);
      }
      this.remember(key, {
        version: segment.version,
        bytes: buffer.length,
        lines: payloads,
        meta: metadata,
      });
    }
    const after = await this.inspect(file);
    if (after.signature !== before.signature)
      throw fail('ARCHIVE_CHANGED', 'Codex 历史在读取期间发生变化，请重试。');
    if (!headMeta) throw invalid('当前分片缺少完整 SessionMeta 行');
    // One canonical head metadata record, followed by bounded raw payloads.
    // User record bytes are never reserialized, so their stable IDs survive.
    return {
      lines: [headMeta, ...lines],
      bytes: used,
      signature: before.signature,
      version: before.version,
      segments: before.segments,
    };
  }
}

module.exports = { CodexLineage, rolloutIdentity, managedHome, historyBase, signature };
