'use strict';

// Office 在无网络、无用户目录的子进程中转为 PDF，PDF 每次只渲染一页。
// 原件只读；私有临时目录在成功、失败或超时后回收。缓存仅保存在有界内存中。
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { paginated } = require('../public/files/file-types');
const MAX_INPUT = 32 * 1024 * 1024,
  MAX_PDF = 64 * 1024 * 1024;
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function execute(command, args, { timeout = 60000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: '/work/home',
        TMPDIR: '/tmp',
        SAL_USE_VCLPLUGIN: 'svp',
      },
    });
    let output = '',
      length = 0,
      stopped = false;
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    };
    const timer = setTimeout(() => {
      stopped = true;
      kill();
    }, timeout);
    const collect = (bytes) => {
      length += bytes.length;
      if (length > 1024 * 1024) {
        stopped = true;
        kill();
      } else output += bytes.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? failure(503, 'PREVIEW_UNAVAILABLE', '执行端缺少文件预览组件，请下载原文件查看。')
          : error,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stopped)
        return reject(failure(504, 'PREVIEW_TIMEOUT', '文件预览超时，请重试或下载原文件查看。'));
      if (code !== 0)
        return reject(
          failure(
            422,
            'PREVIEW_FAILED',
            '文件无法预览，可能已损坏、加密或缺少预览组件。请下载原文件查看。',
          ),
        );
      resolve(output);
    });
  });
}

async function temporary(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-document-'));
  try {
    await fs.mkdir(path.join(directory, 'home'), { mode: 0o700 });
    return await action(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function readOutput(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > limit)
      throw failure(422, 'PREVIEW_FAILED', '无法生成文档预览，请下载原文件查看。');
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function sandbox(directory, command, args) {
  if (process.env.SWIFT_PREVIEW_HELPER_URL && process.env.SWIFT_PREVIEW_HELPER_KEY_FILE)
    return helper(directory, command, args);
  // 仅挂载运行库、字体和本次转换副本；不继承宿主 HOME、凭据、网络或其他文件。
  const mounts = [];
  for (const item of [
    '/usr',
    '/lib',
    '/lib64',
    '/etc/fonts',
    '/etc/libreoffice',
    '/etc/ld.so.cache',
    '/var/cache/fontconfig',
  ]) {
    try {
      await fs.access(item);
      mounts.push('--ro-bind', item, item);
    } catch {
      /* 平台可选路径 */
    }
  }
  return execute(
    'bwrap',
    [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      ...mounts,
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/sbin',
      '/sbin',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--bind',
      directory,
      '/work',
      '--chdir',
      '/work',
      '--',
      '/usr/bin/prlimit',
      '--as=2147483648',
      '--cpu=45',
      '--fsize=134217728',
      '--',
      command,
      ...args,
    ],
    { cwd: directory },
  );
}

async function helper(directory, command, args) {
  const name = path.basename(command);
  if (!['libreoffice', 'pdfinfo', 'pdftoppm', 'pdftotext'].includes(name))
    throw failure(503, 'PREVIEW_UNAVAILABLE', '文件预览组件不可用。');
  const input = name === 'libreoffice' ? path.basename(args[args.length - 1]) : 'document.pdf';
  if (!/^input\.[a-z0-9]+$/.test(input) && input !== 'document.pdf')
    throw failure(400, 'BAD_PREVIEW', '文件预览参数无效。');
  const bytes = await readOutput(path.join(directory, input), MAX_PDF);
  const payload = Buffer.from(
    JSON.stringify({
      command: name,
      extension: path.extname(input),
      page: ['pdftoppm', 'pdftotext'].includes(name)
        ? Number(args[args.indexOf('-f') + 1])
        : undefined,
      input: bytes.toString('base64'),
    }),
  );
  const token = (await fs.readFile(process.env.SWIFT_PREVIEW_HELPER_KEY_FILE, 'utf8')).trim();
  const endpoint = new URL('/run', process.env.SWIFT_PREVIEW_HELPER_URL);
  if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password)
    throw failure(503, 'PREVIEW_UNAVAILABLE', '文件预览服务配置无效。');
  const response = await new Promise((resolve, reject) => {
    // This private Docker bridge connection must never use the management proxy.
    const request = http.request(
      endpoint,
      {
        agent: new http.Agent({ keepAlive: false, proxyEnv: {} }),
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'content-length': payload.length,
        },
        timeout: 70000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (data) => {
          size += data.length;
          if (size > 90 * 1024 * 1024) res.destroy(new Error('Preview response too large'));
          else chunks.push(data);
        });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200)
            return reject(failure(422, 'PREVIEW_FAILED', '文件无法预览，请重试或下载原文件查看。'));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(failure(502, 'PREVIEW_FAILED', '文件预览服务响应无效。'));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('Preview timeout')));
    request.on('error', () =>
      reject(failure(503, 'PREVIEW_UNAVAILABLE', '文件预览服务暂时不可用，请重试。')),
    );
    request.end(payload);
  });
  if (name === 'libreoffice' || name === 'pdftoppm') {
    const output = Buffer.from(response.output || '', 'base64');
    if (!output.length || output.length > (name === 'pdftoppm' ? 16 * 1024 * 1024 : MAX_PDF))
      throw failure(422, 'PREVIEW_FAILED', '文件预览输出无效。');
    await fs.writeFile(
      path.join(directory, name === 'libreoffice' ? 'input.pdf' : 'page.png'),
      output,
      { mode: 0o600, flag: 'wx' },
    );
  }
  return String(response.text || '');
}

class DocumentPreview {
  constructor({ run = sandbox, maxBytes = MAX_PDF, maxEntries = 8 } = {}) {
    this.run = run;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.cache = new Map();
    this.bytes = 0;
    this.pending = 0;
    this.tail = Promise.resolve();
  }

  async serial(action) {
    if (this.pending >= 8) throw failure(503, 'PREVIEW_BUSY', '文件预览繁忙，请稍后重试。');
    this.pending++;
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await action();
    } finally {
      this.pending--;
      release();
    }
  }

  version(file) {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify([file.path, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs]),
      )
      .digest('hex');
  }

  async get(file) {
    if (!paginated(file.kind)) throw failure(415, 'NOT_DOCUMENT', '这种文件不支持分页预览。');
    if (file.size > MAX_INPUT)
      throw failure(413, 'TOO_LARGE', '文档超过 32 MB，请下载原文件查看。');
    const version = this.version(file);
    const cached = this.cache.get(version);
    if (cached) {
      this.cache.delete(version);
      this.cache.set(version, cached);
      return cached.promise;
    }
    const entry = {};
    entry.promise = this.serial(async () => {
      const handle = await fs.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.ino !== file.ino ||
          info.dev !== file.dev ||
          info.size !== file.size ||
          info.mtimeMs !== file.mtimeMs ||
          info.ctimeMs !== file.ctimeMs
        )
          throw failure(409, 'FILE_CHANGED', '文件已经改变，请重新打开。');
        // 使用已核验的描述符和固定长度，不因读取期间文件增长而无界分配。
        bytes = Buffer.alloc(file.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (
          offset !== bytes.length ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs
        )
          throw failure(409, 'FILE_CHANGED', '文件已经改变，请重新打开。');
      } finally {
        await handle.close();
      }
      const result = await temporary(async (directory) => {
        let pdf;
        if (file.kind === 'pdf') pdf = bytes;
        else {
          const input = 'input' + path.extname(file.path).toLowerCase();
          await fs.writeFile(path.join(directory, input), bytes, { mode: 0o600 });
          const profile = path.join(directory, 'profile/user');
          await fs.mkdir(profile, { recursive: true });
          await fs.writeFile(
            path.join(profile, 'registrymodifications.xcu'),
            '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item></oor:items>',
          );
          await this.run(directory, '/usr/bin/libreoffice', [
            '-env:UserInstallation=file:///work/profile',
            '--headless',
            '--norestore',
            '--nodefault',
            '--convert-to',
            'pdf',
            '--outdir',
            '/work',
            '/work/' + input,
          ]);
          try {
            pdf = await readOutput(path.join(directory, 'input.pdf'), MAX_PDF);
          } catch {
            throw failure(422, 'PREVIEW_FAILED', '无法生成文档预览，请下载原文件查看。');
          }
        }
        await fs.writeFile(path.join(directory, 'document.pdf'), pdf, { mode: 0o600 });
        const metadata = await this.run(directory, '/usr/bin/pdfinfo', ['/work/document.pdf']);
        const pages = Number(metadata.match(/^Pages:\s+(\d+)/m)?.[1]);
        if (!Number.isSafeInteger(pages) || pages < 1)
          throw failure(422, 'PREVIEW_FAILED', '无法读取文档页数，请下载原文件查看。');
        return { pdf, pages, version };
      });
      entry.size = result.pdf.length;
      this.bytes += entry.size;
      this.trim();
      return result;
    }).catch((error) => {
      this.cache.delete(version);
      throw error;
    });
    this.cache.set(version, entry);
    this.trim();
    return entry.promise;
  }

  trim() {
    for (const [key, entry] of this.cache) {
      if (this.bytes <= this.maxBytes && this.cache.size <= this.maxEntries) break;
      if (!entry.size) continue; // 正在转换的请求不逐出，以免重复启动。
      this.bytes -= entry.size;
      this.cache.delete(key);
    }
  }

  async document(file, page, version) {
    if (!Number.isSafeInteger(page) || page < 1) throw failure(400, 'BAD_PAGE', '页码无效。');
    const doc = await this.get(file);
    if (version !== doc.version) throw failure(409, 'FILE_CHANGED', '文件已经改变，请重新打开。');
    if (page > doc.pages) throw failure(400, 'BAD_PAGE', '页码超出文档范围。');
    return doc;
  }

  async text(file, page, version) {
    const doc = await this.document(file, page, version);
    return this.serial(() =>
      temporary(async (directory) => {
        await fs.writeFile(path.join(directory, 'document.pdf'), doc.pdf, { mode: 0o600 });
        return this.run(directory, '/usr/bin/pdftotext', [
          '-f',
          String(page),
          '-l',
          String(page),
          '-layout',
          '-nopgbrk',
          '/work/document.pdf',
          '-',
        ]);
      }),
    );
  }

  async page(file, page, version) {
    const doc = await this.document(file, page, version);
    return this.serial(() =>
      temporary(async (directory) => {
        await fs.writeFile(path.join(directory, 'document.pdf'), doc.pdf, { mode: 0o600 });
        await this.run(directory, '/usr/bin/pdftoppm', [
          '-f',
          String(page),
          '-l',
          String(page),
          '-singlefile',
          '-scale-to',
          '1600',
          '-png',
          '/work/document.pdf',
          '/work/page',
        ]);
        return readOutput(path.join(directory, 'page.png'), 16 * 1024 * 1024);
      }),
    );
  }
}

module.exports = { DocumentPreview, sandbox, helper };
