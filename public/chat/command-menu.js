(function (root) {
  'use strict';
  const createId = () =>
    globalThis.crypto?.randomUUID?.() ||
    `command-menu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function create({
    native,
    input,
    list,
    host,
    request,
    target,
    identity,
    settings,
    onSettings,
    onBegin,
    onChange,
    closePopover,
    applySettings,
    loadCatalog,
    openGoal,
  }) {
    const panel = host.querySelector('.native-command-panel'),
      body = panel.querySelector('.native-command-body'),
      head = panel.querySelector('.native-command-head'),
      title = head.querySelector('span'),
      close = head.querySelector('button'),
      error = panel.querySelector('.native-command-error'),
      controls = panel.querySelector('.native-command-controls');
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '返回';
    back.hidden = true;
    back.setAttribute('aria-label', '返回模型列表');
    head.prepend(back);
    const cache = new Map();
    let local = null,
      composing = false;
    const valid = (ctx) => local === ctx && ctx.identity === identity();
    const active = () =>
      Boolean(
        local && ['query', 'model', 'effort', 'fast', 'saving', 'error'].includes(local.phase),
      ) || native.active();
    function warm() {
      const binding = target();
      if (!binding) return null;
      const key = identity();
      let entry = cache.get(key);
      if (entry && Date.now() - entry.at < 60000) return entry;
      entry = {
        at: Date.now(),
        commands: entry?.commands || [],
        models: entry?.models || [],
        loading: true,
      };
      cache.set(key, entry);
      if (cache.size > 32) cache.delete(cache.keys().next().value);
      const update = () => {
        if (local?.identity === key && local.phase === 'query') paint(local);
      };
      entry.promise = Promise.allSettled([
        request(`/api/commands?pane=${encodeURIComponent(binding.paneId)}`)
          .then((data) => {
            entry.commands = data.commands || [];
            entry.version = data.version;
            entry.reason = data.reason || '';
          })
          .catch(() => {
            entry.reason = '命令目录暂时无法读取，可输入完整命令后回车执行。';
          })
          .finally(() => {
            entry.loading = false;
            update();
          }),
        (loadCatalog ? loadCatalog('codex') : request('/api/agent-catalog?provider=codex')).then(
          (data) => {
            entry.models = data?.models || [];
            update();
          },
        ),
      ]);
      return entry;
    }
    function begin(phase = 'query') {
      closePopover();
      native.reset();
      onBegin?.();
      local = {
        phase,
        target: { ...target() },
        identity: identity(),
        index: 0,
        query: input.value,
        items: [],
        error: '',
      };
      return local;
    }
    function sync() {
      if (composing) return active();
      if (local && local.identity !== identity()) reset();
      if (native.active()) return native.sync();
      if (local && local.phase !== 'query') return true;
      if (
        !target() ||
        window.StudioSlashCommands.query(input.value, input.selectionStart) === null
      ) {
        if (local?.phase === 'query') hide();
        return false;
      }
      const ctx = local?.phase === 'query' ? local : begin();
      if (ctx.query !== input.value) {
        ctx.query = input.value;
        ctx.index = 0;
      }
      warm();
      paint(ctx);
      return true;
    }
    function hide() {
      local = null;
      close.disabled = false;
      back.hidden = true;
      panel.hidden = true;
      delete panel.dataset.local;
      list.hidden = true;
      body.replaceChildren();
      delete body.dataset.revision;
      input.readOnly = false;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function reset() {
      hide();
      native.reset();
    }
    function paint(ctx) {
      if (!valid(ctx)) return;
      const entry = cache.get(ctx.identity) || {};
      if (ctx.phase === 'query') {
        const query = window.StudioSlashCommands.query(input.value, input.selectionStart);
        ctx.items =
          query === null
            ? []
            : window.StudioSlashCommands.filter(entry.commands || [], query).map((item) => ({
                label: '/' + item.name,
                description: item.description || '',
                value: item.name,
                needsInput:
                  item.name === 'goal' && openGoal
                    ? false
                    : window.StudioSlashCommands.needsInput(item),
              }));
        ctx.title = entry.version ? `Codex ${entry.version}` : 'Codex 命令';
        ctx.empty = entry.loading
          ? '正在准备命令目录…'
          : entry.reason || '没有匹配的命令，按回车执行已输入的完整命令。';
      }
      panel.hidden = false;
      list.hidden = true;
      controls.hidden = true;
      panel.dataset.phase = ctx.phase;
      panel.dataset.local = 'true';
      back.hidden = ctx.phase !== 'effort';
      input.readOnly = ctx.phase !== 'query';
      title.textContent = ctx.title || 'Codex';
      close.disabled = ctx.phase === 'saving';
      error.hidden = !ctx.error;
      error.textContent = ctx.error || '';
      body.replaceChildren();
      delete body.dataset.revision;
      body.setAttribute('role', ctx.items.length ? 'listbox' : 'group');
      input.setAttribute('aria-controls', 'nativeCommandOptions');
      input.setAttribute('aria-expanded', String(ctx.items.length > 0));
      ctx.index = Math.max(0, Math.min(ctx.index, ctx.items.length - 1));
      for (const [index, item] of ctx.items.entries()) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'native-command-row command-choice';
        row.id = `command-choice-${index}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === ctx.index));
        row.classList.toggle('selected', index === ctx.index);
        row.tabIndex = -1;
        const name = document.createElement('span');
        name.className = 'command-choice-name';
        name.textContent = item.label;
        row.append(name);
        if (item.description) {
          const sub = document.createElement('span');
          sub.className = 'command-choice-description';
          sub.textContent = item.description;
          row.append(sub);
        }
        if (item.current || item.isDefault) {
          const current = document.createElement('span');
          current.className = 'command-choice-current';
          current.textContent = item.current ? '当前' : '默认';
          row.append(current);
        }
        if (ctx.phase === 'query') {
          const action = document.createElement('span');
          action.className = 'command-choice-current';
          action.textContent = item.needsInput ? '填写内容' : '执行';
          row.append(action);
        }
        row.onclick = () => choose(ctx, item);
        body.append(row);
      }
      if (!ctx.items.length) {
        const text = document.createElement('p');
        text.className = 'command-empty';
        text.textContent = ctx.empty || '';
        body.append(text);
        input.removeAttribute('aria-activedescendant');
      } else {
        input.setAttribute('aria-activedescendant', `command-choice-${ctx.index}`);
        body.children[ctx.index]?.scrollIntoView({ block: 'nearest' });
      }
    }
    function models(ctx) {
      ctx.phase = 'model';
      ctx.title = '选择模型';
      const known = settings();
      ctx.items = (cache.get(ctx.identity)?.models || []).map((model) => ({
        label: model.label,
        value: model,
        description: model.effortNote || model.efforts.map((item) => item.label).join(' · '),
        current: known?.model === model.id,
      }));
      ctx.index = Math.max(
        0,
        ctx.items.findIndex((item) => item.current),
      );
      ctx.empty = '当前模型目录暂不可用，可关闭后输入 /model 使用原生菜单。';
      paint(ctx);
    }
    function efforts(ctx, model) {
      if (!model.efforts.length) {
        void apply(ctx, { model: model.id });
        return;
      }
      ctx.phase = 'effort';
      ctx.model = model;
      ctx.title = `${model.label} · 推理强度`;
      const known = settings();
      ctx.items = model.efforts.map((effort) => ({
        label: effort.label,
        value: effort.id,
        description: effort.note || '',
        isDefault: effort.isDefault,
        current: known?.model === model.id && known.effort === effort.id,
      }));
      const current = ctx.items.findIndex((item) => item.current);
      ctx.index =
        current >= 0
          ? current
          : Math.max(
              0,
              ctx.items.findIndex((item) => item.isDefault),
            );
      paint(ctx);
    }
    function fast(ctx, model) {
      ctx.phase = 'fast';
      ctx.title = `${model.label} · 速度`;
      const known = settings();
      ctx.items = [
        { label: 'Standard', value: null },
        ...(model.serviceTiers || []).map((tier) => ({
          label: tier.name,
          value: tier.id,
          description: tier.description,
        })),
      ].map((item) => ({
        ...item,
        current: Object.hasOwn(known || {}, 'serviceTier') && known.serviceTier === item.value,
      }));
      ctx.index = Math.max(
        0,
        ctx.items.findIndex((item) => item.current),
      );
      paint(ctx);
    }
    function complete(text) {
      hide();
      input.value = text.trimEnd() + ' ';
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      onChange();
    }
    function execute(text) {
      const goal = window.StudioSlashCommands.goalCommand(text);
      if (goal && openGoal) {
        hide();
        native.reset();
        input.value = '';
        onChange();
        openGoal(goal);
        return;
      }
      const name = /^\/([\w:.-]+)\s*$/.exec(text)?.[1];
      const command = cache.get(identity())?.commands.find((item) => item.name === name) || {
        name,
      };
      if (name && window.StudioSlashCommands.needsInput(command)) {
        complete('/' + name);
        return;
      }
      if (!local) begin();
      const ctx = local;
      const entry = cache.get(ctx.identity),
        known = settings(),
        model = entry?.models.find((item) => item.id === known?.model);
      if (name === 'model' && entry?.models.length) {
        input.value = '';
        models(ctx);
        return;
      }
      if (name === 'effort' && entry?.models.length) {
        input.value = '';
        model ? efforts(ctx, model) : models(ctx);
        return;
      }
      if (name === 'fast' && model) {
        input.value = '';
        fast(ctx, model);
        return;
      }
      if (name === 'effort') text = '/model';
      hide();
      input.value = text;
      input.focus({ preventScroll: true });
      native.execute(text.trimEnd());
    }
    function choose(ctx, item) {
      if (!valid(ctx)) return;
      if (ctx.phase === 'query') {
        if (item.needsInput) complete(item.label);
        else execute(item.label);
        return;
      }
      if (ctx.phase === 'model') {
        efforts(ctx, item.value);
        return;
      }
      if (ctx.phase === 'effort') {
        void apply(ctx, { model: ctx.model.id, effort: item.value });
        return;
      }
      if (ctx.phase === 'fast') void apply(ctx, { serviceTier: item.value });
    }
    async function apply(ctx, changes) {
      if (!valid(ctx) || ctx.phase === 'saving') return;
      if (applySettings) {
        const binding = { ...ctx.target };
        hide();
        input.value = '';
        onChange();
        input.focus({ preventScroll: true });
        void applySettings(binding, changes, () => native.settled());
        return;
      }
      ctx.phase = 'saving';
      ctx.items = [];
      ctx.error = '';
      ctx.empty = '正在由 Codex 确认…';
      paint(ctx);
      onChange();
      try {
        await native.settled();
        if (!valid(ctx)) return;
        const result = await request('/api/agent-settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...ctx.target,
            threadId: ctx.target.sessionId,
            requestId: createId(),
            ...changes,
          }),
        });
        if (!valid(ctx)) return;
        onSettings(ctx.target, result.settings);
        hide();
        onChange();
      } catch (cause) {
        if (!valid(ctx)) return;
        ctx.phase = 'error';
        ctx.empty = '未确认操作结果。关闭后核对当前设置，再重新选择。';
        ctx.error = cause.message || '无法确认设置';
        paint(ctx);
        onChange();
      }
    }
    function keydown(event) {
      if (event.isComposing || composing) return false;
      if (!local) {
        if (
          !native.active() &&
          event.key === 'Enter' &&
          !event.shiftKey &&
          target() &&
          /^\/[\w:.-]+(?:\s.*)?$/s.test(input.value)
        ) {
          event.preventDefault();
          event.stopPropagation();
          enter();
          return true;
        }
        return native.keydown(event);
      }
      const ctx = local;
      if (!valid(ctx)) {
        reset();
        return false;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (ctx.phase === 'saving') return true;
        if (ctx.phase === 'effort') {
          models(ctx);
          return true;
        }
        input.value = '';
        hide();
        onChange();
        return true;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && ctx.items.length) {
        event.preventDefault();
        event.stopPropagation();
        ctx.index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? ctx.items.length - 1
              : (ctx.index + (event.key === 'ArrowDown' ? 1 : -1) + ctx.items.length) %
                ctx.items.length;
        paint(ctx);
        return true;
      }
      if (event.key === 'Tab' && ctx.phase === 'query' && ctx.items.length) {
        event.preventDefault();
        complete(ctx.items[ctx.index].label);
        return true;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        enter();
        return true;
      }
      return ctx.phase !== 'query';
    }
    function enter() {
      if (!local) {
        if (native.active()) return native.enter();
        if (target() && /^\/[\w:.-]+(?:\s.*)?$/s.test(input.value)) execute(input.value);
        return;
      }
      const ctx = local;
      if (ctx.phase === 'query') {
        const text = input.value;
        if (ctx.items[ctx.index] && /^\/[\w:.-]*$/.test(text)) choose(ctx, ctx.items[ctx.index]);
        else if (/^\/[\w:.-]+(?:\s.*)?$/s.test(text)) execute(text);
      } else if (ctx.items[ctx.index]) choose(ctx, ctx.items[ctx.index]);
    }
    close.addEventListener('click', () => {
      if (!local || local.phase === 'saving') return;
      input.value = '';
      hide();
      onChange();
      input.focus({ preventScroll: true });
    });
    back.onclick = () => {
      if (local?.phase === 'effort') models(local);
    };
    document.addEventListener('pointerdown', (event) => {
      if (!local || local.phase === 'saving' || host.contains(event.target)) return;
      input.blur();
      hide();
      onChange();
    });
    return {
      warm,
      sync,
      active,
      keydown,
      enter,
      reset,
      input: () => (local ? false : native.input()),
      composition(value) {
        composing = value;
        native.composition(value, Boolean(local) || !native.active());
        if (!value && local) sync();
      },
      hasPending: () => active(),
    };
  }
  root.StudioCommandMenu = { create };
})(window);
