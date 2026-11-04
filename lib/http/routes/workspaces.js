'use strict';

// 工作区、标签页与 pane 的结构操作。全部作用在真实运行的 Herdr 对象上。

function register(router, ctx) {
  const { herdr, currentRoot, json, readJson, apiError, prepareWorkspace, scopeDashboard } = ctx;

  router.post('/api/tabs/rename', async (req, res, url) => {
    const payload = await readJson(req);
    await herdr.renameTab(payload.target, payload.name);
    return json(res, 200, {
      ok: true,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  router.post('/api/tabs/cycle', async (req, res, url) => {
    const payload = await readJson(req);
    const tab = await herdr.cycleTab(payload.direction);
    return json(res, 200, { ok: true, tab });
  });

  router.post('/api/panes/close', async (req, res, url) => {
    const payload = await readJson(req);
    await herdr.closePane(payload.target);
    return json(res, 200, {
      ok: true,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  router.post('/api/workspaces/create', async (req, res, url) => {
    const payload = await readJson(req);
    const label = String(payload.label || '').trim();
    if (!label) throw apiError(400, 'BAD_REQUEST', '请输入工作区名称。');
    const directory = await prepareWorkspace(
      currentRoot().data.directory,
      label,
      payload.cwd ?? currentRoot().data.directory,
    );
    const created = await herdr.createWorkspace({ label, cwd: directory.cwd });
    return json(res, 200, {
      ok: true,
      created,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  router.post('/api/workspaces/rename', async (req, res, url) => {
    const payload = await readJson(req);
    await herdr.renameWorkspace(payload.workspaceId, payload.label);
    return json(res, 200, {
      ok: true,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  router.post('/api/workspaces/close', async (req, res, url) => {
    const payload = await readJson(req);
    await herdr.closeWorkspace(payload.workspaceId);
    return json(res, 200, {
      ok: true,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  // 保留显式定位操作兼容；会话查看使用下方带身份核验的接口。
  router.post('/api/panes/focus', async (req, res, url) => {
    const payload = await readJson(req);
    await herdr.focusPane(payload.target);
    return json(res, 200, {
      ok: true,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  router.post('/api/panes/view', async (req, res) => {
    const payload = await readJson(req);
    const result = await require('../../herdr-view').viewPane(
      herdr,
      payload.target,
      payload.expected,
    );
    ctx.broadcastHerdrChanged?.();
    return json(res, 200, { ok: true, ...result });
  });

  router.post('/api/panes/move', async (req, res, url) => {
    const payload = await readJson(req);
    await herdr.movePane(payload.target, payload.workspaceId);
    return json(res, 200, {
      ok: true,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });
}

module.exports = { register };
