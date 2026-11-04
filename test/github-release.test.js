'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { syncTree, verifyPublicBase } = require('../scripts/release/sync-github');
const { verifyGate } = require('../scripts/release/github-release');

test('public synchronization preserves public history and excludes private files and internal history', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-github-sync-'));
  const git = (root, ...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    const source = path.join(temporary, 'source'),
      destination = path.join(temporary, 'public');
    for (const root of [source, destination]) {
      fs.mkdirSync(root);
      git(root, 'init', '-b', 'main');
      git(root, 'config', 'user.name', 'Swift fixture');
      git(root, 'config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(
        path.join(root, '.gitignore'),
        '.local/\nartifacts/*\n!artifacts/.gitkeep\n',
      );
    }
    fs.writeFileSync(path.join(source, 'removed-commercial.txt'), 'private history fixture');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'Internal commercial history');
    const internal = git(source, 'rev-parse', 'HEAD');
    fs.unlinkSync(path.join(source, 'removed-commercial.txt'));
    fs.writeFileSync(path.join(source, 'server.js'), 'public source\n');
    fs.mkdirSync(path.join(source, 'artifacts'));
    fs.writeFileSync(path.join(source, 'artifacts/.gitkeep'), '\n');
    fs.symlinkSync('server.js', path.join(source, 'CLAUDE.md'));
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'Open-source tree');
    fs.mkdirSync(path.join(source, '.local'));
    fs.writeFileSync(path.join(source, '.local/private.txt'), 'ignored fixture');
    fs.writeFileSync(path.join(source, 'artifacts/runtime.log'), 'ignored runtime fixture');
    fs.writeFileSync(path.join(destination, 'obsolete.js'), 'old public source');
    git(destination, 'add', '.');
    git(destination, 'commit', '-m', 'Public root');
    const publicRoot = git(destination, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(destination, '.local'));
    fs.writeFileSync(path.join(destination, '.local/retained.txt'), 'retained fixture');
    const result = syncTree(source, 'HEAD', destination);
    assert.equal(result.tree, git(source, 'rev-parse', 'HEAD^{tree}'));
    git(destination, 'commit', '-m', 'Public update');
    assert.equal(git(destination, 'rev-parse', 'HEAD^'), publicRoot);
    assert.equal(git(destination, 'rev-list', '--count', 'HEAD'), '2');
    assert.notEqual(spawnSync('git', ['cat-file', '-e', internal], { cwd: destination }).status, 0);
    assert.equal(fs.existsSync(path.join(destination, 'removed-commercial.txt')), false);
    assert.equal(fs.existsSync(path.join(destination, '.local/private.txt')), false);
    assert.equal(fs.existsSync(path.join(destination, 'artifacts/.gitkeep')), true);
    assert.equal(fs.existsSync(path.join(destination, 'artifacts/runtime.log')), false);
    assert.equal(
      fs.readFileSync(path.join(destination, '.local/retained.txt'), 'utf8'),
      'retained fixture',
    );
    assert.equal(git(destination, 'status', '--porcelain'), '');
    assert.equal(fs.readlinkSync(path.join(destination, 'CLAUDE.md')), 'server.js');
    assert.equal(verifyPublicBase(source, 'HEAD', destination), git(source, 'rev-parse', 'HEAD'));
    fs.symlinkSync('/unavailable-private-fixture', path.join(source, 'external-link'));
    git(source, 'add', 'external-link');
    git(source, 'commit', '-m', 'Unsupported external link');
    assert.throws(() => syncTree(source, 'HEAD', destination), /inside the repository/);
    assert.equal(git(destination, 'status', '--porcelain'), '');
    fs.writeFileSync(path.join(destination, 'another-feature.js'), 'another published feature');
    git(destination, 'add', '.');
    git(destination, 'commit', '-m', 'Concurrent public feature');
    assert.throws(() => verifyPublicBase(source, 'HEAD', destination), /integrate them/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('release requires successful push CI for the exact current main commit', () => {
  const run = {
    head_sha: 'current',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  };
  assert.equal(verifyGate('current', 'current', [run]), run);
  assert.throws(() => verifyGate('old', 'current', [run]), /newer main/);
  for (const patch of [
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { head_sha: 'old' },
    { event: 'pull_request' },
    { head_branch: 'feature' },
  ])
    assert.throws(() => verifyGate('current', 'current', [{ ...run, ...patch }]), /complete CI/);
});
