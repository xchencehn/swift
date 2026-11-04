'use strict';
const path = require('node:path');
const { WorkspaceFiles, EDIT_LIMIT } = require('../../workspace-files');
function register(router, { currentRoot, json, readJson, apiError, securityHeaders }) {
  const files = new WorkspaceFiles();
  function rootFor(url) {
    const root = currentRoot().data.directory;
    if (
      url.searchParams.has('root') &&
      path.resolve(url.searchParams.get('root')) !== path.resolve(root)
    )
      throw apiError(409, 'ROOT_CHANGED', '根目录已经改变，请重新打开文件。');
    return root;
  }
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
