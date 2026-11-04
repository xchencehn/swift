'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
test('容器转换器限制网络、文件系统和资源，并拒绝命令注入及回收超时作业', () => {
  const result = spawnSync('/usr/bin/python3', ['-B', 'test/document-preview-worker.py'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
