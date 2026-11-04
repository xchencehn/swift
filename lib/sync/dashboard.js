'use strict';

/**
 * 会话快照：Herdr 的完整布局，补上只读会话标题和消息时间等元数据。
 *
 * `/api/snapshot` 与同步中心共用。标题只用于显示，读取不修改 Herdr 布局或名称。
 */
async function buildDashboard({
  herdr,
  currentRoot,
  scopeDashboard,
  getMessageQueue,
  identityRepair,
  broadcastHerdrChanged,
}) {
  const root = currentRoot();
  const dashboard = scopeDashboard(await herdr.dashboard(), root.data.directory);
  await root.sessionMetadata.enrich(dashboard, getMessageQueue().items);
  // 原生恢复参数或已交叉核验的存档身份补报给 Herdr，补上后通知页面重拉。
  identityRepair
    ?.check(dashboard.panes)
    .then((results) => {
      if (results.some(Boolean)) broadcastHerdrChanged();
    })
    .catch(() => {});
  return dashboard;
}

module.exports = { buildDashboard };
