'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { spawnSync, execFileSync } = require('node:child_process');
test(
  'validation reports command failures, source drift and timeouts instead of false success',
  { skip: process.platform === 'win32' },
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-validation-test-'));
    try {
      fs.mkdirSync(path.join(directory, 'scripts'));
      fs.mkdirSync(path.join(directory, 'bin'));
      for (const file of ['check/validate.js', 'lib/source-fingerprint.js']) {
        const target = path.join(directory, 'scripts', file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(__dirname, '../scripts', file), target);
      }
      fs.writeFileSync(path.join(directory, 'source.txt'), 'initial');
      execFileSync('git', ['init', '-q'], { cwd: directory });
      execFileSync('git', ['add', 'scripts', 'source.txt'], { cwd: directory });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'fixture',
        ],
        { cwd: directory },
      );
      fs.writeFileSync(path.join(directory, '.gitignore'), 'artifacts/\nbin/\n');
      const env = {
        ...process.env,
        PATH: path.join(directory, 'bin') + ':' + process.env.PATH,
        SWIFT_VALIDATION_TIMEOUT_MS: '1000',
      };
      function run(script) {
        fs.writeFileSync(path.join(directory, 'bin/npm'), '#!/bin/sh\n' + script + '\n', {
          mode: 0o755,
        });
        const result = spawnSync(process.execPath, ['scripts/check/validate.js', 'fast'], {
          cwd: directory,
          env,
          timeout: 10000,
        });
        return {
          result,
          report: JSON.parse(
            fs.readFileSync(path.join(directory, 'artifacts/validation/fast.json')),
          ),
        };
      }
      let value = run('exit 7');
      assert.equal(value.result.status, 1);
      assert.equal(value.report.ok, false);
      assert.equal(value.report.steps[0].exitCode, 7);
      value = run('echo changed >> source.txt');
      assert.equal(value.result.status, 1);
      assert.equal(value.report.ok, false);
      assert.notEqual(value.report.before.treeSha256, value.report.after.treeSha256);
      value = run('trap \"\" TERM; sleep 20');
      assert.equal(value.result.status, 1);
      assert.equal(value.report.steps[0].timedOut, true);
      value = run('exit 0');
      assert.equal(value.result.status, 0);
      assert.equal(value.report.ok, true);
      assert.equal(value.report.steps.length, 2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
