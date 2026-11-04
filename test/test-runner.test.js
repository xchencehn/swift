'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = path.join(__dirname, '../scripts/check/run-tests.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-test-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('scripts/check/run-tests.js', fs.readFileSync(runner));
  fs.mkdirSync(path.join(root, 'test'));
  write('artifacts/research/poison.test.js', "throw new Error('ARTIFACT_MUST_NOT_RUN');\n");
  const run = (...args) => {
    // Exercise a fresh CLI invocation rather than inheriting Node's internal
    // child-test marker, which intentionally skips a nested --test runner.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['scripts/check/run-tests.js', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    return { ...result, output: result.stdout + result.stderr };
  };
  return { root, write, run };
}

test('default tests include only recursive canonical test files and exclude ignored artifacts and ordinary helpers', (t) => {
  const f = fixture(t);
  // Create these out of order to exercise deterministic discovery independently
  // of filesystem insertion order. No git repository or package is present.
  f.write(
    'test/nested/z.test.mjs',
    "import test from 'node:test'; test('CANONICAL_MJS', () => {});\n",
  );
  f.write('test/nested/m.test.cjs', "require('node:test')('CANONICAL_CJS', () => {});\n");
  f.write('test/a.test.js', "require('node:test')('CANONICAL_JS', () => {});\n");
  f.write('test/helper.js', "throw new Error('HELPER_MUST_NOT_RUN');\n");
  f.write('test/directory.test.js/helper.js', "throw new Error('DIRECTORY_MUST_NOT_RUN');\n");
  const result = f.run();
  assert.equal(result.status, 0, result.output);
  for (const name of ['CANONICAL_JS', 'CANONICAL_CJS', 'CANONICAL_MJS'])
    assert(result.output.includes(name), result.output);
  for (const name of ['ARTIFACT_MUST_NOT_RUN', 'HELPER_MUST_NOT_RUN', 'DIRECTORY_MUST_NOT_RUN'])
    assert(!result.output.includes(name), result.output);
  assert(
    result.output.indexOf('CANONICAL_JS') < result.output.indexOf('CANONICAL_CJS'),
    result.output,
  );
  assert(
    result.output.indexOf('CANONICAL_CJS') < result.output.indexOf('CANONICAL_MJS'),
    result.output,
  );
});

test('explicit Node test targets keep their existing meaning outside the default canonical directory', (t) => {
  const f = fixture(t);
  f.write('test/a.test.js', "require('node:test')('CANONICAL_MUST_NOT_RUN', () => {});\n");
  const result = f.run('--test-name-pattern=.*', 'artifacts/research/poison.test.js');
  assert.equal(result.status, 1, result.output);
  assert(result.output.includes('ARTIFACT_MUST_NOT_RUN'), result.output);
  assert(!result.output.includes('CANONICAL_MUST_NOT_RUN'), result.output);
});

test('an empty canonical test directory fails without falling back to ignored artifact discovery', (t) => {
  const f = fixture(t),
    result = f.run();
  assert.equal(result.status, 1, result.output);
  assert(result.output.includes('No canonical tests found in test/.'), result.output);
  assert(!result.output.includes('ARTIFACT_MUST_NOT_RUN'), result.output);
});
