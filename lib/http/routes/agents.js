'use strict';

// Agent 的模型、推理档位与速度档位。两家都是读画面、在终端里按键切换：控制面是 PTY，
// 不对接各家私有的结构化协议（Claude 见 claude-control.js，Codex 见 codex-settings.js）。

function register(router, ctx) {
  const receipts = new Map();
  const {
    claudeControl,
    codexSettings,
    exactPane,
    readPaneLines,
    broadcastHerdrChanged,
    json,
    readJson,
    sendError,
    apiError,
    readAgentCatalog,
    getAgentSettings,
    validateSettings,
  } = ctx;
  const settingsOf = (pane) =>
    getAgentSettings(pane, {
      readLines: readPaneLines,
      claudeControl,
      codexSettings,
      readCatalog: readAgentCatalog,
    });

  router.get('/api/agent-settings', async (req, res, url) => {
    const pane = await exactPane(url.searchParams.get('pane'));
    return json(res, 200, { ok: true, ...(await settingsOf(pane)) });
  });

  /** 某个 agent 的「模型 + 推理档位 + 速度档位」候选，读本机目录。 */
  router.get('/api/agent-catalog', async (req, res, url) => {
    const provider = String(url.searchParams.get('provider') || '').toLowerCase();
    if (provider !== 'codex' && provider !== 'claude') {
      return json(res, 400, { ok: false, error: 'provider 只能是 codex 或 claude' });
    }
    try {
      return json(res, 200, { ok: true, ...(await readAgentCatalog(provider)) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  /**
   * 改某个会话的模型、推理档位或速度档位，只对这个会话生效。
   *
   * ⚠️ 只改本会话，不改全局默认：Codex 用 `s`（session）而不是回车（default）确认，
   * Claude 同理。改默认会影响之后新开的每一个会话。
   */
  router.post('/api/agent-settings', async (req, res, url) => {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw apiError(400, 'INVALID_SETTINGS', '设置必须是对象。');
    const run = async () => {
      const pane = await exactPane(body.paneId, { input: true });
      const threadId = pane.agent?.session?.value || null;
      if (body.terminalId && body.terminalId !== pane.terminalId)
        throw apiError(409, 'SESSION_CHANGED', '目标终端已经改变。');
      if (body.processRuntimeId && body.processRuntimeId !== pane.runtimeId)
        throw apiError(409, 'SESSION_CHANGED', 'Agent 进程已经改变，请重新选择设置。');
      if (body.runtimeId && body.runtimeId !== ctx.herdr.normalizeSnapshot({}).runtimeId)
        throw apiError(409, 'RUNTIME_CHANGED', 'Herdr 运行实例已经改变。');
      if (body.threadId && body.threadId !== threadId)
        throw apiError(409, 'SESSION_CHANGED', 'pane 与会话不匹配。');
      if (Object.hasOwn(body, 'sessionId') && body.sessionId !== (threadId || ''))
        throw apiError(409, 'SESSION_CHANGED', '目标会话已经改变。');
      const current = await settingsOf(pane);
      if (!current.editable) throw apiError(409, 'SETTINGS_NOT_EDITABLE', current.reason);
      const catalog = await readAgentCatalog(pane.agent.label);
      const settings = validateSettings(body, current, catalog);
      if (pane.agent.label === 'claude') {
        if (body.serviceTier !== undefined)
          throw apiError(400, 'UNSUPPORTED_SETTING', 'Claude 不使用 Codex 的速度档位');
        const actual = await claudeControl.apply(
          pane,
          { model: settings.model || current.model, ...settings },
          catalog,
        );
        broadcastHerdrChanged();
        return { ok: true, paneId: pane.paneId, threadId, settings: actual };
      }
      const actual = await codexSettings.apply(pane, settings, catalog);
      broadcastHerdrChanged();
      return { ok: true, paneId: pane.paneId, threadId, applied: settings, settings: actual };
    };
    if (!body.requestId) return json(res, 200, await run());
    if (typeof body.requestId !== 'string' || !/^[\w-]{1,128}$/.test(body.requestId))
      throw apiError(400, 'INVALID_REQUEST_ID', '设置操作标识无效。');
    const key = `${ctx.currentRoot().data.directory}:${ctx.deviceId(req)}:${body.requestId}`;
    const fingerprint = JSON.stringify(body),
      existing = receipts.get(key);
    if (existing && existing.fingerprint !== fingerprint)
      throw apiError(409, 'REQUEST_CHANGED', '同一操作标识不能用于不同设置。');
    if (!existing) {
      // Keep completed and uncertain outcomes: a repeated HTTP request must not toggle twice.
      const promise = run();
      promise.catch(() => {});
      receipts.set(key, { fingerprint, promise });
      if (receipts.size > 256) receipts.delete(receipts.keys().next().value);
    }
    return json(res, 200, await receipts.get(key).promise);
  });
}

module.exports = { register };
