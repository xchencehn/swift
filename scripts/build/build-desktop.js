'use strict';
// The desktop ships the same front end, without server code or private state.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..'),
  destination = path.join(root, 'desktop/dist');
const { createFrontendAssets } = require('../../lib/frontend-assets');
fs.mkdirSync(destination, { recursive: true });
const expected = new Set();
function write(filename, data) {
  data = Buffer.isBuffer(data) ? data : Buffer.from(data);
  expected.add(filename);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (!fs.existsSync(filename) || !fs.readFileSync(filename).equals(data))
    fs.writeFileSync(filename, data);
}
function copy(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Desktop resources must not contain symbolic links.');
    if (entry.isDirectory()) copy(from, to);
    else if (entry.isFile() && to !== path.join(destination, 'public/index.html'))
      write(to, fs.readFileSync(from));
  }
}
copy(path.join(root, 'public'), path.join(destination, 'public'));
copy(path.join(root, 'desktop/ui'), path.join(destination, 'desktop'));
const assets = createFrontendAssets(path.join(root, 'public')),
  bundle = assets.startup();
fs.mkdirSync(path.join(destination, 'public/assets'), { recursive: true });
// Preserve classic-script globals while reducing source decoding and parsing.
const startup = Buffer.from(
  require('esbuild').transformSync(bundle.data.toString('utf8'), {
    loader: 'js',
    target: 'es2022',
    minifySyntax: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    legalComments: 'eof',
  }).code,
);
write(path.join(destination, 'public/assets/startup.js'), startup);
const startupVersion = crypto.createHash('sha256').update(startup).digest('hex').slice(0, 20);
const hash = crypto.createHash('sha256').update(require('../../package.json').version);
// Every shipped resource participates, including fonts, file styles and UI scripts.
// Versioned URLs may therefore be reused from the WebView disk/code cache safely.
for (const name of [...expected].sort())
  hash.update(path.relative(destination, name)).update(fs.readFileSync(name));
const version = hash.digest('hex').slice(0, 20);
const versionDesktopAssets = (html) =>
  html.replace(/((?:src|href)="\/desktop\/[^"?]+)(")/g, `$1?v=${version}$2`);
let html = assets
  .bundleHtml(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'))
  .replaceAll('__ASSET_VERSION__', version)
  .replaceAll('__ROOT_SETTINGS__', '{}')
  .replace(`assets/startup.js?v=${bundle.version}`, `assets/startup.js?v=${startupVersion}`);
const connectionSettings = fs.readFileSync(
  path.join(root, 'desktop/ui/connection-settings.html'),
  'utf8',
);
html = html
  .replace(
    '</head>',
    '<meta name="swift-desktop" content="1"><link rel="stylesheet" href="/desktop/integration.css"><link rel="stylesheet" href="/desktop/server-dialog.css"><script src="/desktop/auth.js"></script></head>',
  )
  .replace(
    '</body>',
    `<template id="desktopConnectionSettings">${connectionSettings}</template><script src="/desktop/connect.js"></script><script src="/desktop/client-updates.js"></script><script src="/desktop/integration.js"></script></body>`,
  );
write(
  path.join(destination, 'desktop/index.html'),
  versionDesktopAssets(
    fs
      .readFileSync(path.join(root, 'desktop/ui/index.html'), 'utf8')
      .replace('__CONNECTION_SETTINGS__', connectionSettings),
  ),
);
write(path.join(destination, 'public/index.html'), versionDesktopAssets(html));
write(
  path.join(destination, 'VERSION.json'),
  JSON.stringify({ version: require('../../package.json').version, frontendVersion: version }) +
    '\n',
);
write(
  path.join(destination, 'index.html'),
  '<!doctype html><html lang="zh-CN"><title>Swift</title><body>Swift</body></html>',
);
function prune(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      prune(file);
      if (!fs.readdirSync(file).length) fs.rmdirSync(file);
    } else if (!expected.has(file)) fs.unlinkSync(file);
  }
}
prune(destination);
// Reuse the existing application icon; an ICO can contain a PNG image directly.
const png = fs.readFileSync(path.join(root, 'public/icon-192.png'));
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 192;
header[7] = 192;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
fs.mkdirSync(path.join(root, 'desktop/src-tauri/icons'), { recursive: true });
write(path.join(root, 'desktop/src-tauri/icons/icon.ico'), Buffer.concat([header, png]));
write(path.join(root, 'desktop/src-tauri/icons/icon.png'), png);
console.log(`Desktop resources prepared (${version}).`);
