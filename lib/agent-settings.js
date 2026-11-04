'use strict';
const { parseLine } = require('./json-lines');

const { apiError } = require('./message-queue');

function archivedSettings(agent, lines) {
  let model = null;
  let effort = null;
  let recordedAt = null;
  let source = 'unavailable';
  for (const raw of lines) {
    let entry;
    try {
      entry = parseLine(raw);
    } catch {
      continue;
    }
    if (agent === 'codex' && entry?.type === 'turn_context' && entry.payload) {
      const context = entry.payload;
      model = typeof context.model === 'string' ? context.model : null;
      effort =
        typeof context.effort === 'string'
          ? context.effort
          : typeof context.reasoning_effort === 'string'
            ? context.reasoning_effort
            : null;
      recordedAt = entry.timestamp || null;
      source = 'turn_context';
    } else if (
      agent === 'claude' &&
      entry?.type === 'assistant' &&
      typeof entry.message?.model === 'string'
    ) {
      model = entry.message.model;
      recordedAt = entry.timestamp || null;
      source = 'assistant.model';
    }
  }
  return { model, effort, source, recordedAt };
}

/**
 * 某个会话当前的模型与档位，以及能不能从网页改。
 *
 * 两家都是读画面、在终端里按键切换（`claude-control.js`、`codex-settings.js`），所以只要
 * 是这两家的会话就可以改。存档里记的是上一轮用的设置；运行中的进程此刻的设置更新，
 * 读得到就以它为准。
 */
async function getAgentSettings(
  pane,
  { readLines, claudeControl, codexSettings, readCatalog, readArchived },
) {
  const provider = pane.agent?.label || null;
  const threadId = pane.agent?.session?.value || null;
  let lines = [];
  let archived = archivedSettings(provider, []);
  try {
    if (readArchived && provider === 'codex') archived = await readArchived(pane);
    else {
      lines = await readLines(pane);
      archived = archivedSettings(provider, lines);
    }
  } catch {
    /* report unavailable explicitly */
  }
  if (provider === 'claude' && threadId && claudeControl) {
    const recorded = await claudeControl.recorded(pane, lines);
    return {
      paneId: pane.paneId,
      sessionId: threadId,
      threadId,
      provider,
      ...archived,
      ...recorded,
      editable: true,
      reason: '',
      scope: 'session',
      selector: 'native',
    };
  }
  if (provider === 'codex' && codexSettings) {
    // 刚建、还没发过第一句话的 Codex 会话还没有会话 id，但终端里的 /model 照样能用。
    const live = await codexSettings.recorded(pane, await readCatalog('codex')).catch(() => null);
    return {
      paneId: pane.paneId,
      sessionId: threadId,
      threadId,
      provider,
      ...archived,
      ...(live || {}),
      editable: true,
      reason: '',
      scope: 'session',
      selector: 'native',
    };
  }
  return {
    paneId: pane.paneId,
    sessionId: threadId,
    threadId,
    provider,
    ...archived,
    editable: false,
    reason: '这个 pane 没有可识别的会话。',
  };
}

function validateSettings(body, current, catalog) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw apiError(400, 'INVALID_SETTINGS', '设置必须是对象。');
  if (body.model === undefined && body.effort === undefined && body.serviceTier === undefined)
    throw apiError(400, 'EMPTY_SETTINGS', '至少指定 model、effort 或 serviceTier。');
  for (const key of ['model', 'effort']) {
    if (
      body[key] !== undefined &&
      (typeof body[key] !== 'string' || !body[key].trim() || body[key] !== body[key].trim())
    ) {
      throw apiError(400, 'INVALID_SETTINGS', `${key} 必须是非空字符串。`);
    }
  }
  if (!catalog.models?.length)
    throw apiError(503, 'MODEL_CATALOG_UNAVAILABLE', '无法获取模型目录，未修改设置。');
  const model = catalog.models.find((item) => item.id === (body.model ?? current.model));
  if (!model) throw apiError(400, 'INVALID_MODEL', '模型不在当前目录中，或无法确定当前模型。');
  if (body.effort !== undefined && !model.efforts.some((item) => item.id === body.effort)) {
    throw apiError(400, 'INVALID_EFFORT', '这个模型不支持指定的推理强度。');
  }
  if (
    body.serviceTier !== undefined &&
    body.serviceTier !== null &&
    !(model.serviceTiers || []).some((tier) => tier.id === body.serviceTier)
  ) {
    throw apiError(400, 'INVALID_SERVICE_TIER', '这个模型不支持指定的速度档位。');
  }
  return {
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.effort !== undefined ? { effort: body.effort } : {}),
    ...(body.serviceTier !== undefined ? { serviceTier: body.serviceTier } : {}),
  };
}

module.exports = { archivedSettings, getAgentSettings, validateSettings };
