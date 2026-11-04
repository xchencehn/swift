'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { json, securityHeaders } = require('./index');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function createStaticHandler({
  directory: PUBLIC_DIR,
  basePath: BASE_PATH,
  token: TOKEN,
  getSettings,
}) {
  // 可压缩的文本类型。图片、字体本身已是压缩格式,再压只是白费 CPU。
  const COMPRESSIBLE_EXTENSIONS = new Set([
    '.html',
    '.js',
    '.css',
    '.json',
    '.svg',
    '.webmanifest',
    '.txt',
    '.map',
  ]);
  // 前端版本覆盖 public 下的所有资源；压缩缓存按最终响应内容失效。
  const frontendAssets = require('../frontend-assets').createFrontendAssets(PUBLIC_DIR);
  const assetVersion = frontendAssets.version;

  function safeStaticPath(urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const resolved = path.resolve(PUBLIC_DIR, relative);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
    return resolved;
  }

  // 地址里的版本号与文件当前版本一致，这个地址的内容就永远不会变，可以一直缓存；
  // 不一致（旧页面拿旧地址来要）或没带版本号的，每次都要回源确认。
  function cacheControl(ext, file, url) {
    if (ext === '.html') return 'no-store';
    if (path.basename(file) === 'sw.js' || !url.searchParams.has('v')) return 'no-cache';
    const relative = path.relative(PUBLIC_DIR, file).split(path.sep).join('/');
    return url.searchParams.get('v') === frontendAssets.fileVersion(relative)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
  }

  function serveStatic(req, res, url) {
    if (url.pathname === '/frontend-version.json') {
      return json(res, 200, { version: assetVersion() }, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/assets/startup.js') {
      const bundle = frontendAssets.startup();
      if (!bundle) {
        res.writeHead(404);
        return res.end();
      }
      return respond(req, res, url, 'assets/startup.js', bundle.data, '.js', bundle.version);
    }
    const file = safeStaticPath(url.pathname);
    if (!file) {
      res.writeHead(403, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      return res.end('Forbidden');
    }
    fs.stat(file, (statError, stat) => {
      if (statError || !stat.isFile()) {
        res.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('Not found');
      }
      fs.readFile(file, (error, data) => {
        if (error) {
          res.writeHead(500, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
          return res.end('Read failed');
        }
        respond(req, res, url, file, data, path.extname(file));
      });
    });
  }

  function respond(req, res, url, file, data, ext, bundleVersion) {
    if (ext === '.html') {
      data = Buffer.from(
        frontendAssets
          .bundleHtml(data.toString('utf8'))
          .replaceAll('__AGENT_STUDIO_BASE_PATH__', BASE_PATH)
          // 资源引用各带自己的版本号；其余占位（页面元信息里的整体版本）仍是整体版本。
          .replace(
            /((?:src|href)=")([^"?#]+)\?v=__ASSET_VERSION__"/g,
            (_, head, asset) => `${head}${asset}?v=${frontendAssets.fileVersion(asset)}"`,
          )
          .replaceAll('__ASSET_VERSION__', assetVersion())
          .replaceAll(
            '__ROOT_SETTINGS__',
            JSON.stringify(getSettings(req))
              .replaceAll('&', '&amp;')
              .replaceAll('\"', '&quot;')
              .replaceAll('<', '&lt;'),
          ),
      );
    }
    // 静态资源此前一律裸传。当年最大的一笔是 vendor 里的 xterm.js 与 addon-webgl.js
    // (390 KB),它们随网页终端视图一起删掉了;剩下的脚本与样式 gzip 后通常只剩
    // 三分之一,在公网入口那条一个往返就 30 ms 起的链路上仍然值得压。
    const acceptsGzip = /(^|,)\s*gzip\s*(;|,|$)/i.test(req.headers['accept-encoding'] || '');
    let body = data;
    let contentEncoding = null;
    if (acceptsGzip && COMPRESSIBLE_EXTENSIONS.has(ext) && data.length >= 1024) {
      body = frontendAssets.gzip(file, data);
      contentEncoding = 'gzip';
    }
    const headers = securityHeaders({
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': bundleVersion
        ? url.searchParams.get('v') === bundleVersion
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
        : cacheControl(ext, file, url),
      etag: `W/"${crypto.createHash('sha256').update(data).digest('hex')}"`,
      // 同一 URL 会有压缩和未压缩两种响应,不声明 Vary 会被中间缓存串味。
      vary: 'Accept-Encoding',
    });
    if (file === path.join(PUBLIC_DIR, 'files/html-preview.html')) {
      headers['content-security-policy'] = fs
        .readFileSync(path.join(PUBLIC_DIR, 'files/html-preview.csp'), 'utf8')
        .trim();
      headers['x-frame-options'] = 'SAMEORIGIN';
    }
    if (ext === '.html' && path.basename(file) === 'index.html') {
      headers['x-frame-options'] = 'SAMEORIGIN';
      headers['content-security-policy'] += "; frame-ancestors 'self'";
    }
    if (ext !== '.html' && req.headers['if-none-match'] === headers.etag) {
      delete headers['content-length'];
      res.writeHead(304, headers);
      return res.end();
    }
    if (contentEncoding) headers['content-encoding'] = contentEncoding;
    if (ext === '.html' && url.searchParams.get('token') === TOKEN) {
      headers['set-cookie'] =
        `agentStudioToken=${encodeURIComponent(TOKEN)}; Path=${BASE_PATH || '/'}; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return serveStatic;
}
module.exports = { createStaticHandler };
