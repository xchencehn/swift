'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { createHash } = require('node:crypto'),
  { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'),
  args = process.argv.slice(2),
  env = { ...process.env };
const { sourceFingerprint } = require('../lib/source-fingerprint');
const before = sourceFingerprint(root);
const key = path.join(root, '.local/config/desktop-updater.key');
if (!args.includes('--no-bundle') && !env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!fs.existsSync(key))
    throw new Error(
      '缺少私有更新签名文件 .local/config/desktop-updater.key，请按 desktop/README.md 配置。',
    );
  env.TAURI_SIGNING_PRIVATE_KEY = key;
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
}
if (process.platform !== 'win32') {
  args.unshift('--runner', 'cargo-xwin', '--target', 'x86_64-pc-windows-msvc');
  const cache = path.join(require('node:os').homedir(), '.cache/cargo-xwin');
  if (fs.existsSync(cache)) env.XWIN_CACHE_DIR ??= cache;
}
const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...args],
  { cwd: path.join(root, 'desktop'), env, stdio: 'inherit' },
);
if (result.error) throw result.error;
let status = result.status,
  vaultProbe = null;
if (status === 0 && env.SWIFT_WINDOWS_VAULT_CHECK === '1') {
  const args = [
    ...(process.platform === 'win32' ? [] : ['xwin']),
    'build',
    '--manifest-path',
    'desktop/Cargo.toml',
    '--release',
    '--target',
    'x86_64-pc-windows-msvc',
    '--bin',
    'desktop-fixture',
  ];
  const probe = spawnSync('cargo', args, {
    cwd: root,
    env: { ...env, RUSTFLAGS: (env.RUSTFLAGS || '') + ' -C target-feature=+crt-static' },
    stdio: 'inherit',
  });
  if (probe.error) throw probe.error;
  status = probe.status;
  if (status === 0) {
    const file = 'desktop/target/x86_64-pc-windows-msvc/release/desktop-fixture.exe';
    vaultProbe = {
      file,
      sha256: createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex'),
    };
  }
}
const after = sourceFingerprint(root),
  evidence = path.join(root, 'artifacts/validation');
fs.mkdirSync(evidence, { recursive: true });
let executable = null;
if (status === 0) {
  const file =
    process.platform === 'win32'
      ? 'desktop/target/release/swift-desktop.exe'
      : 'desktop/target/x86_64-pc-windows-msvc/release/swift-desktop.exe';
  const binary = fs.readFileSync(path.join(root, file));
  executable = {
    file,
    bytes: binary.length,
    sha256: createHash('sha256').update(binary).digest('hex'),
  };
}
fs.writeFileSync(
  path.join(evidence, 'windows-build.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      before,
      after,
      ok: status === 0 && before.treeSha256 === after.treeSha256,
      host: process.platform,
      target: 'windows-x86_64',
      bundled: !args.includes('--no-bundle'),
      executable,
      vaultProbe,
    },
    null,
    2,
  ) + '\n',
);
process.exitCode = status || (before.treeSha256 === after.treeSha256 ? 0 : 1);
