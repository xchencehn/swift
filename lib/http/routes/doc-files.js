'use strict';

// 会话文件面板的两栏：会话、搜索（docs/PRODUCT_SPEC.md 2.4）。全是读。
// 范围是会话所在工作区的目录（一个工作区就是一个目录）；会话直接落在根目录时，是根目录下的全部工作区。

const fs = require('node:fs');
const path = require('node:path');
const {
  Summaries,
  FileLists,
  fuzzyScore,
  safeFile,
  listable,
  uniqueReal,
} = require('../../doc-files');
const { DocumentPreview } = require('../../document-preview');
const { paginated } = require('../../../public/files/file-types');

const summaries = new Summaries();
const fileLists = new FileLists();
const byTime = (a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path);

// 先按修改时间排好，只给最新的 limit 个读标题：一屏只看得到十几条。
const describeAll = (files, base, limit = 300) =>
  files
    .map((file) => ({ file, mtime: fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs || 0 }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((item) => summaries.describe(item.file, base))
    .filter(Boolean);

/**
 * 一个会话涉及的文档（文件页那个列表）。路由与同步中心（lib/sync/hub.js）共用。
 * @param {object} args
 *   sessionFiles   根目录的 SessionFiles（按存档解析出现过的文件）
 *   transcript     { file, provider }，没有存档时为 null
 *   cwd            会话目录；workspace 所在工作区目录（落在根目录时为 null）；rootDirectory 根目录
 */
async function sessionDocuments({ sessionFiles, transcript, cwd, workspace, rootDirectory }) {
  let seen = { written: [], mentioned: [] };
  if (transcript) {
    try {
      seen = await sessionFiles.appearances(
        await (typeof transcript.file === 'function' ? transcript.file() : transcript.file),
        transcript.provider,
        cwd,
      );
    } catch (error) {
      if (!['ENOENT', 'TRANSCRIPT_NOT_FOUND'].includes(error.code)) throw error;
    }
  }
  const paths = uniqueReal(
    [...seen.written.map((file) => file.path), ...seen.mentioned.map((file) => file.path)].filter(
      listable,
    ),
  );
  return describeAll(paths, workspace || rootDirectory).sort(byTime);
}

function register(router, ctx) {
  const { currentRoot, exactPane, paneTranscriptFile, json, apiError, securityHeaders, herdr } =
    ctx;
  const rootDirectory = () => currentRoot().data.directory;
  const same = (a, b) => path.resolve(a) === path.resolve(b);
  const previews = ctx.documentPreview || new DocumentPreview();

  /**
   * 会话、它的工作目录，以及它所在工作区的目录。会话直接落在根目录（所在工作区就是根目录那一个）时
   * workspace 为 null。
   */
  async function context(url) {
    // 归档里的会话已经没有 pane（2026-09-25 用户要求：归档会话左滑也要能看它涉及的文件）。
    // 用 `archived=<provider>:<sessionId>` 指明，存档与目录都取自归档记录；只读，与活着的会话同一套规则。
    const archived = url.searchParams.get('archived');
    if (archived) {
      const [provider, ...rest] = archived.split(':');
      const entry = await currentRoot().history.find(provider, rest.join(':'));
      const cwd = entry.cwd || rootDirectory();
      // 所在工作区：目录包含这个会话目录的那个（取最深的一个），落在根目录下就是 null。
      const workspace =
        (await herdr.dashboard()).workspaces
          .map((item) => item.cwd)
          .filter(
            (dir) =>
              dir &&
              !same(dir, rootDirectory()) &&
              !path.relative(dir, cwd).startsWith('..') &&
              !path.isAbsolute(path.relative(dir, cwd)),
          )
          .sort((a, b) => b.length - a.length)[0] || null;
      return { transcript: { file: entry.file, provider: entry.provider }, cwd, workspace };
    }
    const pane = await exactPane(url.searchParams.get('pane'));
    if (
      url.searchParams.has('sessionId') &&
      url.searchParams.get('sessionId') !== (pane.agent?.session?.value || '')
    )
      throw apiError(409, 'SESSION_CHANGED', '会话已改变，请重新打开文件。');
    const cwd = pane.baseCwd || pane.cwd || rootDirectory();
    const workspace = (await herdr.dashboard()).workspaces.find(
      (item) => item.workspaceId === pane.workspaceId,
    );
    const directory =
      workspace?.cwd && !same(workspace.cwd, rootDirectory()) ? workspace.cwd : null;
    const transcript =
      pane.agent?.session?.value && ['codex', 'claude'].includes(pane.agent?.label)
        ? { file: () => paneTranscriptFile(pane), provider: pane.agent.label }
        : null;
    return { transcript, cwd, workspace: directory };
  }

  router.get('/api/doc-files', async (req, res, url) => {
    const { transcript, cwd, workspace } = await context(url);
    const tab = url.searchParams.get('tab') || 'session';
    if (tab !== 'session') throw apiError(400, 'BAD_REQUEST', '没有这一栏。');
    const files = await sessionDocuments({
      sessionFiles: currentRoot().sessionFiles,
      transcript,
      cwd,
      workspace,
      rootDirectory: rootDirectory(),
    });
    return json(res, 200, { ok: true, tab, files });
  });

  /**
   * 按路径模糊匹配。范围是会话所在工作区的目录；会话直接落在根目录，就搜根目录下的全部工作区。
   */
  router.get('/api/doc-files/search', async (req, res, url) => {
    const { workspace } = await context(url);
    const query = String(url.searchParams.get('q') || '')
      .trim()
      .slice(0, 200);
    if (!query) return json(res, 200, { ok: true, query, files: [] });
    const root = rootDirectory();
    const scopes = workspace
      ? [workspace]
      : [
          ...new Set(
            (await herdr.dashboard()).workspaces
              .map((item) => item.cwd)
              .filter(
                (dir) => dir && !same(dir, root) && !path.relative(root, dir).startsWith('..'),
              ),
          ),
        ];
    const lists = await Promise.all(
      scopes.map((scope) =>
        fileLists.list(scope).then((files) => files.map((file) => ({ file, scope }))),
      ),
    );
    const ranked = [];
    for (const { file, scope } of lists.flat()) {
      const score = fuzzyScore(query, path.relative(workspace ? scope : root, file));
      if (score > 0) ranked.push({ file, scope, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    const files = ranked
      .slice(0, 50)
      .map((item) => summaries.describe(item.file, workspace ? item.scope : root))
      .filter(Boolean);
    return json(res, 200, { ok: true, query, total: ranked.length, files });
  });

  router.get('/api/doc-files/content', async (req, res, url) => {
    await context(url);
    const file = safeFile(rootDirectory(), url.searchParams.get('path'), { anyText: true });
    if (!file) throw apiError(404, 'NOT_FOUND', '没有这份材料，或它不在工作目录之内。');
    if (!['markdown', 'text', 'code', 'html'].includes(file.kind))
      throw apiError(415, 'NOT_TEXT', '这份材料不是文本。');
    // HTML 必须完整加载，否则截断的样式或脚本会把损坏的页面伪装成预览成功。
    const limit = file.kind === 'html' ? 8 * 1024 * 1024 : 512 * 1024;
    if (file.kind === 'html' && file.size > limit)
      throw apiError(413, 'TOO_LARGE', 'HTML 超过 8 MB，请下载后查看。');
    const handle = fs.openSync(file.path, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(Math.min(file.size, limit));
      fs.readSync(handle, buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, 8192).includes(0))
        throw apiError(415, 'BINARY_FILE', '这是二进制文件，不在这里显示。');
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
    const head = summaries.describe(file.path);
    return json(res, 200, {
      ok: true,
      path: file.path,
      kind: file.kind,
      title: head?.title || path.basename(file.path),
      mtime: file.mtime,
      size: file.size,
      truncated: file.size > limit,
      text,
    });
  });

  // Download original bytes, including archives and binary output. Preview
  // restrictions stay separate; the existing root and symlink boundary applies.
  router.get('/api/doc-files/download', async (req, res, url) => {
    await context(url);
    const file = safeFile(rootDirectory(), url.searchParams.get('path'), { anyText: true });
    if (!file) throw apiError(404, 'NOT_FOUND', '文件不存在，或不在工作目录之内。');
    let fd;
    try {
      fd = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const info = fs.fstatSync(fd),
        fresh = safeFile(rootDirectory(), file.path, { anyText: true });
      const current = fresh && fs.statSync(fresh.path);
      if (!info.isFile() || !current || current.ino !== info.ino || current.dev !== info.dev)
        throw apiError(409, 'FILE_CHANGED', '文件已经改变，请重新打开后下载。');
      if (info.size > 64 * 1024 * 1024)
        throw apiError(413, 'TOO_LARGE', '文件超过 64 MB，无法在这里保存。');
      res.writeHead(
        200,
        securityHeaders({
          'content-type': 'application/octet-stream',
          'content-length': info.size,
          'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}`,
          'cache-control': 'private, no-store',
          'content-security-policy': 'sandbox',
        }),
      );
      const stream = fs.createReadStream(file.path, { fd, autoClose: true });
      fd = undefined;
      stream.on('error', (error) => res.destroy(error));
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });

  // 分页预览的所有请求均重新核验会话、根目录及文件身份。页码请求不能跳过原件授权。
  router.get('/api/doc-files/preview', async (req, res, url) => {
    await context(url);
    const file = safeFile(rootDirectory(), url.searchParams.get('path'));
    if (!file || !paginated(file.kind))
      throw apiError(404, 'NOT_FOUND', '文件不存在，或不支持文档预览。');
    const doc = await previews.get(file);
    await context(url);
    return json(res, 200, { ok: true, pages: doc.pages, version: doc.version });
  });
  router.get('/api/doc-files/page', async (req, res, url) => {
    await context(url);
    const file = safeFile(rootDirectory(), url.searchParams.get('path'));
    if (!file || !paginated(file.kind))
      throw apiError(404, 'NOT_FOUND', '文件不存在，或不支持文档预览。');
    const bytes = await previews.page(
      file,
      Number(url.searchParams.get('page')),
      url.searchParams.get('version'),
    );
    await context(url);
    res.writeHead(
      200,
      securityHeaders({
        'content-type': 'image/png',
        'content-length': bytes.length,
        'cache-control': 'private, no-store',
      }),
    );
    res.end(bytes);
  });
  router.get('/api/doc-files/text', async (req, res, url) => {
    await context(url);
    const file = safeFile(rootDirectory(), url.searchParams.get('path'));
    if (!file || !paginated(file.kind))
      throw apiError(404, 'NOT_FOUND', '文件不存在，或不支持文档预览。');
    const text = await previews.text(
      file,
      Number(url.searchParams.get('page')),
      url.searchParams.get('version'),
    );
    await context(url);
    return json(res, 200, { ok: true, text });
  });

  /** 图片、音视频与 PDF 的原始字节。前端认证取成 blob，不在 URL 放凭据。 */
  router.get('/api/doc-files/raw', async (req, res, url) => {
    await context(url);
    const file = safeFile(rootDirectory(), url.searchParams.get('path'));
    if (!file || !['image', 'pdf', 'audio', 'video'].includes(file.kind))
      throw apiError(404, 'NOT_FOUND', '没有这份材料，或它不在工作目录之内。');
    const limit = ['audio', 'video'].includes(file.kind) ? 64 : 32;
    if (file.size > limit * 1024 * 1024)
      throw apiError(413, 'TOO_LARGE', `文件超过 ${limit} MB，请下载原文件查看。`);
    const fd = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const info = fs.fstatSync(fd);
      if (
        !info.isFile() ||
        info.ino !== file.ino ||
        info.dev !== file.dev ||
        info.size !== file.size
      )
        throw apiError(409, 'FILE_CHANGED', '文件已经改变，请重新打开。');
      bytes = Buffer.alloc(file.size);
      fs.readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    // SVG 可以带脚本：即便被当成页面直接打开，也只能在沙箱里。
    res.writeHead(
      200,
      securityHeaders({
        'content-type': file.mime,
        'content-length': bytes.length,
        'cache-control': 'private, no-cache',
        'content-security-policy': 'sandbox',
      }),
    );
    return res.end(bytes);
  });
}

module.exports = { register, sessionDocuments };
