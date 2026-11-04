'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

function createFrontendAssets(directory) {
  const compressed = new Map();
  let startupCache;
  const startupPattern = /<!-- APP_SCRIPTS_START -->([\s\S]*?)<!-- APP_SCRIPTS_END -->/;
  // Per-file versions keep an unrelated asset change from invalidating every resource.
  function fileVersion(relative) {
    const stat = fs.statSync(path.join(directory, relative), { throwIfNoEntry: false });
    if (!stat?.isFile()) return version();
    return crypto
      .createHash('sha256')
      .update(JSON.stringify([relative, stat.size, stat.mtimeMs, stat.ctimeMs]))
      .digest('hex')
      .slice(0, 16);
  }
  // 整体版本：前端据此发现「有新版本」。
  function version() {
    const hash = crypto.createHash('sha256');
    const visit = (relative) => {
      for (const entry of fs
        .readdirSync(path.join(directory, relative), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile()) {
          const stat = fs.statSync(path.join(directory, name));
          hash.update(JSON.stringify([name, stat.size, stat.mtimeMs, stat.ctimeMs]));
        }
      }
    };
    visit('');
    return hash.digest('hex').slice(0, 20);
  }
  function gzip(file, data) {
    const cached = compressed.get(file);
    // HTML 模板本身没变，替换进去的资源版本也可能已变。按最终字节复用压缩结果。
    if (cached && cached.data.equals(data)) return cached.gzip;
    const value = zlib.gzipSync(data, { level: 6 });
    compressed.set(file, { data: Buffer.from(data), gzip: value });
    return value;
  }
  function startup() {
    const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
    const block = startupPattern.exec(html);
    if (!block) return null;
    const files = [
      ...block[1].matchAll(/<script src="([^"?]+)\?v=__ASSET_VERSION__"><\/script>/g),
    ].map((match) => match[1]);
    if (
      !files.length ||
      block[1].replace(/<script src="[^"?]+\?v=__ASSET_VERSION__"><\/script>/g, '').trim()
    )
      throw new Error('Startup bundle must contain only ordered classic scripts');
    for (const file of files)
      if (file.startsWith('/') || file.split('/').includes('..') || !file.endsWith('.js'))
        throw new Error('Invalid startup script');
    const signature = JSON.stringify(files.map((file) => [file, fileVersion(file)]));
    if (startupCache?.signature === signature) return startupCache;
    const data = Buffer.from(
      files
        .map((file) => `;\n/* ${file} */\n${fs.readFileSync(path.join(directory, file), 'utf8')}\n`)
        .join(''),
    );
    startupCache = {
      signature,
      data,
      files,
      version: crypto.createHash('sha256').update(data).digest('hex').slice(0, 20),
    };
    return startupCache;
  }
  function bundleHtml(html) {
    const bundle = startup();
    return bundle
      ? html.replace(
          startupPattern,
          `<script src="assets/startup.js?v=${bundle.version}"></script>`,
        )
      : html;
  }
  return { version, fileVersion, gzip, startup, bundleHtml };
}
module.exports = { createFrontendAssets };
