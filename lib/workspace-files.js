'use strict';
// Adapted from DeepSeek Harness workspace-files.list (MIT); see third_party/deepseek-harness.
const fs = require('node:fs/promises'),
  { constants } = require('node:fs');
const path = require('node:path'),
  crypto = require('node:crypto');
const { apiError } = require('./message-queue');
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const media = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const EDIT_LIMIT = 8 * 1024 * 1024;
const revisionOf = (stat, bytes) =>
  crypto
    .createHash('sha256')
    .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:`)
    .update(bytes)
    .digest('hex');
const secret = (file) =>
  file
    .split(path.sep)
    .some((part) =>
      /^(?:\.env(?:\..*)?|auth\.json|\.credentials(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|jks))$/i.test(
        part,
      ),
    ) || /(?:^|\/)\.local\/(?:config|state|data)(?:\/|$)/.test(file);
function kindOf(file) {
  const ext = path.extname(file).toLowerCase(),
    mime = media[ext];
  return mime
    ? { kind: mime.split('/')[0] === 'application' ? 'pdf' : mime.split('/')[0], mime }
    : {
        kind: /\.(?:md|markdown)$/i.test(file)
          ? 'markdown'
          : /\.html?$/i.test(file)
            ? 'html'
            : 'code',
        mime: 'text/plain; charset=utf-8',
      };
}
class WorkspaceFiles {
  constructor({ ttlMs = 1000, maxEntries = 2000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.cache = new Map();
    this.pending = new Map();
    this.writing = new Set();
  }
  async confine(directory, wanted = directory) {
    if (typeof wanted !== 'string' || !path.isAbsolute(wanted) || /[\0\r\n]/.test(wanted))
      throw apiError(400, 'INVALID_PATH', '文件路径无效。');
    const base = path.resolve(directory),
      file = path.resolve(wanted);
    if (!within(base, file)) throw apiError(403, 'OUTSIDE_ROOT', '这个路径不在当前根目录内。');
    try {
      const [root, real] = await Promise.all([fs.realpath(base), fs.realpath(file)]);
      if (!within(root, real)) throw apiError(403, 'OUTSIDE_ROOT', '符号链接指向当前根目录之外。');
      return { root, real, file, base };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code))
        throw apiError(404, 'NOT_FOUND', '文件已删除或移动。');
      if (['EACCES', 'EPERM'].includes(error.code))
        throw apiError(403, 'PERMISSION_DENIED', '没有权限读取这个路径。');
      throw error;
    }
  }
  async list(directory, wanted = directory) {
    const target = await this.confine(directory, wanted);
    if (secret(path.relative(target.base, target.file)))
      throw apiError(403, 'PRIVATE_FILE', '此目录包含私人配置，不能在文件浏览器中打开。');
    const info = await fs.stat(target.real);
    if (!info.isDirectory()) throw apiError(400, 'NOT_DIRECTORY', '这个路径不是目录。');
    const key = JSON.stringify([target.root, target.file, target.real]),
      version = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = this.cache.get(key);
    if (cached && cached.version === version && this.now() - cached.at < this.ttlMs)
      return cached.value;
    if (!this.pending.has(key)) {
      const task = (async () => {
        // Dirent avoids a stat call for every child. No recursive scan or file-body reads.
        const children = await fs.readdir(target.real, { withFileTypes: true });
        const fresh = await this.confine(directory, wanted),
          current = await fs.stat(fresh.real);
        if (fresh.real !== target.real || current.ino !== info.ino || current.dev !== info.dev)
          throw apiError(409, 'DIRECTORY_CHANGED', '目录已经改变，请重新展开。');
        children.sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) ||
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
        );
        const entries = children.slice(0, this.maxEntries).map((entry) => ({
          name: entry.name,
          type: secret(path.relative(target.base, path.join(target.file, entry.name)))
            ? 'other'
            : entry.isDirectory()
              ? 'directory'
              : entry.isFile()
                ? 'file'
                : 'other',
        }));
        const value = {
          root: target.base,
          path: target.file,
          entries,
          truncated: children.length > this.maxEntries,
        };
        value.revision = crypto
          .createHash('sha256')
          .update(JSON.stringify(value))
          .digest('hex')
          .slice(0, 20);
        this.cache.delete(key);
        this.cache.set(key, { version, at: this.now(), value });
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
        return value;
      })();
      this.pending.set(key, task);
      task.finally(() => this.pending.delete(key)).catch(() => {});
    }
    return this.pending.get(key);
  }
  async open(directory, wanted) {
    const target = await this.confine(directory, wanted);
    if (
      secret(path.relative(target.base, target.file)) ||
      secret(path.relative(target.root, target.real))
    )
      throw apiError(403, 'PRIVATE_FILE', '私人配置和凭据文件不能在文件浏览器中读取。');
    const info = await fs.lstat(target.file);
    if (!info.isFile() || info.isSymbolicLink())
      throw apiError(415, 'UNSUPPORTED_FILE', '仅支持普通文件。');
    const handle = await fs.open(target.real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fresh = await this.confine(directory, wanted),
        stat = await handle.stat();
      const current = await fs.stat(fresh.real);
      if (
        fresh.real !== target.real ||
        !stat.isFile() ||
        current.ino !== stat.ino ||
        current.dev !== stat.dev
      )
        throw apiError(409, 'FILE_CHANGED', '文件已经改变，请重新打开。');
      return { handle, stat, path: target.file, ...kindOf(target.file) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async content(directory, wanted, { full = false } = {}) {
    const file = await this.open(directory, wanted);
    try {
      const { kind, mime, stat } = file;
      if (media[path.extname(file.path).toLowerCase()])
        return { path: file.path, kind, mime, size: stat.size, mtime: stat.mtimeMs };
      const limit = full || kind === 'html' ? EDIT_LIMIT : 512 * 1024;
      if ((full || kind === 'html') && stat.size > limit)
        throw apiError(413, 'TOO_LARGE', '文件超过 8 MB，请下载后编辑。');
      const buffer = Buffer.alloc(Math.min(stat.size, limit));
      const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, 0),
        bytes = buffer.subarray(0, bytesRead);
      let text,
        length = bytes.length;
      if (!bytes.includes(0))
        for (let trim = 0; trim <= (stat.size > bytesRead ? 3 : 0); trim++) {
          try {
            length = bytes.length - trim;
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
              bytes.subarray(0, length),
            );
            break;
          } catch {}
        }
      const after = await file.handle.stat();
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw apiError(409, 'FILE_CHANGED', '文件正在被修改，请重新读取。');
      return {
        path: file.path,
        title: path.basename(file.path),
        kind: text === undefined ? 'binary' : kind,
        mime,
        size: stat.size,
        mtime: stat.mtimeMs,
        editable: text !== undefined && stat.size <= EDIT_LIMIT,
        ...(text === undefined
          ? {}
          : {
              text,
              truncated: stat.size > length,
              ...(stat.size === length ? { revision: revisionOf(stat, bytes) } : {}),
            }),
      };
    } finally {
      await file.handle.close();
    }
  }
  async write(directory, wanted, text, revision, validate = () => {}) {
    if (
      typeof text !== 'string' ||
      text.includes('\0') ||
      Buffer.from(text).toString('utf8') !== text
    )
      throw apiError(400, 'INVALID_TEXT', '仅支持有效的 UTF-8 文本。');
    if (Buffer.byteLength(text) > EDIT_LIMIT)
      throw apiError(413, 'TOO_LARGE', '文件超过 8 MB，请下载后编辑。');
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
      throw apiError(400, 'INVALID_REVISION', '请重新读取文件后再保存。');
    const target = await this.confine(directory, wanted),
      key = target.real;
    if (this.writing.has(key)) throw apiError(409, 'FILE_BUSY', '这个文件正在保存，请稍后核对。');
    this.writing.add(key);
    let temporary = null;
    try {
      const original = await this.content(directory, wanted, { full: true });
      if (!original.editable)
        throw apiError(415, 'UNSUPPORTED_FILE', '仅支持 UTF-8 文本文件编辑。');
      if (original.revision !== revision)
        throw apiError(
          409,
          'FILE_CHANGED',
          '文件已被其他程序修改。编辑内容已保留，请复制后刷新文件并合并修改。',
        );
      await fs.access(target.real, constants.W_OK);
      const file = await this.open(directory, wanted);
      let mode;
      try {
        mode = file.stat.mode & 0o777;
      } finally {
        await file.handle.close();
      }
      temporary = path.join(path.dirname(target.real), `.swift-edit-${crypto.randomUUID()}`);
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode,
      );
      try {
        await handle.writeFile(text, 'utf8');
        await handle.chmod(mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Recheck after preparing the replacement, so slow writes cannot overwrite an intervening edit.
      const current = await this.content(directory, wanted, { full: true });
      const fresh = await this.confine(directory, wanted);
      if (current.revision !== revision || fresh.real !== target.real)
        throw apiError(
          409,
          'FILE_CHANGED',
          '文件已被其他程序修改。编辑内容已保留，请复制后刷新文件并合并修改。',
        );
      validate();
      await fs.rename(temporary, target.real);
      temporary = null;
      return this.content(directory, wanted, { full: true });
    } catch (error) {
      if (['EACCES', 'EPERM', 'EROFS'].includes(error.code))
        throw apiError(403, 'PERMISSION_DENIED', '没有权限保存这个文件，编辑内容已保留。');
      throw error;
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      this.writing.delete(key);
    }
  }
}
module.exports = { WorkspaceFiles, kindOf, EDIT_LIMIT };
