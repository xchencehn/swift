'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'),
  version = require('../../package.json').version;
const target = process.platform === 'win32' ? 'release' : 'x86_64-pc-windows-msvc/release';
const directory = path.join(root, 'desktop/target', target, 'bundle/nsis');
const installer = path.join(directory, `Swift_${version}_x64-setup.exe`),
  signature = installer + '.sig';
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
    installer,
    signature,
    publicKey,
  ],
  { cwd: root, stdio: 'inherit' },
);
const artifacts = [installer, signature].map((file) => ({
  file: path.relative(root, file),
  bytes: fs.statSync(file).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
}));
fs.mkdirSync(path.join(root, 'artifacts/validation'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'artifacts/validation/windows-package.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      source: require('../lib/source-fingerprint').sourceFingerprint(root),
      updaterSignatureVerified: true,
      tamperedPayloadRejected: true,
      published: false,
      artifacts,
    },
    null,
    2,
  ) + '\n',
);
