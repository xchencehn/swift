'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shortPhrase } = require('../lib/session-naming');

test('短语在子句边界断开，太靠前的边界不算，超长才按长度截', () => {
  assert.equal(shortPhrase('修复附件上传'), '修复附件上传');
  assert.equal(shortPhrase('把消息队列迁移到 SQLite，并且保证幂等'), '把消息队列迁移到 SQLite');
  // 「好，」的边界只有一个字，裁出来是个词不是短语，按长度截更有信息量。
  assert.equal(
    shortPhrase('好，接下来把路由表拆出来再把前端三个核心模块分开'),
    '好，接下来把路由表拆出来再把前端三个核心…',
  );
  assert.equal(shortPhrase(''), '');
  assert.equal(shortPhrase('两行\n第二行'), '两行');
});

test('快照读取多个同 Tab 会话只显示各自标题，从不改名', async () => {
  const { buildDashboard } = require('../lib/sync/dashboard');
  const { scopeDashboard } = require('../lib/root-scope');
  const panes = ['a', 'b'].map((id) => ({
    paneId: id,
    tabId: 'tab',
    tabTitle: '123',
    agent: { session: { value: id } },
  }));
  const root = {
    data: { directory: '/root' },
    sessionMetadata: {
      enrich: async (dashboard) => {
        for (const pane of dashboard.panes) pane.sessionTitle = `conversation ${pane.paneId}`;
      },
    },
    sessionNaming: {
      adopt() {
        throw new Error('must not adopt tab title');
      },
      sync() {
        throw new Error('must not rename');
      },
    },
  };
  const dashboard = await buildDashboard({
    herdr: {
      dashboard: async () => ({ panes }),
      renameTab() {
        throw new Error('must not mutate');
      },
    },
    currentRoot: () => root,
    scopeDashboard,
    getMessageQueue: () => ({ items: [] }),
  });
  assert.deepEqual(
    dashboard.panes.map((p) => [p.tabTitle, p.sessionTitle]),
    [
      ['123', 'conversation a'],
      ['123', 'conversation b'],
    ],
  );
});
