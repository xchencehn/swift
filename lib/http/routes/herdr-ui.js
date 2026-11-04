'use strict';
const { ACTIONS, READS, invoke } = require('../../herdr-ui');
function register(router, { herdr, json, readJson, herdrSessions, broadcastHerdrChanged }) {
  router.get('/api/herdr/sessions', async (_req, res) =>
    json(res, 200, {
      ok: true,
      current: herdr.session || 'default',
      sessions: herdrSessions.list(),
    }),
  );
  router.get('/api/herdr/runtime', async (_req, res) => {
    const view = await herdr.dashboard();
    return json(res, 200, {
      ok: true,
      session: herdr.session || 'default',
      version: view.version,
      protocol: view.protocol,
      actions: Object.keys(ACTIONS),
      reads: Object.keys(READS),
      capabilitySource: 'swift-adapter',
      methodSupport: herdr.uiMethodSupport || {},
      // These are adapter operations, not an invented server capability advertisement.
      capabilityNotice: '操作支持以服务器响应为准；未知方法只禁用对应操作。',
    });
  });
  router.get('/api/herdr/read', async (_req, res, url) => {
    const method = url.searchParams.get('method');
    const params = JSON.parse(url.searchParams.get('params') || '{}');
    return json(res, 200, {
      ok: true,
      result: await invoke(herdr, method, params, null, { read: true }),
    });
  });
  router.post('/api/herdr/action', async (req, res) => {
    const body = await readJson(req);
    const result = await invoke(herdr, body.action, body.params || {}, body.expected);
    broadcastHerdrChanged();
    return json(res, 200, { ok: true, result });
  });
}
module.exports = { register };
