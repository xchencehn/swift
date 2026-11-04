(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioMessageEdit = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const interactive =
    'a[href], button, input, textarea, select, summary, details, img, svg, canvas, video, audio, iframe, pre, code, [contenteditable]:not([contenteditable="false"]), [role="button"], [data-download-url]';
  const inside = (rect, x, y) =>
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.left - 1 &&
    x <= rect.right + 1 &&
    y >= rect.top - 1 &&
    y <= rect.bottom + 1;

  // A Text Range yields the individual rendered text rectangles. A paragraph
  // or multiline bounding box would incorrectly include blank line endings.
  function pointHitsText(bubble, x, y) {
    const doc = bubble.ownerDocument,
      range = doc.createRange();
    const walker = doc.createTreeWalker(bubble, 4); // NodeFilter.SHOW_TEXT
    try {
      while (walker.nextNode()) {
        range.selectNodeContents(walker.currentNode);
        if ([...range.getClientRects()].some((rect) => inside(rect, x, y))) return true;
      }
      return false;
    } catch {
      return true;
    } // Preserve native selection if measurement fails.
  }

  function create({
    log,
    input,
    container = input.closest('.chat-input'),
    popovers,
    context,
    messageFor,
    prepare,
    readDraft,
    writeDraft,
    send,
    reportError = () => {},
    onChange = () => {},
    holdMs = 520,
  }) {
    const doc = log.ownerDocument,
      win = doc.defaultView;
    const listeners = [],
      touchPointers = new Set();
    let current = null,
      press = null,
      ownMenu = null,
      openedGesture = null,
      consumeReleaseClick = null;
    let canceledGesture = false,
      destroyed = false,
      paintedView = '',
      lastPointer = null;
    const createId = () =>
      win.crypto?.randomUUID?.() ||
      `message-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const clientId = createId();
    const bar = doc.createElement('div');
    bar.className = 'chat-message-edit';
    bar.hidden = true;
    const label = doc.createElement('span');
    label.className = 'chat-message-edit-label';
    label.setAttribute('role', 'status');
    const note = doc.createElement('span');
    note.className = 'chat-message-edit-note';
    note.textContent = '发送将回退到这条消息；工作文件不会撤销。';
    note.hidden = true;
    const cancelButton = doc.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = '取消';
    cancelButton.className = 'chat-message-edit-cancel';
    cancelButton.setAttribute('aria-label', '取消编辑历史消息');
    bar.append(label, cancelButton, note);
    container.before(bar);

    const keyOf = (value) => String(value?.identity || '');
    const eligible = (value) =>
      Boolean(
        value &&
        keyOf(value) &&
        value.provider === 'codex' &&
        value.ready !== false &&
        !value.archived &&
        !value.side &&
        value.mode !== 'terminal' &&
        value.enabled !== false,
      );
    const rootOf = (value) => String(value?.root || value?.nativeBinding?.root || '');
    const bindingSignature = (value) => JSON.stringify(value?.nativeBinding ?? null);
    const sameOwner = (ctx) =>
      ctx && keyOf(context()) === ctx.key && rootOf(context()) === rootOf(ctx.owner);
    const nativeKey = (value) => {
      const binding = value?.nativeBinding;
      const paneId = value?.paneId || binding?.paneId,
        terminalId = value?.terminalId || binding?.terminalId;
      return paneId && terminalId
        ? JSON.stringify([
            rootOf(value),
            value.runtimeId || binding?.runtimeId || '',
            paneId,
            terminalId,
          ])
        : '';
    };
    const pending = (ctx) => ctx && ['submitting', 'uncertain'].includes(ctx.phase);
    const ownsView = (ctx) =>
      sameOwner(ctx) ||
      Boolean(
        pending(ctx) && nativeKey(ctx.owner) && nativeKey(ctx.owner) === nativeKey(context()),
      );
    const selected = () => Boolean(win.getSelection() && !win.getSelection().isCollapsed);
    const draftSnapshot = () => {
      const value = readDraft();
      return {
        ...value,
        text: String(value.text || ''),
        attachments: [...(value.attachments || [])],
      };
    };
    const draftSignature = (value) => JSON.stringify([value.text, value.attachments || []]);
    const listen = (node, type, handler, options) => {
      node.addEventListener(type, handler, options);
      listeners.push(() => node.removeEventListener(type, handler, options));
    };
    function closeOwnMenu() {
      if (ownMenu?.isConnected) popovers.close();
      ownMenu = null;
    }
    function clearPress(reason = '') {
      if (press) win.clearTimeout(press.timer);
      press = null;
      if (reason) canceledGesture = true;
    }
    function paint() {
      const ctx = current;
      const visible = Boolean(ctx && ownsView(ctx) && eligible(context()));
      bar.hidden = !visible;
      if (visible) {
        label.textContent =
          ctx.phase === 'preparing'
            ? '正在读取历史消息…'
            : ctx.phase === 'submitting'
              ? '正在发送修改后的消息…'
              : ctx.phase === 'uncertain'
                ? '编辑消息的发送结果待确认'
                : '正在编辑历史消息';
        note.hidden = ctx.phase !== 'editing';
        cancelButton.disabled = ['submitting', 'uncertain'].includes(ctx.phase);
        bar.setAttribute(
          'aria-busy',
          String(ctx.phase === 'preparing' || ctx.phase === 'submitting'),
        );
      }
      const next = JSON.stringify([view(), visible, context().connected]);
      if (paintedView !== next) {
        paintedView = next;
        onChange(view());
      }
    }
    function view() {
      return current
        ? {
            phase: current.phase,
            identity: current.key,
            root: rootOf(current.owner),
            messageId: current.messageId,
            preparationId: current.preparation?.id || '',
            requestId: current.requestId || '',
            attempt: current.attempt || 0,
            pending: ['submitting', 'uncertain'].includes(current.phase),
          }
        : null;
    }
    function cancel({ restore = true } = {}) {
      const ctx = current;
      clearPress();
      closeOwnMenu();
      openedGesture = null;
      if (!ctx) return true;
      if (['submitting', 'uncertain'].includes(ctx.phase)) return false;
      current = null;
      ctx.abort.abort();
      // Preparation is read-only. No cancellation path sends a native key.
      if (restore && ctx.applied)
        writeDraft(ctx.backup, ctx.owner, { restoring: true, editing: false });
      paint();
      return true;
    }
    function sync() {
      const value = context();
      if (press && (press.key !== keyOf(value) || press.root !== rootOf(value) || !eligible(value)))
        clearPress('context');
      if (
        ownMenu &&
        (openedGesture?.key !== keyOf(value) ||
          openedGesture?.root !== rootOf(value) ||
          openedGesture?.binding !== bindingSignature(value) ||
          !eligible(value))
      )
        closeOwnMenu();
      if (current && (!sameOwner(current) || !eligible(value))) {
        if (!['submitting', 'uncertain'].includes(current.phase)) cancel();
      }
      paint();
    }
    function candidateAt(target, x, y) {
      const value = context();
      if (!eligible(value) || selected() || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      const bubble = target?.closest?.('.chat-msg');
      if (!bubble || !log.contains(bubble) || bubble.dataset.role !== 'user') return null;
      const hit = doc.elementFromPoint(x, y);
      if (!hit || !bubble.contains(hit) || hit.closest(interactive) || pointHitsText(bubble, x, y))
        return null;
      const message = messageFor(bubble);
      if (!message || message.role !== 'user' || typeof message.id !== 'string' || !message.id)
        return null;
      return {
        bubble,
        messageId: message.id,
        key: keyOf(value),
        root: rootOf(value),
        binding: bindingSignature(value),
        x,
        y,
      };
    }
    function stillCandidate(value) {
      const next = value?.bubble?.isConnected && candidateAt(value.bubble, value.x, value.y);
      return next &&
        next.bubble === value.bubble &&
        next.messageId === value.messageId &&
        next.key === value.key &&
        next.root === value.root &&
        next.binding === value.binding
        ? next
        : null;
    }
    function menuCandidate(value) {
      const owner = context(),
        bubble = value?.bubble;
      if (
        !bubble?.isConnected ||
        !log.contains(bubble) ||
        bubble.dataset.role !== 'user' ||
        !eligible(owner) ||
        selected() ||
        value.key !== keyOf(owner) ||
        value.root !== rootOf(owner) ||
        value.binding !== bindingSignature(owner)
      )
        return null;
      const message = messageFor(bubble);
      return message?.role === 'user' && message.id === value.messageId ? value : null;
    }
    async function begin(value) {
      // The blank hit was checked when opening the menu. Layout can move the
      // same message before activation; validate its identity, not the old point.
      const target = menuCandidate(value),
        owner = context();
      if (!target || current || !owner.connected) return;
      const backup = draftSnapshot();
      if (backup.attachments.some((item) => item.status && item.status !== 'ready')) {
        reportError('请先等待当前草稿的附件上传完成，或移除上传失败的附件。');
        return;
      }
      const binding =
        owner.nativeBinding && typeof owner.nativeBinding === 'object'
          ? { ...owner.nativeBinding }
          : owner.nativeBinding;
      const ctx = {
        key: target.key,
        owner: { ...owner, nativeBinding: binding },
        messageId: target.messageId,
        backup,
        draftSignature: draftSignature(backup),
        phase: 'preparing',
        applied: false,
        abort: new AbortController(),
      };
      current = ctx;
      paint();
      reportError('');
      try {
        const result = await prepare({
          messageId: ctx.messageId,
          clientId,
          requestId: createId(),
          nativeBinding: owner.nativeBinding,
          signal: ctx.abort.signal,
        });
        if (destroyed || current !== ctx) return;
        if (!sameOwner(ctx) || !eligible(context()) || !context().connected) {
          cancel();
          return;
        }
        if (draftSignature(draftSnapshot()) !== ctx.draftSignature) {
          cancel();
          reportError('草稿已变化，本次历史消息编辑已取消。');
          return;
        }
        const preparation = result?.preparation;
        if (
          !preparation ||
          typeof preparation.id !== 'string' ||
          !preparation.id ||
          preparation.messageId !== ctx.messageId ||
          typeof preparation.sourceText !== 'string'
        )
          throw new Error('未取得可核验的历史消息，请重新打开编辑。');
        ctx.preparation = preparation;
        ctx.phase = 'editing';
        ctx.applied = true;
        writeDraft(
          {
            text: preparation.sourceText,
            attachments: [],
            selectionStart: preparation.sourceText.length,
            selectionEnd: preparation.sourceText.length,
          },
          ctx.owner,
          { restoring: false, editing: true },
        );
        paint();
        input.focus({ preventScroll: true });
      } catch (error) {
        if (current !== ctx || destroyed) return;
        if (ctx.applied) writeDraft(ctx.backup, ctx.owner, { restoring: true, editing: false });
        current = null;
        paint();
        if (error.name !== 'AbortError' && sameOwner(ctx))
          reportError(error.message || '无法读取这条历史消息。');
      }
    }
    function openMenu(value, gesture) {
      const target = stillCandidate(value);
      if (!target || current) return false;
      clearPress();
      openedGesture = { ...target, pointerId: gesture?.pointerId ?? null };
      const anchor = {
        contextPoint: { x: target.x, y: target.y },
        contextElement: target.bubble,
        contextScope: log,
        focus: () => target.bubble.focus?.({ preventScroll: true }),
      };
      ownMenu = popovers.open(anchor, {
        title: '历史消息',
        at: anchor.contextPoint,
        items: [{ id: 'edit', label: '编辑', disabled: !context().connected }],
        onPick: (item) => {
          ownMenu = null;
          if (item.id === 'edit') void begin(target);
        },
      });
      return true;
    }
    function onPointerDown(event) {
      consumeReleaseClick = null;
      if (!ownMenu?.contains(event.target)) openedGesture = null;
      canceledGesture = false;
      lastPointer = null;
      if (event.pointerType === 'touch') touchPointers.add(event.pointerId);
      if (touchPointers.size > 1) {
        clearPress('multi');
        closeOwnMenu();
      }
    }
    function onLogDown(event) {
      if (
        event.button !== 0 ||
        event.isPrimary === false ||
        touchPointers.size > 1 ||
        current ||
        event.defaultPrevented
      )
        return;
      const value = candidateAt(event.target, event.clientX, event.clientY);
      if (!value) return;
      clearPress();
      const mine = { ...value, pointerId: event.pointerId, timer: 0 };
      press = mine;
      lastPointer = mine;
      mine.timer = win.setTimeout(() => {
        if (press !== mine || canceledGesture || touchPointers.size > 1 || !stillCandidate(mine))
          return clearPress();
        if (openMenu(mine, event)) consumeReleaseClick = { ...mine, released: false };
      }, holdMs);
    }
    function onMove(event) {
      const value = press || lastPointer;
      if (!value || event.pointerId !== value.pointerId) return;
      if (Math.abs(event.clientX - value.x) > 8 || Math.abs(event.clientY - value.y) > 8) {
        clearPress('move');
        closeOwnMenu();
      }
    }
    function onPointerEnd(event) {
      touchPointers.delete(event.pointerId);
      if (press?.pointerId === event.pointerId) clearPress();
      if (consumeReleaseClick?.pointerId === event.pointerId) {
        consumeReleaseClick.released = true;
        event.preventDefault();
      }
    }
    function onPointerCancel(event) {
      touchPointers.delete(event.pointerId);
      clearPress();
      consumeReleaseClick = null;
      // The OS may cancel a pointer before dispatching its own long-press
      // contextmenu. Cancellation stops our timer; a later stable contextmenu is
      // a separate request. Movement/scroll/selection/multi-touch remain denied.
    }
    function onContextMenu(event) {
      const bubble = event.target.closest?.('.chat-msg');
      if (!bubble || !log.contains(bubble)) return;
      // Let the browser own text selection, but never allow the page's Tab menu
      // to replace a message's native menu, including assistant message text.
      event.stopPropagation();
      if (event.defaultPrevented || selected() || touchPointers.size > 1) return;
      const alreadyOpened =
        ownMenu?.isConnected &&
        openedGesture?.bubble === bubble &&
        openedGesture.key === keyOf(context()) &&
        openedGesture.root === rootOf(context()) &&
        Math.abs(openedGesture.x - event.clientX) <= 8 &&
        Math.abs(openedGesture.y - event.clientY) <= 8;
      if (alreadyOpened) {
        event.preventDefault();
        return;
      }
      if (canceledGesture) return;
      const value = candidateAt(event.target, event.clientX, event.clientY);
      if (!value) return;
      if (openMenu(value, event)) event.preventDefault();
    }
    function onClick(event) {
      const value = consumeReleaseClick;
      if (
        !value?.released ||
        event.detail === 0 ||
        Math.abs(event.clientX - value.x) > 8 ||
        Math.abs(event.clientY - value.y) > 8
      )
        return;
      consumeReleaseClick = null;
      event.preventDefault();
      event.stopPropagation();
    }
    async function submit() {
      const ctx = current;
      if (
        !ctx ||
        ctx.phase !== 'editing' ||
        !sameOwner(ctx) ||
        !eligible(context()) ||
        !context().connected ||
        context().composing
      )
        return false;
      const draft = draftSnapshot();
      if (!draft.text.trim() && !draft.attachments.length) return false;
      if (draft.attachments.some((item) => item.status && item.status !== 'ready')) {
        reportError('请等待附件上传完成，或移除上传失败的附件。');
        return false;
      }
      ctx.phase = 'submitting';
      ctx.attempt = (ctx.attempt || 0) + 1;
      ctx.requestId = '';
      ctx.submittedDraft = draft;
      ctx.editedDraft = draft;
      ctx.submittedVersion = ctx.editVersion || 0;
      paint();
      reportError('');
      try {
        const result = await send({
          rewind: { preparationId: ctx.preparation.id },
          onRequestId: (id) => {
            if (
              current === ctx &&
              ctx.phase === 'submitting' &&
              typeof id === 'string' &&
              id &&
              !ctx.requestId
            ) {
              ctx.requestId = id;
              paint();
            }
          },
        });
        if (current !== ctx || destroyed) return false;
        if (result?.accepted === true) return finishAccepted(ctx);
        ctx.phase =
          result?.accepted === false && result?.uncertain === false ? 'editing' : 'uncertain';
        paint();
        if (sameOwner(ctx))
          reportError(result?.error || '消息尚未确认发送，编辑内容已保留。', result?.errorSource);
      } catch (error) {
        if (current !== ctx || destroyed) return false;
        // A thrown transport error cannot establish that rewind did not occur.
        ctx.phase = error?.deliveryUncertain === false ? 'editing' : 'uncertain';
        paint();
        if (sameOwner(ctx)) reportError(error.message || '消息发送结果尚未确认，编辑内容已保留。');
      }
      return false;
    }
    function finishAccepted(ctx) {
      if (current !== ctx) return false;
      const ownerIsCurrent = sameOwner(ctx),
        local = ownerIsCurrent ? draftSnapshot() : ctx.editedDraft;
      const remainingAttachments =
        local?.attachments.filter((item) => !ctx.submittedDraft.attachments.includes(item)) || [];
      const versionUnchanged = (ctx.editVersion || 0) === ctx.submittedVersion;
      const submittedStillHere =
        local &&
        versionUnchanged &&
        local.text === ctx.submittedDraft.text &&
        !remainingAttachments.length;
      const clearedWithoutNewInput =
        local && !local.text && !local.attachments.length && versionUnchanged;
      current = null;
      // Restore the unrelated normal draft only if the submitted edit still
      // occupies this input or was cleared without subsequent typing. Otherwise
      // persist the newer draft unchanged. Background writes remain owner-bound.
      const restoring = !local || submittedStillHere || clearedWithoutNewInput;
      const newer = local && {
        ...local,
        text: versionUnchanged && local.text === ctx.submittedDraft.text ? '' : local.text,
        attachments: remainingAttachments,
      };
      writeDraft(restoring ? ctx.backup : newer, ctx.owner, {
        restoring,
        editing: false,
        accepted: true,
        preserveNew: !restoring,
      });
      paint();
      return true;
    }
    function settle(result) {
      if (
        !current ||
        current.phase !== 'uncertain' ||
        !current.requestId ||
        result.requestId !== current.requestId ||
        result.attempt !== current.attempt ||
        result.preparationId !== current.preparation?.id
      )
        return false;
      if (result.accepted === true) return finishAccepted(current);
      else if (result.deliveryUncertain === false) current.phase = 'editing';
      else current.phase = 'uncertain';
      paint();
      return true;
    }
    function draftChanged({ userInput = false } = {}) {
      if (!current || !sameOwner(current)) return false;
      // Ordinary draft persistence remains untouched while historical text is
      // being edited. The adapter owns storage for the original draft backup.
      if (current.applied) {
        const value = draftSnapshot();
        if (
          userInput ||
          !current.editedDraft ||
          draftSignature(value) !== draftSignature(current.editedDraft)
        )
          current.editVersion = (current.editVersion || 0) + 1;
        current.editedDraft = value;
      }
      return current.applied;
    }
    listen(doc, 'pointerdown', onPointerDown, true);
    listen(log, 'pointerdown', onLogDown, { passive: true });
    listen(doc, 'pointermove', onMove, { passive: true });
    listen(doc, 'pointerup', onPointerEnd, true);
    listen(doc, 'pointercancel', onPointerCancel, true);
    listen(log, 'contextmenu', onContextMenu);
    listen(doc, 'click', onClick, true);
    listen(doc, 'selectionchange', () => {
      if (selected()) {
        clearPress('selection');
        closeOwnMenu();
      }
    });
    listen(
      doc,
      'scroll',
      () => {
        clearPress('scroll');
        closeOwnMenu();
      },
      true,
    );
    function resetGesture(reason) {
      clearPress(reason);
      closeOwnMenu();
      touchPointers.clear();
      lastPointer = null;
      consumeReleaseClick = null;
      openedGesture = null;
    }
    listen(win, 'blur', () => resetGesture('blur'));
    listen(win, 'resize', () => {
      clearPress('resize');
      closeOwnMenu();
    });
    listen(doc, 'visibilitychange', () => {
      if (doc.hidden) resetGesture('hidden');
    });
    listen(input, 'keydown', (event) => {
      if (
        event.key === 'Escape' &&
        current &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        cancel()
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    listen(cancelButton, 'click', () => {
      cancel();
      input.focus({ preventScroll: true });
    });
    function destroy() {
      cancel();
      destroyed = true;
      clearPress();
      closeOwnMenu();
      for (const release of listeners) release();
      bar.remove();
    }
    function editMessage(messageId) {
      const owner = context();
      if (!eligible(owner) || !owner.connected) {
        reportError('请等待会话就绪并结束当前操作后，再编辑这条消息。');
        return;
      }
      const bubble = [...log.querySelectorAll('[data-message-id][data-role="user"]')].find(
        (node) => node.dataset.messageId === messageId && messageFor(node)?.id === messageId,
      );
      if (!bubble) {
        reportError('这条消息已变化，请重新打开编辑。');
        return;
      }
      return begin({
        bubble,
        messageId,
        key: keyOf(owner),
        root: rootOf(owner),
        binding: bindingSignature(owner),
      });
    }
    paintedView = JSON.stringify([null, false, context().connected]);
    paint();
    return {
      active: () => Boolean(current && sameOwner(current)),
      busy: () => Boolean(current && ownsView(current) && current.phase !== 'editing'),
      view,
      sync,
      cancel,
      send: submit,
      settle,
      draftChanged,
      destroy,
      editMessage,
    };
  }
  return { create, pointHitsText };
});
