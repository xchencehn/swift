(function (root) {
  'use strict';
  const createId = () =>
    globalThis.crypto?.randomUUID?.() ||
    `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const labels = {
    active: '进行中',
    paused: '已暂停',
    blocked: '受阻',
    usageLimited: '额度受限',
    budgetLimited: '预算耗尽',
    complete: '已完成',
    unknown: '状态未知',
  };
  function create({ dialogs, request, target, identity, refresh }) {
    let current = null;
    const jobs = new Map(),
      valid = (ctx) => current === ctx && ctx.key === identity();
    function update(key, goal) {
      if (!current) return;
      if (current.key !== key) return dialogs.close(null);
      if (current.busy || current.editing || !current.ready) return;
      const changed =
        current.goal?.objective !== goal?.objective || current.goal?.status !== goal?.status;
      current.goal = goal;
      if (changed) {
        current.message = '';
        if (current.binding) {
          current.ready = false;
          void load(current);
        }
      }
      paint(current);
    }
    function paint(ctx) {
      if (!valid(ctx)) return;
      const editable = Boolean(ctx.binding),
        hasGoal = Boolean(ctx.goal),
        creating = !hasGoal && ctx.ready && editable;
      const editing = ctx.editing || creating;
      ctx.status.textContent = ctx.busy
        ? '正在确认…'
        : !ctx.ready
          ? ctx.loadError
            ? '读取失败'
            : '正在读取…'
          : hasGoal
            ? labels[ctx.goal.status] || '状态未知'
            : '未设置';
      ctx.status.dataset.status = ctx.goal?.status || '';
      ctx.text.textContent =
        ctx.goal?.objective || '为当前会话设置目标，Codex 将继续推进直到完成或暂停。';
      ctx.text.hidden = editing && !ctx.replacing;
      ctx.inputLabel.hidden = ctx.input.hidden = !editing;
      ctx.inputLabel.textContent = ctx.replacing ? '新目标' : creating ? '目标' : '修改目标';
      ctx.input.maxLength = ctx.replacing || creating ? 2000 : 12000;
      ctx.input.disabled = ctx.busy || ctx.uncertain;
      const available = ctx.ready && editable && !ctx.busy && !ctx.uncertain;
      ctx.actions.forEach((button) => {
        button.hidden = true;
        button.disabled = !available;
        button.classList.remove('goal-primary');
      });
      const show = (index, text, primary = false) => {
        const button = ctx.actions[index];
        button.hidden = false;
        button.textContent = text;
        button.classList.toggle('goal-primary', primary);
        return button;
      };
      if (ctx.confirmClear && hasGoal) {
        show(3, ctx.busy ? '清空中…' : '确认清空 Goal', true);
        show(5, '保留目标');
      } else if (editing) {
        show(
          ctx.replacing || creating ? 4 : 0,
          ctx.busy ? '保存中…' : ctx.replacing ? '替换目标' : creating ? '启动 Goal' : '保存修改',
          true,
        );
      } else if (hasGoal && editable) {
        show(0, '修改');
        if (ctx.goal.status === 'active')
          show(2, ctx.busy && ctx.action === 'pause' ? '暂停中…' : '暂停 Goal', true);
        else if (['paused', 'blocked', 'usageLimited'].includes(ctx.goal.status))
          show(1, ctx.busy && ctx.action === 'resume' ? '继续中…' : '继续', true);
        show(3, '清空 Goal');
      }
      if (ctx.loadError || ctx.uncertain || ctx.operationError) {
        const button = show(6, '刷新核对');
        button.disabled = ctx.busy;
      }
      ctx.feedback.textContent = ctx.message || '';
      ctx.feedback.hidden = !ctx.message;
      ctx.note.textContent = !editable
        ? '当前会话只支持查看 Goal。'
        : ctx.uncertain
          ? '结果尚未确认。刷新只核对状态，不会重复提交。'
          : ctx.confirmClear
            ? '这会删除当前目标。暂停可以保留目标，清空后无法恢复。'
            : ctx.replacing
              ? '确认后替换当前目标并开始推进；原目标的预算不会沿用。'
              : creating
                ? '设置后开始推进当前会话。'
                : ctx.editing
                  ? '保存后保留当前预算。'
                  : ctx.goal?.status === 'active'
                    ? '暂停会保留目标和预算，不会清空会话内容。'
                    : '';
      ctx.note.hidden = !ctx.note.textContent;
      dialogs.elements.cancel.textContent = editing || ctx.confirmClear ? '取消' : '关闭';
      dialogs.elements.root.dataset.goalMode = ctx.confirmClear
        ? 'clear'
        : ctx.replacing
          ? 'replace'
          : editing
            ? 'edit'
            : 'view';
    }
    async function load(ctx) {
      if (!ctx.binding) {
        ctx.ready = true;
        paint(ctx);
        return;
      }
      ctx.loadError = ctx.operationError = false;
      try {
        const preview = await request('?' + new URLSearchParams(ctx.binding));
        if (!valid(ctx)) return;
        Object.assign(ctx, { preview, goal: preview.goal, ready: true });
        const intent = ctx.intent;
        ctx.intent = null;
        if (intent?.action === 'set') {
          ctx.input.value = intent.objective;
          ctx.replacing = Boolean(ctx.goal);
          ctx.editing = true;
          paint(ctx);
          if (!ctx.goal) {
            void act(ctx, 'set');
            return;
          }
        } else if (intent?.action === 'edit' && ctx.goal) {
          ctx.editing = true;
          ctx.input.value = ctx.goal.objective;
        } else if (intent?.action === 'clear' && ctx.goal) ctx.confirmClear = true;
        else if (intent && ['pause', 'resume'].includes(intent.action)) {
          if (ctx.goal) {
            paint(ctx);
            void act(ctx, intent.action);
            return;
          }
          ctx.fail('当前没有设置 Goal。');
        }
        paint(ctx);
      } catch (error) {
        if (valid(ctx)) {
          ctx.loadError = true;
          ctx.fail(error.message);
          paint(ctx);
        }
      }
    }
    async function poll(ctx, requestId) {
      while (valid(ctx)) {
        try {
          const { job } = await request('?' + new URLSearchParams({ requestId }));
          if (!valid(ctx)) return;
          if (job.status !== 'running') {
            ctx.busy = false;
            if (job.status === 'succeeded') {
              ctx.uncertain = ctx.operationError = false;
              jobs.delete(ctx.key);
              ctx.editing = ctx.replacing = ctx.confirmClear = false;
              ctx.goal = job.goal;
              ctx.message = job.message;
              ctx.fail('');
              ctx.ready = false;
              ctx.input.value = '';
              paint(ctx);
              void load(ctx);
              void Promise.resolve()
                .then(refresh)
                .catch(() => {});
            } else {
              ctx.operationError = true;
              ctx.uncertain = Boolean(job.uncertain);
              if (!ctx.uncertain) jobs.delete(ctx.key);
              ctx.fail(job.message);
            }
            paint(ctx);
            if (ctx.uncertain) void load(ctx);
            return;
          }
        } catch (error) {
          if (valid(ctx)) {
            ctx.busy = false;
            ctx.fail('操作结果尚未确认，请刷新核对 Goal。');
            ctx.uncertain = true;
            paint(ctx);
            void load(ctx);
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    async function act(ctx, action) {
      if (!valid(ctx) || !ctx.ready || ctx.busy || ctx.uncertain) return;
      if (action === 'clear' && !ctx.confirmClear) {
        ctx.confirmClear = true;
        paint(ctx);
        return;
      }
      if (action !== 'clear') ctx.confirmClear = false;
      if (action === 'edit' && !ctx.editing) {
        ctx.editing = true;
        ctx.input.value = ctx.goal.objective;
        ctx.message = '';
        ctx.fail('');
        paint(ctx);
        ctx.input.focus();
        return;
      }
      const objective = ctx.input.value.trim();
      if (['edit', 'set'].includes(action) && !objective) {
        ctx.fail('Goal 不能为空。');
        ctx.input.focus();
        return;
      }
      ctx.busy = true;
      ctx.action = action;
      ctx.fail('');
      ctx.message = '';
      paint(ctx);
      const requestId = createId();
      jobs.set(ctx.key, { requestId, action });
      const body = {
        ...ctx.binding,
        requestId,
        action,
        revision: ctx.preview.revision,
        processRuntimeId: ctx.preview.processRuntimeId,
        ...(['edit', 'set'].includes(action) ? { objective } : {}),
        ...(action === 'set' && ctx.goal ? { confirmReplace: true } : {}),
      };
      try {
        await request('', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        /* Recover only the receipt; never replay a mutation. */
      }
      await poll(ctx, requestId);
    }
    function open(goal, intent = null) {
      const ctx = {
        key: identity(),
        goal,
        binding: target(),
        ready: false,
        busy: false,
        editing: false,
        intent,
      };
      if (ctx.binding) ctx.binding = { ...ctx.binding, clientId: createId() };
      dialogs.open({
        title: 'Goal',
        actions: [
          { text: '修改', onClick: () => act(ctx, 'edit') },
          { text: '继续', onClick: () => act(ctx, 'resume') },
          { text: '暂停 Goal', onClick: () => act(ctx, 'pause') },
          { text: '清空 Goal', danger: true, onClick: () => act(ctx, 'clear') },
          { text: '启动 Goal', onClick: () => act(ctx, 'set') },
          {
            text: '保留目标',
            onClick: () => {
              ctx.confirmClear = false;
              paint(ctx);
            },
          },
          {
            text: '刷新核对',
            onClick: () => {
              const pending = jobs.get(ctx.key);
              if (pending) {
                ctx.busy = true;
                paint(ctx);
                void poll(ctx, pending.requestId);
              } else {
                ctx.ready = false;
                ctx.fail('');
                paint(ctx);
                void load(ctx);
              }
            },
          },
        ],
        build(body, { actions, fail }) {
          current = ctx;
          ctx.actions = actions;
          ctx.fail = fail;
          dialogs.elements.root.classList.add('goal-dialog');
          ctx.status = document.createElement('p');
          ctx.status.className = 'goal-dialog-status';
          ctx.status.setAttribute('role', 'status');
          ctx.text = document.createElement('div');
          ctx.text.className = 'chat-goal-detail';
          ctx.inputLabel = document.createElement('label');
          ctx.inputLabel.className = 'goal-dialog-label';
          ctx.inputLabel.htmlFor = 'goalObjective';
          ctx.input = document.createElement('textarea');
          ctx.input.id = 'goalObjective';
          ctx.input.className = 'chat-dialog-textarea';
          ctx.input.rows = 5;
          ctx.input.addEventListener('input', () => {
            if (!ctx.busy && !ctx.uncertain) ctx.fail('');
          });
          ctx.input.setAttribute('aria-label', 'Goal 目标');
          ctx.feedback = document.createElement('p');
          ctx.feedback.className = 'goal-dialog-feedback';
          ctx.feedback.setAttribute('role', 'status');
          ctx.note = document.createElement('p');
          ctx.note.className = 'goal-dialog-note';
          body.append(ctx.status, ctx.text, ctx.inputLabel, ctx.input, ctx.feedback, ctx.note);
          paint(ctx);
          const reposition = () => {
            if (!valid(ctx)) return;
            const viewport = window.visualViewport;
            const top =
              (viewport?.offsetTop || 0) +
              Math.max(
                12,
                ((viewport?.height || innerHeight) -
                  dialogs.elements.root.getBoundingClientRect().height) /
                  2,
              );
            dialogs.elements.root.style.setProperty('--goal-top', `${top}px`);
          };
          const resize = new ResizeObserver(reposition);
          resize.observe(dialogs.elements.root);
          window.visualViewport?.addEventListener('resize', reposition);
          const pending = jobs.get(ctx.key);
          if (pending) {
            ctx.busy = true;
            ctx.action = pending.action;
            paint(ctx);
            void poll(ctx, pending.requestId);
          } else void load(ctx);
          return () => {
            resize.disconnect();
            window.visualViewport?.removeEventListener('resize', reposition);
            dialogs.elements.root.style.removeProperty('--goal-top');
            if (current === ctx) current = null;
            dialogs.elements.root.classList.remove('goal-dialog');
            delete dialogs.elements.root.dataset.goalMode;
          };
        },
      });
    }
    return { open, update };
  }
  root.StudioGoalDialog = { create };
})(window);
