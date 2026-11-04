(function (root) {
  'use strict';
  const createId = () =>
    root.crypto?.randomUUID?.() ||
    `status-view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function create({
    request,
    target,
    identity,
    observation,
    openPopover,
    closePopover,
    currentPopover,
    onChange,
  }) {
    let current = null;
    const valid = (ctx) => Boolean(ctx && current === ctx && identity() === ctx.identity);
    const active = () =>
      Boolean(
        current &&
        valid(current) &&
        !current.ended &&
        (current.busy ||
          current.closing ||
          !current.view ||
          current.view.pending ||
          current.view.mode === 'menu'),
      );
    function changed() {
      onChange();
    }
    async function call(ctx, action, extra = {}) {
      let value;
      try {
        value = await request({
          ...ctx.target,
          clientId: ctx.clientId,
          leaseId: ctx.leaseId,
          requestId: createId(),
          action,
          ...extra,
        });
      } catch (error) {
        error.nativeStatusAction = action;
        throw error;
      }
      if (!valid(ctx)) return null;
      if (
        action === 'read' &&
        (ctx.errorAction === 'read' ||
          (['COMMAND_MENU_CHANGED', 'COMMAND_ACTION_PENDING'].includes(ctx.errorCode) &&
            value.revision !== ctx.view?.revision &&
            !value.pending))
      )
        ctx.error = '';
      ctx.leaseId = value.leaseId;
      if (!value.unchanged) ctx.view = value;
      return ctx.view;
    }
    async function execute(ctx) {
      try {
        return await call(ctx, 'execute', { text: ctx.command });
      } catch (error) {
        if (!valid(ctx)) return null;
        // Recover a lost response using this client's read-only lease lookup.
        // A second execute could paste the command into an occupied composer.
        try {
          const view = await call(ctx, 'read');
          if (view && (view.pending || ['result', 'menu'].includes(view.mode))) return view;
        } catch {
          /* Keep the original operation error. */
        }
        throw error;
      }
    }
    function fail(ctx, error) {
      if (!valid(ctx)) return;
      ctx.error = error.message || '原生状态读取失败，请核对当前终端。';
      ctx.errorAction = error.nativeStatusAction || 'operation';
      ctx.errorCode = error.code || '';
      ctx.busy = false;
      if (ctx.closeRequested || !ctx.view || (!ctx.view.pending && ctx.view.mode !== 'menu'))
        ctx.ended = true;
      clearTimeout(ctx.timer);
      paint(ctx);
      changed();
      if (!ctx.closeRequested && ctx.leaseId) schedule(ctx);
    }
    function schedule(ctx) {
      clearTimeout(ctx.timer);
      if (!valid(ctx) || ctx.ended || ctx.closing || ctx.busy || document.hidden || !active())
        return;
      ctx.timer = setTimeout(
        async () => {
          if (!valid(ctx) || ctx.closing || ctx.busy || ctx.ended) return;
          ctx.reading = call(ctx, 'read', { revision: ctx.view?.revision });
          try {
            await ctx.reading;
            paint(ctx);
            changed();
          } catch (error) {
            fail(ctx, error);
          } finally {
            ctx.reading = null;
            schedule(ctx);
          }
        },
        ctx.view?.pending ? 150 : 1000,
      );
    }
    async function settle(ctx) {
      for (let i = 0; valid(ctx) && ctx.view?.pending && i < 30; i++) {
        await pause(100);
        await call(ctx, 'read', { revision: ctx.view.revision });
      }
      if (ctx.view?.pending) throw new Error('原生操作结果待确认，请核对当前终端；不会重复按键。');
    }
    async function finish(ctx) {
      ctx.closeRequested = true;
      clearTimeout(ctx.timer);
      if (!valid(ctx) || ctx.ended || ctx.closing || ctx.busy) return;
      if (!ctx.leaseId) {
        ctx.ended = true;
        changed();
        return;
      }
      ctx.closing = true;
      changed();
      try {
        if (ctx.reading) await ctx.reading;
        await call(ctx, 'read');
        await settle(ctx);
        const limit = Math.min(130, (ctx.view?.warningCount || 1) * 2 + 3);
        for (let n = 0; valid(ctx) && ctx.view?.mode === 'menu' && n < limit; n++) {
          if (ctx.view.surface !== 'warnings')
            throw new Error('原生界面已变化，请在终端核对后关闭。');
          await call(ctx, 'close', { revision: ctx.view.revision });
          await settle(ctx);
        }
        if (ctx.view?.mode === 'menu')
          throw new Error('警告数量较多，已保留当前处理结果，请继续在终端操作。');
        ctx.ended = true;
        ctx.error = '';
      } catch (error) {
        ctx.error = error.message;
        ctx.ended = true;
      } finally {
        ctx.closing = false;
        changed();
      }
    }
    async function key(ctx, value) {
      if (!valid(ctx) || ctx.busy || ctx.closing || ctx.view?.pending) return;
      const expectedRevision = ctx.view.revision;
      clearTimeout(ctx.timer);
      ctx.busy = true;
      ctx.error = '';
      ctx.note = '';
      paint(ctx);
      changed();
      try {
        if (ctx.reading) await ctx.reading;
        if (!valid(ctx)) return;
        if (ctx.view.revision !== expectedRevision) {
          ctx.busy = false;
          ctx.note = '原生警告已更新，请按当前内容继续。';
          paint(ctx);
          changed();
          schedule(ctx);
          return;
        }
        await call(ctx, 'key', { key: value, revision: ctx.view.revision });
        ctx.busy = false;
        paint(ctx);
        changed();
        if (ctx.view?.mode !== 'menu' && !ctx.view?.pending) {
          ctx.ended = true;
          if (currentPopover() === ctx.layer) closePopover();
          changed();
        } else if (ctx.closeRequested) void finish(ctx);
        else schedule(ctx);
      } catch (error) {
        fail(ctx, error);
      }
    }
    function paint(ctx) {
      if (!valid(ctx) || !ctx.content.isConnected) return;
      const view = ctx.view,
        pending = !view || view.pending;
      const note = ctx.content.querySelector('[data-native-notice]');
      note.textContent =
        ctx.error ||
        (pending
          ? '正在读取原生状态，聊天草稿可继续编辑。'
          : ctx.busy
            ? '正在由 Codex 确认…'
            : ctx.note || '');
      note.hidden = !note.textContent;
      const body = ctx.content.querySelector('[data-native-content]');
      const lines = (view?.rows || []).map((row) =>
        row
          .map((span) => span.text)
          .join('')
          .trimEnd(),
      );
      const heading = lines.find((line) => /^\s*Warnings\b/.test(line));
      const visible = lines.filter(
        (line) =>
          line !== heading &&
          !/^\s*(?:\/ps|\/warnings|Background terminals\s*$)/.test(line) &&
          !/\bk keep\s*&\s*next\b/.test(line),
      );
      const content = pending ? '' : visible.join('\n').trim();
      if (body.textContent !== content) body.textContent = content;
      const buttons = ctx.content.querySelector('[data-native-buttons]');
      buttons.hidden = view?.surface !== 'warnings';
      buttons.querySelector('[data-native-progress]').textContent =
        view?.surface === 'warnings' ? `${view.warningIndex} / ${view.warningCount}` : '';
      for (const button of buttons.querySelectorAll('button'))
        button.disabled = ctx.busy || pending || ctx.closing;
    }
    function open(command, anchor) {
      if (active() || !['/warnings', '/ps'].includes(command) || !target()) return false;
      const ctx = {
        identity: identity(),
        target: { ...target() },
        clientId: createId(),
        leaseId: '',
        command,
        startedObservation: observation().observationToken,
        busy: true,
        closing: false,
        ended: false,
        closeRequested: false,
        view: null,
        error: '',
        timer: 0,
      };
      current = ctx;
      const content = document.createElement('div');
      ctx.content = content;
      content.className = 'session-status-content';
      const notice = document.createElement('p');
      notice.dataset.nativeNotice = '';
      notice.setAttribute('role', 'status');
      const body = document.createElement('div');
      body.className = 'session-native-details';
      body.dataset.nativeContent = '';
      body.tabIndex = 0;
      const buttons = document.createElement('div');
      buttons.className = 'session-native-buttons';
      buttons.dataset.nativeButtons = '';
      buttons.hidden = true;
      const progress = document.createElement('span');
      progress.className = 'session-native-progress';
      progress.dataset.nativeProgress = '';
      buttons.append(progress);
      for (const [label, value] of [
        ['上一条', 'left'],
        ['下一条', 'right'],
        ['向上滚动', 'up'],
        ['向下滚动', 'down'],
        ['保留并继续', 'k'],
        ['忽略已读并关闭', 'esc'],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.dataset.nativeKey = value;
        button.onclick = () => key(ctx, value);
        buttons.append(button);
      }
      content.append(notice, body, buttons);
      anchor.setAttribute('aria-expanded', 'true');
      ctx.layer = openPopover(anchor, {
        content,
        className: 'session-status-popover',
        label: command === '/ps' ? '后台终端' : 'Codex 警告',
        onClose: () => {
          anchor.setAttribute('aria-expanded', 'false');
          void finish(ctx);
        },
      });
      paint(ctx);
      changed();
      void execute(ctx)
        .then(() => {
          if (!valid(ctx)) return;
          ctx.busy = false;
          paint(ctx);
          changed();
          if (ctx.closeRequested) void finish(ctx);
          else schedule(ctx);
        })
        .catch((error) => fail(ctx, error));
      return true;
    }
    function reset() {
      const previous = current;
      if (!previous) return;
      current = null;
      clearTimeout(previous.timer);
      if (currentPopover() === previous.layer) closePopover();
    }
    return {
      open,
      active,
      reset,
      reconcile: (hidden) => {
        if (current && (hidden || !valid(current))) {
          reset();
          return;
        }
        const latest = observation();
        if (
          current?.ended &&
          current.error &&
          latest.observationToken &&
          latest.observationToken !== current.startedObservation &&
          !latest.stale &&
          latest.observation?.thread === 'main' &&
          latest.observation?.capabilities?.compose
        )
          reset();
      },
      notice: () =>
        valid(current) ? (current.closing ? '正在保留警告并返回…' : current.error || '') : '',
    };
  }
  root.StudioNativeStatusView = { create };
})(window);
