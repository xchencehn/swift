'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolvePath, localHref, ago, displayPath } = require('../public/files/doc-view.js');

test('正文路径从 Swift 根目录开始展示，并保留不在根目录内的完整路径', () => {
  const file = '/home/developer/workdir/mxops/tasks/review/fix-report.md';
  assert.equal(displayPath(file, '/home/developer/workdir'), 'mxops/tasks/review/fix-report.md');
  assert.equal(displayPath(file, '/home/developer/workdir/'), 'mxops/tasks/review/fix-report.md');
  assert.equal(
    displayPath('/home/developer/workdir-other/file.md', '/home/developer/workdir'),
    '/home/developer/workdir-other/file.md',
  );
  assert.equal(displayPath(file, ''), file);
  assert.equal(displayPath('mxops/results.md', '/home/developer/workdir'), 'mxops/results.md');
  assert.equal(displayPath('/file.md', '/'), 'file.md');
});

test('相对链接按所在文档解析：文档之间全靠它互相引用', () => {
  assert.equal(resolvePath('tasks/51-x/results.md', 'workspace.json'), 'tasks/51-x/workspace.json');
  assert.equal(resolvePath('tasks/51-x/results.md', 'reports/a.md'), 'tasks/51-x/reports/a.md');
  assert.equal(resolvePath('tasks/51-x/reports/a.md', '../results.md'), 'tasks/51-x/results.md');
  assert.equal(resolvePath('tasks/51-x/results.md', './notes/b.md'), 'tasks/51-x/notes/b.md');
  // 越界交给服务端再挡一次，这里只负责算出它想去哪。
  assert.equal(resolvePath('tasks/51-x/results.md', '../../../etc/passwd'), 'etc/passwd');
});

test('只有本地相对路径才成为面板内的一跳', () => {
  assert.equal(localHref('results.md'), 'results.md');
  assert.equal(localHref('results.md#now'), 'results.md');
  assert.equal(localHref('results.md?v=1'), 'results.md');
  for (const outside of [
    'https://example.com',
    'http://a.b',
    'mailto:a@b',
    'file:///etc',
    '//cdn/x.js',
    '#section',
    '',
  ]) {
    assert.equal(localHref(outside), null, `不该当成本地路径: ${outside}`);
  }
});

test('时间按量级说人话，没有时间就不说', () => {
  const now = Date.now();
  assert.equal(ago(now - 5 * 60000, now), '5 分钟前');
  assert.equal(ago(now - 3 * 3600000, now), '3 小时前');
  assert.equal(ago(now - 2 * 86400000, now), '2 天前');
  assert.equal(ago(now - 90 * 86400000, now), '3 个月前');
  assert.equal(ago(0, now), '');
  assert.equal(ago(null, now), '');
});
