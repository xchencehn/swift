(function (root) {
  'use strict';
  function create({
    box,
    summary,
    input,
    request,
    refresh,
    checkReceipt,
    enabled = () => true,
    draftScope = () => '',
    ownerOf = () => '',
  }) {
    const drafts = new Map();
    let prompt = null,
      state,
      panel,
      textInput,
      status,
      heading,
      buttons = [],
      pending = null,
      structure = '';
    let observed = null,
      opened = false,
      items = [],
      owner = '';
    const element = (tag, cls, text) => {
      const node = document.createElement(tag);
      node.className = cls;
      if (text) node.textContent = text;
      return node;
    };
    const key = (q) => q?.draftKey || q?.challenge;
    let storageKey = '';
    const persist = () => {
      if (storageKey)
        try {
          localStorage.setItem(storageKey, JSON.stringify([...drafts]));
        } catch {}
    };
    const save = () => {
      if (prompt && state && !prompt.isSecret) drafts.set(key(prompt), state);
      while (drafts.size > 64) {
        const settled = [...drafts].find(([, value]) => !value.pending && !value.uncertain);
        if (!settled) break;
        drafts.delete(settled[0]);
      }
      persist();
    };
    const signature = () =>
      JSON.stringify([key(prompt), opened, prompt.question, prompt.options, prompt.allowText]);
    function paint() {
      if (!prompt || !panel) return;
      const rateLimit = prompt.nativeModal?.kind === 'rate-limit';
      const quotaSwitch = rateLimit && prompt.question.startsWith('Approaching rate limits');
      heading.textContent = rateLimit
        ? 'Codex 额度提醒'
        : prompt.nativeModal
          ? 'Codex 原生选项'
          : `Codex 的问题 ${items.findIndex((item) => key(item) === key(prompt)) + 1}/${items.length}`;
      const locked = Boolean(
        state.done ||
        (prompt.delivery && ['sent', 'skipped', 'uncertain'].includes(prompt.delivery)),
      );
      buttons.forEach((button, index) => {
        button.setAttribute('aria-pressed', String(index === state.selected));
        button.disabled = Boolean(
          pending?.challenge === prompt.challenge || state.uncertain || locked,
        );
      });
      if (textInput) {
        textInput.hidden = prompt.options.length > 0 && state.selected !== prompt.options.length;
        textInput.disabled = Boolean(
          pending?.challenge === prompt.challenge || state.uncertain || locked,
        );
      }
      status.textContent =
        state.error ||
        (prompt.canWrite === false
          ? '无法确认原生运行实例，暂不可操作。'
          : prompt.observation === 'stale'
            ? '暂时无法读取原生问题，已保留草稿。'
            : state.status || '');
      status.className = state.error ? 'chat-inline-question-error' : '';
      panel.setAttribute('aria-busy', String(Boolean(pending?.challenge === prompt.challenge)));
      const currentIndex = items.findIndex((item) => key(item) === key(prompt));
      const previous = panel.querySelector('[data-action="previous"]'),
        next = panel.querySelector('[data-action="next"]');
      if (previous)
        previous.firstChild.textContent =
          currentIndex > 0 ? '上一题' : prompt.nativeModal ? '收起选项' : '返回输入框';
      if (next) next.hidden = currentIndex >= items.length - 1;
      const receipt = panel.querySelector('.chat-question-receipt');
      if (receipt)
        receipt.hidden =
          !(state.requestId || prompt.receiptRequestId) ||
          !(state.uncertain || prompt.delivery === 'uncertain');
      panel.querySelectorAll('[data-action]').forEach((button) => {
        button.disabled =
          ['answer', 'skip', 'native-up', 'native-down', 'native-toggle'].includes(
            button.dataset.action,
          ) &&
          Boolean(
            pending ||
            prompt.observation === 'stale' ||
            prompt.canWrite === false ||
            !enabled() ||
            locked ||
            state.uncertain,
          );
      });
      const summaryButton = summary.querySelector('.chat-question-open');
      if (summaryButton) {
        summaryButton.setAttribute('aria-expanded', String(opened));
        summaryButton.querySelector('.chat-question-preview').textContent = quotaSwitch
          ? '接近额度限制，是否切换模型？'
          : prompt.question;
        summaryButton.querySelector('.chat-question-preview').title = prompt.question;
        summaryButton.querySelector('.chat-question-prefix').textContent = rateLimit
          ? '额度提醒：'
          : prompt.nativeModal
            ? '原生选项：'
            : '问题：';
        summaryButton.querySelector('.chat-question-count').textContent = prompt.nativeModal
          ? opened
            ? '收起'
            : rateLimit
              ? '处理'
              : '选择'
          : `${observed?.remaining || items.length || 1} 个问题 · ${opened ? '收起' : '回答'}`;
      }
    }
    function select(index, focusText = false) {
      if (pending?.challenge === prompt?.challenge || state.uncertain || state.done) return;
      state.selected = index;
      state.error = '';
      paint();
      save();
      if (focusText && index === prompt.options.length && textInput)
        textInput.focus({ preventScroll: true });
    }
    function draw() {
      structure = signature();
      panel = element('div', 'codex-question-interaction');
      panel.tabIndex = -1;
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', 'Codex 提问');
      heading = element('div', 'chat-inline-question-head');
      panel.append(heading);
      buttons = [];
      textInput = null;
      const action = (label, value, keys) => {
        const button = element('button', 'chat-question-action', label);
        button.type = 'button';
        button.dataset.action = value;
        if (keys) {
          button.append(element('span', 'chat-question-key', ` · ${keys}`));
          button.title = `${label} · ${keys}`;
        }
        button.onclick = () => act(value);
        return button;
      };
      if (opened) {
        panel.append(element('div', 'chat-inline-question-title', prompt.question));
        if (prompt.nativeModal)
          for (const url of new Set(prompt.question.match(/https:\/\/[^\s<>"]+/g) || [])) {
            const link = element('a', 'chat-question-action', '在浏览器打开链接');
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = url;
            panel.append(link);
          }
        const options = prompt.options || [];
        for (const [index, option] of [
          ...options,
          ...(options.length && prompt.allowText !== false ? [{ label: 'Other · 自己填写' }] : []),
        ].entries()) {
          const button = element('button', 'chat-inline-option');
          button.type = 'button';
          button.append(
            element('span', 'chat-inline-option-label', `${index + 1}. ${option.label}`),
          );
          if (option.description)
            button.append(element('span', 'chat-inline-option-hint', option.description));
          button.onclick = () => select(index, true);
          buttons.push(button);
          panel.append(button);
          button.onfocus = () => select(index);
        }
        if (prompt.allowText !== false) {
          textInput = element('textarea', 'chat-inline-question-text');
          textInput.rows = 2;
          textInput.setAttribute('aria-label', '自己写一个答案');
          textInput.placeholder = '写下你的回答';
          textInput.value = state.text;
          textInput.oninput = () => {
            state.text = textInput.value;
            state.selected = options.length;
            save();
          };
          panel.append(textInput);
        }
        const actions = element('div', 'chat-inline-question-actions');
        if (prompt.nativeModal?.scrollable)
          actions.append(
            action('向上查看选项', 'native-up'),
            action('向下查看选项', 'native-down'),
          );
        if (prompt.nativeModal?.toggle) actions.append(action('切换当前勾选', 'native-toggle'));
        actions.append(action('提交', 'answer', 'Ctrl+Enter'));
        if (prompt.queued) actions.append(action('跳过', 'skip', 'Ctrl+]'));
        const index = items.findIndex((q) => key(q) === key(prompt));
        actions.append(action(index > 0 ? '上一题' : '返回输入框', 'previous', 'Alt+↓'));
        actions.append(action('下一题', 'next', 'Alt+↑'));
        panel.append(actions);
      }
      status = element('span', '');
      status.setAttribute('role', 'status');
      panel.append(status);
      if (checkReceipt) {
        const check = element(
          'button',
          'chat-question-action chat-question-receipt',
          '核对操作结果',
        );
        check.type = 'button';
        check.onclick = async () => {
          check.disabled = true;
          const target = prompt,
            local = state;
          local.error = '';
          local.status = '正在核对操作结果…';
          paint();
          try {
            const result = await checkReceipt(
              target.paneId,
              local.requestId || target.receiptRequestId,
            );
            local.uncertain = result.delivery === 'uncertain';
            local.done = ['sent', 'skipped'].includes(result.delivery);
            local.status = local.uncertain
              ? '操作结果仍待确认，不会重复发送。'
              : local.done
                ? '已确认提交'
                : '已核对操作结果';
            if (prompt?.challenge === target.challenge) {
              save();
              update(observed);
            }
            void Promise.resolve()
              .then(refresh)
              .catch(() => {});
          } catch (error) {
            local.error = error.message;
          } finally {
            check.disabled = false;
            if (prompt?.challenge === target.challenge) {
              save();
              paint();
            }
          }
        };
        panel.append(check);
      }
      summary.hidden = false;
      box.hidden = !opened;
      if (!summary.firstChild) {
        const button = element('button', 'chat-question-open');
        button.type = 'button';
        button.setAttribute('aria-controls', box.id);
        button.append(
          element('span', 'chat-question-prefix', '问题：'),
          element('span', 'chat-question-preview'),
          element('span', 'chat-question-count'),
        );
        button.onclick = () => act(opened ? 'main' : 'open');
        summary.append(button);
      }
      box.replaceChildren(panel);
      paint();
    }
    function update(next) {
      const nextStorage = 'studioQuestionDraft:' + draftScope();
      if (storageKey !== nextStorage) {
        save();
        storageKey = nextStorage;
        drafts.clear();
        try {
          for (const [id, value] of JSON.parse(localStorage.getItem(storageKey) || '[]')) {
            if (value.pending) {
              value.pending = false;
              value.uncertain = true;
              value.status = '操作结果待确认，请核对后继续。';
            }
            drafts.set(id, value);
          }
        } catch {}
        prompt = null;
      }
      const pendingOwner = ownerOf();
      if (!next && pendingOwner) {
        const unsettled = [...drafts.values()].filter(
          (value) =>
            value.owner === pendingOwner &&
            !value.done &&
            (value.pending || value.uncertain) &&
            value.question,
        );
        if (unsettled.length)
          next = {
            ...unsettled[0].question,
            items: unsettled.map((value) => value.question),
            remaining: unsettled.length,
            observation: 'stale',
            canWrite: false,
          };
      }
      if (!next) {
        if (prompt) {
          save();
          prompt = null;
          pending = null;
          structure = '';
          box.replaceChildren();
          box.hidden = true;
        }
        summary.replaceChildren();
        summary.hidden = true;
        opened = false;
        observed = null;
        items = [];
        owner = '';
        return;
      }
      const nextOwner = JSON.stringify([
        next.paneId,
        next.terminalId,
        next.runtimeId,
        next.sessionId,
      ]);
      if (nextOwner !== owner) {
        opened = false;
        prompt = null;
        owner = nextOwner;
      }
      observed = next;
      items = (next.items?.length ? next.items : [next]).map((item) => ({
        ...next,
        ...item,
        options: item.options || [],
      }));
      for (const value of drafts.values())
        if (
          value.owner === nextOwner &&
          !value.done &&
          (value.pending || value.uncertain) &&
          value.question &&
          !items.some((item) => key(item) === key(value.question))
        )
          items.push({ ...next, ...value.question });
      const available = items.filter((item) => !drafts.get(key(item))?.done);
      if (available.length) items = available;
      next = items.find((item) => key(item) === key(prompt)) || items[0];
      const previous = prompt,
        changed = !previous || key(previous) !== key(next);
      if (changed) {
        save();
        state = {
          selected: next.selected >= 0 ? next.selected : 0,
          text: '',
          status: '',
          error: '',
          ...drafts.get(key(next)),
        };
      }
      prompt = { ...next };
      if (
        !Number.isInteger(state.selected) ||
        state.selected < 0 ||
        state.selected > prompt.options.length
      )
        state.selected = 0;
      if (typeof state.text !== 'string') state.text = '';
      if (next.delivery && ['sent', 'uncertain', 'skipped'].includes(next.delivery))
        state.status =
          next.delivery === 'uncertain'
            ? '操作结果待确认'
            : next.delivery === 'skipped'
              ? '已跳过'
              : '已提交';
      const nextStructure = signature();
      if (nextStructure !== structure) {
        const focused = panel?.contains(document.activeElement);
        const selection =
          textInput && document.activeElement === textInput
            ? [textInput.selectionStart, textInput.selectionEnd]
            : null;
        draw();
        if (selection && textInput && !textInput.hidden) {
          textInput.focus({ preventScroll: true });
          textInput.setSelectionRange(...selection);
        } else if (focused && opened) panel.focus({ preventScroll: true });
      } else paint();
    }
    async function act(action) {
      if (!prompt) return;
      if (['open', 'main', 'previous', 'next'].includes(action)) {
        save();
        const index = items.findIndex((item) => key(item) === key(prompt));
        if (action === 'main' || (action === 'previous' && index <= 0)) {
          opened = false;
        } else {
          opened = true;
          if (action === 'previous' || action === 'next') {
            const next = items[index + (action === 'next' ? 1 : -1)];
            if (next) {
              prompt = { ...next };
              state = { selected: 0, text: '', status: '', error: '', ...drafts.get(key(next)) };
            }
          }
        }
        structure = '';
        draw();
        if (!opened) input.focus({ preventScroll: true });
        else if (!prompt.options.length) textInput?.focus({ preventScroll: true });
        else panel?.focus({ preventScroll: true });
        return;
      }
      if (
        !enabled() ||
        pending ||
        prompt.canWrite === false ||
        state.done ||
        state.uncertain ||
        state.pending
      )
        return;
      const target = prompt,
        local = state;
      const custom = !target.options.length || state.selected === target.options.length;
      if (action === 'answer' && custom && !state.text.trim()) {
        state.error = '请填写回答。';
        paint();
        textInput?.focus({ preventScroll: true });
        return;
      }
      const body = {
        paneId: target.paneId,
        sessionId: target.sessionId,
        challenge: target.challenge,
        requestId:
          root.crypto?.randomUUID?.() ||
          'question-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
        action,
        choices: action === 'answer' && !custom ? [state.selected] : [],
        text: action === 'answer' && custom ? state.text.trim() : '',
      };
      pending = body;
      local.error = '';
      local.status = '正在操作…';
      paint();
      const { items: ignoredItems, ...savedQuestion } = target;
      local.requestId = body.requestId;
      local.pending = true;
      local.owner = owner;
      local.question = savedQuestion;
      save();
      const requestStorage = storageKey;
      const persistResult = () => {
        if (requestStorage === storageKey) {
          drafts.set(key(target), local);
          persist();
        } else
          try {
            const saved = new Map(JSON.parse(localStorage.getItem(requestStorage) || '[]'));
            saved.set(key(target), local);
            localStorage.setItem(requestStorage, JSON.stringify([...saved]));
          } catch {}
      };
      try {
        const result = await request(body);
        local.status =
          result.delivery === 'uncertain'
            ? '操作结果待确认，请核对后继续。'
            : action === 'answer'
              ? '已提交'
              : action === 'skip'
                ? '已跳过'
                : '';
        local.uncertain = result.delivery === 'uncertain';
        if (['sent', 'skipped'].includes(result.delivery)) local.done = true;
        persistResult();
        if (prompt?.challenge !== target.challenge) return;
        void Promise.resolve()
          .then(refresh)
          .catch(() => {});
        if (action === 'answer' && panel?.contains(document.activeElement))
          input.focus({ preventScroll: true });
      } catch (error) {
        local.status = '';
        local.error = error.message || '操作结果待确认。';
        local.uncertain = error.deliveryUncertain !== false;
        persistResult();
        if (prompt?.challenge !== target.challenge) return;
      } finally {
        local.pending = false;
        persistResult();
        if (pending === body) pending = null;
        if (prompt?.challenge === target.challenge) paint();
      }
    }
    document.addEventListener(
      'keydown',
      (event) => {
        if (
          !prompt ||
          !enabled() ||
          event.isComposing ||
          event.keyCode === 229 ||
          document.hidden ||
          document.querySelector('dialog[open], .popover') ||
          summary.hidden
        )
          return;
        const inPanel = panel?.contains(event.target),
          inInput = event.target === input;
        if (!inPanel && !inInput) return;
        let action;
        if (event.altKey && event.key === 'ArrowUp') action = !opened || inInput ? 'open' : 'next';
        if (event.altKey && event.key === 'ArrowDown' && inPanel && opened) action = 'previous';
        if (event.ctrlKey && event.key === ']' && inPanel && opened && prompt.queued)
          action = 'skip';
        if (action) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void act(action);
          return;
        }
        if (!inPanel || !opened || pending) return;
        if (
          event.target === textInput &&
          !(event.key === 'Enter' && (event.ctrlKey || event.metaKey))
        )
          return;
        if (!event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && buttons.length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          select(
            (state.selected + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
              buttons.length,
          );
          panel.focus({ preventScroll: true });
        } else if (
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.target.closest?.('button.chat-question-action')
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void act('answer');
        } else if (
          /^[1-9]$/.test(event.key) &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.target !== textInput
        ) {
          const index = Number(event.key) - 1;
          if (index < buttons.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            select(index, true);
            if (index < prompt.options.length) void act('answer');
          }
        }
      },
      true,
    );
    root.addEventListener('pagehide', save);
    return {
      update,
      flush: save,
      hasDraft: () =>
        Boolean(pending || (state && prompt && !state.done && (state.text || state.selected))),
      active: () => Boolean(prompt),
    };
  }
  root.StudioQuestionInteraction = { create };
})(window);
