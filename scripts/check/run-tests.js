'use strict';
// Every subprocess gets an empty home and no inherited live runtime endpoints.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-tests-'));
const env = { ...process.env };
for (const key of Object.keys(env))
  if (
    /^(?:HERDR_|SWIFT_|AGENT_STUDIO_|CODEX_(?:SQLITE_)?HOME$|CLAUDE_CONFIG_DIR$|OPENCODE_DB$)/.test(
      key,
    )
  )
    delete env[key];
Object.assign(env, {
  SWIFT_DIRECT_AUTH: 'token',
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_RUNTIME_DIR: path.join(home, 'runtime'),
});
fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
try {
  const args = process.argv.slice(2);
  // Only this checkout's canonical tests belong to the default suite. Explicit
  // Node test-runner arguments retain their existing meaning.
  if (!args.length) {
    const directory = path.join(__dirname, '../../test');
    args.push(
      ...fs
        .readdirSync(directory, { recursive: true })
        .filter(
          (file) =>
            /\.test\.(?:js|cjs|mjs)$/.test(file) &&
            fs.statSync(path.join(directory, file)).isFile(),
        )
        .sort()
        .map((file) => path.join(directory, file)),
    );
    // An empty list would make Node rediscover ignored research snapshots.
    if (!args.length) throw new Error('No canonical tests found in test/.');
  }
  const concurrency = process.env.SWIFT_TEST_CONCURRENCY;
  if (concurrency !== undefined) {
    if (!/^[1-9]\d*$/.test(concurrency))
      throw new Error('SWIFT_TEST_CONCURRENCY must be a positive integer.');
    args.unshift('--test-concurrency=' + concurrency);
  }
  const result = spawnSync(process.execPath, ['--test', ...args], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
