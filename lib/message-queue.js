'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isRewindPreflightFailure } = require('./rewind-interaction');

function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function sessionOf(pane) {
  const session = pane?.agent?.session;
  if (!pane?.agent?.label || session?.kind === 'path') return null;
  const sessionId = session?.value || null;
  const agentName = pane.agent.name || null;
  // Before a first turn there may be no archive or session id. In that case a
  // named occupant and terminal id are required; a bare shell is never a target.
  if (!sessionId && (!pane.terminalId || !agentName)) return null;
  return {
    agent: pane.agent.label,
    agentName,
    sessionId,
    ...(pane.runtimeId ? { runtimeId: pane.runtimeId } : {}),
    terminalId: pane.terminalId || null,
  };
}
/**
 * 这条队列项的目标，是否还是当下这个 pane 里的同一个会话。
 *
 * ⚠️ `terminalId` **不能**单独当作会话身份。运行时热交接（`server.live_handoff`）
 * 会给每个 pane 换一个新的 terminalId，而它并不中断 Agent 进程：shell 与前台
 * 进程的 PID 都保持不变。2026-09-22 的实测确认，用同一个二进制交接也会换。
 * 此前这里无条件要求 terminalId 相等，于是每次交接都会把未投递的消息标成
 * `failed/orphaned`，白白作废。
 *
 * 真正能证明身份的是两样：原生会话 ID（Agent 自己的身份）和进程身份
 * `pid:starttime`（交接后不变）。两者任一匹配即认定同一会话；首轮之前两样都
 * 没有，才退回 terminalId 加占用者名字这条弱判据。
 */
function sameSession(item, pane) {
  const current = sessionOf(pane);
  if (!current || current.agent !== item.agent) return false;
  // 任何一样对不上就是换了会话，不管另一样是否匹配。
  if (item.sessionId && current.sessionId !== item.sessionId) return false;
  if (item.runtimeId && current.runtimeId !== item.runtimeId) return false;
  if (item.sessionId || item.runtimeId) return true;
  return current.terminalId === item.terminalId && current.agentName === item.agentName;
}
// Slash commands are terminal actions; an input receipt, not a user archive
// record, completes their delivery. They must never be combined with prompts.
function isCommand(text) {
  return /^\/[a-z][\w:.-]*(?:[ \t]|$)/i.test(text);
}
// Codex handles /goal in its composer during an active turn. Keep that native
// control path distinct from ordinary prompts and commands that require idle.
function isLiveGoal(item) {
  return item.agent === 'codex' && /^\/goal(?:[ \t]|$)/.test(item.text);
}
function normalizeText(text) {
  return text.replace(/\r\n/g, '\n');
}
// 终端提交会把**两头**的空白都去掉。基线摘要保持原样不动，但比对送出去的内容时
// 要按它实际的行为来。
//
// ⚠️ 这里原来只去尾（`trimEnd`），于是**带前导空白的消息永远确认不了**：存档里
// 记下的是去掉前导空白之后的正文，逐字比对必然不等，60 秒后按 ACK_TIMEOUT 判失败，
// 而消息其实已经送到了。2026-09-22 实测：队列文本 `"  这些不要 …"`，存档 prompt
// 是 `"这些不要 …"`，只差两个前导空格。
function sameText(a, b) {
  return normalizeText(a).trim() === normalizeText(b).trim();
}
/** 用户消息送进终端时的原文。附件被拆成图片块后，原文在 `sourceText` 里（见 agent-transcript 的 textOnly）。 */
function userText(message) {
  return (
    message.sourceText ??
    message.blocks
      .filter((block) => block.kind === 'text')
      .map((block) => block.text)
      .join('\n')
  );
}
function userTexts(messages) {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => normalizeText(userText(message)));
}
function digest(values) {
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
function rewindIntent(value) {
  if (value === undefined || value === null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'preparationId') ||
    typeof value.preparationId !== 'string' ||
    !/^[\w-]{1,128}$/.test(value.preparationId)
  )
    throw apiError(400, 'INVALID_REWIND', '历史消息编辑标识无效，请重新选择要编辑的消息。');
  return { preparationId: value.preparationId };
}
function sameRewind(a, b) {
  return (a?.preparationId || null) === (b?.preparationId || null);
}
function canRetry(item) {
  if (item.status !== 'failed') return false;
  if (item.rewind) return item.deliveryUncertain === false && isRewindPreflightFailure(item);
  return !item.deliveryUncertain && item.retryable;
}
function retryableFailure(item, error) {
  return (
    error.retryable !== false &&
    error.deliveryUncertain === false &&
    (!item.rewind || isRewindPreflightFailure(item))
  );
}
function readQueueFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('消息队列文件格式不正确。');
  return data.items;
}
function transportAccepted(item) {
  return item.transportAcceptedAt != null || item.error?.code === 'ACK_TIMEOUT';
}
function discardedFields(item, now) {
  return {
    status: 'discarded',
    historyDiscardedAt: item.historyDiscardedAt ?? now,
    deliveryUncertain: false,
    retryable: false,
    error: null,
  };
}
function canSend(pane, item) {
  if (item.paused) return false;
  if (pane.agent?.interactiveReady === false || pane.agent?.launchPending) return false;
  const status = pane.agent?.status || pane.status;
  return (
    ['idle', 'done'].includes(status) ||
    (status === 'working' &&
      item.sessionId &&
      item.deliveryRequestedAt != null &&
      (!isCommand(item.text) || isLiveGoal(item)))
  );
}

/** A durable outbox. A successful terminal write is not an acknowledgement. */
class MessageQueue {
  constructor({
    file,
    store = null,
    getPane,
    getNativePane = getPane,
    sendNative = null,
    readMessages,
    readArchive = null,
    send,
    now = Date.now,
    acknowledgementMs = 60000,
    onChange = () => {},
    getPanes,
    inputAvailable = () => true,
    captureNativeSubmission = () => null,
  }) {
    Object.assign(this, {
      file,
      store,
      getPane,
      getNativePane,
      sendNative,
      readMessages,
      readArchive,
      send,
      now,
      acknowledgementMs,
      onChange,
      getPanes,
      inputAvailable,
      captureNativeSubmission,
    });
    this.items = [];
    this.running = null;
    this.storageError = null;
    this.seq = 0;
    // The store is authoritative once present; `file` then only names the
    // JSON backup that was imported from, and is no longer written.
    const stored = store ? store.load() : file && fs.existsSync(file) ? readQueueFile(file) : null;
    if (stored) {
      this.items = stored;
      let changed = false;
      for (const item of this.items) {
        // Older versions turned abandoned history into retryable failures or
        // left it consumed. Preserve receipts, but never revive that branch.
        if (item.error?.code === 'HISTORY_DISCARDED' || item.historyDiscardedAt != null) {
          if (
            item.status !== 'discarded' ||
            item.retryable ||
            item.deliveryUncertain ||
            item.error
          ) {
            Object.assign(item, discardedFields(item, now()), { updatedAt: now() });
            changed = true;
          }
          continue;
        }
        // The controller saves native acceptance before the queue's final receipt.
        // Recover that durable fact if the process stopped between the two saves.
        if (
          item.nativeDelivery &&
          item.rewind &&
          (item.rewindProgress?.phase === 'submitted' || item.rewindProgress?.sendAccepted === true)
        ) {
          if (item.status !== 'dispatched' || item.deliveryUncertain || item.error) {
            Object.assign(item, {
              status: 'dispatched',
              deliveryUncertain: false,
              retryable: false,
              error: null,
              transportAcceptedAt: item.transportAcceptedAt ?? item.updatedAt ?? now(),
              dispatchedAt: item.dispatchedAt ?? item.updatedAt ?? now(),
            });
            changed = true;
          }
          continue;
        }
        if (!item.sessionId && !item.runtimeId && ['queued', 'sending'].includes(item.status)) {
          Object.assign(item, {
            status: 'failed',
            orphaned: true,
            retryable: false,
            deliveryUncertain: false,
            error: { code: 'SESSION_UNAVAILABLE', message: '旧队列缺少进程身份，未继续投递。' },
          });
          changed = true;
          continue;
        }
        // Older queues incorrectly waited for /resume and other terminal
        // commands to appear as user messages. ACK_TIMEOUT is only recorded
        // after send() returned successfully; it is a transport receipt.
        if (
          item.deliveryUncertain &&
          item.error?.code === 'ACK_TIMEOUT' &&
          isCommand(item.dispatchText || item.text) &&
          (item.dispatchText || item.text) === item.text
        ) {
          Object.assign(item, {
            status: 'dispatched',
            deliveryUncertain: false,
            error: null,
            retryable: false,
            dispatchedAt: item.sendingAt,
            updatedAt: now(),
          });
          changed = true;
        }
        if (item.status !== 'sending' || transportAccepted(item)) continue;
        Object.assign(item, {
          status: 'failed',
          deliveryUncertain: true,
          error: {
            code: 'RESTART_UNCERTAIN',
            message: '服务在发送期间重启；不会自动重发，等待存档确认。',
          },
          updatedAt: now(),
        });
        changed = true;
      }
      if (changed) this.persist();
    }
  }

  persist(changedItems = null, { notify = true } = {}) {
    // 没有落盘位置（测试里的内存队列）：只通知，不写。
    if (!this.store && !this.file) {
      if (notify) this.onChange();
      return;
    }
    // Fail closed: after a storage failure this process must not send anything else.
    if (this.storageError) throw this.storageError;
    if (this.store) return this.persistToStore(changedItems, { notify });
    const dir = path.dirname(this.file);
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, items: this.items }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch (error) {
      this.storageError = apiError(
        503,
        'QUEUE_STORAGE_FAILED',
        `消息队列无法持久化：${error.message}`,
      );
      throw this.storageError;
    }
    try {
      if (notify) this.onChange();
    } catch {
      /* notification failures must not undo a durable write */
    }
  }

  persistToStore(changedItems, { notify = true } = {}) {
    let change;
    try {
      change = this.store.save(this.items, {
        now: this.now(),
        changedIds: changedItems?.map((item) => item.id) ?? null,
      });
      this.seq = change.seq;
    } catch (error) {
      this.storageError = apiError(
        503,
        'QUEUE_STORAGE_FAILED',
        `消息队列无法持久化：${error.message}`,
      );
      throw this.storageError;
    }
    // Tell listeners which panes moved so they can skip unrelated refetches.
    try {
      if (notify) this.onChange({ scope: 'outbox', seq: change.seq, paneIds: change.paneIds });
    } catch {
      /* notification failures must not undo a durable write */
    }
  }

  /** The durably stored items, whichever backend holds them. */
  persisted() {
    if (this.store) return this.store.load();
    if (this.file && fs.existsSync(this.file)) return readQueueFile(this.file);
    return [];
  }

  list(paneId) {
    return structuredClone(
      this.items
        .filter((item) => item.paneId === paneId)
        .map((item) => ({ ...item, authoritative: true })),
    );
  }

  async submit(body) {
    const item = await this.enqueue(body);
    if (item.status !== 'queued') return item;
    // Submitting is sending. A message used to stop here whenever the agent was
    // busy and wait for a second press on its bubble; that step could not edit
    // the text, and it made every send redraw the page twice.
    this.change(
      this.items.find((entry) => entry.id === item.id),
      { deliveryRequestedAt: this.now() },
    );
    // Use the same serialized drain and identity checks as background delivery.
    // A drain already in progress may have captured its candidates before us.
    const running = this.running;
    await this.tick();
    if (running && this.items.find((entry) => entry.id === item.id)?.status === 'queued')
      await this.tick();
    return structuredClone(this.items.find((entry) => entry.id === item.id));
  }

  // Direct native delivery records only an idempotency receipt. Agent scheduling,
  // steering, busy state and archive flushing belong to Herdr and the Agent.
  async submitNative(body) {
    // Capture server-owned operation context before asynchronous target lookup.
    const submission = this.captureNativeSubmission(body);
    let saved;
    try {
      saved = await this.enqueue(body, { nativeDelivery: true });
    } catch (error) {
      // No adapter has run for this request. Keep validation/identity failures
      // distinct from a lost response after native input.
      error.deliveryUncertain ??= false;
      error.retryable ??= false;
      throw error;
    }
    this.nativeSubmissions ||= new Map();
    if (this.nativeSubmissions.has(saved.id)) return this.nativeSubmissions.get(saved.id);
    const item = this.items.find((entry) => entry.id === saved.id);
    if (item.status !== 'queued') return structuredClone(item);
    const pending = (async () => {
      Object.assign(item, {
        nativeDelivery: true,
        paused: false,
        status: 'sending',
        deliveryUncertain: true,
        sendingAt: this.now(),
        attempts: (item.attempts || 0) + 1,
        updatedAt: this.now(),
      });
      try {
        this.persist([item], { notify: false });
      } catch (error) {
        error.deliveryUncertain = false;
        error.retryable = false;
        throw error;
      }
      try {
        if (!this.inputAvailable(item.paneId, item))
          throw Object.assign(
            apiError(409, 'AGENT_NOT_READY', '原生操作正在确认，请完成后重新发送。'),
            { deliveryUncertain: false },
          );
        let receipt;
        if (this.sendNative) {
          // The adapter serializes with pane controls and revalidates this
          // recorded identity immediately before writing, inside that lock.
          // Rewind adapters persist each native phase before an irreversible
          // key. The same durable item survives a lost response or restart.
          // This authorization is server-owned and exists only for this call;
          // it is not a durable claim that a future restart may replay input.
          const operation =
            item.rewind && body.retry === true ? { ...item, rewindPreflightRetry: true } : item;
          receipt = await this.sendNative(
            operation,
            (fields) => this.change(item, fields),
            submission,
          );
        } else {
          const pane = await this.getNativePane(item.paneId);
          if (!sameSession(item, pane))
            throw Object.assign(apiError(409, 'SESSION_CHANGED', '目标会话已改变。'), {
              deliveryUncertain: false,
            });
          receipt = await this.send(pane, item.text, item.id);
        }
        this.change(item, {
          status: 'dispatched',
          transportAcceptedAt: this.now(),
          dispatchedAt: this.now(),
          deliveryUncertain: false,
          retryable: false,
          error: null,
          nativeUserMessageId: receipt?.nativeUserMessageId || null,
        });
      } catch (error) {
        this.change(item, {
          status: 'failed',
          deliveryUncertain: error.deliveryUncertain !== false,
          retryable: retryableFailure(item, error),
          error: {
            code: error.code || 'SEND_FAILED',
            message: error.message,
            ...(error.diagnosticId ? { diagnosticId: error.diagnosticId } : {}),
          },
        });
      }
      return structuredClone(item);
    })();
    this.nativeSubmissions.set(item.id, pending);
    try {
      return await pending;
    } finally {
      this.nativeSubmissions.delete(item.id);
    }
  }

  async enqueue(body, { nativeDelivery = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw apiError(400, 'INVALID_MESSAGE', '消息必须是对象。');
    const { id, paneId, text } = body;
    const rewind = rewindIntent(body.rewind);
    if (rewind && !nativeDelivery)
      throw apiError(400, 'INVALID_REWIND', '历史编辑只能通过当前原生消息接口提交。');
    if (body.retry !== undefined && typeof body.retry !== 'boolean')
      throw apiError(400, 'INVALID_RETRY', 'retry 必须是布尔值。');
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      id.length > 200 ||
      typeof paneId !== 'string' ||
      !paneId.trim() ||
      typeof text !== 'string' ||
      !text.trim() ||
      Buffer.byteLength(text) > 100 * 1024 ||
      /[\x00-\x08\x0b-\x1f\x7f]/.test(text.replace(/\r\n/g, '\n'))
    ) {
      throw apiError(
        400,
        'INVALID_MESSAGE',
        '需要有效的 id、paneId 和非空 text；文本不能包含终端控制字符。',
      );
    }
    // Recover a durable native receipt even when the native endpoint is now
    // offline. Looking up an already completed/uncertain request never writes.
    const recorded = nativeDelivery && this.items.find((item) => item.id === id);
    if (recorded) {
      if (
        !recorded.nativeDelivery ||
        recorded.paneId !== paneId ||
        recorded.text !== text ||
        !sameRewind(recorded.rewind, rewind) ||
        (Object.hasOwn(body, 'sessionId') &&
          (body.sessionId || null) !== (recorded.sessionId || null))
      )
        throw apiError(409, 'MESSAGE_ID_CONFLICT', '这个 id 已用于另一条消息或会话。');
      const retryWrite = body.retry === true && canRetry(recorded);
      if (recorded.status !== 'queued' && !retryWrite) return structuredClone(recorded);
    }
    const pane = await (nativeDelivery ? this.getNativePane(paneId) : this.getPane(paneId));
    if (nativeDelivery) {
      require('./conversation-state').assertIdentity(pane, body);
      if (!pane.agent?.session?.value && !pane.runtimeId)
        throw apiError(409, 'SESSION_UNAVAILABLE', '尚未确认原生会话或进程身份，请稍后重试。');
    }
    const session = sessionOf(pane);
    if (rewind && session?.agent !== 'codex')
      throw apiError(409, 'UNSUPPORTED_PROVIDER', '此会话不支持历史消息编辑。');
    if (!session || !require('../public/provider-capabilities').get(session.agent).send)
      throw apiError(409, 'SESSION_UNAVAILABLE', '目标没有可确认消费的会话。');
    if (body.sessionId != null && body.sessionId !== session.sessionId)
      throw apiError(409, 'SESSION_CHANGED', '目标会话已改变。');
    this.bindSession(pane);
    const existing = this.items.find((item) => item.id === id);
    if (existing) {
      if (
        existing.paneId !== paneId ||
        existing.text !== text ||
        !sameRewind(existing.rewind, rewind) ||
        !sameSession(existing, pane)
      ) {
        throw apiError(409, 'MESSAGE_ID_CONFLICT', '这个 id 已用于另一条消息或会话。');
      }
      if (body.retry === true && canRetry(existing)) {
        this.change(existing, {
          status: 'queued',
          error: null,
          retryable: false,
          batchId: null,
          dispatchText: null,
        });
      }
      return structuredClone(existing);
    }
    if (body.retry === true) throw apiError(404, 'MESSAGE_NOT_FOUND', '要重试的消息不存在。');
    const pending = this.items.filter((item) =>
      nativeDelivery
        ? item.nativeDelivery && item.status === 'sending' && this.nativeSubmissions?.has(item.id)
        : ['queued', 'sending'].includes(item.status) || item.deliveryUncertain,
    );
    if (pending.length >= 256 || pending.filter((item) => item.paneId === paneId).length >= 32)
      throw apiError(429, 'QUEUE_LIMIT', '待发消息已达到上限，请先处理已有消息。');
    const initialMessages =
      !nativeDelivery && session.sessionId ? await this.readMessages(pane) : [];
    const historyAnchor = initialMessages.filter((m) => m.role === 'user').at(-1)?.id || null;
    const item = {
      id,
      paneId,
      ...session,
      historyAnchor,
      cwd: pane.cwd || pane.baseCwd,
      text,
      nativeDelivery,
      status: 'queued',
      deliveryUncertain: false,
      ...(rewind ? { rewind } : {}),
      ...(body.spaceWorkspaceId ? { spaceWorkspaceId: body.spaceWorkspaceId } : {}),
      receiptAmbiguous: this.items.some(
        (other) =>
          other.paneId === paneId &&
          sameSession(other, pane) &&
          other.interruptedAt != null &&
          sameText(other.text, text),
      ),
      createdAt: this.now(),
      updatedAt: this.now(),
      error: null,
    };
    this.items.push(item);
    // Intermediate native receipts are durable, but do not make every client
    // reload history while the input write itself is still in progress.
    this.persist([item], { notify: !nativeDelivery });
    return structuredClone(item);
  }

  interrupted(pane) {
    // A stop boundary invalidates unresolved text receipts. The next identical
    // prompt must not be mistaken for a receipt of the interrupted delivery.
    const affected = this.items.filter(
      (i) =>
        i.paneId === pane.paneId &&
        sameSession(i, pane) &&
        (i.status === 'queued' || i.status === 'sending' || i.deliveryUncertain),
    );
    for (const item of affected) {
      if (item.status === 'queued')
        Object.assign(item, { paused: true, deliveryRequestedAt: null, error: null });
      if (item.status === 'sending' || item.deliveryUncertain)
        Object.assign(item, {
          status: 'failed',
          deliveryUncertain: Boolean(item.nativeUserMessageId),
          retryable: false,
          interruptedAt: this.now(),
          error: { code: 'INTERRUPTED', message: '发送后已停止；未确认的消息不会自动重发。' },
        });
    }
    this.persist(affected);
  }

  cancel(paneId, id) {
    const item = this.items.find((value) => value.paneId === paneId && value.id === id);
    if (!item) throw apiError(404, 'MESSAGE_NOT_FOUND', '消息不存在。');
    if (item.status === 'cancelled') return structuredClone(item);
    if (item.status !== 'queued' && !(item.status === 'failed' && !item.deliveryUncertain)) {
      throw apiError(409, 'MESSAGE_ALREADY_DISPATCHED', '消息已开始投递，不能取消。');
    }
    this.change(item, { status: 'cancelled', retryable: false, error: null });
    return structuredClone(item);
  }

  async deliver({ paneId, id, sessionId }) {
    const item = this.items.find((value) => value.paneId === paneId && value.id === id);
    if (!item) throw apiError(404, 'MESSAGE_NOT_FOUND', '消息不存在。');
    const pane = await this.getPane(paneId);
    if (!sameSession(item, pane) || (sessionId != null && sessionId !== pane.agent?.session?.value))
      throw apiError(409, 'SESSION_CHANGED', '目标会话已改变。');
    if (item.status !== 'queued')
      throw apiError(409, 'MESSAGE_ALREADY_DISPATCHED', '消息已开始投递。');
    const status = pane.agent?.status || pane.status;
    if (
      !['idle', 'done', 'working'].includes(status) ||
      pane.agent?.interactiveReady === false ||
      pane.agent?.launchPending
    )
      throw apiError(409, 'AGENT_NOT_READY', '请先完成 Agent 当前的交互。');
    if (status === 'working' && isCommand(item.text) && !isLiveGoal(item))
      throw apiError(409, 'COMMAND_REQUIRES_IDLE', '这条斜杠命令需要等当前任务结束。');
    if (item.deliveryRequestedAt == null)
      this.change(item, { deliveryRequestedAt: this.now(), paused: false });
    return structuredClone(item);
  }

  bindSession(pane) {
    const current = sessionOf(pane);
    if (!current?.sessionId) return false;
    const pending = this.items.filter(
      (item) =>
        item.paneId === pane.paneId &&
        !item.sessionId &&
        !item.orphaned &&
        item.status !== 'cancelled' &&
        sameSession(item, pane),
    );
    if (!pending.length) return false;
    // Bind all messages from this initial occupant together. Binding only the
    // head would let later queued messages silently adopt a replacement session.
    for (const item of pending)
      Object.assign(item, {
        sessionId: current.sessionId,
        sessionBoundAt: this.now(),
        updatedAt: this.now(),
      });
    this.persist(pending);
    return true;
  }

  change(item, fields) {
    Object.assign(item, fields, { updatedAt: this.now() });
    this.persist([item]);
  }

  changeDelivery(item, fields) {
    const batch = item.batchId
      ? this.items.filter(
          (other) =>
            other.batchId === item.batchId &&
            (other.status === 'sending' || other.deliveryUncertain),
        )
      : [item];
    for (const member of batch) Object.assign(member, fields, { updatedAt: this.now() });
    this.persist(batch);
  }

  tick() {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async drain() {
    if (this.storageError) throw this.storageError;
    const panes = [
      ...new Set(
        this.items
          .filter(
            (item) =>
              !item.nativeDelivery &&
              !item.orphaned &&
              (item.status === 'queued' ||
                item.status === 'sending' ||
                item.deliveryUncertain ||
                item.retryable),
          )
          .map((item) => item.paneId),
      ),
    ];
    if (!panes.length) return;
    const snapshot = this.getPanes
      ? new Map((await this.getPanes()).map((pane) => [pane.paneId, pane]))
      : null;
    await Promise.all(panes.map((paneId) => this.drainPane(paneId, snapshot)));
  }

  // Delivery receipts and branch membership are independent. An abandoned
  // record stays in the outbox for deduplication, never as a retryable prompt.
  // Use the complete history, not a page: missing records alone prove nothing.
  async recheckConsumed(paneId, pane, messages, archive = null) {
    if (!archive && !this.readArchive) return;
    const activeIds = new Set(messages.map((message) => message.id));
    const stale = this.items.filter(
      (item) =>
        item.paneId === paneId &&
        item.status === 'consumed' &&
        item.consumedMessageId &&
        sameSession(item, pane) &&
        !activeIds.has(item.consumedMessageId),
    );
    if (!stale.length) return;
    try {
      archive ||= await this.readArchive(pane);
    } catch {
      return;
    }
    if (!archive) return;
    for (const item of stale) {
      // A later archive read can already contain a restored branch. Neither
      // compaction nor a read race should turn a delivery into a failure.
      if (
        item.status !== 'consumed' ||
        !archive.ids.has(item.consumedMessageId) ||
        archive.activeIds?.has(item.consumedMessageId)
      )
        continue;
      this.change(item, discardedFields(item, this.now()));
    }
  }

  async drainPane(paneId, snapshot) {
    const submission = this.captureNativeSubmission({ paneId });
    const candidates = this.items.filter(
      (item) =>
        !item.nativeDelivery &&
        item.paneId === paneId &&
        !item.orphaned &&
        (item.status === 'queued' ||
          item.status === 'sending' ||
          item.deliveryUncertain ||
          item.retryable),
    );
    if (!candidates.length) return;
    let pane;
    try {
      pane = snapshot ? snapshot.get(paneId) : await this.getPane(paneId);
    } catch (error) {
      if (error.status !== 404 && !['TARGET_NOT_FOUND', 'PANE_NOT_FOUND'].includes(error.code))
        return;
    }
    this.bindSession(pane);
    // Resolve any previous write before allowing a retried or newly queued item.
    const priority = (item) =>
      item.status === 'sending' || item.deliveryUncertain
        ? 2
        : item.deliveryRequestedAt != null
          ? 1
          : 0;
    candidates.sort(
      (a, b) => priority(b) - priority(a) || (priority(a) === 2 ? a.sendingAt - b.sendingAt : 0),
    );
    let nativePending = false;
    for (const item of candidates) {
      if (!sameSession(item, pane)) {
        this.change(item, {
          status: 'failed',
          orphaned: true,
          retryable: false,
          error: {
            code: 'SESSION_CHANGED',
            message: '目标 pane 或会话已关闭或替换，消息未继续投递。',
          },
        });
        continue;
      }
      if (item.status === 'sending' || item.deliveryUncertain) {
        let users, messages;
        try {
          messages = item.sessionId ? await this.readMessages(pane) : [];
          users = userTexts(messages);
        } catch {
          return;
        }
        // 已经读到有效历史了,顺带回头看一眼先前确认过的那些还在不在。
        await this.recheckConsumed(paneId, pane, messages);
        const baseline = item.baseline;
        const userMessages = messages.filter((message) => message.role === 'user');
        const claimed = new Set(
          this.items
            .filter(
              (other) =>
                other.paneId === paneId &&
                sameSession(other, pane) &&
                other.status === 'consumed' &&
                other.batchId !== item.batchId,
            )
            .map((other) => other.consumedMessageId)
            .filter(Boolean),
        );
        let index = -1,
          matched = [item];
        if (item.nativeUserMessageId)
          index = userMessages.findIndex(
            (m) =>
              (m.operationId === item.nativeUserMessageId || m.id === item.nativeUserMessageId) &&
              !claimed.has(m.id),
          );
        if (
          !item.nativeUserMessageId &&
          !item.receiptAmbiguous &&
          baseline &&
          users.length > baseline.count &&
          digest(users.slice(0, baseline.count)) === baseline.digest
        ) {
          const batches = [item];
          const seen = new Set([item.batchId || item.id]);
          // Native queues may archive several separately submitted messages as
          // one user record. Match only the exact ordered text, never substrings.
          for (const other of candidates.slice(candidates.indexOf(item) + 1)) {
            if (
              !sameSession(other, pane) ||
              !(other.status === 'sending' || other.deliveryUncertain) ||
              !transportAccepted(other)
            )
              continue;
            if (seen.has(other.batchId || other.id)) continue;
            if (
              !other.baseline ||
              digest(users.slice(0, other.baseline.count)) !== other.baseline.digest
            )
              break;
            batches.push(other);
            seen.add(other.batchId || other.id);
          }
          for (let n = 1; n <= batches.length && index < 0; n++) {
            const group = batches.slice(0, n);
            const parts = group.map((entry) => entry.dispatchText ?? entry.text);
            index = users.findIndex(
              (text, i) =>
                i >= Math.max(...group.map((entry) => entry.baseline.count)) &&
                !claimed.has(userMessages[i].id) &&
                ['\n\n', '\n'].some((separator) => sameText(text, parts.join(separator))),
            );
            if (index >= 0) matched = group;
          }
        }
        if (index >= 0) {
          const consumedMessageId =
            messages.filter((message) => message.role === 'user')[index].id || null;
          const consumedAt =
            Date.parse(messages.filter((message) => message.role === 'user')[index].ts || '') ||
            this.now();
          for (const member of matched)
            this.changeDelivery(member, {
              status: 'consumed',
              deliveryUncertain: false,
              retryable: false,
              error: null,
              consumedAt,
              consumedMessageId,
            });
          if (
            candidates.some(
              (candidate) => candidate.status === 'queued' && candidate.deliveryRequestedAt != null,
            )
          )
            continue;
          return;
        }
        if (item.status === 'sending' && this.now() - item.sendingAt >= this.acknowledgementMs) {
          this.changeDelivery(item, {
            status: 'failed',
            deliveryUncertain: true,
            error: { code: 'ACK_TIMEOUT', message: '尚未在会话存档中确认消费；不会自动重发。' },
          });
        }
        // A native input receipt is enough to deliver later messages. Archive
        // flushing is independent of the TUI accepting a mid-turn correction.
        // Unknown partial writes still block; they must never be replayed.
        if (transportAccepted(item) && item.sessionId) {
          nativePending = true;
          continue;
        }
        return;
      }
      // Abandoned history is terminal and is excluded from candidates.
      if (item.status === 'failed') return;
      if (item.paused) continue;
      if (nativePending && isCommand(item.text) && !isLiveGoal(item)) return;
      let users, messages;
      try {
        messages = item.sessionId ? await this.readMessages(pane) : [];
        users = userTexts(messages);
      } catch {
        return;
      }
      // 读到有效历史了,顺带回头看一眼先前确认过的那些还在不在。
      await this.recheckConsumed(paneId, pane, messages);
      if (item.historyAnchor && !messages.some((m) => m.id === item.historyAnchor)) {
        this.change(item, {
          status: 'failed',
          orphaned: true,
          retryable: false,
          error: { code: 'HISTORY_CHANGED', message: '原消息所在历史已回滚，待发内容未继续投递。' },
        });
        continue;
      }
      // A queued message may already have been submitted through the terminal.
      // Only an unclaimed, identical user record created after enqueue counts;
      // old repeats and another message's receipt must never consume this item.
      const claimed = new Set(
        this.items
          .filter(
            (other) =>
              other.paneId === paneId && sameSession(other, pane) && other.status === 'consumed',
          )
          .map((other) => other.consumedMessageId)
          .filter(Boolean),
      );
      const receipt = messages.find(
        (message) =>
          message.role === 'user' &&
          message.id &&
          !claimed.has(message.id) &&
          Date.parse(message.ts || '') >= item.createdAt &&
          sameText(userText(message), item.text),
      );
      if (item.status === 'queued' && receipt && !item.receiptAmbiguous) {
        this.change(item, {
          status: 'consumed',
          deliveryUncertain: false,
          retryable: false,
          error: null,
          consumedAt: Date.parse(receipt.ts),
          consumedMessageId: receipt.id,
        });
        continue;
      }
      if (!canSend(pane, item)) return;
      // Cancellation can happen while reading the archive.
      if (item.status !== 'queued') continue;
      let current;
      try {
        current = await this.getPane(paneId);
      } catch {
        return;
      }
      if (item.status !== 'queued') continue;
      if (!sameSession(item, current)) return;
      if (!canSend(current, item) || !this.inputAvailable(paneId)) return;
      // A session discovered during this await needs a fresh archive baseline.
      if (this.bindSession(current)) return;
      // Freeze this turn at the final readiness check. Recheck each member after
      // awaits: cancelled messages are excluded; later arrivals wait for a turn.
      const batch = [];
      for (const member of this.items.slice(this.items.indexOf(item))) {
        if (
          member.paneId !== paneId ||
          member.orphaned ||
          member.paused ||
          ['cancelled', 'consumed', 'dispatched', 'discarded'].includes(member.status)
        )
          continue;
        if (member.status !== 'queued' || !sameSession(member, current)) break;
        if (batch.length && (isCommand(item.text) || isCommand(member.text))) break;
        batch.push(member);
        // An explicit delivery sends only the chosen message; it must not take
        // other retractable messages out of the user's queue.
        if (item.deliveryRequestedAt != null) break;
      }
      const dispatchText = batch.map((member) => member.text).join('\n\n');
      const batchId = crypto.randomUUID();
      for (const member of batch)
        Object.assign(member, {
          status: 'sending',
          batchId,
          dispatchText,
          sendingAt: this.now(),
          updatedAt: this.now(),
          attempts: (member.attempts || 0) + 1,
          retryable: false,
          baseline: {
            count: users.length,
            digest: digest(users),
            lastMessageId: messages.filter((message) => message.role === 'user').at(-1)?.id || null,
          },
          deliveryUncertain: true,
        });
      // Persist the whole batch before the one atomic paste and Enter.
      this.persist(batch);
      try {
        const receipt = await this.send(current, dispatchText, batchId, submission);
        if (receipt?.nativeUserMessageId)
          this.changeDelivery(item, {
            nativeUserMessageId: receipt.nativeUserMessageId,
            nativeTurnId: receipt.nativeTurnId,
          });
        if (isCommand(dispatchText))
          this.changeDelivery(item, {
            status: 'dispatched',
            deliveryUncertain: false,
            retryable: false,
            error: null,
            dispatchedAt: this.now(),
          });
        else this.changeDelivery(item, { transportAcceptedAt: this.now() });
      } catch (error) {
        this.changeDelivery(item, {
          status: 'failed',
          deliveryUncertain: error.deliveryUncertain !== false,
          retryable: retryableFailure(item, error),
          error: { code: error.code || 'SEND_FAILED', message: error.message },
        });
      }
      return;
    }
  }
}

module.exports = { MessageQueue, apiError, sessionOf };
