'use strict';
const path = require('node:path');
const { WorkspaceFiles, EDIT_LIMIT } = require('../../workspace-files');
const { DocumentPreview } = require('../../document-preview');
const { paginated } = require('../../../public/files/file-types');
function register(
  router,
  { currentRoot, json, readJson, apiError, securityHeaders, documentPreview },
) {
  const files = new WorkspaceFiles();
  const previews = documentPreview || new DocumentPreview();
  function rootFor(url) {
    const root = currentRoot().data.directory;
    if (
      url.searchParams.has('root') &&
      path.resolve(url.searchParams.get('root')) !== path.resolve(root)
    )
      throw apiError(409, 'ROOT_CHANGED', '根目录已经改变，请重新打开文件。');
    return root;
  }
  async function previewFile(url) {
    const file = await files.open(rootFor(url), url.searchParams.get('path'));
    try {
      if (!paginated(file.kind)) throw apiError(415, 'NOT_DOCUMENT', '这种文件不支持分页预览。');
      return { ...file.stat, path: file.path, kind: file.kind };
    } finally {
      await file.handle.close();
    }
  }
  for (const action of ['preview', 'page', 'text'])
    router.get(`/api/workspace-files/${action}`, async (req, res, url) => {
      const file = await previewFile(url);
      const page = Number(url.searchParams.get('page')),
        version = url.searchParams.get('version');
      const value = await (action === 'preview'
        ? previews.get(file)
        : action === 'page'
          ? previews.page(file, page, version)
          : previews.text(file, page, version));
      rootFor(url);
      if (action === 'page') {
        res.writeHead(
          200,
          securityHeaders({
            'content-type': 'image/png',
            'content-length': value.length,
            'cache-control': 'private, no-store',
          }),
        );
        return res.end(value);
      }
      return json(
        res,
        200,
        action === 'preview'
          ? { ok: true, pages: value.pages, version: value.version }
          : { ok: true, text: value },
      );
    });
  router.get('/api/workspace-files/list', async (req, res, url) => {
    const root = rootFor(url),
      value = await files.list(root, url.searchParams.get('path') || root);
    rootFor(url);
    return json(res, 200, { ok: true, ...value });
  });
  router.get('/api/workspace-files/content', async (req, res, url) => {
    const root = rootFor(url),
      value = await files.content(root, url.searchParams.get('path'), {
        full: url.searchParams.get('full') === '1',
      });
    rootFor(url);
    return json(res, 200, { ok: true, ...value });
  });
  router.post('/api/workspace-files/content', async (req, res, url) => {
    const root = rootFor(url);
    const payload = await readJson(req, { maxBytes: EDIT_LIMIT * 6 + 4096 });
    rootFor(url);
    const value = await files.write(
      root,
      url.searchParams.get('path'),
      payload.text,
      payload.revision,
      () => rootFor(url),
    );
    return json(res, 200, { ok: true, ...value });
  });
  router.get(
    ['/api/workspace-files/raw', '/api/workspace-files/download'],
    async (req, res, url) => {
      const file = await files.open(rootFor(url), url.searchParams.get('path'));
      try {
        const download = url.pathname.endsWith('/download'),
          max = (download ? 64 : 32) * 1024 * 1024;
        if (file.stat.size > max)
          throw apiError(
            413,
            'TOO_LARGE',
            `文件超过 ${max / 1024 / 1024} MB，无法在这里${download ? '保存' : '预览'}。`,
          );
        rootFor(url);
        res.writeHead(
          200,
          securityHeaders({
            'content-type': download ? 'application/octet-stream' : file.mime,
            'content-length': file.stat.size,
            'content-security-policy': "sandbox; default-src 'none'",
            'cache-control': 'private, no-store',
            ...(download
              ? {
                  'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}`,
                }
              : {}),
          }),
        );
        await new Promise((resolve, reject) => {
          const stream = file.handle.createReadStream({ autoClose: false });
          stream.on('error', reject);
          res.on('close', () => {
            stream.destroy();
            resolve();
          });
          stream.on('end', resolve);
          stream.pipe(res);
        });
      } finally {
        await file.handle.close();
      }
    },
  );
}
module.exports = { register };
