'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'),
  version = require('../../package.json').version;
const target = process.platform === 'win32' ? 'release' : 'x86_64-pc-windows-msvc/release';
const directory = path.join(root, 'desktop/target', target, 'bundle/nsis'),
  output = path.join(root, 'artifacts/release', version, 'windows');
const installer = `Swift_${version}_x64-setup.exe`,
  files = [installer, installer + '.sig'];
fs.mkdirSync(output, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(directory, file), path.join(output, file));
const publicKey = require('../../desktop/src-tauri/tauri.conf.json').plugins.updater.pubkey;
execFileSync(
  'cargo',
  [
    'run',
    '--quiet',
    '--manifest-path',
    'desktop/Cargo.toml',
    '--bin',
    'desktop-signature',
    '--',
    path.join(output, installer),
    path.join(output, installer + '.sig'),
    publicKey,
  ],
  { cwd: root, stdio: 'inherit' },
);
const source = require('../lib/source-fingerprint').sourceFingerprint(root);
if (source.dirty) throw new Error('Windows 发行需要已提交、干净的源码；当前构建可以留作开发证据。');
const manifest = {
  version,
  ...source,
  target: 'windows-x86_64',
  authenticodeSigned: false,
  updaterSignatureVerified: true,
  artifacts: files.map((filename) => {
    const b = fs.readFileSync(path.join(output, filename));
    return {
      filename,
      bytes: b.length,
      sha256: crypto.createHash('sha256').update(b).digest('hex'),
    };
  }),
};
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(
  path.join(output, 'SHA256SUMS'),
  manifest.artifacts.map((a) => `${a.sha256}  ${a.filename}\n`).join(''),
);
const latest = {
  version,
  notes: process.env.SWIFT_RELEASE_NOTES || `Swift ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: fs.readFileSync(path.join(output, installer + '.sig'), 'utf8').trim(),
      url: `https://github.com/xchencehn/swift/releases/download/v${version}/${installer}`,
    },
  },
};
fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(`Packaged Windows ${version} (${source.revision}) at ${path.relative(root, output)}.`);
