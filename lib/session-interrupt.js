'use strict';
const { createHash } = require('node:crypto');
const { codexFooter, hasCodexModelAndDirectory } = require('./codex-footer');
const { matchActivityLine, stripAnsi } = require('../public/ansi');
const { sideScreen } = require('./codex-side');
const { interruptPane } = require('./herdr-input');
const { isRule } = require('./agent-composer');
const { apiError } = require('./message-queue');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function runningScreen(raw, provider = 'codex') {
  if (/^claude$/i.test(provider)) {
    const lines = stripAnsi(raw).split('\n'),
      prompt = lines.findLastIndex((line) => /^\s*❯/.test(line));
    if (prompt < 0) return false;
    const before = lines.slice(0, prompt);
    while (before.length && (!before.at(-1).trim() || isRule(before.at(-1)))) before.pop();
    if (/^\s*⎿\s*Tip:/.test(before.at(-1) || '')) before.pop();
    while (before.length && !before.at(-1).trim()) before.pop();
    return matchActivityLine(before.at(-1) || '')?.running === true;
  }
  const { lines, prompt, fields } = codexFooter(raw);
  if (prompt < 0 || !hasCodexModelAndDirectory(fields) || sideScreen(raw).mode !== 'main')
    return false;
  // A historical Working line is not an active turn. The current activity is
  // immediately above the composer, with only blank lines between them.
  const line = lines.slice(0, prompt).findLast((line) => line.trim());
  return matchActivityLine(line || '')?.running === true && /esc to interrupt/i.test(line);
}
class SessionInterrupt {
  constructor({
    herdr,
    exactPane,
    readTurn,
    operate = (_id, work) => work(),
    beforeWrite = async () => {},
    interrupt = interruptPane,
    onInterrupted = () => {},
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      readTurn,
      operate,
      beforeWrite,
      interrupt,
      onInterrupted,
    });
    this.receipts = new Map();
    this.interruptedTurns = new Map();
  }
  async target(body) {
    const runtimeId = this.herdr.normalizeSnapshot
      ? this.herdr.normalizeSnapshot({}).runtimeId
      : (await this.herdr.dashboard()).runtimeId;
    if (!body?.runtimeId || body.runtimeId !== runtimeId)
      throw apiError(409, 'RUNTIME_CHANGED', 'Herdr 运行实例已改变，请重新打开菜单。');
    const pane = await this.exactPane(body.paneId);
    if (
      !/^(?:codex|claude)$/i.test(pane?.agent?.label || '') ||
      !pane.runtimeId ||
      !body.terminalId ||
      pane.terminalId !== body.terminalId ||
      !body.sessionId ||
      pane.agent.session?.value !== body.sessionId
    )
      throw apiError(409, 'SESSION_CHANGED', '中断目标会话已改变，请重新打开菜单。');
    return pane;
  }
  async inspect(body) {
    const pane = await this.target(body);
    const processRuntimeId = pane.runtimeId;
    const [raw, turnId] = await Promise.all([
      this.herdr.readPane(pane.paneId, { source: 'recent', lines: 60, ansi: true, exact: true }),
      this.readTurn(pane),
    ]);
    const current = await this.target(body);
    if (current.runtimeId !== processRuntimeId)
      throw apiError(409, 'SESSION_CHANGED', 'Agent 进程已改变，请重新打开菜单。');
    const key = digest([body.runtimeId, pane.terminalId, body.sessionId, processRuntimeId]);
    const canInterrupt = Boolean(
      turnId &&
      pane.agent.interactiveReady !== false &&
      !pane.agent.launchPending &&
      runningScreen(raw, pane.agent.label) &&
      this.interruptedTurns.get(key) !== turnId,
    );
    return { pane, key, turnId, canInterrupt, processRuntimeId };
  }
  async preview(body) {
    const { canInterrupt, turnId, processRuntimeId } = await this.inspect(body);
    return { ok: true, canInterrupt, turnId, processRuntimeId };
  }
  receipt(body) {
    const entry = this.receipts.get(body?.requestId);
    if (
      !entry ||
      entry.body.paneId !== body.paneId ||
      entry.body.sessionId !== body.sessionId ||
      (body.terminalId && entry.body.terminalId !== body.terminalId)
    )
      throw apiError(
        404,
        'INTERRUPT_RECEIPT_UNKNOWN',
        '无法确认这次中断结果，请查看当前原生状态；不会重复发送中断。',
      );
    return {
      ok: true,
      status: entry.status,
      ...(entry.result ? { result: entry.result } : {}),
      ...(entry.error ? { message: entry.error.message, deliveryUncertain: entry.written } : {}),
    };
  }
  async run(body) {
    if (!/^[\w-]{1,128}$/.test(body?.requestId || ''))
      throw apiError(400, 'INTERRUPT_REQUEST_REQUIRED', '缺少中断操作标识。');
    const fingerprint = digest(body),
      previous = this.receipts.get(body.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw apiError(409, 'INTERRUPT_REQUEST_CHANGED', '同一操作标识不能用于其他会话。');
      return previous.promise;
    }
    const entry = { fingerprint, body: { ...body }, status: 'pending', written: false };
    const promise = (async () => {
      // Resolve the live turn when this request arrives, before waiting for
      // the shared input lock. A queued stop must not stop a later turn.
      const turnId = body.currentTurn === true ? (await this.inspect(body)).turnId : body.turnId;
      return this.operate(body.paneId, async () => {
        let view = await this.inspect(body);
        if (view.processRuntimeId !== body.processRuntimeId)
          throw apiError(409, 'TURN_CHANGED', '当前消息轮次或进程已改变，请重新打开菜单。');
        if (!view.turnId) return { ok: true, interrupted: false };
        if (!turnId || view.turnId !== turnId) {
          if (body.currentTurn === true)
            return { ok: true, interrupted: false, reason: 'turn-changed' };
          throw apiError(409, 'TURN_CHANGED', '当前消息轮次已改变，请重新打开菜单。');
        }
        if (!view.canInterrupt) return { ok: true, interrupted: false, reason: 'native-state' };
        await this.beforeWrite(view.pane);
        view = await this.inspect(body);
        if (view.processRuntimeId !== body.processRuntimeId)
          throw apiError(409, 'TURN_CHANGED', '当前消息轮次或进程已改变，请重新打开菜单。');
        if (!view.turnId) return { ok: true, interrupted: false };
        if (view.turnId !== turnId) {
          if (body.currentTurn === true)
            return { ok: true, interrupted: false, reason: 'turn-changed' };
          throw apiError(409, 'TURN_CHANGED', '当前消息轮次已改变，请重新打开菜单。');
        }
        if (!view.canInterrupt) return { ok: true, interrupted: false, reason: 'native-state' };
        // Mark before writing: an uncertain reply must never turn another Esc
        // into navigation of past messages. A new native turn has another token.
        this.interruptedTurns.set(view.key, view.turnId);
        if (this.interruptedTurns.size > 512)
          this.interruptedTurns.delete(this.interruptedTurns.keys().next().value);
        entry.written = true;
        await this.interrupt(view.pane.paneId, { socketFile: this.herdr.socketPath });
        this.onInterrupted(view.pane);
        return { ok: true, interrupted: true };
      });
    })();
    entry.promise = promise;
    promise.then(
      (result) => {
        entry.status = 'complete';
        entry.result = result;
      },
      (error) => {
        entry.status = 'failed';
        entry.error = error;
        error.deliveryUncertain = entry.written;
      },
    );
    this.receipts.set(body.requestId, entry);
    if (this.receipts.size > 512) this.receipts.delete(this.receipts.keys().next().value);
    return promise;
  }
}
module.exports = { SessionInterrupt, runningScreen };
