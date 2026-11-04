'use strict';
const { clearNativeComposer } = require('./native-composer');
const { createHash, randomUUID } = require('node:crypto');
const { matchActivityLine } = require('../public/ansi');
const { codexInteraction } = require('./codex-footer');
const { readStatusArea } = require('./agent-composer');
const Conversation = require('./conversation-state');
const { apiError } = require('./message-queue');
const { herdrRequest } = require('./herdr-input');
const nativeSide = require('./codex-side-native');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readReceipts(file) {
  let ledger;
  try {
    ledger = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') ledger = { version: 1, receipts: {} };
    else throw apiError(500, 'SIDE_RECEIPTS_INVALID', '无法读取临时消息操作记录，未继续发送。');
  }
  if (
    ledger?.version !== 1 ||
    !ledger.receipts ||
    Array.isArray(ledger.receipts) ||
    typeof ledger.receipts !== 'object' ||
    Object.values(ledger.receipts).some(
      (item) => !/^[a-f0-9]{64}$/.test(item?.intent || '') || typeof item.submitted !== 'boolean',
    )
  )
    throw apiError(500, 'SIDE_RECEIPTS_INVALID', '临时消息操作记录无效，未继续发送。');
  return ledger;
}

// Side threads are ephemeral: their transcript belongs to the native terminal,
// not the main thread's JSONL archive. Only recognize the current footer, never
// a mention of /side in an answer or an older scrollback frame.
function sideScreen(raw) {
  const interaction = codexInteraction(raw);
  const { lines, prompt, text: tail } = interaction.footer;
  const mode = interaction.thread;
  const area = readStatusArea(raw);
  const draft = area.composerHint ? '' : area.composer || '';
  const lastActivity = lines
    .slice(0, prompt)
    .findLast((line) => /^\s*Worked for /.test(line) || matchActivityLine(line));
  const activity = matchActivityLine(lastActivity || '');
  const completed = /^\s*Worked for /.test(lastActivity || '');
  const empty = prompt >= 0 && !lines.slice(0, prompt).some((line) => line.trim());
  const { footer, ...facts } = interaction;
  return {
    mode,
    hasSide: interaction.hasSide,
    origin: interaction.origin,
    canClose: Boolean(
      mode === 'side' &&
      !interaction.modal &&
      !draft &&
      activity?.running !== true &&
      (/\^c to close\b/.test(tail) || completed || empty),
    ),
    inputOccupied: Boolean(draft),
    inputDigest: digest(draft),
    interaction: facts,
  };
}

class CodexSide {
  constructor({
    herdr,
    exactPane,
    operate = (_id, run) => run(),
    beforeOpen = async () => {},
    recoverUnknown,
    press,
    paste,
    settleMs = 50,
    diagnostics,
    native = nativeSide.request,
    receiptFile = null,
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      operate,
      beforeOpen,
      recoverUnknown,
      settleMs,
      diagnostics,
    });
    this.press =
      press ||
      ((id, keys) =>
        herdrRequest('agent.send_keys', { target: id, keys }, { socketFile: herdr.socketPath }));
    this.paste =
      paste ||
      ((id, text) =>
        herdrRequest(
          'pane.send_input',
          { pane_id: id, text, keys: [] },
          { socketFile: herdr.socketPath },
        ));
    this.native = native;
    this.receiptFile = receiptFile;
    this.nativeStates = new Map();
    this.structuredThreads = new Map();
    this.receipts = new Map();
    this.observations = new Map();
    this.epoch = randomUUID();
  }
  async read(pane) {
    if (!/^codex$/i.test(pane.agent?.label || '')) return { supported: false };
    const view = sideScreen(
      await this.herdr.readPane(pane.paneId, {
        source: 'recent',
        lines: 40,
        ansi: true,
        exact: true,
      }),
    );
    const native = await this.native(pane, 'state').catch(() => null);
    const known = this.nativeStates.get(pane.runtimeId);
    if (!native && known)
      Object.assign(view, { mode: 'unknown', structured: true, sideId: known.sideId });
    if (native) {
      this.nativeStates.set(pane.runtimeId, native);
      if (this.nativeStates.size > 512)
        this.nativeStates.delete(this.nativeStates.keys().next().value);
    }
    if (native) {
      const capabilityKey = `${pane.runtimeId}:${native.sideId}`;
      if (native.sideId && !this.structuredThreads.has(capabilityKey)) {
        const probe = await this.native(pane, 'read', native.sideId).catch(() => null);
        if (probe?.data?.thread?.id === native.sideId)
          this.structuredThreads.set(capabilityKey, true);
        if (this.structuredThreads.size > 512)
          this.structuredThreads.delete(this.structuredThreads.keys().next().value);
      }
      view.structured = !native.sideId || this.structuredThreads.get(capabilityKey) === true;
      view.sideId = native.sideId;
      view.turnId = native.turnId;
      view.mode =
        view.mode === 'unknown'
          ? 'unknown'
          : native.activeId === native.sideId && native.sideId
            ? 'side'
            : native.activeId === native.mainId
              ? 'main'
              : 'unknown';
      view.hasSide = Boolean(native.sideId);
    }
    const binding = Conversation.binding(pane);
    const state = `${binding}:${view.mode}:${view.hasSide}`;
    let observation = this.observations.get(pane.paneId);
    if (!observation || observation.state !== state) {
      observation = { state, generation: randomUUID() };
      this.observations.set(pane.paneId, observation);
      if (this.observations.size > 512)
        this.observations.delete(this.observations.keys().next().value);
    }
    return {
      supported: true,
      ...view,
      paneId: pane.paneId,
      binding,
      revision: digest([this.epoch, observation.generation, binding, view]),
    };
  }
  async transcript(pane) {
    const value = await this.native(pane, 'read');
    if (!value?.sideId)
      throw apiError(
        409,
        'SIDE_NATIVE_UNAVAILABLE',
        '当前 Codex 尚不支持临时聊天，请更新后恢复会话；现有终端仍可使用。',
      );
    if (Conversation.binding(await this.exactPane(pane.paneId)) !== Conversation.binding(pane))
      throw apiError(409, 'SESSION_CHANGED', '目标会话已改变。');
    const messages = nativeSide.messages(value.data.thread);
    for (const message of messages)
      for (const block of message.blocks)
        if (block.kind === 'tool') {
          for (const key of ['input', 'result'])
            if (block[key]?.text?.length > 4000)
              block[key] = {
                ...block[key],
                fullLength: block[key].text.length,
                text: block[key].text.slice(0, 4000),
                truncated: true,
              };
        }
    return {
      sideId: value.sideId,
      messages: require('./agent-transcript').textOnly(messages),
      hasMore: false,
    };
  }
  async tool(pane, sideId, id) {
    const value = await this.native(pane, 'read', sideId);
    if (
      !value ||
      value.sideId !== sideId ||
      Conversation.binding(await this.exactPane(pane.paneId)) !== Conversation.binding(pane)
    )
      throw apiError(409, 'SIDE_CHANGED', '临时会话已改变。');
    const tool = nativeSide
      .messages(value.data.thread, { toolTextLimit: Infinity })
      .flatMap((message) => message.blocks)
      .find((block) => block.kind === 'tool' && block.id === id);
    if (!tool) throw apiError(404, 'TOOL_NOT_FOUND', '临时会话没有这个工具调用。');
    return require('./agent-transcript').describeTool(tool);
  }
  async assertMain(pane, { requestId = '', recoverUnknown = false } = {}) {
    if (!/^codex$/i.test(pane.agent?.label || '')) return;
    const binding = Conversation.binding(pane);
    let view = await this.read(pane);
    const refuse = (code, message) => {
      const diagnosticId = this.diagnostics?.observe({
        source: 'prewrite',
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        binding,
        requestId,
        interaction: view.interaction,
        code,
      });
      throw Object.assign(apiError(409, code, message), diagnosticId ? { diagnosticId } : {});
    };
    const requireComposer = () => {
      const modal = view.interaction?.modal;
      if (modal)
        refuse(
          'QUESTION_PENDING',
          modal.numbered
            ? 'Codex 正在等待你选择当前原生选项，请先完成输入栏上方的确认。'
            : 'Codex 当前打开了原生表单或验证界面，请通过“原生界面”入口完成操作。',
        );
    };
    requireComposer();
    // A redraw can briefly hide the footer. Recheck only reads, with the full
    // identity validated each time; never authorize using a cached main state.
    for (let attempt = 0; view.mode === 'unknown' && attempt < 3; attempt++) {
      await delay(this.settleMs);
      const current = await this.exactPane(pane.paneId);
      if (Conversation.binding(current) !== binding)
        throw apiError(409, 'SESSION_CHANGED', '目标会话已改变，请重新选择会话后发送。');
      view = await this.read(current);
      requireComposer();
    }
    // Recovery is a caller-authorized prewrite action, never an observation.
    // Its return value is not input authority: only a fresh exact native read
    // under the original full identity can establish the main thread again.
    if (
      recoverUnknown === true &&
      typeof requestId === 'string' &&
      requestId.trim() &&
      typeof this.recoverUnknown === 'function'
    ) {
      const target = async () => {
        const current = await this.exactPane(pane.paneId);
        if (!current || Conversation.binding(current) !== binding)
          throw apiError(409, 'SESSION_CHANGED', '目标会话已改变，请重新选择会话后发送。');
        return current;
      };
      try {
        if (view.mode === 'unknown') {
          const current = await target();
          let recoveryFailed = false;
          try {
            await this.recoverUnknown({ pane: current, requestId, reason: 'prewrite-unknown' });
          } catch (error) {
            if (error?.code === 'SESSION_CHANGED') throw error;
            recoveryFailed = true;
          }
          const after = await target();
          view = await this.read(after);
          await target();
          if (recoveryFailed && !view.interaction?.modal) view = { ...view, mode: 'unknown' };
        } else if (view.mode === 'main') {
          // Explicit prewrite checks must also catch replacement during one
          // of the preceding readonly observations. Default callers keep the
          // existing observation-only path.
          await target();
        }
      } catch (error) {
        if (error?.code === 'SESSION_CHANGED') throw error;
        view = { ...view, mode: 'unknown' };
      }
    }
    if (view.mode === 'side')
      refuse('SIDE_ACTIVE', 'Codex 已切到临时会话。请切回主会话后再发送主会话输入。');
    requireComposer();
    if (view.mode !== 'main')
      refuse(
        'SIDE_UNKNOWN',
        '尚未确认当前原生输入位置，内容未发送，草稿已保留。Swift 正在重新检查。',
      );
    this.diagnostics?.observe({
      source: 'prewrite',
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      binding,
      requestId,
      interaction: view.interaction,
    });
  }
  async handle(body) {
    if (
      !body ||
      !['open', 'main', 'side', 'close', 'send', 'interrupt'].includes(body.action) ||
      !/^[\w-]{1,128}$/.test(body.requestId || '')
    )
      throw apiError(400, 'INVALID_SIDE_ACTION', '临时会话操作无效。');
    const key = `${body.binding}:${body.requestId}`,
      fingerprint = digest(body);
    const receipt = this.receipts.get(key);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw apiError(409, 'SIDE_REQUEST_CHANGED', '同一操作标识不能用于不同操作。');
      return receipt.promise;
    }
    const promise = this.operate(body.paneId, async () => {
      const target = async () => {
        const pane = await this.exactPane(body.paneId);
        if (
          !body.binding ||
          !pane.runtimeId ||
          Conversation.binding(pane) !== body.binding ||
          !/^codex$/i.test(pane.agent?.label || '')
        )
          throw apiError(409, 'SESSION_CHANGED', '目标会话已改变，请重新打开临时会话。');
        return pane;
      };
      let pane = await target(),
        view = await this.read(pane);
      let file, ledger, receiptKey, intent;
      const { writeJson } = require('./root-data');
      if (body.action === 'send') {
        file = this.receiptFile?.();
        ledger = null;
        if (file) {
          ledger = readReceipts(file);
        }
        receiptKey = digest([body.binding, body.requestId]);
        const prior = ledger?.receipts?.[receiptKey];
        intent = digest([body.sideId, body.text]);
        if (prior) {
          if (prior.intent !== intent)
            throw apiError(409, 'SIDE_REQUEST_CHANGED', '同一消息标识不能用于其他内容。');
          if (prior.submitted) return { ...view, submitted: true };
          throw apiError(
            409,
            'SIDE_INPUT_UNCONFIRMED',
            '上次临时消息结果尚未确认；不会自动重发，请查看终端。',
          );
        }
      }
      if (view.interaction?.modal) {
        const diagnosticId = this.diagnostics?.observe({
          source: 'prewrite',
          paneId: pane.paneId,
          terminalId: pane.terminalId,
          binding: body.binding,
          requestId: body.requestId,
          interaction: view.interaction,
          code: 'QUESTION_PENDING',
        });
        throw Object.assign(
          apiError(
            409,
            'QUESTION_PENDING',
            'Codex 当前原生界面正在等待操作，请先完成后再切换或结束临时会话。',
          ),
          diagnosticId ? { diagnosticId } : {},
        );
      }
      if (
        !body.revision ||
        (body.action !== 'send' && body.revision !== view.revision) ||
        view.mode === 'unknown'
      )
        throw apiError(409, 'SIDE_CHANGED', '原生会话已变化，请按当前页面重新操作。');
      if (
        (body.action === 'main' && view.mode === 'main') ||
        (body.action === 'side' && view.mode === 'side')
      )
        return view;
      if (body.action === 'open' && (view.mode !== 'main' || view.hasSide))
        throw apiError(409, 'SIDE_EXISTS', '临时会话已经存在，请切换到现有临时会话。');
      if (['main', 'side'].includes(body.action) && !view.hasSide)
        throw apiError(409, 'SIDE_CLOSED', '临时会话已结束。');
      if (body.action === 'close' && (view.mode !== 'side' || !view.canClose))
        throw apiError(
          409,
          'SIDE_NOT_CLOSABLE',
          '请先停止临时会话的执行，并处理原生输入框中未发送的内容。',
        );
      if (body.action === 'interrupt') {
        if (view.mode !== 'side') throw apiError(409, 'SIDE_CHANGED', '临时会话已切换。');
        if (!body.turnId) return view;
        await this.native(await target(), 'interrupt', view.sideId, undefined, body.turnId);
        return this.read(await target());
      }
      if (body.action === 'send') {
        if (view.mode !== 'side' || !view.structured || !body.sideId || body.sideId !== view.sideId)
          throw apiError(409, 'SIDE_CHANGED', '临时会话已改变，内容未发送。');
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000000)
          throw apiError(400, 'INVALID_SIDE_MESSAGE', '临时会话消息为空或过长。');

        const fresh = await this.native(await target(), 'state');
        if (fresh?.sideId !== body.sideId || fresh.activeId !== body.sideId)
          throw apiError(409, 'SIDE_CHANGED', '临时会话已切换，内容未发送。');
        if (ledger) {
          ledger = readReceipts(file);
          if (!ledger.receipts || Object.keys(ledger.receipts).length >= 10000)
            throw apiError(409, 'SIDE_RECEIPTS_FULL', '临时消息操作记录已满，请检查执行端。');
          ledger.receipts[receiptKey] = { intent, submitted: false };
          writeJson(file, ledger);
        }
        const result = await this.native(await target(), 'send', body.sideId, body.text);
        if (!result?.data?.submitted)
          throw apiError(
            409,
            'SIDE_INPUT_UNCONFIRMED',
            '临时消息的原生提交未确认；不会自动重发，请查看终端。',
          );
        if (ledger) {
          ledger = readReceipts(file);
          ledger.receipts[receiptKey].submitted = true;
          writeJson(file, ledger);
        }
        return { ...(await this.read(await target())), submitted: true };
      }
      if (body.action === 'open') {
        await this.beforeOpen(pane);
        pane = await target();
        if ((await this.read(pane)).revision !== view.revision)
          throw apiError(409, 'SIDE_CHANGED', '原生输入已变化，请重新操作。');
        await clearNativeComposer({
          pane,
          herdr: this.herdr,
          exactPane: target,
          press: (keys) => this.press(pane.paneId, keys),
          stepMs: this.settleMs,
        });
        await target();
        await this.paste(pane.paneId, '/side');
        for (let i = 0; i < 20; i++) {
          await delay(this.settleMs);
          await target();
          const raw = await this.herdr.readPane(pane.paneId, {
            source: 'recent',
            lines: 40,
            ansi: true,
            exact: true,
          });
          if (readStatusArea(raw).composer.trim() === '/side') break;
          if (i === 19)
            throw apiError(
              409,
              'SIDE_INPUT_UNCONFIRMED',
              '未确认原生 /side 输入，请在终端核对；不会自动重发。',
            );
        }
        await this.press(pane.paneId, ['enter']);
      } else {
        await target();
        await this.press(pane.paneId, [body.action === 'close' ? 'ctrl+c' : 'ctrl+/']);
      }
      for (let i = 0; i < 30; i++) {
        await delay(this.settleMs);
        pane = await target();
        view = await this.read(pane);
        if (
          (['open', 'side'].includes(body.action) && view.mode === 'side') ||
          (body.action === 'main' && view.mode === 'main') ||
          (body.action === 'close' && view.mode === 'main' && !view.hasSide)
        )
          return view;
      }
      throw apiError(
        409,
        'SIDE_UNCONFIRMED',
        '原生切换结果尚未确认，请查看当前页面；不会自动重发操作。',
      );
    });
    // Retain failures as well: a lost reply must never toggle twice or repeat Ctrl+C.
    this.receipts.set(key, { fingerprint, promise });
    if (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value);
    return promise;
  }
}
module.exports = { CodexSide, sideScreen };
