'use strict';

const { randomUUID } = require('node:crypto');
const { digest } = require('./codex-rewind-history');
const clone = (value) => structuredClone(value);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const error = (code, message, fields = {}) =>
  Object.assign(new Error(message), { status: 409, code, ...fields });
const validId = (value) => typeof value === 'string' && /^[\w-]{1,200}$/.test(value);
const identityOf = (pane, nativeTarget) => ({
  herdrRuntimeId: nativeTarget.runtimeId,
  paneId: pane.paneId,
  terminalId: pane.terminalId,
  processRuntimeId: pane.runtimeId,
  sessionId: pane.agent?.session?.value,
  provider: pane.agent?.label,
});
const orderOf = (history) =>
  history.targets.map((target) => [
    target.messageId,
    target.turnId,
    target.sourceRecordId || digest(target.sourceText),
  ]);

// This proves only that the durable rewind operation never entered native
// input. Queue status is checked separately: it is already `sending` when the
// controller receives an explicitly retried item.
function isRewindPreflightFailure(item) {
  const state = item?.rewindProgress,
    context = state?.context,
    identity = context?.identity;
  const nonempty = (value) => typeof value === 'string' && value.length > 0;
  if (!state || state.phase !== 'failed' || state.rewindPhase !== 'validated') return false;
  // Task085 wrote `selecting/nativeStarted:true` before calling native.select.
  // Only that known failed/validated format may omit nativeStarted. Other
  // absent flags and non-boolean values do not prove that no operation ran.
  if (Object.hasOwn(state, 'nativeStarted') && state.nativeStarted !== false) return false;
  for (const key of [
    'revertAttempted',
    'reverted',
    'sendAttempted',
    'cleanupRequired',
    'recoveryRequired',
    'messageSubmitted',
    'revertUncertain',
    'deliveryUncertain',
  ])
    if (state[key] !== false) return false;
  if (
    (Object.hasOwn(state, 'sendAccepted') && state.sendAccepted !== false) ||
    state.selection != null ||
    state.receipt != null
  )
    return false;
  if (
    !nonempty(item.id) ||
    !nonempty(item.text) ||
    !nonempty(item.rewind?.preparationId) ||
    context?.preparationId !== item.rewind.preparationId ||
    !identity ||
    identity.provider !== 'codex'
  )
    return false;
  for (const key of ['herdrRuntimeId', 'paneId', 'terminalId', 'processRuntimeId', 'sessionId'])
    if (!nonempty(identity[key])) return false;
  if (
    item.paneId !== identity.paneId ||
    item.terminalId !== identity.terminalId ||
    item.runtimeId !== identity.processRuntimeId ||
    item.sessionId !== identity.sessionId ||
    item.agent !== identity.provider
  )
    return false;
  const target = context.target,
    nativeTarget = context.nativeTarget;
  if (
    !nonempty(context.scopeHash) ||
    !nonempty(context.historyRevision) ||
    !Array.isArray(context.prefix) ||
    target?.supported !== true ||
    !nonempty(target.messageId) ||
    !nonempty(target.turnId) ||
    !nonempty(target.sourceText) ||
    !nativeTarget ||
    nativeTarget.messageId !== target.messageId ||
    nativeTarget.paneId !== identity.paneId ||
    nativeTarget.terminalId !== identity.terminalId ||
    nativeTarget.runtimeId !== identity.herdrRuntimeId ||
    nativeTarget.sessionId !== identity.sessionId
  )
    return false;
  return true;
}

class RewindInteraction {
  constructor({
    target,
    readHistory,
    native,
    beforeWrite = async () => {},
    scope = () => '',
    now = Date.now,
    preparationTtlMs = 30 * 60 * 1000,
    maxPreparations = 256,
    timeoutMs = 8000,
    historyRetryMs = 1500,
    stepMs = 60,
  }) {
    Object.assign(this, {
      target,
      readHistory,
      native,
      beforeWrite,
      scope,
      now,
      preparationTtlMs,
      maxPreparations,
      timeoutMs,
      historyRetryMs,
      stepMs,
    });
    this.preparations = new Map();
    this.prepareReceipts = new Map();
    this.running = new Map();
    this.busy = new Set();
    this.barriers = new Map();
  }

  async readStable(read) {
    const deadline = performance.now() + this.historyRetryMs;
    while (true) {
      try {
        return await read();
      } catch (cause) {
        if (cause.code !== 'ARCHIVE_CHANGED' || performance.now() >= deadline) throw cause;
        await delay(this.stepMs);
      }
    }
  }

  async history(pane) {
    const history = await this.readStable(() => this.readHistory(pane));
    if (
      !history?.complete ||
      !Array.isArray(history.targets) ||
      typeof history.revision !== 'string'
    )
      throw error(
        'REWIND_HISTORY_UNVERIFIED',
        '暂时无法准确对应原生消息，请等待记录同步后再编辑。',
      );
    return history;
  }

  async closeNative(pane) {
    if (!pane) return;
    try {
      await this.native.close?.({ pane });
    } catch {
      /* Observer cleanup must not replace a durable operation result. */
    }
  }

  async observeRead(pane, fields = {}) {
    try {
      return await this.readStable(() => this.native.read({ pane, ...fields }));
    } finally {
      await this.closeNative(pane);
    }
  }

  async prepare(body) {
    if (
      !validId(body?.requestId) ||
      !validId(body?.clientId) ||
      typeof body?.messageId !== 'string' ||
      !body.messageId
    )
      throw error('INVALID_REWIND_PREPARATION', '缺少有效的编辑请求或原消息标识。');
    const scopeHash = digest(this.scope()),
      key = `${scopeHash}:${body.clientId}:${body.requestId}`,
      fingerprint = digest(body);
    this.prune();
    const previous = this.prepareReceipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw error('REWIND_REQUEST_CHANGED', '同一编辑请求不能用于另一条消息。');
      this.prepareReceipts.delete(key);
      this.prepareReceipts.set(key, previous);
      return previous.promise;
    }
    const promise = (async () => {
      const pane = await this.target(body);
      if (
        pane.agent?.label !== 'codex' ||
        !pane.runtimeId ||
        !pane.terminalId ||
        !pane.agent?.session?.value
      )
        throw error('REWIND_UNSUPPORTED', '当前会话没有可核验的 Codex 消息回退身份。');
      const identity = identityOf(pane, body),
        history = await this.history(pane);
      const matches = history.targets.filter((target) => target.messageId === body.messageId);
      if (matches.length !== 1)
        throw error('REWIND_MESSAGE_CHANGED', '这条消息已不在当前原生历史中，请刷新后重新选择。');
      const target = matches[0];
      if (!target.supported || !target.turnId || !target.sourceText?.trim())
        throw error(
          'REWIND_MESSAGE_UNSUPPORTED',
          target.reason || '这条消息暂时无法无损回填，请在原生界面编辑。',
        );
      if (
        digest(identityOf(await this.target(body), body)) !== digest(identity) ||
        digest(this.scope()) !== scopeHash
      )
        throw error('SESSION_CHANGED', '会话或根目录已改变，请重新选择消息。');
      const firstInTurn = history.targets.findIndex((item) => item.turnId === target.turnId);
      const preparation = {
        id: randomUUID(),
        requestId: body.requestId,
        clientId: body.clientId,
        messageId: target.messageId,
        sourceText: target.sourceText,
        historyRevision: history.revision,
        identity,
        nativeTarget: clone(body),
        target: clone(target),
        scopeHash,
        prefix: orderOf(history).slice(0, firstInTurn),
        expiresAt: this.now() + this.preparationTtlMs,
        claimedBy: null,
        cancelled: false,
      };
      this.preparations.set(preparation.id, preparation);
      this.prune();
      return { ok: true, preparation: this.publicPreparation(preparation) };
    })();
    this.prepareReceipts.set(key, {
      fingerprint,
      promise,
      expiresAt: this.now() + this.preparationTtlMs,
    });
    promise.catch(() => {
      if (this.prepareReceipts.get(key)?.promise === promise) this.prepareReceipts.delete(key);
    });
    // Preparations are read-only and can safely expire. Completed write receipts
    // are stored separately in the durable MessageQueue, never evicted here.
    this.prune();
    return promise;
  }

  prune() {
    for (const [id, entry] of this.preparations)
      if (entry.expiresAt < this.now() && !this.running.has(entry.claimedBy))
        this.preparations.delete(id);
    for (const [id, entry] of this.prepareReceipts)
      if (entry.expiresAt < this.now()) this.prepareReceipts.delete(id);
    for (const map of [this.preparations, this.prepareReceipts])
      while (map.size > this.maxPreparations) {
        const oldest = [...map].find(
          ([_id, entry]) => !entry.claimedBy || !this.running.has(entry.claimedBy),
        );
        if (!oldest) break;
        map.delete(oldest[0]);
      }
  }

  publicPreparation(value) {
    return {
      id: value.id,
      messageId: value.messageId,
      sourceText: value.sourceText,
      historyRevision: value.historyRevision,
      identity: clone(value.identity),
      expiresAt: value.expiresAt,
    };
  }

  cancel({ preparationId, clientId }) {
    const preparation = this.preparations.get(preparationId);
    if (!preparation || preparation.clientId !== clientId)
      throw error('REWIND_PREPARATION_EXPIRED', '编辑准备已失效。');
    if (preparation.claimedBy)
      throw error('REWIND_SUBMIT_STARTED', '提交已经开始，请先核对操作结果。');
    preparation.cancelled = true;
    return { ok: true, cancelled: true };
  }

  async resumePreparation(item) {
    // Only MessageQueue can authorize this path for an explicit retry of an
    // existing durable request. A normal receipt lookup never creates a new
    // preparation, and progress after any native operation never qualifies.
    if (item.rewindPreflightRetry !== true || !isRewindPreflightFailure(item)) return null;
    const context = clone(item.rewindProgress.context),
      body = context.nativeTarget;
    try {
      if (!validId(body.clientId) || !validId(body.requestId))
        throw error(
          'REWIND_PREPARATION_EXPIRED',
          '缺少可核验的编辑准备，草稿已保留，请重新选择原消息。',
        );
      if (digest(this.scope()) !== context.scopeHash)
        throw error('REWIND_SCOPE_CHANGED', '根目录已改变，请重新选择原消息。');
      const pane = await this.target(body);
      if (digest(identityOf(pane, body)) !== digest(context.identity))
        throw error('SESSION_CHANGED', '原生会话或进程已改变，未继续提交。');
      const history = await this.history(pane),
        matches = history.targets.filter((target) => target.messageId === context.target.messageId);
      if (
        history.revision !== context.historyRevision ||
        matches.length !== 1 ||
        digest(matches[0]) !== digest(context.target) ||
        digest(
          orderOf(history).slice(
            0,
            history.targets.findIndex((target) => target.turnId === context.target.turnId),
          ),
        ) !== digest(context.prefix)
      )
        throw error('REWIND_HISTORY_CHANGED', '原生用户历史已改变，草稿已保留，请重新选择原消息。');
      if (
        digest(this.scope()) !== context.scopeHash ||
        digest(identityOf(await this.target(body), body)) !== digest(context.identity)
      )
        throw error('SESSION_CHANGED', '会话或根目录已改变，请重新选择原消息。');
      const preparation = {
        id: context.preparationId,
        requestId: body.requestId,
        clientId: body.clientId,
        messageId: context.target.messageId,
        sourceText: context.target.sourceText,
        historyRevision: context.historyRevision,
        identity: context.identity,
        nativeTarget: body,
        target: context.target,
        scopeHash: context.scopeHash,
        prefix: context.prefix,
        expiresAt: this.now() + this.preparationTtlMs,
        claimedBy: null,
        cancelled: false,
      };
      this.preparations.set(preparation.id, preparation);
      this.prune();
      return preparation;
    } catch (cause) {
      throw Object.assign(cause, { deliveryUncertain: false, retryable: false });
    }
  }

  restore(item) {
    const state = item.rewindProgress,
      paneId = state?.context?.identity?.paneId;
    if (!paneId) return false;
    const entries = this.barriers.get(paneId) || new Map();
    if (state.phase === 'submitted' || isRewindPreflightFailure(item)) entries.delete(item.id);
    else entries.set(item.id, clone(item));
    if (entries.size) {
      this.barriers.set(paneId, entries);
      this.busy.add(paneId);
    } else {
      this.barriers.delete(paneId);
      this.busy.delete(paneId);
    }
    return entries.size > 0;
  }

  async ensureAvailable(pane) {
    const entries = this.barriers.get(pane.paneId);
    if (!entries?.size) {
      if (this.busy.has(pane.paneId))
        throw error('REWIND_BUSY', '原生消息回退正在提交，请稍后再发送。', {
          deliveryUncertain: false,
        });
      return;
    }
    for (const item of entries.values()) {
      if (this.running.has(item.id))
        throw error('REWIND_BUSY', '原生消息回退正在提交，请稍后再发送。', {
          deliveryUncertain: false,
        });
      const previous = item.rewindProgress.context.identity;
      if (pane.runtimeId && pane.runtimeId !== previous.processRuntimeId) {
        entries.delete(item.id);
        continue;
      }
      let view;
      try {
        view = await this.observeRead(pane, { target: item.rewindProgress.context.target });
      } catch (cause) {
        throw Object.assign(cause, { deliveryUncertain: false });
      }
      if (view?.mode === 'main' && view.input === '') entries.delete(item.id);
      else
        throw error(
          'REWIND_RECOVERY_REQUIRED',
          '原生编辑状态尚未结束，请先核对终端；本条消息未发送。',
          { deliveryUncertain: false },
        );
    }
    if (!entries.size) {
      this.barriers.delete(pane.paneId);
      this.busy.delete(pane.paneId);
    }
  }

  submit(item, progress) {
    const fingerprint = digest([item.id, item.paneId, item.sessionId, item.text, item.rewind]);
    const existing = this.running.get(item.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(
          error('REWIND_REQUEST_CHANGED', '同一消息标识不能用于不同编辑提交。'),
        );
      return existing.promise;
    }
    const pending = this.apply(item, progress).finally(() => this.running.delete(item.id));
    this.running.set(item.id, { fingerprint, promise: pending, paneId: item.paneId });
    return pending;
  }

  async apply(item, progress) {
    // Codex routes these prefixes to commands or shell execution. There is no
    // verified literal submit key; reject before any rewind or native input.
    const leading =
      typeof item.text === 'string' ? item.text.replace(/^[\p{White_Space}\uFEFF]+/u, '') : '';
    if (!item.text?.trim() || /^[/!]/.test(leading))
      throw error(
        'REWIND_LITERAL_MESSAGE_REQUIRED',
        '编辑后的消息不能以 / 或 ! 开头，草稿已保留。',
        { deliveryUncertain: false, retryable: false },
      );
    if (typeof progress !== 'function')
      throw error('REWIND_RECEIPT_REQUIRED', '无法持久化回退操作，未修改原生会话。', {
        deliveryUncertain: false,
        retryable: false,
      });
    if (item.rewindProgress && !isRewindPreflightFailure(item)) {
      if (item.rewindProgress.phase === 'submitted') return item.rewindProgress.receipt || {};
      let observation;
      try {
        observation = await this.recover(item);
      } catch (cause) {
        observation = {
          phase: 'unknown',
          code: cause.code || 'REWIND_READ_FAILED',
          readOnly: true,
        };
      }
      throw error(
        'REWIND_RECOVERY_REQUIRED',
        '上次回退已有操作记录，请先核对结果；不会再次回退或发送。',
        {
          retryable: false,
          deliveryUncertain: Boolean(item.rewindProgress.sendAttempted),
          rewindObservation: observation,
        },
      );
    }
    const preparation =
      this.preparations.get(item.rewind?.preparationId) || (await this.resumePreparation(item));
    if (!preparation || preparation.cancelled || preparation.expiresAt < this.now())
      throw error('REWIND_PREPARATION_EXPIRED', '编辑准备已失效，草稿已保留，请重新选择原消息。', {
        deliveryUncertain: false,
        retryable: false,
      });
    if (preparation.claimedBy && preparation.claimedBy !== item.id)
      throw error('REWIND_PREPARATION_USED', '这次编辑准备已用于另一条提交，请先核对结果。', {
        deliveryUncertain: false,
        retryable: false,
      });
    const identity = preparation.identity;
    if (
      item.paneId !== identity.paneId ||
      item.terminalId !== identity.terminalId ||
      item.runtimeId !== identity.processRuntimeId ||
      item.sessionId !== identity.sessionId ||
      item.agent !== identity.provider
    )
      throw error('SESSION_CHANGED', '提交消息与原编辑目标不一致，草稿已保留。', {
        deliveryUncertain: false,
        retryable: false,
      });
    const context = {
      preparationId: preparation.id,
      identity,
      nativeTarget: preparation.nativeTarget,
      scopeHash: preparation.scopeHash,
      target: preparation.target,
      historyRevision: preparation.historyRevision,
      prefix: preparation.prefix,
    };
    if (item.rewindProgress && digest(item.rewindProgress.context) !== digest(context))
      throw error('REWIND_REQUEST_CHANGED', '编辑准备与原提交记录不一致，请重新选择原消息。', {
        deliveryUncertain: false,
        retryable: false,
      });
    let state = {
        phase: 'validated',
        context,
        nativeStarted: false,
        revertAttempted: false,
        reverted: false,
        sendAttempted: false,
      },
      pane,
      history,
      selection,
      selectStarted = false;
    const checkpoint = async (phase, fields = {}) => {
      const next = { ...state, ...fields, phase, updatedAt: this.now() };
      await progress({ rewindProgress: clone(next) });
      state = next;
      this.restore({ ...item, rewindProgress: next });
    };
    const verifyIdentity = async () => {
      if (digest(this.scope()) !== context.scopeHash)
        throw error('REWIND_SCOPE_CHANGED', '根目录已改变，请重新选择原消息。');
      const current = await this.target(context.nativeTarget);
      if (digest(identityOf(current, context.nativeTarget)) !== digest(identity))
        throw error('SESSION_CHANGED', '原生会话或进程已改变，未继续提交。');
      return current;
    };
    const verifyBeforeRevert = async () => {
      const current = await verifyIdentity(),
        snapshot = await this.history(current);
      if (snapshot.revision !== context.historyRevision)
        throw error('REWIND_HISTORY_CHANGED', '原生用户历史已改变，草稿已保留，请重新选择原消息。');
      return current;
    };
    const verifyAfterRevert = async () => {
      const current = await verifyIdentity(),
        snapshot = await this.history(current);
      if (digest(orderOf(snapshot)) !== digest(context.prefix))
        throw error('REWIND_HISTORY_CHANGED', '回退后的原生历史已再次改变，消息未继续发送。');
      return current;
    };
    this.busy.add(identity.paneId);
    try {
      pane = await verifyBeforeRevert();
      history = await this.history(pane);
      await this.beforeWrite(pane, { requestId: item.id });
      pane = await verifyBeforeRevert();
      preparation.claimedBy = item.id;
      await checkpoint('selecting', { nativeStarted: true });
      selectStarted = true;
      selection = await this.native.select({
        pane,
        target: preparation.target,
        history,
        verify: verifyBeforeRevert,
      });
      if (
        selection?.messageId !== preparation.messageId ||
        selection?.turnId !== preparation.target.turnId
      )
        throw error('REWIND_SELECTION_UNVERIFIED', '尚未准确选中原消息，未确认回退。');
      await checkpoint('selected', { selection: clone(selection) });
      pane = await verifyBeforeRevert();
      // The caller persists this marker before the first irreversible Enter.
      // It can also invalidate ordinary sends queued before this rewind.
      await checkpoint('revert_pending', { revertAttempted: true });
      await this.native.confirm({
        pane,
        target: preparation.target,
        selection,
        verify: verifyBeforeRevert,
      });
      const deadline = performance.now() + this.timeoutMs;
      do {
        pane = await verifyIdentity();
        const current = await this.history(pane);
        if (digest(orderOf(current)) === digest(context.prefix)) {
          state.reverted = true;
          break;
        }
        if (current.revision !== context.historyRevision)
          throw error('REWIND_HISTORY_CHANGED', '原生历史已改变，但未能确认所选回退边界。');
        await delay(this.stepMs);
      } while (performance.now() < deadline);
      if (!state.reverted)
        throw error('REWIND_REVERT_UNCONFIRMED', '回退结果尚未确认，消息未发送；不会重复回退。');
      await checkpoint('reverted', { reverted: true });
      pane = await verifyAfterRevert();
      await this.native.replace({
        pane,
        sourceText: preparation.sourceText,
        text: item.text,
        verify: verifyAfterRevert,
      });
      await checkpoint('draft_ready');
      pane = await verifyAfterRevert();
      await checkpoint('send_pending', { sendAttempted: true });
      const receipt = await this.native.send({ pane, text: item.text, verify: verifyAfterRevert });
      state = { ...state, sendAccepted: true, receipt: clone(receipt || {}) };
      await checkpoint('submitted', { receipt: clone(receipt || {}) });
      return receipt || {};
    } catch (cause) {
      let cleanupRequired = false;
      if (selectStarted && !state.revertAttempted) {
        try {
          pane = await verifyBeforeRevert();
          if (!this.native.cancel)
            throw error('REWIND_CLEANUP_UNAVAILABLE', '请先在终端中取消消息选择。');
          await this.native.cancel({
            pane,
            target: preparation.target,
            selection,
            history,
            verify: verifyBeforeRevert,
          });
        } catch {
          cleanupRequired = true;
        }
      }
      const fields = {
        retryable: false,
        deliveryUncertain: Boolean(state.sendAttempted),
        reverted: state.reverted,
        revertUncertain: state.revertAttempted && !state.reverted,
        messageSubmitted: state.sendAccepted ? true : state.sendAttempted ? null : false,
        rewindPhase: state.phase,
        cleanupRequired,
        recoveryRequired: state.revertAttempted && state.phase !== 'submitted',
      };
      fields.retryable = isRewindPreflightFailure({
        ...item,
        rewindProgress: { ...state, ...fields, phase: 'failed' },
      });
      if (state.reverted && !state.sendAttempted)
        cause.message = '原生会话已回退，编辑后的消息尚未发送，草稿已保留。';
      state = { ...state, cleanupRequired, recoveryRequired: fields.recoveryRequired };
      try {
        await checkpoint('failed', {
          error: { code: cause.code || 'REWIND_FAILED', message: cause.message },
          ...fields,
        });
      } catch {
        fields.retryable = false;
      }
      throw Object.assign(cause, fields);
    } finally {
      await this.closeNative(pane);
      if (!state.cleanupRequired && !state.recoveryRequired) {
        this.barriers.get(identity.paneId)?.delete(item.id);
        if (!this.barriers.get(identity.paneId)?.size) {
          this.barriers.delete(identity.paneId);
          this.busy.delete(identity.paneId);
        }
      }
    }
  }

  async recover(item) {
    const state = item.rewindProgress,
      context = state?.context;
    if (!context)
      return { phase: 'unstarted', reverted: false, messageSubmitted: false, readOnly: true };
    if (digest(this.scope()) !== context.scopeHash)
      return { phase: 'unknown', code: 'REWIND_SCOPE_CHANGED', readOnly: true };
    const pane = await this.target(context.nativeTarget);
    if (digest(identityOf(pane, context.nativeTarget)) !== digest(context.identity)) {
      this.busy.delete(context.identity.paneId);
      return { phase: 'unknown', code: 'SESSION_CHANGED', readOnly: true };
    }
    const history = await this.history(pane),
      order = orderOf(history);
    const original = history.revision === context.historyRevision,
      reverted = digest(order) === digest(context.prefix);
    const native = this.native.read
      ? await this.observeRead(pane, { target: context.target, history })
      : null;
    if (state.cleanupRequired || state.recoveryRequired) this.busy.add(context.identity.paneId);
    if (
      state.phase === 'submitted' ||
      (native?.mode === 'main' && native.input === '' && (original || reverted))
    )
      this.busy.delete(context.identity.paneId);
    return {
      phase: state.phase,
      originalHistory: original,
      reverted: state.reverted || reverted,
      revertUncertain: Boolean(state.revertAttempted && !state.reverted && !original && !reverted),
      messageSubmitted:
        state.phase === 'submitted' || state.sendAccepted
          ? true
          : state.sendAttempted
            ? null
            : false,
      deliveryUncertain: Boolean(state.sendAttempted && state.phase !== 'submitted'),
      native,
      readOnly: true,
    };
  }
}

module.exports = { RewindInteraction, isRewindPreflightFailure };
