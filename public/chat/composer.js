(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioComposer = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  function afterFeedback() {
    return new Promise((resolve) => {
      const view = typeof window === 'undefined' ? globalThis : window;
      if (!view.requestAnimationFrame || view.document?.hidden) {
        setTimeout(resolve, 0);
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 100);
      view.requestAnimationFrame(() => setTimeout(finish, 0));
    });
  }
  /** Measure wrapped text without temporarily shrinking the live input or moving its caret. */
  function autoHeight(input, { beforeResize = () => null, afterResize = () => {} } = {}) {
    const view = input.ownerDocument.defaultView;
    const measure = input.ownerDocument.createElement('textarea');
    measure.tabIndex = -1;
    measure.setAttribute('aria-hidden', 'true');
    measure.setAttribute('inert', '');
    measure.style.cssText =
      'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;overflow:hidden;margin:0;';
    input.ownerDocument.body.append(measure);
    const properties = [
      'boxSizing',
      'font',
      'letterSpacing',
      'wordSpacing',
      'textIndent',
      'textTransform',
      'tabSize',
      'whiteSpace',
      'overflowWrap',
      'wordBreak',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'borderStyle',
    ];
    let frame = 0,
      previous = '';
    function resize() {
      frame = 0;
      const width = input.getBoundingClientRect().width;
      if (!width || !input.getClientRects().length) {
        previous = '';
        return;
      }
      const style = view.getComputedStyle(input);
      const signature = JSON.stringify([
        input.value,
        width,
        style.minHeight,
        style.maxHeight,
        ...properties.map((key) => style[key]),
      ]);
      if (signature === previous) return;
      previous = signature;
      for (const key of properties) measure.style[key] = style[key];
      measure.style.width = `${width}px`;
      measure.wrap = input.wrap;
      measure.value = input.value;
      const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const height = Math.min(
        parseFloat(style.maxHeight),
        Math.max(parseFloat(style.minHeight), measure.scrollHeight + borders),
      );
      if (input.getBoundingClientRect().height !== height) {
        const before = beforeResize();
        input.style.height = `${height}px`;
        afterResize(before);
      }
    }
    function schedule() {
      if (!frame) frame = view.requestAnimationFrame(resize);
    }
    const observer = new view.ResizeObserver(schedule);
    observer.observe(input);
    input.addEventListener('input', schedule);
    input.addEventListener('compositionend', schedule);
    view.addEventListener('herdr:fontchange', schedule);
    schedule();
    return { schedule };
  }

  function create({
    state,
    els,
    reportError,
    currentProvider,
    currentChatPane,
    saveDraft,
    runComposerAction,
    renderAttachments,
    api,
    appPath,
    applyOutboxUpdate,
    refreshChat,
    renderSessionStatus,
    clearSubmittedDraft,
  }) {
    const requests = (state.composerRequests = new Map()),
      attempts = new Map(),
      rewindRequests = new Map();
    const deliveries = new Map();
    const terminalRequests = (state.composerTerminalRequests = new Map());
    const terminalKey = (pane, root = state.config?.rootDirectory) =>
      JSON.stringify([root, state.herdrRuntimeId, pane?.paneId, pane?.terminalId]);
    const deliveryKey = (pane) =>
      JSON.stringify([
        appPath('/api/messages'),
        state.config?.rootDirectory,
        state.herdrRuntimeId,
        pane?.paneId,
        pane?.terminalId,
        pane?.runtimeId || '',
        pane?.agent?.session?.value || '',
      ]);
    const storageKey = (key) => 'studioDelivery:' + key;
    const accepted = (message) =>
      message.transportAcceptedAt != null || ['dispatched', 'consumed'].includes(message.status);
    function persist(entry) {
      if (entry.rewind) return;
      try {
        if (['pending', 'uncertain', 'checking'].includes(entry.phase)) {
          localStorage.setItem(
            storageKey(entry.deliveryKey),
            JSON.stringify({
              payload: entry.message.payload,
              intent: entry.message.intent,
              draft: entry.draft,
              attachments: entry.attachments,
              provider: entry.provider,
            }),
          );
        } else localStorage.removeItem(storageKey(entry.deliveryKey));
      } catch {
        /* The editable draft remains under the existing draft store. */
      }
    }
    function currentDelivery() {
      const pane = currentChatPane();
      if (!pane) return null;
      const key = deliveryKey(pane);
      if (!deliveries.has(key)) {
        let saved;
        try {
          saved = JSON.parse(localStorage.getItem(storageKey(key)) || 'null');
        } catch {}
        if (
          saved?.payload?.id &&
          saved.payload.paneId === pane.paneId &&
          saved.payload.sessionId === pane.agent?.session?.value &&
          typeof saved.payload.text === 'string' &&
          typeof saved.draft === 'string'
        ) {
          const message = {
            ...saved.payload,
            payload: saved.payload,
            intent: saved.intent,
            serverKnown: true,
          };
          const entry = {
            deliveryKey: key,
            phase: 'uncertain',
            message,
            pane: structuredClone(pane),
            root: state.config?.rootDirectory,
            draft: saved.draft,
            attachments: saved.attachments || [],
            provider: saved.provider,
            key: `${state.config?.rootDirectory}:${state.composerIdentity}`,
          };
          deliveries.set(key, entry);
          attempts.set(entry.key, message);
        } else deliveries.set(key, null);
      }
      return deliveries.get(key);
    }
    function setPhase(entry, phase, error = '', durable = true) {
      entry.phase = phase;
      entry.error = error;
      if (durable) persist(entry);
      deliveries.set(entry.deliveryKey, entry);
      if (deliveries.size > 64) {
        const removable = [...deliveries].find(
          ([, value]) => !value || ['accepted', 'failed'].includes(value.phase),
        );
        if (removable) deliveries.delete(removable[0]);
      }
    }
    function settleAccepted(entry) {
      attempts.delete(entry.key);
      setPhase(entry, 'accepted');
      const { pane, draft, root } = entry;
      const same = deliveryKey(currentChatPane()) === entry.deliveryKey;
      if (state.config?.rootDirectory === root) {
        state.attachments[pane.paneId] = (state.attachments[pane.paneId] || []).filter(
          (item) =>
            !entry.attachments.some((sent) =>
              sent.id ? sent.id === item.id : sent.path === item.path && sent.name === item.name,
            ),
        );
        if (same && els.commandInput.value === draft) {
          els.commandInput.value = '';
          saveDraft();
        } else if (
          !same &&
          state.drafts[pane.paneId] === draft &&
          window.StudioDrafts.identity(state.chatAgents.find((p) => p.paneId === pane.paneId)) ===
            window.StudioDrafts.identity(pane)
        )
          state.drafts[pane.paneId] = '';
        clearSubmittedDraft(pane, draft, root);
      }
      if (same) {
        renderAttachments();
        reportError('');
        reportError('', 'session-check');
      }
    }
    function view() {
      const entry = currentDelivery();
      if (!entry) return null;
      const name =
        entry.provider === 'codex' ? 'Codex' : entry.provider === 'claude' ? 'Claude' : '原生端';
      return {
        phase: entry.phase,
        requestId: entry.message.id,
        error: entry.error,
        label:
          entry.phase === 'pending'
            ? '正在投递…'
            : entry.phase === 'checking'
              ? '正在核对投递结果…'
              : entry.phase === 'uncertain'
                ? '投递结果待确认，内容已保留。'
                : entry.phase === 'accepted'
                  ? `${name} 已接收`
                  : '未发送，草稿已保留。',
        canCheck: entry.phase === 'uncertain',
        busy: ['pending', 'checking'].includes(entry.phase),
      };
    }
    async function checkDelivery() {
      const entry = currentDelivery();
      if (!entry || !['uncertain', 'failed'].includes(entry.phase)) return;
      setPhase(entry, 'checking');
      renderSessionStatus(currentChatPane());
      try {
        const result = await api(
          appPath(
            '/api/messages?' +
              new URLSearchParams({ pane: entry.pane.paneId, id: entry.message.id }),
          ),
        );
        const receipt = result.messages?.find((item) => item.id === entry.message.id);
        if (receipt) applyOutboxUpdate(entry.message, receipt);
        if (receipt && accepted(entry.message)) settleAccepted(entry);
        else if (receipt?.status === 'failed' && receipt.deliveryUncertain === false)
          setPhase(entry, 'failed', receipt.error?.message || '原生端未接收这条消息。');
        else setPhase(entry, 'uncertain');
      } catch (error) {
        setPhase(entry, 'uncertain', error.message);
      } finally {
        renderSessionStatus(currentChatPane());
        void refreshChat();
      }
      return {
        accepted: entry.phase === 'accepted',
        uncertain: entry.phase === 'uncertain',
        requestId: entry.message.id,
      };
    }
    let sessionCheck = null;
    function recoverSession(value) {
      if (
        !sessionCheck ||
        value?.mode !== 'main' ||
        value.interaction?.modal ||
        value.binding !== sessionCheck.binding ||
        !sessionCheck.sameView()
      )
        return;
      sessionCheck = null;
      reportError('', 'session-check');
    }
    function reportSendFailure(error, binding, sameView) {
      const source =
        ['SIDE_UNKNOWN', 'QUESTION_PENDING'].includes(error.code) &&
        error.deliveryUncertain === false &&
        error.retryable === true
          ? 'session-check'
          : 'operation';
      if (sameView()) {
        if (source === 'session-check') sessionCheck = binding ? { binding, sameView } : null;
        reportError(error.message, source);
      }
      return source;
    }
    async function send({ rewind = null, onRequestId } = {}) {
      const paneId = state.chatPaneId,
        identity = state.composerIdentity,
        root = state.config?.rootDirectory,
        key = `${root}:${identity}`;
      const requestPath = appPath('/api/messages'),
        runtimeId = state.herdrRuntimeId;
      const pane = currentChatPane(),
        attachments = [...(state.attachments[paneId] || [])];
      const nativeKey = terminalKey(pane, root);
      const failed = (error) => ({ accepted: false, uncertain: false, error });
      if (!rewind && ['uncertain', 'checking'].includes(currentDelivery()?.phase))
        return failed('请先核对上一条消息的投递结果。');
      if (requests.has(key) || terminalRequests.has(nativeKey))
        return failed('该终端的消息发送尚未完成。');
      if (attachments.some((item) => item.status !== 'ready')) {
        reportError('请等待附件上传完成，或移除上传失败的附件。');
        return failed('附件尚未准备完成。');
      }
      const draft = els.commandInput.value;
      const text = [
        draft,
        ...attachments.map((item) => `附件：${item.name}\n文件路径：${JSON.stringify(item.path)}`),
      ]
        .filter(Boolean)
        .join('\n\n');
      if (!text.trim() || !paneId || !state.connected) return failed('当前无法发送消息。');
      const actionName = text
        .trim()
        .match(/^\/(model|effort|fast|skills|resume|agents|copy|new)$/)?.[1];
      if (
        !rewind &&
        actionName &&
        (currentProvider() === 'codex' || ['model', 'effort'].includes(actionName))
      ) {
        els.commandInput.value = '';
        saveDraft();
        return runComposerAction({ name: actionName });
      }
      const sameView = () =>
        state.chatPaneId === paneId &&
        state.composerIdentity === identity &&
        state.config?.rootDirectory === root;
      const binding =
        state.lastChatStatus?.identity?.paneId === paneId
          ? state.lastChatStatus.binding
          : undefined;
      const previous = attempts.get(key);
      const intent = JSON.stringify([
        text,
        rewind,
        pane.terminalId,
        pane.agent?.session?.value || '',
        binding,
      ]);
      const message =
        previous?.intent === intent
          ? previous
          : {
              id:
                globalThis.crypto?.randomUUID?.() ||
                `message-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              paneId,
              text,
              intent,
            };
      if (!message.payload)
        message.payload = {
          id: message.id,
          paneId,
          sessionId: pane?.agent?.session?.value,
          binding,
          text,
          ...(rewind ? { rewind: { preparationId: rewind.preparationId } } : {}),
        };
      attempts.set(key, message);
      requests.set(key, message);
      message.submissionPending = true;
      const delivery = {
        deliveryKey: deliveryKey(pane),
        key,
        root,
        pane: structuredClone(pane),
        draft,
        attachments: attachments.map(({ previewUrl, ...item }) => item),
        provider: currentProvider(),
        message,
        rewind,
      };
      if (!rewind) setPhase(delivery, 'pending', '', false);
      if (rewind) {
        terminalRequests.set(nativeKey, message);
        rewindRequests.set(message.id, {
          message,
          root,
          key,
          nativeKey,
          paneId,
          binding,
          sameView,
        });
      }
      onRequestId?.(message.id);
      sessionCheck = null;
      reportError('', 'session-check');
      reportError('');
      renderSessionStatus(pane);
      try {
        if (!rewind) {
          // Paint the local acknowledgement before synchronous storage and
          // payload serialization. A throttled/background frame cannot hold it.
          await afterFeedback();
          const live = state.chatAgents.find((item) => item.paneId === paneId);
          if (
            state.config?.rootDirectory !== root ||
            state.herdrRuntimeId !== runtimeId ||
            live?.terminalId !== delivery.pane.terminalId ||
            live?.runtimeId !== delivery.pane.runtimeId ||
            live?.agent?.session?.value !== delivery.pane.agent?.session?.value
          )
            throw Object.assign(new Error('目标会话已改变，内容未发送。'), {
              deliveryUncertain: false,
            });
          persist(delivery);
        }
        const result = await api(requestPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...message.payload,
            ...(message.serverKnown ? { retry: true } : {}),
          }),
        });
        applyOutboxUpdate(message, result.message || result.item || {});
        if (!accepted(message))
          throw Object.assign(
            new Error(
              message.error?.message ||
                (message.deliveryUncertain
                  ? '原生端接收结果尚未确认。重新发送时将核对同一条投递记录。'
                  : '原生端没有接收消息，请检查后重新发送。'),
            ),
            {
              code: message.error?.code,
              deliveryUncertain: message.deliveryUncertain,
              retryable: message.retryable,
            },
          );
        attempts.delete(key);
        if (rewind) {
          terminalRequests.delete(nativeKey);
          rewindRequests.delete(message.id);
          return { accepted: true, requestId: message.id, message };
        }
        settleAccepted(delivery);
        return { accepted: true, requestId: message.id, message };
      } catch (error) {
        // Keep the draft and the same id for explicit retry, including a lost
        // HTTP response. Never generate a second chat message or auto-resend.
        const errorSource = reportSendFailure(error, binding, sameView);
        const uncertain = error.deliveryUncertain !== false;
        if (!rewind) setPhase(delivery, uncertain ? 'uncertain' : 'failed', error.message);
        if (rewind && !uncertain) terminalRequests.delete(nativeKey);
        return {
          accepted: false,
          uncertain,
          requestId: message.id,
          error: error.message,
          errorSource,
          code: error.code,
          retryable: error.retryable,
          message,
        };
      } finally {
        message.submissionPending = false;
        requests.delete(key);
        if (sameView()) {
          renderSessionStatus(currentChatPane());
          void refreshChat();
        }
      }
    }
    async function checkReceipt(requestId) {
      const entry = rewindRequests.get(requestId);
      if (!entry || state.config?.rootDirectory !== entry.root)
        return { accepted: false, uncertain: true };
      try {
        const result = await api(
          appPath('/api/messages?' + new URLSearchParams({ pane: entry.paneId, id: requestId })),
        );
        const incoming = result.messages?.find((item) => item.id === requestId);
        if (!incoming) return { accepted: false, uncertain: true };
        applyOutboxUpdate(entry.message, incoming);
        const accepted =
          entry.message.transportAcceptedAt != null ||
          ['dispatched', 'consumed'].includes(entry.message.status);
        const notWritten =
          entry.message.deliveryUncertain === false && entry.message.status === 'failed';
        if (accepted || notWritten) terminalRequests.delete(entry.nativeKey);
        if (accepted) {
          attempts.delete(entry.key);
          rewindRequests.delete(requestId);
          if (entry.sameView()) {
            reportError('', 'session-check');
            reportError('');
          }
        }
        const failure = notWritten && {
          ...entry.message.error,
          deliveryUncertain: false,
          retryable: entry.message.retryable,
        };
        const errorSource = failure
          ? reportSendFailure(failure, entry.binding, entry.sameView)
          : undefined;
        return {
          accepted,
          uncertain: !accepted && !notWritten,
          deliveryUncertain: !accepted && !notWritten,
          requestId,
          error: entry.message.error?.message,
          errorSource,
          code: entry.message.error?.code,
          retryable: entry.message.retryable,
          message: entry.message,
        };
      } catch {
        return { accepted: false, uncertain: true, requestId };
      }
    }
    return { send, recoverSession, checkReceipt, checkDelivery, view };
  }
  return { create, autoHeight };
});
