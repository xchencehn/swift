'use strict';
const fs = require('node:fs');
const Conversation = require('./conversation-state');
const { parseTranscript, textOnly, createCodexTranscriptParser } = require('./agent-transcript');
const { imageSources } = require('./chat-images');
const { archivedStatus } = require('./chat-status');
const { claudeGoal } = require('./agent-goal');
const { parseLine, register, release } = require('./json-lines');
const { CodexLineage } = require('./codex-lineage');

// 按文件留住的原始行与逐行解析结果的总量上限（按存档字节数的三倍估算）。解析出的对象大约是原文的两三倍。
const RETAINED_BYTES = 256 * 1024 * 1024;
const RETAINED_FILES = 32;
// 追加读取前核对上次读到位置之前的这一段没变，变了（被改写）就整份重读。
const CHECK_BYTES = 256;

const previewPart = (part) =>
  !part?.text || part.text.length <= 512
    ? part
    : {
        ...part,
        text: part.text.slice(0, 512),
        truncated: true,
        fullLength: part.fullLength || part.text.length,
      };
const previewTools = (block) =>
  block.kind !== 'tools'
    ? block
    : {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          input: previewPart(item.input),
          result: previewPart(item.result),
        })),
      };

/**
 * 每个原生存档文件版本对应一份投影，同一根目录下的读者共用。
 *
 * 存档只会追加，而会话在跑时每一两秒就追加一次。原来每次都整份重读、每行解析六七遍，
 * 78MB 的存档一次近两秒且全程同步（2026-09-24 实测）。现在按文件留住已读到的行与每行的解析结果：
 * 文件只是变长了就只读新增的字节，已经解析过的行不再解析。
 */
class ConversationStore {
  constructor() {
    this.files = new Map();
    this.pending = new Map();
    this.operations = new Map();
    this.bytes = 0;
    this.readVersions = new WeakMap();
    this.lineage = new CodexLineage();
  }
  async sourceVersion(file, provider) {
    if (provider !== 'codex') return fs.promises.stat(file);
    const descriptor = await this.lineage.inspect(file);
    return {
      ...descriptor.version,
      lineageSignature: descriptor.segments ? descriptor.signature : null,
    };
  }
  async sourceSignature(file, provider) {
    const version = await this.sourceVersion(file, provider);
    return (
      version.lineageSignature ||
      [version.ino, version.size, version.mtimeMs, version.ctimeMs].join(':')
    );
  }
  operate(paneId, work) {
    const previous = this.operations.get(paneId) || Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    this.operations.set(paneId, task);
    const clear = () => {
      if (this.operations.get(paneId) === task) this.operations.delete(paneId);
    };
    task.then(clear, clear);
    return task;
  }
  async read(file, provider) {
    const key = `${provider}:${file}`;
    if (this.pending.has(key)) {
      // A request arriving after an append must not inherit a read whose stat
      // was captured before that append. Share IO only if its observed version
      // satisfies this caller, including same-length rewrites and inode changes.
      const [required, value] = await Promise.all([
        this.sourceVersion(file, provider),
        this.pending.get(key),
      ]);
      const version = this.readVersions.get(value);
      if (version?.lineageSignature && version.lineageSignature === required.lineageSignature)
        return value;
      if (
        !required.lineageSignature &&
        !version?.lineageSignature &&
        version?.ino === required.ino &&
        (version.ctimeMs > required.ctimeMs ||
          (version.ctimeMs === required.ctimeMs &&
            version.mtimeMs === required.mtimeMs &&
            version.size === required.size))
      )
        return value;
      return this.read(file, provider);
    }
    const task = this.readFile(file, provider).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  async readLineage(file, descriptor) {
    let entry = this.files.get(file);
    if (entry?.lineageSignature === descriptor.signature) {
      this.touch(file, entry);
      return entry.value;
    }
    const data = await this.lineage.read(file, descriptor),
      lines = data.lines;
    // Reuse the existing incremental parser when only this immutable leaf has
    // grown. A changed inherited prefix rebuilds every derived projection.
    const appended =
      entry?.lineageSignature &&
      entry.complete.length <= lines.length &&
      entry.complete.every((line, index) => line === lines[index]);
    const fresh = appended ? lines.slice(entry.complete.length) : lines;
    if (!appended) {
      if (entry) release(entry.complete);
      entry = { agentKind: 'codex', complete: [], codexParser: createCodexTranscriptParser() };
    }
    register(fresh);
    const rollback = fresh.some((raw) => {
      try {
        const e = parseLine(raw);
        return e.type === 'event_msg' && e.payload?.type === 'thread_rolled_back';
      } catch {
        return false;
      }
    });
    if (rollback) {
      entry.codexParser = createCodexTranscriptParser();
      entry.codexParser.write(Conversation.effectiveLines('codex', lines));
    } else entry.codexParser.write(fresh);
    entry.complete = lines;
    entry.lineageSignature = data.signature;
    entry.size = data.bytes;
    entry.ino = data.version.ino;
    entry.mtimeMs = data.version.mtimeMs;
    entry.ctimeMs = data.version.ctimeMs;
    entry.value = project('codex', lines, entry.codexParser.snapshot({ shared: true }));
    this.readVersions.set(entry.value, { ...data.version, lineageSignature: data.signature });
    this.retain(file, entry);
    return entry.value;
  }
  async readFile(file, agentKind) {
    if (agentKind === 'codex') {
      const descriptor = await this.lineage.inspect(file);
      if (descriptor.segments) return this.readLineage(file, descriptor);
    }
    const stat = await fs.promises.stat(file);
    if (require('./providers/native').JSONL.includes(agentKind) && stat.size > 64 * 1024 * 1024)
      throw Object.assign(new Error('该提供方存档超过 64 MiB 的读取上限。'), {
        status: 413,
        code: 'ARCHIVE_LIMIT',
      });
    let entry = this.files.get(file);
    const same = entry && entry.agentKind === agentKind;
    if (
      same &&
      entry.mtimeMs === stat.mtimeMs &&
      entry.size === stat.size &&
      entry.ino === stat.ino &&
      entry.ctimeMs === stat.ctimeMs
    ) {
      this.touch(file, entry);
      return entry.value;
    }
    const grown =
      same &&
      entry.ino === stat.ino &&
      stat.size >= entry.offset &&
      (await unchangedBefore(file, entry));
    if (!grown) {
      if (entry) release(entry.complete);
      entry = { agentKind, ino: stat.ino, offset: 0, tail: Buffer.alloc(0), complete: [] };
    }
    const added = await readRange(file, entry.offset, stat.size);
    // 最后一行可能还没写完：完整的行记下来，残段下次连同新字节重读。
    const end = added.lastIndexOf(10) + 1;
    const fresh = added.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
    register(fresh);
    for (const line of fresh) entry.complete.push(line);
    if (end) {
      entry.offset += end;
      entry.tail = Buffer.from(added.subarray(Math.max(0, end - CHECK_BYTES), end));
    }
    const rest = added.subarray(end).toString('utf8');
    // 复制一份：entry.complete 之后还会追加，已经交出去的投影不能跟着变。
    const rawLines = rest ? [...entry.complete, rest] : [...entry.complete];
    let incremental = null;
    if (agentKind === 'codex') {
      const rollback = fresh.some((raw) => {
        try {
          const e = parseLine(raw);
          return e.type === 'event_msg' && e.payload?.type === 'thread_rolled_back';
        } catch {
          return false;
        }
      });
      if (!entry.codexParser || rollback) {
        entry.codexParser = createCodexTranscriptParser();
        entry.codexParser.write(Conversation.effectiveLines('codex', entry.complete));
      } else entry.codexParser.write(fresh);
      // An unfinished line is never committed to the parser; it can still be rewritten.
      if (!rest) incremental = entry.codexParser.snapshot({ shared: true });
    }
    entry.value = project(agentKind, rawLines, incremental);
    Object.assign(entry, { mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs });
    this.readVersions.set(entry.value, {
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
    });
    this.retain(file, entry);
    return entry.value;
  }
  touch(file, entry) {
    this.files.delete(file);
    this.files.set(file, entry);
  }
  retain(file, entry) {
    const previous = this.files.get(file);
    if (previous) {
      this.bytes -= previous.retained || 0;
      this.files.delete(file);
    }
    entry.retained = entry.size * 3;
    while (
      this.files.size &&
      (this.files.size >= RETAINED_FILES || this.bytes + entry.retained > RETAINED_BYTES)
    ) {
      const [oldest, dropped] = this.files.entries().next().value;
      this.bytes -= dropped.retained;
      this.files.delete(oldest);
      release(dropped.complete);
    }
    if (entry.retained > RETAINED_BYTES) {
      release(entry.complete);
      return;
    }
    this.bytes += entry.retained;
    this.files.set(file, entry);
  }
}

function lazy(target, name, compute) {
  Object.defineProperty(target, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = compute();
      Object.defineProperty(target, name, { enumerable: true, value });
      return value;
    },
  });
}
const previews = new WeakMap();
function previewMessage(message) {
  if (Object.isFrozen(message) && previews.has(message)) return previews.get(message);
  const result = { ...message, blocks: message.blocks.map(previewTools) };
  if (Object.isFrozen(message)) {
    deepFreeze(result);
    previews.set(message, result);
  }
  return result;
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 一份存档的全部投影。 */
function project(agentKind, rawLines, incremental = null) {
  let effective;
  const lines = () => (effective ||= Conversation.effectiveLines(agentKind, rawLines));
  const messages = incremental || parseTranscript(agentKind, lines());
  const conversation = textOnly(messages).map(previewMessage);
  const value = { messages, conversation };
  // Sync reads only conversation. Build archive/control projections only for consumers that need them.
  lazy(value, 'lines', lines);
  lazy(value, 'archive', () => ({
    ...Conversation.archiveIndex(rawLines),
    activeIds: new Set(messages.map((message) => message.id)),
  }));
  lazy(value, 'turnIds', () => {
    const ids = new Set();
    for (const raw of lines()) {
      try {
        const e = parseLine(raw);
        if (e?.payload?.type === 'task_started') ids.add(e.payload.turn_id);
      } catch {}
    }
    return [...ids];
  });
  lazy(value, 'turnId', () => Conversation.turnToken(agentKind, lines()));
  lazy(value, 'images', () => imageSources(conversation));
  lazy(value, 'status', () => archivedStatus(agentKind, lines()));
  lazy(value, 'goal', () => (/claude/i.test(agentKind) ? claudeGoal(lines()) : null));
  return value;
}

async function readRange(file, start, end) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    let done = 0;
    while (done < buffer.length) {
      const { bytesRead } = await handle.read(buffer, done, buffer.length - done, start + done);
      if (!bytesRead) break;
      done += bytesRead;
    }
    return buffer.subarray(0, done);
  } finally {
    await handle.close();
  }
}

async function unchangedBefore(file, entry) {
  if (!entry.offset) return true;
  const bytes = await readRange(file, entry.offset - entry.tail.length, entry.offset);
  return bytes.equals(entry.tail);
}

module.exports = { ConversationStore };
