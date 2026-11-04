(function (root) {
  'use strict';
  const createId = () =>
    root.crypto?.randomUUID?.() ||
    `command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function create({
    input,
    list,
    host,
    request,
    target,
    identity,
    onChange,
    onBegin,
    closePopover,
  }) {
    const panel = document.createElement('section');
    panel.className = 'native-command-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Codex 原生命令');
    const head = document.createElement('div');
    head.className = 'native-command-head';
    const title = document.createElement('span');
    title.textContent = 'Codex';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.setAttribute('aria-label', '结束命令交互');
    head.append(title, close);
    const body = document.createElement('div');
    body.className = 'native-command-body';
    body.id = 'nativeCommandOptions';
    body.setAttribute('aria-label', 'Codex 原生菜单');
    const error = document.createElement('p');
    error.className = 'native-command-error';
    error.hidden = true;
    const controls = document.createElement('div');
    controls.className = 'native-command-controls';
    for (const [label, key] of [
      ['上移', 'up'],
      ['下移', 'down'],
      ['确认', 'enter'],
      ['返回', 'esc'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.nativeKey = key;
      button.onclick = () => keyAction(key);
      controls.append(button);
    }
    panel.append(head, body, error, controls);
    host.append(panel);
    panel.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) event.preventDefault();
    });
    let current = null,
      chain = Promise.resolve(),
      timer = 0,
      editTimer = 0,
      composing = false;
    const active = () =>
      Boolean(
        current &&
        (!current.view || current.view.pending || ['query', 'menu'].includes(current.view.mode)),
      );
    const valid = (ctx) => ctx === current && ctx.identity === identity();
    const enqueue = (run) => {
      chain = chain
        .catch(() => {})
        .then(run)
        .catch(fail);
      return chain;
    };
    function fail(cause) {
      if (!current) return;
      current.opening = false;
      input.readOnly = false;
      current.error = cause.message || '原生命令连接失败，请核对 Codex 页面。';
      current.errorAction = cause.nativeAction || 'operation';
      paint(current);
      clearTimeout(timer);
      if (
        ![
          'NATIVE_INPUT_OCCUPIED',
          'NATIVE_INPUT_CHANGED',
          'COMMAND_IN_USE',
          'COMMAND_EXPIRED',
          'RUNTIME_CHANGED',
          'SESSION_CHANGED',
          'UNSUPPORTED_PROVIDER',
        ].includes(cause.code)
      )
        schedule(current, 1000);
      onChange();
    }
    async function call(ctx, action, extra = {}) {
      let result;
      try {
        result = await request({
          ...ctx.target,
          clientId: ctx.clientId,
          leaseId: ctx.leaseId,
          requestId: createId(),
          action,
          ...extra,
        });
      } catch (cause) {
        if (!valid(ctx)) return null;
        cause.nativeAction = action;
        throw cause;
      }
      if (!valid(ctx)) return null;
      const hadError = Boolean(ctx.error);
      ctx.leaseId = result.leaseId;
      const clear =
        action !== 'read' ||
        ctx.errorAction === 'read' ||
        (!result.unchanged && result.revision !== ctx.view?.revision);
      if (clear) ctx.error = '';
      return result.unchanged ? (hadError && clear ? { ...ctx.view } : ctx.view) : result;
    }
    function setView(ctx, view, fromKey = false) {
      if (!view || !valid(ctx)) return;
      if (view === ctx.view) {
        schedule(ctx);
        return;
      }
      const previous = ctx.view?.mode;
      ctx.view = view;
      ctx.opening = false;
      input.readOnly = Boolean(view.pending);
      if (ctx.selectionRevision !== view.revision) {
        ctx.selection = null;
        ctx.selectionRevision = view.revision;
      }
      if (fromKey && view.mode === 'query') {
        input.value = view.input;
        ctx.desired = ctx.applied = view.input;
      }
      if (view.mode === 'menu' && previous !== 'menu') input.value = '';
      if (
        ['result', 'idle'].includes(view.mode) &&
        (input.value.startsWith('/') || previous === 'menu')
      )
        input.value = '';
      if (['result', 'idle'].includes(view.mode) && !view.pending && !view.failed && !ctx.error) {
        hide();
        onChange();
        return;
      }
      paint(ctx, fromKey);
      onChange();
      schedule(ctx);
    }
    function schedule(ctx, delay = 250) {
      clearTimeout(timer);
      if (!valid(ctx) || !active() || document.hidden) return;
      timer = setTimeout(
        () =>
          enqueue(async () => {
            if (!valid(ctx) || !active()) return;
            setView(ctx, await call(ctx, 'read', { revision: ctx.view?.revision }));
          }),
        delay,
      );
    }
    async function flush(ctx) {
      while (
        valid(ctx) &&
        ctx.desired !== ctx.applied &&
        ctx.desired.startsWith('/') &&
        (!ctx.view || ctx.view.mode === 'query')
      ) {
        const text = ctx.desired;
        const view = await call(ctx, 'edit', { text });
        if (!view) return;
        ctx.applied = text;
        setView(ctx, view);
      }
    }
    function sync() {
      if (composing) return;
      if (current && current.identity !== identity()) reset();
      const binding = target();
      if (!binding) return false;
      if (current?.view?.pending || current?.view?.mode === 'menu') return true;
      if (!input.value.startsWith('/')) {
        if (active()) void finish(true);
        return false;
      }
      if (!current || !active()) {
        closePopover();
        clearTimeout(timer);
        current = {
          target: binding,
          identity: identity(),
          clientId: createId(),
          leaseId: '',
          view: null,
          desired: input.value,
          applied: null,
          error: '',
        };
        onBegin?.();
      }
      const ctx = current;
      ctx.desired = input.value;
      clearTimeout(editTimer);
      editTimer = setTimeout(() => enqueue(() => flush(ctx)), 60);
      return true;
    }
    function execute(text) {
      input.value = text;
      sync();
      clearTimeout(editTimer);
      const ctx = current;
      if (!ctx) return;
      ctx.opening = true;
      input.readOnly = true;
      paint(ctx);
      onChange();
      enqueue(async () => {
        if (!valid(ctx)) return;
        ctx.desired = ctx.applied = text;
        setView(ctx, await call(ctx, 'execute', { text }), true);
      });
    }
    function keyAction(key) {
      const ctx = current;
      if (!ctx || !active()) return;
      if (ctx.view?.mode === 'menu' && ctx.view.options.length && !ctx.view.pending) {
        const index = ctx.selection ?? ctx.view.options.findIndex((item) => item.selected);
        if (['up', 'down', 'home', 'end'].includes(key)) {
          ctx.selection =
            key === 'home'
              ? 0
              : key === 'end'
                ? ctx.view.options.length - 1
                : Math.max(
                    0,
                    Math.min(ctx.view.options.length - 1, index + (key === 'down' ? 1 : -1)),
                  );
          paint(ctx, true);
          return;
        }
        if (key === 'enter') {
          pick(ctx.view.options[index]?.label);
          return;
        }
      }
      clearTimeout(editTimer);
      enqueue(async () => {
        if (!valid(ctx)) return;
        await flush(ctx);
        if (!valid(ctx) || !ctx.view || ctx.view.pending) return;
        setView(ctx, await call(ctx, 'key', { key, revision: ctx.view.revision }), true);
      });
    }
    function pick(option) {
      const ctx = current;
      if (!ctx || ctx.picking) return;
      ctx.picking = true;
      clearTimeout(editTimer);
      enqueue(async () => {
        try {
          await flush(ctx);
          if (!valid(ctx) || !ctx.view || ctx.view.pending) return;
          setView(ctx, await call(ctx, 'pick', { option, revision: ctx.view.revision }), true);
        } finally {
          ctx.picking = false;
        }
      });
    }
    function inputEvent() {
      if (composing) return active();
      if (current?.view?.mode === 'menu') {
        const text = input.value;
        input.value = '';
        if (text) {
          const ctx = current;
          enqueue(async () => {
            if (valid(ctx))
              setView(
                ctx,
                await call(ctx, 'key', { key: 'text', text, revision: ctx.view.revision }),
                true,
              );
          });
        }
        return true;
      }
      return false;
    }
    function keydown(event) {
      if (event.isComposing || composing) return false;
      if (current && current.identity !== identity()) reset();
      if (!active()) {
        if (event.key === 'Escape' && !panel.hidden) {
          event.preventDefault();
          event.stopPropagation();
          hide();
          return true;
        }
        return false;
      }
      const map = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', Escape: 'esc', Tab: 'tab' };
      if (current.view?.mode === 'menu')
        Object.assign(map, {
          ArrowLeft: 'left',
          ArrowRight: 'right',
          Home: 'home',
          End: 'end',
          Backspace: 'backspace',
          ' ': 'space',
        });
      let key = map[event.key];
      if (current.view?.mode === 'menu') {
        if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) key = event.key.toLowerCase();
        if ((event.ctrlKey || event.altKey) && event.key.toLowerCase() === 'v' && !event.altKey)
          return false;
        const base = key || (event.key.length === 1 ? event.key.toLowerCase() : '');
        if (base && (event.ctrlKey || event.altKey || (event.shiftKey && event.key === 'Enter')))
          key = [
            ...(event.ctrlKey ? ['ctrl'] : []),
            ...(event.altKey ? ['alt'] : []),
            ...(event.shiftKey ? ['shift'] : []),
            base,
          ].join('+');
      }
      if (
        !key &&
        current.view?.mode === 'menu' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.length === 1
      ) {
        const ctx = current;
        event.preventDefault();
        event.stopPropagation();
        enqueue(async () => {
          if (valid(ctx))
            setView(
              ctx,
              await call(ctx, 'key', {
                key: /^[1-9s]$/.test(event.key) ? event.key : 'text',
                text: event.key,
                revision: ctx.view.revision,
              }),
              true,
            );
        });
        return true;
      }
      if (!key) return false;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'esc' && (!current.view || current.error)) void finish();
      else keyAction(key);
      return true;
    }
    async function finish(preserveInput = false) {
      const ctx = current;
      if (!ctx) return;
      clearTimeout(editTimer);
      clearTimeout(timer);
      return enqueue(async () => {
        if (!valid(ctx)) return;
        // Closing a query clears only our verified draft. A native selector may
        // have parents; read each Escape result before returning another one.
        if (active())
          for (let tries = 0; tries < 8; tries++) {
            const result = await call(ctx, 'close');
            if (!result) return;
            ctx.view = result;
            if (!['menu', 'query'].includes(result.mode)) break;
          }
        if (active()) throw new Error('Codex 菜单仍未关闭，请继续在原生界面处理。');
        if (!preserveInput) input.value = '';
        hide();
        onChange();
      });
    }
    function hide() {
      clearTimeout(timer);
      clearTimeout(editTimer);
      current = null;
      input.readOnly = false;
      panel.hidden = true;
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function reset() {
      const old = current,
        wasActive = active();
      hide();
      if (old && wasActive)
        chain = chain
          .catch(() => {})
          .then(() =>
            request({
              ...old.target,
              clientId: old.clientId,
              leaseId: old.leaseId,
              requestId: createId(),
              action: 'close',
            }),
          )
          .catch(() => {});
    }
    function paint(ctx, followSelection = false) {
      if (!valid(ctx)) return;
      const view = ctx.view;
      error.hidden = !ctx.error;
      error.textContent = ctx.error;
      if (ctx.opening || view?.pending) {
        panel.hidden = false;
        list.hidden = true;
        controls.hidden = true;
        title.textContent = ctx.desired || 'Codex';
        body.replaceChildren();
        delete body.dataset.revision;
        const pending = document.createElement('p');
        pending.className = 'command-empty';
        pending.textContent = '正在由 Codex 确认…';
        body.append(pending);
        input.setAttribute('aria-expanded', 'false');
        return;
      }
      if (!view) body.replaceChildren();
      if (view?.mode === 'query' && !ctx.error) {
        // Codex already renders command candidates in the native status area.
        // Keep keyboard interaction here without creating a second popup.
        panel.hidden = true;
        list.hidden = true;
        list.replaceChildren();
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-controls');
        input.removeAttribute('aria-activedescendant');
        return;
      }
      list.hidden = true;
      body.setAttribute('role', view?.mode === 'menu' && view.options.length ? 'listbox' : 'group');
      input.setAttribute(
        'aria-controls',
        view?.mode === 'menu' ? 'nativeCommandOptions' : 'slashCommands',
      );
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      panel.hidden = !ctx.error && (!view || view.mode === 'idle');
      title.textContent = ctx.desired || 'Codex';
      controls.hidden = view?.mode !== 'menu';
      if (view && body.dataset.revision !== view.revision + ':' + ctx.selection) {
        body.dataset.revision = view.revision + ':' + ctx.selection;
        for (let index = 0; index < view.rows.length; index++) {
          const spans = view.rows[index],
            text = spans.map((span) => span.text).join('');
          const option = view.options.find(
            (option) =>
              new RegExp('^\\s*[› ]?\\s*\\d+\\.\\s+').test(text) &&
              text.trim().endsWith(option.label),
          );
          let row = body.children[index];
          const tag = option ? 'BUTTON' : 'DIV';
          if (!row || row.tagName !== tag) {
            const next = document.createElement(tag.toLowerCase());
            if (row) row.replaceWith(next);
            else body.append(next);
            row = next;
          }
          const selected =
            option &&
            (ctx.selection == null ? option.selected : view.options[ctx.selection] === option);
          row.className = 'native-command-row';
          row.classList.toggle('selected', Boolean(selected));
          if (option) {
            row.type = 'button';
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(Boolean(selected)));
            row.onclick = () => pick(option.label);
          }
          if (row.dataset.text !== JSON.stringify(spans)) {
            row.dataset.text = JSON.stringify(spans);
            row.replaceChildren();
            for (const span of spans) {
              const node = document.createElement('span');
              node.textContent = span.text;
              if (span.color) node.style.color = span.color;
              if (span.bold) node.style.fontWeight = '600';
              if (span.dim) node.className = 'dim';
              row.append(node);
            }
          }
        }
        while (body.children.length > view.rows.length) body.lastChild.remove();
        if (followSelection) {
          const selected = body.querySelector('.selected');
          if (selected) {
            const r = selected.getBoundingClientRect(),
              bounds = body.getBoundingClientRect();
            if (r.top < bounds.top) body.scrollTop -= bounds.top - r.top;
            else if (r.bottom > bounds.bottom) body.scrollTop += r.bottom - bounds.bottom;
          }
        }
      }
    }
    close.onclick = () => finish();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(timer);
      else if (current) schedule(current, 0);
    });
    return {
      sync,
      execute,
      active,
      keydown,
      input: inputEvent,
      enter: () => keyAction('enter'),
      reset,
      settled: () => chain,
      composition(value, defer = false) {
        composing = value;
        if (!value && !defer) {
          if (current?.view?.mode === 'menu') inputEvent();
          else sync();
        }
      },
      hasPending: () => active(),
    };
  }
  root.StudioCommandInteraction = { create };
})(window);
