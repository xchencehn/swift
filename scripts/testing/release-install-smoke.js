#!/usr/bin/env node
'use strict';
// Install the actual distribution in an empty home; systemctl is a recording fixture.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../..'),
  version = require('../../package.json').version;
const { sourceFingerprint } = require('../lib/source-fingerprint');
async function main() {
  const before = sourceFingerprint(root),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-release-install-'));
  let child;
  try {
    const output = path.join(directory, 'release');
    execFileSync(
      process.execPath,
      ['scripts/release/package-release.js', '--server-only', `--output=${output}`],
      { cwd: root, stdio: 'pipe' },
    );
    const unpacked = path.join(directory, 'portable project 100%');
    fs.mkdirSync(unpacked);
    execFileSync('tar', [
      '-xzf',
      path.join(output, `swift-${version}-server.tar.gz`),
      '-C',
      unpacked,
    ]);
    const members = execFileSync(
      'tar',
      ['-tzf', path.join(output, `swift-${version}-server.tar.gz`)],
      { encoding: 'utf8' },
    ).split('\n');
    assert(members.some((name) => name.endsWith('/NOTICE')));
    assert(
      !members.some((name) =>
        /(?:^|\/)(?:__pycache__|node_modules|\.local|\.env(?:\.|$)|signing\.properties)(?:\/|$)/.test(
          name,
        ),
      ),
      'Release contains only source inputs, not ignored local state',
    );
    const source = path.join(unpacked, `swift-${version}`),
      home = path.join(directory, 'empty-home'),
      bin = path.join(directory, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    const operations = path.join(directory, 'systemctl-operations');
    fs.writeFileSync(
      path.join(bin, 'systemctl'),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${operations}'\n`,
      { mode: 0o755 },
    );
    const herdr = path.join(bin, 'herdr');
    fs.writeFileSync(herdr, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/^(HERDR_|SWIFT_|AGENT_STUDIO_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|OPENCODE_DB$)/.test(key))
        delete env[key];
    Object.assign(env, {
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      NPM_CONFIG_USERCONFIG: '/dev/null',
      XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
    });
    fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    // This is a real production-only npm install, not a dependency fixture.
    execFileSync(
      'bash',
      ['deploy/install.sh', '--root', directory, '--herdr', herdr, '--no-start'],
      { cwd: source, env, timeout: 180000, stdio: 'pipe' },
    );
    const units = path.join(source, '.local/config/systemd');
    execFileSync('systemd-analyze', ['verify', path.join(units, 'swift.service')], {
      env,
      stdio: 'pipe',
    });
    assert(!fs.readFileSync(operations, 'utf8').includes('\nstart\n'));
    const commandDirectory = path.join(source, 'data/commands');
    const catalogFile = fs
      .readdirSync(commandDirectory)
      .find((name) => /^codex-.*\.json$/.test(name));
    assert(catalogFile);
    const catalog = JSON.parse(fs.readFileSync(path.join(commandDirectory, catalogFile), 'utf8'));
    const nativeCatalog = require(path.join(source, 'lib/agent-commands')).versionCatalog;
    assert(catalog.commands.length > 0);
    assert.equal(nativeCatalog(catalog.provider, catalog.version).length, catalog.commands.length);
    // Start only a disposable server, bound to an ephemeral local port and a fake runtime.
    const listener = http.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    Object.assign(env, {
      HOST: '127.0.0.1',
      PORT: String(port),
      HERDR_BIN: herdr,
      HERDR_SESSION: `release-fixture-${process.pid}`,
      SWIFT_DIRECT_AUTH: 'token',
      SWIFT_ROOT_DIR: directory,
      SWIFT_TOKEN: 'release-fixture-only',
      SWIFT_HIDE_STARTUP_URLS: '1',
      SWIFT_BASE_PATH: '/swift',
    });
    child = spawn(process.execPath, ['server.js'], {
      cwd: source,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const url = `http://127.0.0.1:${port}/swift`;
    let response;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw Error('Distribution server exited before HTTP verification');
      try {
        response = await fetch(`${url}/api/config`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(response?.status, 401);
    const config = await fetch(`${url}/api/config`, {
      headers: { 'x-agent-studio-token': 'release-fixture-only' },
    });
    assert.equal(config.status, 200);
    assert.equal((await config.json()).providerCapabilities.length, 8);
    for (const endpoint of [
      '/api/collaboration',
      '/api/collaboration/reference',
      '/api/collaboration/agent',
      '/api/execution-environments',
      '/api/execution-environments/check',
      '/api/execution-environments/shell',
    ])
      assert.equal(
        (
          await fetch(`${url}${endpoint}`, {
            headers: { 'x-agent-studio-token': 'release-fixture-only' },
          })
        ).status,
        404,
      );
    const html = await fetch(`${url}/`);
    assert.equal(html.status, 200);
    const startup = (await html.text()).match(/src="(assets\/startup\.js\?v=[^"]+)"/)?.[1];
    assert(startup);
    assert.equal((await fetch(`${url}/${startup}`)).status, 200);
    const result = {
      at: new Date().toISOString(),
      before,
      after: sourceFingerprint(root),
      version,
      productionDependencies: true,
      portableInstallation: true,
      systemdVerified: true,
      commandCatalogIncluded: true,
      unauthorizedStatus: response.status,
      authenticatedStatus: config.status,
      providerCount: 8,
      startupBundleStatus: 200,
      startedRealServices: false,
    };
    fs.mkdirSync(path.join(root, 'artifacts/five-defects'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'artifacts/five-defects/release-install.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
