'use strict';
const { parseLine } = require('./json-lines');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ToolLifecycle } = require('./tool-lifecycle');
const { apiError } = require('./message-queue');
const idFor = (value) => crypto.createHash('sha256').update(value).digest('hex');
const textOf = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));
function parsed(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function patchPaths(text) {
  return [...text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)]
    .map((m) => ({ path: m[2].trim(), operation: m[1].toLowerCase() }))
    .concat(
      [...text.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((m) => ({
        path: m[1].trim(),
        operation: 'update',
      })),
    );
}
function literal(value) {
  if (value[0] === '"') {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value
    .slice(1, -1)
    .replace(/\\(['"\\])/g, '$1')
    .replace(/\\n/g, '\n');
}
// Read explicit write destinations, never run or evaluate command source.
function commandPaths(command) {
  const found = patchPaths(command),
    variables = new Map();
  const string = `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
  for (const m of command.matchAll(
    new RegExp(`\\b([a-zA-Z_]\\w*)\\s*=\\s*(?:Path\\(\\s*)?(${string})`, 'g'),
  )) {
    const values = variables.get(m[1]) || [];
    values.push({ at: m.index, value: literal(m[2]) });
    variables.set(m[1], values);
  }
  const lookup = (name, at) =>
    variables
      .get(name)
      ?.filter((item) => item.at < at)
      .at(-1)?.value;
  const add = (value) => {
    if (value && !/[\n\r\0]/.test(value)) found.push({ path: value, operation: 'update' });
  };
  for (const m of command.matchAll(
    new RegExp(
      `(?:open\\(\\s*|Path\\(\\s*)(${string}|[a-zA-Z_]\\w*)\\s*[,)](?=([^\\n]{0,100}))`,
      'g',
    ),
  )) {
    if (/^\s*,?\s*['"][wax][b+t]*['"]/.test(m[2]) || /^\s*\.write_(text|bytes)\s*\(/.test(m[2]))
      add(lookup(m[1], m.index) || (/^["']/.test(m[1]) ? literal(m[1]) : null));
  }
  for (const m of command.matchAll(/\b([a-zA-Z_]\w*)\.write_(?:text|bytes)\s*\(/g))
    add(lookup(m[1], m.index));
  for (const m of command.matchAll(
    /(?:^|\n)[ \t]*(?:cat|echo|printf|python3?|node|npm|cargo|make)\b[^\n]*?\s(?:\d?>{1,2})\s*("[^"\n]+"|'[^'\n]+'|[^\s;&|<>]+)/g,
  ))
    if (!/^&|^\/dev\//.test(m[1])) add(m[1].replace(/^['"]|['"]$/g, ''));
  return found;
}
function writePaths(name, input, output, cwd) {
  const value = typeof input === 'string' ? parsed(input) : input;
  if (/^(?:Write|Edit|MultiEdit|write_file|edit_file)$/i.test(name)) {
    const file = value?.file_path || value?.path;
    return file
      ? [{ path: path.resolve(cwd, file), operation: /write/i.test(name) ? 'write' : 'update' }]
      : [];
  }
  const result = [];
  const collect = (text, dir) => {
    for (const item of commandPaths(text))
      result.push({ ...item, path: path.resolve(dir, item.path) });
  };
  if (/apply_patch/.test(name)) collect(textOf(input), cwd);
  if (/exec|bash|shell|command/i.test(name)) {
    const dir = value?.workdir || value?.cwd || cwd;
    const source = value?.cmd || value?.command || textOf(value);
    collect(source, dir);
    for (const m of source.matchAll(
      /(?:tools\.)?apply_patch\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    ))
      collect(literal(m[1]), dir);
    // Orchestrated tool calls contain JSON string arguments. Decode strings so
    // Python heredocs and shell redirections are read with their actual newlines.
    for (const m of source.matchAll(
      /\{\s*(?:"cmd"|cmd)\s*:\s*("(?:[^"\\]|\\.)*"|\x27(?:[^\x27\\]|\\.)*\x27)([\s\S]*?)\}/g,
    )) {
      const workdir = m[2].match(
        /(?:"workdir"|workdir)\s*:\s*("(?:[^"\\]|\\.)*"|\x27(?:[^\x27\\]|\\.)*\x27)/,
      );
      collect(literal(m[1]), workdir ? literal(workdir[1]) : dir);
    }
  }
  // apply_patch reports exact changed paths even inside an orchestrated call.
  if (/apply_patch/.test(name) || /(?:tools\.)?apply_patch\s*\(/.test(textOf(input)))
    for (const m of textOf(output)
      .replace(/\\n/g, '\n')
      .matchAll(/(?:^|\n)([MAD]) ([^\n]+)(?=\n|$)/g)) {
      const file = m[2].trim();
      if (!/["{}]/.test(file))
        result.push({
          path: path.resolve(cwd, file),
          operation: m[1] === 'D' ? 'delete' : 'update',
        });
    }
  return result;
}
/**
 * Agent 回复里引用的文件：Markdown 链接，以及反引号里的绝对路径。Agent 交付报告
 * 最常见的写法就是「已写入[性能空间初评](/…/report.md)」。只收可阅读的类型
 * （文档与图片，见 lib/doc-files.js），外链与锚点不算。
 */
function linkedPaths(text, cwd) {
  const { kindOf } = require('./doc-files');
  const found = [];
  const add = (raw) => {
    let value = String(raw || '')
      .trim()
      .replace(/^<|>$/g, '');
    if (
      !value ||
      value.startsWith('#') ||
      (/^[a-z][\w+.-]*:/i.test(value) && !value.startsWith('file:'))
    )
      return;
    value = value
      .replace(/^file:\/\//, '')
      .split('#')[0]
      .split('?')[0];
    try {
      value = decodeURI(value);
    } catch {}
    if (!kindOf(value) || /[\0\r\n]/.test(value)) return;
    found.push(path.resolve(cwd, value));
  };
  for (const m of String(text || '').matchAll(/\]\(\s*(<[^>\n]+>|[^)\s]+)[^)]*\)/g)) add(m[1]);
  for (const m of String(text || '').matchAll(/`(\/[^`\s]+)`/g)) add(m[1]);
  return found;
}

function createCollector(provider, initialCwd) {
  let cwd = initialCwd;
  const calls = new Map(),
    files = new Map(),
    lifecycle = new ToolLifecycle();
  // 读过与引用过的文件（写过的在 files 里）。只用于「会话」栏的列表，不开放预览权限。
  const mentions = new Map();
  const mention = (file, ts, operation) => {
    if (!file || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) return;
    const at = Date.parse(ts || '') || 0;
    if ((mentions.get(file)?.at || 0) <= at) mentions.set(file, { path: file, at, operation });
  };
  const start = (id, call) => {
    calls.set(id, call);
    lifecycle.start(call, call.input);
  };
  const finish = (id, output, entry, failed) => {
    const current = calls.get(id);
    if (!current) return;
    current.output = output;
    current.result = true;
    current.failed = Boolean(failed);
    lifecycle.result(current, output);
    for (const [callId, call] of calls) {
      if (!call.result || call.running || call.applied) continue;
      call.applied = true;
      calls.delete(callId);
      const raw = textOf(call.output);
      if (
        call.failed ||
        /Process exited with code [1-9]|"exit_code"\s*:\s*[1-9]|\b(?:Error:|Failed to apply)/.test(
          raw,
        )
      )
        continue;
      for (const file of writePaths(call.name, call.input, call.output, call.cwd)) {
        if (!path.isAbsolute(file.path) || /[\x00-\x1f]/.test(file.path)) continue;
        const at = Date.parse(entry.timestamp || call.ts || '') || 0;
        files.set(file.path, {
          ...file,
          id: idFor(file.path),
          updatedAt: at,
          name: path.basename(file.path),
        });
      }
    }
  };
  const feed = (lines) => {
    for (const raw of lines) {
      let e;
      try {
        e = parseLine(raw);
      } catch {
        continue;
      }
      if (provider === 'codex') {
        const p = e.payload || {};
        if (
          (e.type === 'session_meta' || e.type === 'turn_context') &&
          path.isAbsolute(p.cwd || '')
        )
          cwd = p.cwd;
        if (e.type !== 'response_item') continue;
        if (p.type === 'message' && p.role === 'assistant') {
          for (const item of Array.isArray(p.content) ? p.content : [])
            for (const file of linkedPaths(item?.text, cwd)) mention(file, e.timestamp, 'link');
        }
        if (p.type === 'function_call' && p.name === 'view_image') {
          const args = parsed(p.arguments);
          if (args?.path) mention(path.resolve(cwd, args.path), e.timestamp, 'read');
        }
        if (['function_call', 'custom_tool_call'].includes(p.type))
          start(p.call_id || p.id, {
            name: p.name,
            input: p.input ?? p.arguments,
            cwd,
            ts: e.timestamp,
          });
        if (['function_call_output', 'custom_tool_call_output'].includes(p.type))
          finish(p.call_id, p.output, e, false);
      } else if (provider === 'claude' && !e.isSidechain) {
        if (path.isAbsolute(e.cwd || '')) cwd = e.cwd;
        for (const block of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (e.type === 'assistant' && block.type === 'text')
            for (const file of linkedPaths(block.text, cwd)) mention(file, e.timestamp, 'link');
          if (block.type === 'tool_use' && block.name === 'Read' && block.input?.file_path)
            mention(path.resolve(cwd, block.input.file_path), e.timestamp, 'read');
          if (block.type === 'tool_use')
            start(block.id, { name: block.name, input: block.input, cwd, ts: e.timestamp });
          if (block.type === 'tool_result')
            finish(block.tool_use_id, block.content, e, block.is_error);
        }
      }
    }
  };
  return {
    feed,
    entries: () =>
      [...files.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path)),
    mentions: () => [...mentions.values()],
  };
}
function collectFiles(lines, provider, initialCwd) {
  const collector = createCollector(provider, initialCwd);
  collector.feed(require('./conversation-state').effectiveLines(provider, lines));
  return collector.entries();
}
class SessionFiles {
  constructor() {
    this.cache = new Map();
    this.pending = new Map();
  }
  async list(file, provider, cwd, full = false) {
    const key = `${file}:${provider}:${cwd}`;
    if (!this.pending.has(key)) {
      const task = this.update(file, provider, cwd, key);
      this.pending.set(key, task);
      task.finally(() => this.pending.delete(key)).catch(() => {});
    }
    const cached = (await this.pending.get(key)) ?? this.cache.get(key);
    return full ? cached : cached.entries;
  }
  async update(file, provider, cwd, key) {
    const stat = await fs.stat(file);
    let cached = this.cache.get(key);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtime === stat.mtimeMs &&
      cached.ino === stat.ino
    )
      return cached;
    const append = false; // Branch changes and rollback records can invalidate any previous file operation.
    const collector = append ? cached.collector : createCollector(provider, cwd);
    const offset = append ? cached.size : 0;
    const handle = await fs.open(file, 'r');
    let buffer;
    try {
      buffer = Buffer.alloc(stat.size - offset);
      let read = 0;
      while (read < buffer.length) {
        const part = await handle.read(buffer, read, buffer.length - read, offset + read);
        if (!part.bytesRead) break;
        read += part.bytesRead;
      }
      buffer = buffer.subarray(0, read);
    } finally {
      await handle.close();
    }
    const text = buffer.toString('utf8');
    collector.feed(require('./conversation-state').effectiveLines(provider, text.split('\n')));
    cached = {
      size: offset + buffer.length,
      mtime: stat.mtimeMs,
      ino: stat.ino,
      appendable: text.endsWith('\n'),
      collector,
      entries: collector.entries(),
      mentions: collector.mentions(),
    };
    if (this.cache.size >= 32 && !this.cache.has(key))
      this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, cached);
    return cached;
  }
  /** 本会话出现过的文件：写过的，加上读过与在回复里引用过的。 */
  async appearances(file, provider, cwd) {
    const { entries, mentions } = await this.list(file, provider, cwd, true);
    return { written: entries, mentioned: mentions };
  }
  async preview(entries, id, offset = 0) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw apiError(404, 'FILE_NOT_IN_SESSION', '这个文件不在当前会话的写入记录中。');
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw apiError(400, 'INVALID_OFFSET', '文件位置无效。');
    let handle;
    try {
      // Do not follow a recorded file if it has been replaced with a symlink.
      const info = await fs.lstat(entry.path);
      if (!info.isFile() || info.isSymbolicLink())
        throw apiError(400, 'UNSUPPORTED_FILE', '仅支持普通文件的只读预览。');
      handle = await fs.open(
        entry.path,
        require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) throw apiError(400, 'UNSUPPORTED_FILE', '仅支持普通文件。');
      const images = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      const mime = images[path.extname(entry.path).toLowerCase()];
      if (mime && stat.size <= 8 * 1024 * 1024)
        return {
          ...entry,
          kind: 'image',
          mime,
          data: (await handle.readFile()).toString('base64'),
          size: stat.size,
        };
      const size = Math.min(256 * 1024, Math.max(0, stat.size - offset));
      const buffer = Buffer.alloc(size),
        { bytesRead } = await handle.read(buffer, 0, size, offset);
      if (mime || buffer.subarray(0, bytesRead).includes(0))
        return { ...entry, kind: 'binary', size: stat.size };
      let end = bytesRead,
        content;
      for (let trim = 0; trim <= 3 && trim <= bytesRead; trim++) {
        try {
          end = bytesRead - trim;
          content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
          break;
        } catch {}
      }
      if (content === undefined) return { ...entry, kind: 'binary', size: stat.size };
      return {
        ...entry,
        kind: 'text',
        content,
        size: stat.size,
        offset,
        nextOffset: offset + end < stat.size ? offset + end : null,
      };
    } catch (error) {
      if (error.code === 'ENOENT') throw apiError(404, 'FILE_MISSING', '文件已删除或移动。');
      throw error;
    } finally {
      await handle?.close();
    }
  }
}
module.exports = { SessionFiles, collectFiles, commandPaths, writePaths };
