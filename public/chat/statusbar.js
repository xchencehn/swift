(function (root) {
  'use strict';
  const Model = root.StudioSessionStatusModel;
  function create({
    nodes,
    openPopover,
    closePopover,
    currentPopover,
    checkOperation,
    readAccount,
    latest,
    interrupt,
    moveDraft,
  }) {
    let state = null,
      opened = null,
      content = null,
      openedKind = '';
    let delayedStatus = '',
      delayedSince = 0,
      delayedTimer = 0,
      lastInput = null;
    const delayMs = 15000;
    const aria = (node, label, value) => {
      const name = value ? `${label}：${value}` : label;
      if (node.getAttribute('aria-label') !== name) node.setAttribute('aria-label', name);
    };
    const text = (node, value) => {
      if (node.textContent !== value) node.textContent = value;
    };
    const titles = {
      hint: '提示',
      details: '会话状态',
      execution: '会话状态',
      elapsed: '耗时',
      identity: '账号',
      quota: '用量',
      shortcuts: '快捷键',
      directory: '目录',
      context: '上下文',
    };
    const explanations = {
      Sending: '消息尚未收到投递回执。',
      Checking: '正在核对上次操作。',
      Interrupting: '正在中断当前轮次。',
      'Applying settings': '正在应用所选设置。',
      Unconfirmed: '结果尚未确认，请先核对，再决定是否重试。',
      Failed: '操作失败，草稿已保留。',
      Working: 'Codex 正在执行。',
      Worked: '上一轮已结束。',
      Identifying: '正在读取原生状态。',
      Offline: '连接已断开，草稿已保留。',
      'Awaiting input': '请回答当前原生问题。',
      'Native draft': '请先处理终端中的草稿。',
      'Compacting context': '正在压缩上下文。',
      Ready: '可以发送消息。',
      Error: '请查看终端中的错误详情。',
    };
    function close() {
      if (opened && currentPopover() === opened) closePopover();
      opened = content = null;
      openedKind = '';
    }
    function paintInterrupt(button) {
      button.disabled = state.interrupt?.disabled !== false;
      button.title = state.interrupt?.title || '中断当前轮次。';
      button.setAttribute('aria-busy', String(Boolean(state.interrupt?.busy)));
    }
    function statusOf(next) {
      const operation = next.operations?.find(
        (item) => item.inline !== false && ['uncertain', 'failed'].includes(item.phase),
      );
      if (operation) return operation.phase === 'uncertain' ? 'Unconfirmed' : 'Failed';
      const waiting = next.operations?.find(
        (item) => item.inline !== false && ['pending', 'checking'].includes(item.phase),
      );
      if (waiting)
        return waiting.phase === 'checking'
          ? 'Checking'
          : { delivery: 'Sending', interrupt: 'Interrupting', settings: 'Applying settings' }[
              waiting.kind
            ] || next.execution;
      return next.execution;
    }
    function detailRows(kind) {
      const view = state.view,
        elapsed =
          view.elapsedText ||
          (view.elapsedSeconds == null ? '—' : Model.formatDuration(view.elapsedSeconds));
      const account =
        state.account?.phase === 'reading'
          ? '正在读取…'
          : state.account?.phase === 'unconfirmed'
            ? '结果未确认'
            : state.account?.account || (state.account?.phase === 'idle' ? '尚未读取' : '暂不可用');
      const alias = view.metadata.find((item) => item.label === 'Native info')?.value || '—';
      if (kind === 'execution')
        return [
          { label: '会话状态', value: state.status },
          ...(['Ready', 'Worked', 'Working', '会话状态'].includes(state.status)
            ? []
            : [{ label: '说明', value: explanations[state.status] || '当前原生活动。' }]),
          ...(state.operations || [])
            .filter((item) => ['uncertain', 'failed'].includes(item.phase))
            .map((item) => ({ label: item.name, value: item.error || item.label })),
        ];
      if (kind === 'directory')
        return [{ label: '目录', value: state.cwd || view.directory || '—' }];
      if (kind === 'context') return [{ label: '上下文', value: view.context || '—' }];
      if (kind === 'elapsed')
        return [
          { label: '耗时', value: elapsed },
          ...(view.completedAt ? [{ label: '完成时间', value: view.completedAt }] : []),
        ];
      if (kind === 'identity') {
        const weekly = view.quotas.find((item) => item.label === 'weekly');
        return [
          { label: '别名', value: alias },
          { label: '账号', value: account },
          {
            label: '每周剩余额度',
            value: weekly?.remaining == null ? '暂不可用' : `${weekly.remaining}%`,
          },
        ];
      }
      if (kind === 'quota')
        return view.quotas.length
          ? view.quotas.flatMap((item) => [
              { label: item.label, value: item.value },
              ...(item.resetsAt
                ? [{ label: '重置时间', value: new Date(item.resetsAt * 1000).toLocaleString() }]
                : []),
            ])
          : [{ label: '用量', value: 'Codex 未提供用量。' }];
      const rows = [
        ...(state.connections || []),
        { label: 'Session', value: state.sessionName || '暂不可用' },
        { label: 'Status', value: state.status },
        { label: 'Account', value: account },
      ];
      if (view.completedAt) rows.push({ label: 'Completed at', value: view.completedAt });
      for (const [label, value] of [
        ['model', [state.model, state.effort].filter(Boolean).join(' ')],
        ['Context', view.context],
        ['Directory', state.cwd || view.directory],
      ])
        if (value) rows.push({ label, value });
      for (const quota of view.quotas)
        rows.push({
          label: quota.label,
          value:
            quota.value +
            (quota.resetsAt ? ` · resets ${new Date(quota.resetsAt * 1000).toLocaleString()}` : ''),
        });
      if (view.warnings > 0) rows.push({ label: 'Warnings', value: String(view.warnings) });
      if (view.background > 0)
        rows.push({ label: 'Background terminals', value: String(view.background) });
      for (const item of state.operations || [])
        if (item.kind !== 'delivery')
          rows.push({
            label: { interrupt: 'Interrupt', settings: 'Settings' }[item.kind] || 'Operation',
            value: [item.label, item.error].filter(Boolean).join('\n'),
          });
      if (view.stale) rows.push({ label: 'Source', value: '显示上次已知状态，正在等待更新。' });
      return rows;
    }
    function paintDetails() {
      if (!content || openedKind === 'shortcuts') return;
      if (openedKind === 'hint') {
        text(
          content,
          nodes.feedback && !nodes.feedback.hidden
            ? nodes.feedback.textContent
            : nodes.hint.textContent,
        );
        return;
      }
      const list = content.querySelector('dl'),
        rows = detailRows(openedKind);
      rows.forEach((row, index) => {
        let pair = list.children[index];
        if (!pair) {
          pair = document.createElement('div');
          pair.append(document.createElement('dt'), document.createElement('dd'));
          list.append(pair);
        }
        text(pair.firstChild, row.label);
        text(pair.lastChild, row.value);
      });
      while (list.children.length > rows.length) list.lastChild.remove();
      const actions = content.querySelector('[data-operation-checks]');
      if (actions) {
        const checks = (state.operations || []).filter((item) => item.canCheck);
        for (const old of [...actions.children])
          if (!checks.some((item) => item.kind === old.dataset.kind)) old.remove();
        for (const item of checks) {
          let button = actions.querySelector(`[data-kind="${item.kind}"]`);
          if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.dataset.kind = item.kind;
            button.id = item.kind === 'delivery' ? 'chatDeliveryCheck' : 'chatInterruptCheck';
            button.textContent = item.kind === 'delivery' ? '核对投递结果' : '核对中断结果';
            button.onclick = () => checkOperation(item.kind);
            actions.append(button);
          }
          button.disabled = Boolean(item.busy);
        }
        actions.hidden = !checks.length;
      }
      const stop = content.querySelector('#chatInterrupt');
      if (stop) paintInterrupt(stop);
      const refresh = content.querySelector('[data-refresh-account]');
      if (refresh) {
        const checking = state.account?.phase === 'unconfirmed';
        text(
          refresh,
          openedKind === 'details'
            ? '刷新'
            : checking
              ? '核对结果'
              : state.account?.account
                ? '刷新账号'
                : '读取账号',
        );
        refresh.disabled = checking
          ? Boolean(state.view.networkOffline)
          : !(state.canReadStatus ?? state.canOperate) || state.account?.phase === 'reading';
        refresh.setAttribute('aria-busy', String(state.account?.phase === 'reading'));
      }
    }
    function addAction(parent, label, run, id) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (id) button.id = id;
      button.onclick = run;
      parent.append(button);
      return button;
    }
    function show(kind, anchor) {
      if (!state || state.hidden) return;
      if (openedKind === kind && currentPopover() === opened) {
        close();
        return;
      }
      close();
      openedKind = kind;
      content = document.createElement('div');
      content.className = 'session-status-content';
      const list = document.createElement('dl');
      list.className = 'session-status-facts';
      if (kind === 'hint') content.classList.add('session-status-hint-content');
      else content.append(list);
      if (kind === 'details') {
        const actions = document.createElement('div');
        actions.className = 'session-native-buttons session-status-actions';
        content.append(actions);
        addAction(
          actions,
          'ESC',
          () => {
            if (state.interrupt?.disabled === false) void interrupt();
          },
          'chatInterrupt',
        );
        addAction(
          actions,
          '刷新',
          () => readAccount({ refresh: true }),
          'chatRefreshStatus',
        ).dataset.refreshAccount = '';
        addAction(
          actions,
          '回到底部',
          () => {
            close();
            latest();
          },
          'chatLatestAction',
        );
      }
      if (kind !== 'shortcuts') {
        if (kind === 'execution') {
          const checks = document.createElement('div');
          checks.className = 'session-native-buttons';
          checks.dataset.operationChecks = '';
          content.append(checks);
        }
        if (kind === 'identity') {
          const actions = document.createElement('div');
          actions.className = 'session-native-buttons';
          content.append(actions);
          addAction(actions, '刷新账号', () =>
            readAccount({ refresh: true }),
          ).dataset.refreshAccount = '';
        }
        paintDetails();
      } else {
        for (const [label, value] of [
          ['发送', 'Enter · Ctrl / Command + Enter'],
          ['换行', 'Shift + Enter · 触摸键盘 Enter'],
          ['中断', 'Esc'],
          ['模型', 'Shift + ← / →'],
          ['推理强度', 'Shift + ↑ / ↓'],
          ['输入历史', '输入框内 ↑ / ↓'],
          ['原生选项', '当前问题中按 1–9'],
        ]) {
          const row = document.createElement('div'),
            term = document.createElement('dt'),
            description = document.createElement('dd');
          term.textContent = label;
          description.textContent = value;
          row.append(term, description);
          list.append(row);
        }
      }
      anchor.setAttribute('aria-expanded', 'true');
      opened = openPopover(anchor, {
        content,
        className: `session-status-popover${kind === 'details' ? ' session-status-full' : ''}${kind !== 'details' && kind !== 'shortcuts' ? ' session-status-brief' : ''}`,
        label: titles[kind],
        onClose: () => {
          anchor.setAttribute('aria-expanded', 'false');
          opened = content = null;
          openedKind = '';
        },
      });
      if (['identity', 'details'].includes(kind) && state.canOperate && state.provider === 'codex')
        void readAccount();
    }
    function render(next) {
      if (state && (state.identity !== next.identity || next.hidden)) {
        close();
        delayedStatus = '';
        delayedSince = 0;
        clearTimeout(delayedTimer);
        delayedTimer = 0;
      }
      lastInput = next;
      const candidate = statusOf(next);
      let status = candidate;
      if (
        [
          'Offline',
          'Identifying',
          'Error',
          'Sending',
          'Checking',
          'Interrupting',
          'Applying settings',
        ].includes(candidate) &&
        !next.hidden
      ) {
        const waiting = next.operations?.find(
          (item) => item.inline !== false && ['pending', 'checking'].includes(item.phase),
        );
        const delayKey =
          candidate === 'Offline'
            ? 'network'
            : waiting
              ? `operation:${waiting.kind}:${waiting.requestId || ''}`
              : 'native';
        if (delayedStatus !== delayKey) {
          delayedStatus = delayKey;
          delayedSince = Date.now();
          clearTimeout(delayedTimer);
          delayedTimer = setTimeout(() => {
            delayedTimer = 0;
            if (lastInput) render(lastInput);
          }, delayMs);
        }
        if (Date.now() - delayedSince < delayMs)
          status =
            state?.identity === next.identity && state.status !== candidate
              ? state.status
              : '会话状态';
      } else {
        delayedStatus = '';
        delayedSince = 0;
        clearTimeout(delayedTimer);
        delayedTimer = 0;
      }
      const view =
        status !== candidate && state?.identity === next.identity ? state.view : next.view;
      state = { ...next, status, view };
      paintInterrupt(nodes.desktopInterrupt);
      nodes.details.disabled = Boolean(next.hidden);
      text(nodes.executionLabel, state.status);
      text(
        nodes.elapsed,
        [
          view.elapsedText ||
            (view.elapsedSeconds == null ? '—' : Model.formatDuration(view.elapsedSeconds)),
          view.completedAt,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      const alias = view.metadata.find((item) => item.label === 'Native info')?.value || '';
      nodes.elapsedAction.closest('[data-status-slot]').hidden = view.elapsedSeconds == null;
      nodes.identity.closest('[data-status-slot]').hidden = !alias;
      const brief = (node, value, missing, title) => {
        text(node, value || missing);
        node.dataset.empty = String(!value);
        node.title = title;
        aria(
          node,
          { identity: '账号', quota: '用量', directory: '目录', context: '上下文' }[
            Object.keys(nodes).find((key) => nodes[key] === node)
          ] || title,
          value || missing,
        );
      };
      brief(nodes.identity, alias, '—', '账号');
      const quota = view.quotas.find((item) => item.label === 'weekly') || view.quotas[0];
      const percent = quota?.remaining ?? quota?.value.match(/(\d+(?:\.\d+)?)%/)?.[1];
      nodes.quota.closest('[data-status-slot]').hidden = !quota;
      for (const kind of ['model', 'effort'])
        nodes.scroll.querySelector(`[data-status-slot="${kind}"]`).hidden =
          state.provider !== 'codex';
      brief(
        nodes.quota,
        quota ? `${quota.label} ${percent == null ? '—' : `${percent}%`}` : '',
        'weekly —',
        '用量',
      );
      nodes.quota.dataset.tone =
        quota?.remaining != null && quota.remaining <= 5
          ? 'error'
          : quota?.remaining != null && quota.remaining <= 20
            ? 'waiting'
            : '';
      nodes.execution.dataset.tone = view.networkOffline
        ? ''
        : ['Error', 'Failed'].includes(state.status)
          ? 'error'
          : [
                'Sending',
                'Checking',
                'Unconfirmed',
                'Identifying',
                'Interrupting',
                'Awaiting input',
                'Native draft',
                'Applying settings',
              ].includes(state.status)
            ? 'waiting'
            : state.status === 'Accepted'
              ? 'completed'
              : view.running
                ? 'running'
                : view.completed
                  ? 'completed'
                  : '';
      nodes.execution.title = state.status;
      aria(nodes.execution, '执行状态', state.status);
      aria(nodes.elapsedAction, '耗时', nodes.elapsed.textContent);
      for (const [kind, value] of [
        ['directory', view.directory || state.cwd],
        ['context', view.context ? `Context ${view.context}` : ''],
      ]) {
        nodes[kind].closest('[data-status-slot]').hidden = !value;
        brief(nodes[kind], value, '', kind === 'directory' ? state.cwd || value : value);
      }
      const operation =
        status === candidate
          ? next.operations?.find(
              (item) => item.inline !== false && ['uncertain', 'failed'].includes(item.phase),
            )
          : null;
      const hint = next.hidden
        ? ''
        : operation?.error ||
          operation?.label ||
          (status === candidate ? view.notice : '') ||
          view.notes.join(' ');
      text(nodes.hint, hint);
      nodes.hint.title = hint;
      aria(nodes.hint, '活动详情', hint);
      if (nodes.moveDraft) {
        nodes.moveDraft.hidden = next.hidden || !view.nativeDraft;
        nodes.moveDraft.disabled = Boolean(next.draftMoving || view.stale || view.networkOffline);
        text(nodes.moveDraft, next.draftMoving ? '正在移动…' : '移动到swift');
      }
      nodes.hint.parentElement.dataset.empty = String(!hint);
      nodes.hint.tabIndex = hint ? 0 : -1;
      const fields = [...nodes.scroll.querySelectorAll('.chat-status-field')].filter(
        (field) => !field.hidden,
      );
      fields.forEach((field, index) => {
        field.querySelector('.chat-status-separator').hidden = index === fields.length - 1;
      });
      const notice = status === candidate && !next.hidden ? view.notice : '';
      nodes.notice.hidden = !notice;
      text(nodes.notice, notice);
      if (view.diagnosticId) nodes.notice.dataset.diagnosticId = view.diagnosticId;
      else delete nodes.notice.dataset.diagnosticId;
      if (opened && currentPopover() === opened) paintDetails();
    }
    if (nodes.moveDraft) nodes.moveDraft.onclick = () => moveDraft?.();
    if (nodes.feedback) {
      nodes.feedback.onclick = () => show('hint', nodes.feedback);
    }
    nodes.hint.onclick = () => {
      if (nodes.hint.textContent) show('hint', nodes.hint);
    };
    nodes.details.onclick = () => show('details', nodes.details);
    nodes.desktopInterrupt.onclick = () => {
      if (state?.interrupt?.disabled === false) void interrupt();
    };
    for (const kind of ['execution', 'elapsed', 'identity', 'quota', 'directory', 'context']) {
      const node = kind === 'elapsed' ? nodes.elapsedAction : nodes[kind];
      node.onclick = () => show(kind, node);
    }
    for (const scroll of [nodes.scroll, nodes.execution.closest('.chat-status-activity')])
      scroll.addEventListener(
        'scroll',
        () => {
          const layer = currentPopover();
          if (layer && scroll.contains(layer._anchor)) closePopover();
        },
        { passive: true },
      );
    return { render, close, showDetails: (anchor) => show('details', anchor) };
  }
  root.StudioSessionStatusBar = { create };
})(window);
