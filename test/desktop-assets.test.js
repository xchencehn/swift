'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { execFileSync } = require('node:child_process');

test('desktop build compresses classic scripts and invalidates cached URLs after a CSS-only change', () => {
  const root = path.resolve(__dirname, '..'),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-desktop-assets-'));
  try {
    for (const name of ['public', 'desktop/ui'])
      fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
    for (const name of [
      'scripts/build/build-desktop.js',
      'lib/frontend-assets.js',
      'package.json',
    ]) {
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      fs.copyFileSync(path.join(root, name), path.join(directory, name));
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    const build = () => {
      execFileSync(process.execPath, ['scripts/build/build-desktop.js'], {
        cwd: directory,
        stdio: 'pipe',
      });
      return JSON.parse(fs.readFileSync(path.join(directory, 'desktop/dist/VERSION.json')));
    };
    const before = build();
    const startup = fs.readFileSync(
      path.join(directory, 'desktop/dist/public/assets/startup.js'),
      'utf8',
    );
    const original = require('../lib/frontend-assets')
      .createFrontendAssets(path.join(directory, 'public'))
      .startup().data;
    assert(startup.length < original.length * 0.8);
    new (require('node:vm').Script)(startup);
    fs.appendFileSync(
      path.join(directory, 'public/files/workspace.css'),
      '\n/* isolated cache invalidation fixture */\n',
    );
    const after = build();
    assert.notEqual(after.frontendVersion, before.frontendVersion);
    const html = fs.readFileSync(path.join(directory, 'desktop/dist/public/index.html'), 'utf8');
    assert(html.includes(`files/workspace.css?v=${after.frontendVersion}`));
    assert(html.includes(`/desktop/integration.js?v=${after.frontendVersion}`));
    assert(html.includes(`/desktop/auth.js?v=${after.frontendVersion}`));
    const guide = fs.readFileSync(path.join(directory, 'desktop/dist/desktop/index.html'), 'utf8');
    assert(guide.includes(`/desktop/connect.js?v=${after.frontendVersion}`));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
