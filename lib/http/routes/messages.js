'use strict';

// 消息投递、停止、附件与同步事件游标。发送与停止都必须携带明确的目标 pane 和会话身份。

const path = require('node:path');
const { randomUUID } = require('node:crypto');

function register(router, ctx) {
  const {
    Conversation,
    apiError,
    clampInt,
    currentRoot,
    exactPane,
    getMessageQueue,
    herdr,
    json,
    readJson,
    saveAttachment,
    wakeMessageQueue,
  } = ctx;

  router.post('/api/attachments', async (req, res, url) => {
    const terminalId = url.searchParams.get('terminalId');
    const view = terminalId ? await herdr.dashboard() : null;
    const pane = terminalId
      ? view.panes.find((item) => item.paneId === url.searchParams.get('pane'))
      : await exactPane(url.searchParams.get('pane'));
    if (
      terminalId &&
      (!url.searchParams.get('runtimeId') ||
        view.runtimeId !== url.searchParams.get('runtimeId') ||
        !pane ||
        pane.terminalId !== terminalId)
    )
      throw apiError(409, 'TERMINAL_CHANGED', '终端已变化，请重新粘贴。');
    if (!terminalId && !pane.agent)
      throw apiError(409, 'SESSION_UNAVAILABLE', '请先选择一个 Agent 会话。');
    const sessionId = url.searchParams.get('sessionId') || '';
    if ((pane.agent?.session?.value || '') !== sessionId)
      throw apiError(409, 'SESSION_CHANGED', '会话已变化，请重新选择附件。');
    const attachment = await saveAttachment(
      req,
      url.searchParams.get('name'),
      path.join(currentRoot().data.path, 'attachments'),
    );
    return json(res, 201, { ok: true, attachment, paneId: pane.paneId, sessionId });
  });

  router.post('/api/messages/interrupt', async (req, res, url) => {
    const body = await readJson(req);
    const pane = await exactPane(body?.paneId);
    try {
      Conversation.assertIdentity(pane, body, true);
    } catch (error) {
      error.deliveryUncertain = false;
      throw error;
    }
    const runtimeId = herdr.normalizeSnapshot
      ? herdr.normalizeSnapshot({}).runtimeId
      : (await herdr.dashboard()).runtimeId;
    if (body.runtimeId && body.runtimeId !== runtimeId)
      throw apiError(409, 'RUNTIME_CHANGED', 'Herdr 运行实例已改变，请重新选择会话。');
    if (body.processRuntimeId && body.processRuntimeId !== pane.runtimeId)
      throw apiError(409, 'SESSION_CHANGED', 'Agent 进程已改变，请重新选择会话。');
    const result = await ctx.sessionInterrupt.run({
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      sessionId: pane.agent?.session?.value,
      runtimeId,
      processRuntimeId: pane.runtimeId,
      currentTurn: true,
      requestId: body.requestId || randomUUID(),
    });
    return json(res, 200, { ...result, paneId: pane.paneId });
  });

  router.get('/api/messages/interrupt', async (_req, res, url) => {
    return json(res, 200, ctx.sessionInterrupt.receipt(Object.fromEntries(url.searchParams)));
  });

  router.post('/api/messages/deliver', async (req, res, url) => {
    const body = await readJson(req);
    const queue = getMessageQueue();
    const message = await queue.deliver(body);
    // A delivery requested during an existing tick must get a fresh pass,
    // rather than waiting for the periodic timer's next snapshot.
    await queue.tick();
    wakeMessageQueue();
    return json(res, 202, {
      ok: true,
      message: queue.list(message.paneId).find((item) => item.id === message.id),
    });
  });

  // 三种方法共用一次目标解析：POST 提交，GET 列出，DELETE 取消。
  router.add(['DELETE', 'GET', 'POST'], '/api/messages', async (req, res, url) => {
    if (req.method === 'POST') {
      const body = await readJson(req);
      const message = await getMessageQueue().submitNative(body);
      wakeMessageQueue();
      return json(res, 202, { ok: true, message });
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const paneId = url.searchParams.get('pane');
      if (!paneId) throw apiError(400, 'PANE_REQUIRED', '缺少 pane。');
      // Closed panes retain their durable history and can still cancel queued messages.
      if (req.method === 'GET')
        return json(res, 200, { ok: true, paneId, messages: getMessageQueue().list(paneId) });
      const id = url.searchParams.get('id');
      if (!id) throw apiError(400, 'MESSAGE_ID_REQUIRED', '缺少 id。');
      return json(res, 200, { ok: true, message: getMessageQueue().cancel(paneId, id) });
    }
  });

  router.get('/api/events', async (req, res, url) => {
    const context = currentRoot();
    const since = Number(url.searchParams.get('since') ?? 0);
    if (!Number.isInteger(since) || since < 0)
      throw apiError(400, 'INVALID_CURSOR', 'since 必须是非负整数。');
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200);
    // Read the cursor and the events it covers in one go; a client that resets
    // must take a fresh snapshot rather than patch from an unknown position.
    return json(res, 200, context.events.since(since, limit));
  });
}

module.exports = { register };
