'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HerdrClient } = require('../lib/herdr-client');

function client(workspaces) {
  const herdr = new HerdrClient({ bin: '/nonexistent', socketPath: '/nonexistent' });
  const created = [];
  herdr.dashboard = async () => ({ workspaces, panes: [] });
  herdr.createWorkspace = async (options) => {
    created.push(options);
    return { workspace: { workspace_id: 'w-new' }, root_pane: { pane_id: 'p-new' } };
  };
  return { herdr, created };
}

test('按工作区的目录找：改过名也找得到，同名但目录不同的不算', async () => {
  const { herdr, created } = client([
    { workspaceId: 'w1', label: '改过的名字', cwd: '/root/mxops' },
    { workspaceId: 'w2', label: 'mxops', cwd: '/elsewhere/mxops' },
  ]);
  assert.deepEqual(await herdr.workspaceForDirectory('/root/mxops'), {
    workspaceId: 'w1',
    rootPaneId: null,
  });
  assert.equal(created.length, 0);
});

test('没有绑定这个目录的工作区就新建一个，并交回它自带的那一格', async () => {
  const { herdr, created } = client([{ workspaceId: 'w1', label: 'other', cwd: '/root/other' }]);
  assert.deepEqual(await herdr.workspaceForDirectory('/root/fresh'), {
    workspaceId: 'w-new',
    rootPaneId: 'p-new',
  });
  assert.deepEqual(created, [{ label: 'fresh', cwd: '/root/fresh' }]);
});

test('没有目录证据时不根据同名标签挑选已有工作区', async () => {
  const { herdr, created } = client([{ workspaceId: 'w1', label: 'mxops', cwd: '' }]);
  assert.equal((await herdr.workspaceForDirectory('/root/mxops')).workspaceId, 'w-new');
  assert.deepEqual(created, [{ label: 'mxops', cwd: '/root/mxops' }]);
});

test('同一目录可有多个分组，兼容启动接口必须要求明确选择', async () => {
  const { herdr, created } = client([
    { workspaceId: 'w1', cwd: '/root/a' },
    { workspaceId: 'w2', cwd: '/root/a' },
  ]);
  await assert.rejects(herdr.workspaceForDirectory('/root/a'), { code: 'WORKSPACE_AMBIGUOUS' });
  assert.equal(created.length, 0);
});
