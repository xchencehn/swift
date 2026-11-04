(function (root) {
  'use strict';
  const createId = () =>
    globalThis.crypto?.randomUUID?.() ||
    `side-thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function create({
    entry,
    bar,
    context,
    request,
    onChange,
    onBeforeChange = () => {},
    onFork = () => {},
    canOptimistic = () => false,
    onObserved = () => {},
    confirmClose,
  }) {
    const main = bar.querySelector('[data-side="main"]'),
      side = bar.querySelector('[data-side="side"]');
    const end = bar.querySelector('[data-side="close"]'),
      fork = bar.querySelector('[data-side="fork"]');
    const error = bar.querySelector('.side-thread-error');
    let sendAttempt = null;
    let current = null,
      key = '',
      pending = null,
      busy = false,
      fresh = false,
      serial = 0;
    const identity = () => {
      const c = context();
      return c.pane && !c.archived
        ? JSON.stringify([
            c.root,
            c.runtimeId,
            c.pane.paneId,
            c.pane.terminalId,
            c.pane.runtimeId,
            c.pane.agent?.session?.value,
          ])
        : '';
    };
    const eligible = () =>
      /^codex$/i.test(context().pane?.agent?.label || '') && !context().archived;
    function view() {
      return key === identity() ? current : null;
    }
    function render() {
      const value = view(),
        c = context(),
        active = value?.mode === 'side';
      entry.hidden = !eligible();
      entry.disabled = !c.connected || busy || !fresh || !value || value.mode === 'unknown';
      entry.setAttribute('aria-pressed', String(active));
      entry.setAttribute(
        'aria-label',
        active ? '返回主会话' : value?.hasSide ? '返回临时会话' : '打开临时会话',
      );
      entry.title = entry.getAttribute('aria-label');
      bar.hidden = !eligible() || (!value?.hasSide && error.hidden);
      main.setAttribute('aria-pressed', String(!active));
      side.setAttribute('aria-pressed', String(active));
      main.disabled = side.disabled = !c.connected || busy || !fresh;
      if (fork) {
        fork.hidden = !value?.hasSide || !value?.structured;
        fork.disabled = !c.connected || busy || !value?.sideId;
      }
      end.hidden = !active;
      end.disabled = !c.connected || busy || !fresh || !value?.canClose;
      end.title = value?.canClose ? '结束临时会话' : '执行中或有未发送内容，请先在临时会话中处理';
      bar.setAttribute('aria-busy', String(busy));
    }
    function accept(value, mine) {
      if (mine !== identity()) return;
      const previous = view();
      key = mine;
      fresh = value.mode !== 'unknown';
      // An obscured footer or interrupted observation cannot prove side ended.
      const changed =
        (previous?.mode === 'side') !== (value.mode === 'side') ||
        previous?.sideId !== value.sideId;
      if (changed) onBeforeChange(previous);
      current =
        value.mode === 'unknown' && previous?.hasSide ? { ...previous, canClose: false } : value;
      render();
      onObserved(value);
      if (changed) onChange(current, previous);
    }
    async function refresh() {
      if (!eligible() || !context().connected) {
        fresh = false;
        render();
        return;
      }
      const mine = identity();
      if (pending?.key === mine) return pending.promise;
      if (key !== mine) {
        current = null;
        fresh = false;
        key = mine;
        error.hidden = true;
      }
      const task = { key: mine },
        order = ++serial;
      task.promise = request(`/api/agents/side?pane=${encodeURIComponent(context().pane.paneId)}`)
        .then((value) => {
          if (order === serial && !busy) accept(value, mine);
        })
        .catch(() => {
          if (mine === identity()) {
            fresh = false;
            render();
          }
        })
        .finally(() => {
          if (pending === task) pending = null;
        });
      pending = task;
      return task.promise;
    }
    async function act(action, extra = {}) {
      const value = view(),
        mine = identity();
      if (!value || busy || !fresh || !context().connected) return;
      if (action === 'close' && !(await confirmClose())) return;
      if (mine !== identity() || value.revision !== view()?.revision) return;
      busy = true;
      ++serial;
      error.hidden = true;
      if (['main', 'side'].includes(action) && value.structured && canOptimistic(action, value)) {
        onBeforeChange(value);
        current = { ...value, mode: action };
        fresh = false;
        render();
        onChange(current, value);
      } else render();
      const intent = action === 'send' ? JSON.stringify([mine, extra.sideId, extra.text]) : '';
      const body =
        action === 'send' && sendAttempt?.intent === intent
          ? sendAttempt.body
          : {
              paneId: context().pane.paneId,
              binding: value.binding,
              revision: value.revision,
              action,
              requestId: createId(),
              sideId: value.sideId,
              turnId: value.turnId,
              ...extra,
            };
      if (action === 'send') sendAttempt = { intent, body };
      try {
        const result = await request('/api/agents/side', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (action === 'send') sendAttempt = null;
        accept(result, mine);
        return result;
      } catch (failure) {
        if (
          action === 'send' &&
          ['SIDE_CHANGED', 'QUESTION_PENDING', 'INVALID_SIDE_MESSAGE', 'SESSION_CHANGED'].includes(
            failure.code,
          )
        )
          sendAttempt = null;
        if (mine === identity()) {
          error.textContent = failure.message;
          error.hidden = false;
          bar.hidden = false;
        }
        if (action === 'send') throw failure;
      } finally {
        busy = false;
        render();
        await refresh();
      }
    }
    entry.addEventListener('click', () => {
      const v = view();
      void act(v?.mode === 'side' ? 'main' : v?.hasSide ? 'side' : 'open');
    });
    main.addEventListener('click', () => {
      if (view()?.mode === 'side') void act('main');
    });
    side.addEventListener('click', () => {
      if (view()?.mode !== 'side') void act('side');
    });
    fork?.addEventListener('click', async () => {
      if (busy || !context().connected || !view()?.sideId) return;
      busy = true;
      render();
      try {
        await onFork(view());
      } finally {
        busy = false;
        render();
      }
    });
    end.addEventListener('click', () => {
      void act('close');
    });
    return {
      view,
      refresh,
      render,
      act,
      ready: () => fresh && !busy && context().connected,
      send: (text) => act('send', { text, sideId: view()?.sideId }),
      active: () => eligible() && view()?.mode === 'side',
    };
  }
  root.StudioSideThread = { create };
})(globalThis);
