'use strict';

// 会话文件面板的两栏：会话、搜索（docs/PRODUCT_SPEC.md 2.4）。
//
// 列出文档、图片与音视频；代码仍只通过文档链接打开。
// 全程只读，一个字节都不写。

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// CSV 测试结果仍不纳入材料列表。文件类型在两端共用。
const { KINDS, MIME, LABELS } = require('../public/files/file-types');
// 扩展名是 .txt 的构建与依赖清单，不是给人读的文档。
const NOT_DOCS =
  /^(cmakelists|requirements[\w.-]*|constraints|licen[cs]e|copying|notice|robots)\.txt$/i;
const listable = (file) => Boolean(kindOf(file));
const kindOf = (file) => {
  const name = path.basename(String(file || ''));
  return NOT_DOCS.test(name) ? null : KINDS[path.extname(name).toLowerCase()] || null;
};
const stat = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};

// ——— 标题与摘要 ————————————————————————————————————————————————————————————

/** 行内 Markdown 标记剥成纯文字：`[开发计划](../plan.md)` 只留「开发计划」。 */
function plainInline(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>\n]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 头一句：到第一个句末标点为止，太长就按字数截。 */
function firstSentence(text, limit = 90) {
  const clean = String(text || '').trim();
  // 中文句末标点后面通常不跟空格；英文的要跟空格，免得把 3.14、v0.9 切开。
  const end = clean.search(/[。！？；]|[.!?;](?=\s|$)/);
  const sentence = end >= 0 ? clean.slice(0, end + 1) : clean;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence;
}

/**
 * Markdown 的标题与正文头一句。
 *
 * 标题读第一行 `# `，不用文件名 —— `README.md`、`results.md` 各有几百个，文件名分辨
 * 不出任何东西。摘要跳过 front matter、标题、代码块、表格、分隔线与 HTML 注释。
 */
function markdownHead(source) {
  const lines = String(source || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let i = 0,
    title = null,
    summary = null,
    fence = null,
    comment = false;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    i++;
  }
  for (; i < lines.length && (title === null || summary === null); i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    const open = trimmed.match(/^(```+|~~~+)/);
    if (open) {
      fence = open[1];
      continue;
    }
    if (comment) {
      if (trimmed.includes('-->')) comment = false;
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) comment = true;
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      if (title === null && heading[1] === '#') title = plainInline(heading[2]);
      continue;
    }
    if (!trimmed || /^(\||[-*_=]{3,}$|\[[^\]]+\]:)/.test(trimmed)) continue;
    const body = plainInline(
      trimmed.replace(/^(>\s*)+/, '').replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ''),
    );
    if (body && summary === null) summary = firstSentence(body);
  }
  return { title, summary };
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 标题与摘要按「路径 + 修改时间 + 大小」缓存：同一份文件没变就不再读。
 * 这不是索引 —— 列表每次都现扫，缓存的只是读过的开头。
 */
class Summaries {
  constructor({ limit = 4000 } = {}) {
    this.cache = new Map();
    this.limit = limit;
  }

  describe(file, relativeTo = null) {
    const info = stat(file);
    const kind = kindOf(file);
    if (!info?.isFile() || !kind) return null;
    const key = `${file}\0${info.mtimeMs}\0${info.size}`;
    let head = this.cache.get(key);
    if (!head) {
      head = this.read(file, kind, info);
      this.cache.set(key, head);
      if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
    }
    const directory = path.dirname(relativeTo ? path.relative(relativeTo, file) || '.' : file);
    const summary =
      head.summary ??
      (kind === 'image' ? `图片 · ${directory}` : `${LABELS[kind]} · ${humanSize(info.size)}`);
    return {
      path: file,
      name: path.basename(file),
      kind,
      title: head.title || path.basename(file),
      summary,
      mtime: Math.round(info.mtimeMs),
      size: info.size,
    };
  }

  read(file, kind, info) {
    if (kind !== 'markdown' && kind !== 'text') return { title: null, summary: null };
    let text = '';
    try {
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(info.size, 16 * 1024));
        fs.readSync(handle, buffer, 0, buffer.length, 0);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return { title: null, summary: null };
    }
    if (kind === 'markdown') return markdownHead(text);
    const first = text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    return { title: null, summary: first ? firstSentence(first) : null };
  }
}

// ——— 搜索 ————————————————————————————————————————————————————————————

/**
 * 路径模糊匹配：查询按空白切成几段，每段都要按顺序出现在路径里（子序列）。
 * 连续命中、命中在文件名里、命中在词首的得分高；路径越短越靠前。
 */
function fuzzyScore(query, candidate) {
  const target = candidate.toLowerCase();
  const name = path.basename(target);
  const nameStart = target.length - name.length;
  let total = 0;
  for (const term of String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)) {
    const direct = target.lastIndexOf(term);
    if (direct >= 0) {
      total +=
        100 +
        term.length * 4 +
        (direct >= nameStart ? 60 : 0) +
        (/[/._-]/.test(target[direct - 1] || '/') ? 20 : 0);
      continue;
    }
    let at = -1,
      score = 0,
      run = 0;
    for (const ch of term) {
      const next = target.indexOf(ch, at + 1);
      if (next < 0) return 0;
      run = next === at + 1 ? run + 1 : 0;
      score +=
        1 +
        run * 3 +
        (/[/._-]/.test(target[next - 1] || '/') ? 4 : 0) +
        (next >= nameStart ? 2 : 0);
      at = next;
    }
    total += score;
  }
  return total ? total - target.length * 0.05 : 0;
}

/**
 * 一个目录下所有可阅读文件的列表，给搜索用。
 *
 * git 仓库用 `git ls-files`（受 .gitignore 约束，compete 5.6 万个文件 450ms），不是仓库
 * 就遍历。列表缓存 60 秒：每敲一个字都要搜一次，每次都重列一遍是白花。
 */
class FileLists {
  constructor({ ttlMs = 60000, now = Date.now } = {}) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async list(directory) {
    const cached = this.cache.get(directory);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.promise;
    const promise = this.read(directory).catch((error) => {
      this.cache.delete(directory);
      throw error;
    });
    this.cache.set(directory, { at: this.now(), promise });
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }

  read(directory) {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['-C', directory, 'ls-files', '-co', '--exclude-standard', '-z'],
        { maxBuffer: 256 * 1024 * 1024 },
        (error, stdout) => {
          if (error) return resolve(walk(directory, { limit: 200000 }));
          resolve(
            stdout
              .split('\0')
              .filter((name) => name && listable(name))
              .map((name) => path.join(directory, name)),
          );
        },
      );
    });
  }
}

// 非 Git 目录仍可搜索材料；不跟随目录链接，并限制遍历工作量。
async function walk(directory, { limit }) {
  const files = [],
    pending = [directory];
  let visited = 0;
  while (pending.length && visited < limit) {
    let entries;
    try {
      entries = await fs.promises.readdir(pending.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > limit) break;
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        pending.push(file);
      else if (entry.isFile() && listable(file)) files.push(file);
    }
  }
  return files;
}

// ——— 读取 ———————————————————————————————————————————————————————————————————

/**
 * 解析并核对一个要读的文件：必须是可阅读的类型、落在工作根目录之内、不是符号链接。
 * 越界、类型不对、不存在都返回 null，由调用方报 404。
 */
function safeFile(root, file, { anyText = false } = {}) {
  // 列表只收文档与图片（kindOf）；从文档里点进来的链接可以是代码，那时 anyText 放开类型，
  // 由读取方再挡掉二进制。根目录之内、不跟符号链接这两条不变。
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    /[\0\r\n]/.test(file) ||
    (!kindOf(file) && !anyText)
  )
    return null;
  let real, base;
  try {
    real = fs.realpathSync(file);
    base = fs.realpathSync(root);
  } catch {
    return null;
  }
  if (real !== path.resolve(file)) return null;
  if (!(real === base || real.startsWith(base + path.sep))) return null;
  const info = stat(real);
  return info?.isFile()
    ? {
        path: real,
        kind: kindOf(real) || 'code',
        mime: MIME[path.extname(real).toLowerCase()] || 'text/plain; charset=utf-8',
        size: info.size,
        mtime: Math.round(info.mtimeMs),
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: info.ino,
        dev: info.dev,
      }
    : null;
}

/** 按真实路径去重：软链与它指向的文件是同一份（CLAUDE.md → AGENTS.md 曾经各列一次，2026-09-24）。读不到的原样保留。 */
function uniqueReal(files) {
  const real = (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return file;
    }
  };
  return [...new Set(files.map(real))];
}

module.exports = {
  KINDS,
  kindOf,
  listable,
  plainInline,
  firstSentence,
  markdownHead,
  Summaries,
  fuzzyScore,
  FileLists,
  safeFile,
  uniqueReal,
};
