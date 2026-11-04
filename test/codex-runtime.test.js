'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { managedCodexBinary } = require('../lib/codex-runtime');
test(
  'Codex runtime updater and launcher cover immutable resources, failed upgrades, rollback, locks and local UI policy',
  { skip: process.platform !== 'linux' },
  () => {
    const result = spawnSync(
      '/usr/bin/python3',
      ['-B', '-m', 'unittest', 'discover', '-s', 'runtime/codex/tests', '-v'],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
test('Swift selects only the approved managed native binary and rejects path or content changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-codex-select-'));
  try {
    const release = path.join(root, 'releases', 'fixture'),
      binary = path.join(release, 'bin/codex');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'fixture');
    fs.chmodSync(binary, 0o755);
    const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
    const manifest = Buffer.from(
      JSON.stringify({ schema: 1, files: { 'bin/codex': { sha256: sha('fixture') } } }),
    );
    fs.writeFileSync(path.join(release, 'runtime-manifest.json'), manifest);
    fs.writeFileSync(
      path.join(root, 'approved.json'),
      JSON.stringify({ fixture: { manifestSha256: sha(manifest) } }),
    );
    fs.symlinkSync(release, path.join(root, 'current'));
    assert.equal(managedCodexBinary({ root }), binary);
    fs.writeFileSync(binary, 'corrupted');
    assert.equal(managedCodexBinary({ root }), null);
    fs.unlinkSync(path.join(root, 'current'));
    fs.symlinkSync(root, path.join(root, 'current'));
    assert.equal(managedCodexBinary({ root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
