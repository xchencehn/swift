'use strict';
function register(router, { spaceActions, getMessageQueue, json, readJson }) {
  router.get('/api/spaces/actions', async (_req, res, url) => {
    const id = url.searchParams.get('requestId');
    json(res, 200, {
      ok: true,
      ...(id
        ? { job: spaceActions.get(id) }
        : await spaceActions.preview(
            url.searchParams.get('workspaceId'),
            url.searchParams.get('paneId'),
          )),
    });
  });
  router.post('/api/spaces/actions', async (req, res) => {
    const job = await spaceActions.start(await readJson(req), getMessageQueue());
    json(res, 202, { ok: true, job });
  });
}
module.exports = { register };
