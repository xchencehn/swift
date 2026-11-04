(function (root) {
  'use strict';
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  function create({
    state,
    request,
    switchToPane,
    refresh,
    renderSidebar,
    dialogs,
    popovers,
    reportError,
    copyText,
    closeNavigation,
    closeFiles,
    openSettings,
    closeSettings,
    toggleNavigation,
    interrupt,
    showSessionStatus,
  }) {
    const spaceAction = root.StudioSpaceActions.create({ request, dialogs, refresh });
    const conversation = document.querySelector('.chat-conversation');
    const main = document.querySelector('.chat-main');
    const stage = make('section', 'herdr-pane-stage');
    stage.setAttribute('aria-label', 'Tab 会话');
    function createNotice(className, closeLabel) {
      const element = make('p', className),
        message = make('span', 'herdr-notice-message');
      element.setAttribute('role', 'status');
      element.hidden = true;
      const dismiss = make('button', 'herdr-notice-close');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', closeLabel);
      dismiss.title = closeLabel;
      dismiss.innerHTML =
        '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      element.append(message, dismiss);
      let currentKey = null,
        dismissedKey = null;
      dismiss.addEventListener('click', (event) => {
        // Dismiss only this presentation. The native operation, lock and
        // recovery tracker continue independently of the visible message.
        const restoreFocus = event.detail === 0 && document.activeElement === dismiss;
        dismissedKey = currentKey;
        element.hidden = true;
        if (restoreFocus) {
          const next = [
            document.querySelector('#commandInput'),
            document.querySelector('.herdr-tab [aria-selected="true"]'),
            document.querySelector('#chatDrawerToggle'),
            document.querySelector('#chatSidebarCollapse'),
          ].find((node) => node && !node.disabled && node.getClientRects().length);
          next?.focus({ preventScroll: true });
        }
      });
      return {
        element,
        update(text, key = text) {
          const value = String(text || ''),
            nextKey = value ? key : null;
          if (currentKey !== nextKey) {
            currentKey = nextKey;
            dismissedKey = null;
          }
          if (message.textContent !== value) message.textContent = value;
          element.hidden = !value || dismissedKey === currentKey;
        },
      };
    }
    const operationNotice = createNotice('herdr-operation-notice', '关闭操作提示');
    const restoreFeedback = createNotice(
      'herdr-operation-notice herdr-restore-notice',
      '关闭恢复提示',
    );
    const notice = operationNotice.element,
      restoreNotice = restoreFeedback.element;
    conversation.querySelector('.chat-head').after(restoreNotice);
    const desktopMedia = root.matchMedia(
      '(min-width: 761px) and (hover: hover) and (pointer: fine)',
    );
    let pendingSelection = null;
    const tabNavigation = () =>
      root.innerWidth > 760 &&
      !(
        root.matchMedia('(pointer: coarse)').matches &&
        Math.min(root.innerWidth, root.innerHeight) < 600
      );
    const desktop = () => desktopMedia.matches;
    const bindingFor = (pane) => ({
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      sessionId: pane.agent?.session?.value || '',
    });
    const selectedById = (id) =>
      (state.allPanes || state.chatAgents || []).find((p) => p.paneId === id);
    const head = conversation.querySelector('.chat-head');
    conversation.before(notice, stage);
    stage.append(conversation);
    let operationRuntimeId;
    let busy = false,
      lastSelected = '',
      lastPaneLocation = '',
      creationFailure = null;
    const pendingForks = new Set();
    const tabbar = make('nav', 'herdr-tabs');
    tabbar.setAttribute('aria-label', 'Herdr 标签页');
    tabbar.hidden = true;
    const tablist = make('div', 'herdr-tab-list');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', '当前工作区标签页');
    const addTab = make('button', 'herdr-tab-add', '+');
    addTab.type = 'button';
    addTab.setAttribute('aria-label', '新建 Tab');
    addTab.title = '新建 Tab';
    tabbar.append(tablist, addTab);
    head.insertBefore(tabbar, document.querySelector('#chatCurrentDot'));
    const tabNodes = new Map();
    let visibleTabs = [],
      tabRuntimeId = '',
      revealSignature = '';
    const tabDrag = root.StudioNativeTabDrag.create({
      list: tablist,
      read: () => ({
        ids: visibleTabs.map((tab) => tab.tab_id),
        runtimeId: state.herdrRuntimeId,
        workspaceId: state.selectedWorkspaceId,
        visible: !tabbar.hidden,
        connected: state.connected,
        busy,
      }),
      commit: (id, index, runtimeId) =>
        act('tab.move', { tab_id: id, insert_index: index }, undefined, { runtimeId }),
      render: () => renderTabs(false),
    });
    tablist.addEventListener(
      'wheel',
      (event) => {
        if (
          event.defaultPrevented ||
          event.ctrlKey ||
          event.metaKey ||
          tabbar.hidden ||
          tablist.scrollWidth <= tablist.clientWidth + 1
        )
          return;
        // Browse overflow without selecting a tab or changing native Pane focus.
        const mode = event.deltaMode;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (!Number.isFinite(delta) || delta === 0) return;
        let unit = 1;
        if (mode === 1) {
          const style = root.getComputedStyle(tablist);
          unit = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
        } else if (mode === 2) unit = tablist.clientWidth;
        event.preventDefault();
        event.stopPropagation();
        tablist.scrollLeft += delta * unit;
      },
      { passive: false },
    );
    addTab.onclick = () => {
      const workspace = (state.chatWorkspaces || []).find(
        (w) => w.workspaceId === state.selectedWorkspaceId,
      );
      if (workspace) void createTab(workspace);
    };
    addTab.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const workspace = (state.chatWorkspaces || []).find(
        (w) => w.workspaceId === state.selectedWorkspaceId,
      );
      if (workspace)
        menu(contextAnchor(event), workspace.label, [['新建 Tab', () => createTab(workspace)]]);
    };
    function renderTabs(reveal = true) {
      const wide = tabNavigation();
      document.body.classList.toggle('herdr-tab-navigation', wide);
      if (wide && head.parentNode !== main) main.insertBefore(head, notice);
      else if (!wide && head.parentNode !== conversation) conversation.prepend(head);
      tabbar.hidden = !wide || Boolean(state.archived);
      head.classList.toggle('has-native-tabs', !tabbar.hidden);
      visibleTabs = allTabs().filter((t) => t.workspace_id === state.selectedWorkspaceId);
      head.classList.toggle(
        'no-active-tab',
        !state.archived && !visibleTabs.some((t) => t.tab_id === selected()?.tabId),
      );
      tabRuntimeId = state.herdrRuntimeId;
      const disabled = busy || !state.connected;
      addTab.disabled = disabled || !state.selectedWorkspaceId;
      const preserveOrder = tabDrag.sync();
      const ids = new Set(visibleTabs.map((t) => t.tab_id));
      for (const [id, node] of tabNodes)
        if (!ids.has(id)) {
          node.remove();
          tabNodes.delete(id);
        }
      for (const tab of visibleTabs) {
        let node = tabNodes.get(tab.tab_id);
        if (!node) {
          node = make('div', 'herdr-tab');
          node.dataset.tabId = tab.tab_id;
          const button = make('button', 'herdr-tab-select');
          button.type = 'button';
          button.setAttribute('role', 'tab');
          button.append(make('span', 'herdr-tab-label'));
          const remove = make('button', 'herdr-tab-close', '×');
          remove.type = 'button';
          node.append(button, remove);
          tabNodes.set(tab.tab_id, node);
          const current = () =>
            allTabs().find(
              (t) =>
                t.tab_id === node.dataset.tabId && t.workspace_id === state.selectedWorkspaceId,
            );
          const valid = () =>
            current() && tabRuntimeId === state.herdrRuntimeId && state.connected && !busy;
          button.onclick = () => {
            const tab = current();
            if (!tab) return;
            if (selected()?.tabId === tab.tab_id && selected()?.agent && !state.archived)
              showSessionStatus?.(button);
            else selectTab(tab);
          };
          button.ondblclick = () => {
            const t = current();
            if (valid()) void rename('tab.rename', { tab_id: t.tab_id }, t.label, tabPane(t));
          };
          node.oncontextmenu = (event) => {
            if (tabbar.hidden || !current()) return;
            event.preventDefault();
            event.stopPropagation();
            tabMenu(contextAnchor(event), current());
          };
          remove.onclick = () => {
            const t = current();
            if (valid())
              void close('tab.close', { tab_id: t.tab_id }, `Tab ${t.label}`, tabPane(t));
          };
          button.onkeydown = (event) => {
            if (
              event.isComposing ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              !current() ||
              tabRuntimeId !== state.herdrRuntimeId
            )
              return;
            const index = visibleTabs.findIndex((t) => t.tab_id === node.dataset.tabId);
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % visibleTabs.length;
            if (event.key === 'ArrowLeft')
              next = (index + visibleTabs.length - 1) % visibleTabs.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = visibleTabs.length - 1;
            if (next !== undefined) {
              event.preventDefault();
              const target = visibleTabs[next];
              selectTab(target);
              tabNodes.get(target.tab_id)?.firstChild.focus({ preventScroll: true });
            } else if (event.key === 'Delete' && valid()) {
              event.preventDefault();
              remove.click();
            } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
              event.preventDefault();
              tabMenu(contextAnchor(event), current());
            }
          };
        }
        const active = tab.tab_id === state.selectedTabId,
          button = node.firstChild,
          remove = node.lastChild;
        const status = ['working', 'blocked', 'done', 'idle', 'unknown'].includes(tab.agent_status)
          ? tab.agent_status
          : 'shell';
        node.classList.toggle('selected', active);
        node.draggable = false;
        // Selecting cached content is local; connectivity only gates native mutations.
        button.disabled = false;
        remove.disabled = disabled;
        button.tabIndex = active ? 0 : -1;
        button.setAttribute('aria-selected', String(active));
        button.id = 'herdr-tab-' + tab.tab_id;
        button.setAttribute('aria-controls', 'herdrTabPanel');
        button.setAttribute('aria-description', status);
        button.title = `${tab.label || tab.tab_id} · ${tab.tab_id}`;
        button.setAttribute('aria-label', tab.label || tab.tab_id);
        if (button.lastChild.textContent !== (tab.label || tab.tab_id))
          button.lastChild.textContent = tab.label || tab.tab_id;
        remove.setAttribute('aria-label', `关闭 Tab ${tab.label || tab.tab_id}`);
        remove.title = '关闭 Tab';
        remove.tabIndex = active ? 0 : -1;
        const position = visibleTabs.indexOf(tab);
        if (!preserveOrder && tablist.children[position] !== node)
          tablist.insertBefore(node, tablist.children[position] || null);
      }
      stage.id = 'herdrTabPanel';
      const active = tabNodes.get(state.selectedTabId);
      if (active && !tabbar.hidden) {
        stage.setAttribute('role', 'tabpanel');
        stage.setAttribute('aria-labelledby', active.firstChild.id);
      } else {
        stage.removeAttribute('role');
        stage.removeAttribute('aria-labelledby');
      }
      if (active && !tabbar.hidden) {
        if (!tabDrag.active()) {
          const key = [
            state.selectedTabId,
            tablist.clientWidth,
            active.offsetLeft,
            active.offsetWidth,
          ].join(':');
          if (key !== revealSignature) {
            revealSignature = key;
            if (reveal) {
              const box = active.getBoundingClientRect(),
                area = tablist.getBoundingClientRect();
              if (box.left < area.left) tablist.scrollLeft -= area.left - box.left;
              else if (box.right > area.right) tablist.scrollLeft += box.right - area.right;
            }
          }
        }
      } else revealSignature = '';
    }
    const selected = () =>
      (state.allPanes || state.chatAgents || []).find((p) => p.paneId === state.chatPaneId);
    const tabPane = (tab) => (state.allPanes || []).find((p) => p.tabId === tab.tab_id);
    const allTabs = () =>
      state.chatTabs?.length
        ? state.chatTabs
        : [
            ...new Map(
              (state.allPanes || []).map((p) => [
                p.tabId,
                {
                  tab_id: p.tabId,
                  workspace_id: p.workspaceId,
                  label: p.tab || p.tabTitle,
                  number: p.tabNumber,
                },
              ]),
            ).values(),
          ];
    const expected = (pane) =>
      pane
        ? {
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            sessionId: pane.agent?.session?.value || '',
          }
        : undefined;
    const read = (method, params = {}) =>
      request('/api/herdr/read?' + new URLSearchParams({ method, params: JSON.stringify(params) }));
    let feedbackGeneration = 0;
    const feedback = (message, { newOperation = false } = {}) => {
      if (newOperation) feedbackGeneration += 1;
      creationFailure = null;
      operationNotice.update(message, JSON.stringify([feedbackGeneration, message || '']));
    };
    async function forkSession(target) {
      const key = JSON.stringify([
        state.herdrRuntimeId,
        target.paneId,
        target.terminalId,
        target.sessionId,
      ]);
      if (!state.connected || pendingForks.has(key)) return;
      pendingForks.add(key);
      feedback('正在 Fork 会话…', { newOperation: true });
      closeNavigation?.();
      try {
        await root.StudioSessionFork.run({
          target: { ...target, runtimeId: operationRuntimeId ?? state.herdrRuntimeId },
          request: ({ action, ...body }) =>
            action === 'start'
              ? request('/api/agents/fork', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(body),
                })
              : request('/api/agents/fork?' + new URLSearchParams({ requestId: body.requestId })),
        });
        feedback('');
      } catch (error) {
        feedback(`${error.message} 请先核对 Tab 状态后再操作。`);
      } finally {
        // Fork preserves the selected conversation and both its local/native
        // drafts. Refresh topology without selecting or focusing the new Tab.
        pendingForks.delete(key);
        renderTabs();
        void refresh().catch(() => {});
      }
    }
    async function interruptSession(target, preview, runtimeId) {
      if (busy || !state.connected || !preview?.canInterrupt) return;
      if (interrupt) {
        closeNavigation?.();
        feedback('正在中断会话…', { newOperation: true });
        const result = await interrupt({
          ...target,
          runtimeId,
          currentTurn: true,
          turnId: preview.turnId,
          processRuntimeId: preview.processRuntimeId,
        });
        feedback(
          result?.uncertain
            ? `${result.message || ''} 中断结果待确认，请在会话操作区核对。`
            : result?.interrupted
              ? '中断请求已接收，等待原生状态更新。'
              : result?.reason === 'native-state'
                ? '当前原生界面无法确认中断操作，请查看会话状态。'
                : result?.message || '当前轮次已结束或发生变化，请查看会话状态。',
        );
        return;
      }
      busy = true;
      renderTabs();
      document.body.classList.add('herdr-operation-pending');
      closeNavigation?.();
      feedback('正在中断会话…', { newOperation: true });
      try {
        const result = await request('/api/agents/interrupt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...target,
            runtimeId,
            turnId: preview.turnId,
            currentTurn: true,
            processRuntimeId: preview.processRuntimeId,
            requestId: crypto.randomUUID(),
          }),
        });
        feedback(
          result.interrupted
            ? '已发送中断（Esc）。'
            : result.reason === 'turn-changed'
              ? '会话已进入新一轮，状态已更新，请确认后再次中断。'
              : '会话当前没有正在执行的消息。',
        );
      } catch (error) {
        feedback(`${error.message} 请先核对会话状态后再操作。`);
      } finally {
        busy = false;
        renderTabs();
        document.body.classList.remove('herdr-operation-pending');
        void refresh().catch(() => {});
      }
    }
    async function act(action, params, pane, expectedOverride, { startCodex = false } = {}) {
      if (busy || !state.connected) return;
      busy = true;
      renderTabs();
      document.body.classList.add('herdr-operation-pending');
      feedback(startCodex ? '正在新建 Codex…' : '', { newOperation: true });
      const runtimeId = expectedOverride?.runtimeId ?? operationRuntimeId ?? state.herdrRuntimeId;
      const selection = {
        version: state.selectionVersion,
        paneId: state.chatPaneId,
        workspaceId: state.selectedWorkspaceId,
        tabId: state.selectedTabId,
      };
      const sameSelection = () =>
        state.selectionVersion === selection.version &&
        state.chatPaneId === selection.paneId &&
        state.selectedWorkspaceId === selection.workspaceId &&
        state.selectedTabId === selection.tabId;
      let createdId = '',
        created;
      const reveal = async (id) => {
        await refresh();
        if (state.herdrRuntimeId !== runtimeId || !sameSelection()) return;
        if (id) {
          pendingSelection = { id, runtimeId, selection };
          render();
        }
      };
      const invoke = (action, params, expected) =>
        request('/api/herdr/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, params, expected }),
        });
      try {
        const binding = { runtimeId, ...expected(pane) };
        const response = await invoke(action, params, { ...binding, ...expectedOverride });
        const result = response.result;
        createdId =
          result?.selected_pane_id ||
          result?.move_result?.pane?.pane_id ||
          result?.root_pane?.pane_id ||
          result?.pane?.pane_id;
        if (startCodex) {
          created = result?.root_pane;
          if (!created?.pane_id || !created.terminal_id)
            throw new Error('未取得新 Tab 的终端身份。');
          // Both native operations stay under the same UI lock. Bind the launch
          // to the returned terminal, never to the menu's original session.
          await invoke(
            'agent.start',
            {
              pane_id: created.pane_id,
              kind: 'codex',
              name: 'codex-' + crypto.randomUUID().replaceAll('-', '').slice(0, 26),
            },
            { runtimeId, paneId: created.pane_id, terminalId: created.terminal_id, sessionId: '' },
          );
        }
        feedback('');
        await reveal(createdId);
        return response;
      } catch (error) {
        feedback(
          startCodex && createdId
            ? `新 Tab 已创建，Codex 启动结果未确认：${error.message} 请查看新 Tab 后再操作。`
            : `${error.message} 请刷新核对当前状态后再操作。`,
        );
        if (startCodex && created?.pane_id && created.terminal_id)
          creationFailure = { runtimeId, paneId: created.pane_id, terminalId: created.terminal_id };
        if (startCodex && createdId) await reveal(createdId).catch(() => {});
      } finally {
        busy = false;
        renderTabs();
        document.body.classList.remove('herdr-operation-pending');
      }
    }
    async function rename(action, params, value, pane) {
      const runtimeId = state.herdrRuntimeId;
      const workspace = action === 'workspace.rename';
      const label = await dialogs.askText({
        title: workspace ? '重命名 Space' : '重命名',
        label: workspace ? 'Space 名称（不修改目录名）' : '名称',
        value,
      });
      if (label) await act(action, { ...params, label }, pane, { runtimeId });
    }
    async function close(action, params, label, pane) {
      const runtimeId = state.herdrRuntimeId;
      if (
        await dialogs.askConfirm({
          title: `关闭 ${label}`,
          message: '该对象中的终端及进程将被关闭。请确认影响范围。',
          confirmText: '关闭',
          danger: true,
        })
      )
        await act(action, params, pane, { runtimeId });
    }
    function contextAnchor(event) {
      const element = event.target.closest?.(
        '.session-item[data-pane-id], .session-item[data-tab-id], .herdr-tab[data-tab-id], .chat-tree-group[data-workspace-id]',
      );
      const scope = element?.parentElement?.closest('[id]');
      const attribute = element?.matches('.chat-tree-group')
        ? 'data-workspace-id'
        : element?.hasAttribute('data-pane-id')
          ? 'data-pane-id'
          : 'data-tab-id';
      const selector =
        element && scope
          ? `#${CSS.escape(scope.id)} .${element.classList[0]}[${attribute}="${CSS.escape(element.getAttribute(attribute))}"]`
          : null;
      const box = event.target.getBoundingClientRect?.();
      const point =
        event.clientX || event.clientY
          ? { x: event.clientX, y: event.clientY }
          : { x: box?.left || 8, y: Math.min(box?.bottom || 8, root.innerHeight - 8) };
      return {
        contextPoint: point,
        contextElement: element,
        contextScope: scope,
        contextSelector: selector,
        focus: () =>
          ((selector && document.querySelector(selector)) || element || event.target).focus?.({
            preventScroll: true,
          }),
      };
    }
    function menu(anchor, title, items, localItems = []) {
      const runtimeId = state.herdrRuntimeId;
      const native = items.map(([label, run, danger, disabled, group]) => ({
        label,
        run,
        danger,
        group,
        disabled: busy || !state.connected || Boolean(disabled),
      }));
      const tail = native.at(-1)?.danger ? native.splice(-1) : [];
      return popovers.open(anchor, {
        title,
        at: anchor?.contextPoint,
        items: [...native, ...localItems.map((item) => ({ ...item, local: true })), ...tail],
        onPick: async (item) => {
          if (!item.local && runtimeId !== state.herdrRuntimeId) {
            feedback('Herdr 运行实例已经改变，请刷新并重新打开操作菜单。', { newOperation: true });
            return;
          }
          const previous = operationRuntimeId;
          operationRuntimeId = runtimeId;
          try {
            await item.run();
          } catch (error) {
            reportError(error.message || '操作失败');
          } finally {
            operationRuntimeId = previous;
          }
        },
      });
    }
    async function createWorkspace() {
      const runtimeId = state.herdrRuntimeId;
      const cwd = await dialogs.askDirectory({
        title: '选择已有启动目录',
        start: state.config?.defaultCwd || '',
      });
      if (!cwd) return;
      const label = cwd.replace(/\/+$/, '').split('/').pop() || '/';
      return act('workspace.create', { label, cwd }, undefined, { runtimeId });
    }
    async function createTab(workspace, { askName = true, startCodex = true } = {}) {
      const runtimeId = state.herdrRuntimeId;
      const choice = askName
        ? await dialogs.askNewTab()
        : { label: startCodex ? 'Codex' : 'Shell', kind: startCodex ? 'codex' : 'shell' };
      if (!choice) return;
      // Herdr inherits the target workspace's launch directory even when its
      // public snapshot omits cwd. Never substitute the focused pane's path.
      return act(
        'tab.create',
        { workspace_id: workspace.workspaceId, label: choice.label },
        undefined,
        { runtimeId },
        { startCodex: choice.kind === 'codex' },
      );
    }
    function allowsContextMenu(event) {
      const touch =
        event.pointerType === 'touch' ||
        event.sourceCapabilities?.firesTouchEvents ||
        root.matchMedia('(hover: none) and (pointer: coarse)').matches;
      if (!touch) return true;
      // Keep native text selection outside navigation controls. Spaces and Tabs
      // rows share their mouse and touch context menus.
      return Boolean(
        event.target.closest?.(
          '.chat-tree-group[data-workspace-id], .session-item[data-pane-id], .session-item[data-tab-id], #sidebarWorkspaces',
        ) ||
        (event.target.closest?.('#chatCurrentName') && selected()?.agent && !state.archived),
      );
    }
    document.querySelector('#sidebarWorkspaces')?.addEventListener('contextmenu', (event) => {
      if (!allowsContextMenu(event)) return;
      event.preventDefault();
      menu(contextAnchor(event), 'Spaces', [['新建 Space', createWorkspace]]);
    });
    const editable = (target) =>
      target.closest?.(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), a[href]',
      );
    const sidebar = document.querySelector('#chatSidebar');
    const sidebarTarget = (target) =>
      !editable(target) &&
      target.closest?.(
        '#sidebarWorkspaces, .chat-tree-group[data-workspace-id], .session-item[data-pane-id], .session-item[data-tab-id]',
      );
    const sidebarKey = (node) =>
      node?.id === 'sidebarWorkspaces'
        ? 'spaces'
        : node?.dataset?.workspaceId
          ? 'workspace:' + node.dataset.workspaceId
          : node?.dataset?.paneId
            ? 'pane:' + node.dataset.paneId
            : node?.dataset?.tabId
              ? 'tab:' + node.dataset.tabId
              : null;
    let sidebarPress = null,
      lastSidebarPress = null,
      dispatchedContext = null;
    const pressTime = () => root.performance.now();
    function sidebarIdentity(node) {
      if (node.id === 'sidebarWorkspaces')
        return JSON.stringify([state.herdrRuntimeId, state.sidebarMode, 'spaces']);
      const workspaceId = node.dataset.workspaceId;
      if (workspaceId)
        return (state.chatWorkspaces || []).some(
          (workspace) => workspace.workspaceId === workspaceId,
        )
          ? JSON.stringify([state.herdrRuntimeId, state.sidebarMode, workspaceId])
          : null;
      const pane = node.dataset.paneId
        ? selectedById(node.dataset.paneId)
        : tabPane({ tab_id: node.dataset.tabId });
      return pane
        ? JSON.stringify([
            state.herdrRuntimeId,
            state.sidebarMode,
            pane.workspaceId,
            pane.tabId,
            ...Object.values(bindingFor(pane)),
          ])
        : null;
    }
    function validSidebarPress(press) {
      const box = sidebar.getBoundingClientRect();
      return (
        press.node.isConnected &&
        sidebar.contains(press.node) &&
        press.node.getClientRects().length &&
        box.right > 0 &&
        box.left < root.innerWidth &&
        box.bottom > 0 &&
        box.top < root.innerHeight &&
        sidebarIdentity(press.node) === press.identity
      );
    }
    function cancelSidebarPress() {
      const press = sidebarPress || lastSidebarPress;
      if (!press || (!sidebarPress && pressTime() > press.until)) return;
      clearTimeout(press.timer);
      press.cancelled = true;
      press.contextBlocked = true;
    }
    function confirmSidebarContext(press) {
      if (!press?.context?.defaultPrevented || press.handled) return;
      press.handled = true;
      press.until = pressTime() + 1000;
      lastSidebarPress = press;
      clearTimeout(press.timer);
    }
    sidebar?.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'touch' || event.isPrimary === false || sidebarPress) return;
        const node = sidebarTarget(event.target);
        if (!node || !sidebar.contains(node)) return;
        const identity = sidebarIdentity(node);
        if (!identity) return;
        const press = {
          node,
          key: sidebarKey(node),
          identity,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          cancelled: false,
          handled: false,
        };
        sidebarPress = press;
        press.timer = setTimeout(() => {
          if (sidebarPress !== press || press.cancelled || !validSidebarPress(press)) return;
          const context = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: press.x,
            clientY: press.y,
          });
          press.context = context;
          dispatchedContext = context;
          try {
            press.node.dispatchEvent(context);
          } finally {
            dispatchedContext = null;
          }
          confirmSidebarContext(press);
        }, 520);
      },
      { passive: true },
    );
    sidebar?.addEventListener(
      'pointermove',
      (event) => {
        if (
          sidebarPress?.pointerId === event.pointerId &&
          Math.hypot(event.clientX - sidebarPress.x, event.clientY - sidebarPress.y) > 8
        )
          cancelSidebarPress();
      },
      { passive: true },
    );
    sidebar?.addEventListener('scroll', cancelSidebarPress, { capture: true, passive: true });
    // These observers only cancel or finish a gesture that began in the sidebar.
    // A second finger may land outside it; no document event is intercepted.
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType === 'touch' && event.isPrimary === false) {
          cancelSidebarPress();
          return;
        }
        lastSidebarPress = null;
        if (
          sidebarPress &&
          event.pointerType === 'touch' &&
          event.isPrimary &&
          !validSidebarPress(sidebarPress)
        ) {
          cancelSidebarPress();
          sidebarPress = null;
        } else if (sidebarPress && event.pointerId !== sidebarPress.pointerId) cancelSidebarPress();
      },
      { capture: true, passive: true },
    );
    const finishSidebarPress = (event) => {
      const press = sidebarPress;
      if (!press || press.pointerId !== event.pointerId) return;
      clearTimeout(press.timer);
      confirmSidebarContext(press);
      // As with message editing, OS contextmenu may follow pointercancel.
      // Pure cancellation stops our timer; movement/scroll/multitouch also block it.
      if (event.type === 'pointercancel') press.cancelled = true;
      press.until = pressTime() + 1000;
      lastSidebarPress = press;
      sidebarPress = null;
    };
    document.addEventListener('pointerup', finishSidebarPress, { capture: true, passive: true });
    document.addEventListener('pointercancel', finishSidebarPress, {
      capture: true,
      passive: true,
    });
    sidebar?.addEventListener(
      'contextmenu',
      (event) => {
        if (event === dispatchedContext || editable(event.target)) return;
        const press = sidebarPress || lastSidebarPress,
          node = sidebarTarget(event.target);
        if (
          !press ||
          sidebarKey(node) !== press.key ||
          (!sidebarPress && pressTime() > press.until)
        )
          return;
        const touch =
          event.pointerType === 'touch' ||
          event.sourceCapabilities?.firesTouchEvents ||
          (!event.pointerType && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 8);
        if (!touch) return;
        confirmSidebarContext(press);
        if (press.handled || press.contextBlocked || !validSidebarPress(press)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        clearTimeout(press.timer);
        press.context = event;
        queueMicrotask(() => confirmSidebarContext(press));
      },
      { capture: true },
    );
    sidebar?.addEventListener(
      'click',
      (event) => {
        const press = sidebarPress || lastSidebarPress;
        confirmSidebarContext(press);
        if (
          !press?.handled ||
          event.detail === 0 ||
          sidebarKey(sidebarTarget(event.target)) !== press.key ||
          (!sidebarPress && pressTime() > press.until)
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true },
    );
    function pageContextMenu(event) {
      if (event.target.closest?.('#chatLog .chat-msg')) return;
      if (event.defaultPrevented || !allowsContextMenu(event) || editable(event.target)) return;
      // 文档图片已有保存／分享菜单，不能被页面菜单覆盖。
      if (
        event.target.closest?.(
          '.chat-image img, .chat-image-viewer img, #projectView img.doc-image, #projectView .doc-inline-image img, [data-download-url]',
        )
      )
        return;
      event.preventDefault();
      if (event.target.closest?.('dialog[open], .popover')) return;
      const anchor = contextAnchor(event),
        text = event.target.closest?.('.chat-sidebar') ? '' : root.getSelection()?.toString() || '';
      const local = [];
      if (text) local.push({ label: '复制选中内容', run: () => copyText(text) });
      const settings = { label: '设置', run: () => openSettings?.() };
      const navigation = {
        label: '显示／隐藏侧栏',
        run: () => {
          toggleNavigation?.();
        },
      };
      if (state.settingsOpen) {
        menu(
          anchor,
          '设置',
          [],
          [...local, { label: '返回会话', run: () => closeSettings?.() }, navigation],
        );
        return;
      }
      if (event.target.closest?.('#sessionFilesPage')) {
        menu(
          anchor,
          '会话文件',
          [],
          [...local, { label: '收起会话文件', run: () => closeFiles?.() }, settings],
        );
        return;
      }
      if (event.target.closest?.('.chat-sidebar')) {
        const actions = state.sidebarMode === 'workspace' ? [['新建 Space', createWorkspace]] : [];
        menu(anchor, '侧栏', actions, [...local, settings]);
        return;
      }
      const pane = selected();
      const files = document.querySelector('#chatFilesToggle');
      local.push(
        {
          label: files.getAttribute('aria-expanded') === 'true' ? '收起会话文件' : '展开会话文件',
          disabled: files.disabled,
          run: () => files.click(),
        },
        navigation,
        settings,
      );
      if (pane && !state.archived && event.target.closest?.('.chat-conversation, .chat-head'))
        paneMenu(anchor, pane, local);
      else menu(anchor, 'Swift', [], local);
    }
    document.addEventListener('contextmenu', pageContextMenu);
    document.addEventListener('keydown', (event) => {
      if (
        !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) ||
        editable(event.target)
      )
        return;
      const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      if (!event.target.dispatchEvent(context)) event.preventDefault();
    });
    function workspaceMenu(anchor, workspace) {
      const id = workspace.workspaceId;
      menu(anchor, workspace.label, [
        ['新建 Tab', () => createTab(workspace)],
        ['新建 Space', createWorkspace],
        ['重命名 Space', () => rename('workspace.rename', { workspace_id: id }, workspace.label)],
        ['全部停止', () => spaceAction(workspace, 'stop', state.herdrRuntimeId)],
        ['全部重启', () => spaceAction(workspace, 'restart', state.herdrRuntimeId)],
        ['一键发送', () => spaceAction(workspace, 'send', state.herdrRuntimeId)],
        [
          '查看操作结果',
          () => spaceAction(workspace, 'stop', state.herdrRuntimeId, { showRecent: true }),
        ],
        ['移到首位', () => act('workspace.move', { workspace_id: id, insert_index: 0 })],
        [
          '向后移动',
          () =>
            act('workspace.move', {
              workspace_id: id,
              insert_index: Math.min(
                (state.chatWorkspaces || []).length - 1,
                (state.chatWorkspaces || []).findIndex((w) => w.workspaceId === id) + 1,
              ),
            }),
        ],
        ['查看 worktree', () => inspect('worktree.list', { workspace_id: id }, 'Worktree')],
        [
          '创建 worktree',
          async () => {
            const branch = await dialogs.askText({ title: '创建 worktree', label: '新分支名称' });
            if (branch) await act('worktree.create', { workspace_id: id, branch });
          },
        ],
        [
          '打开 worktree',
          async () => {
            const branch = await dialogs.askText({ title: '打开 worktree', label: '已有分支名称' });
            if (branch) await act('worktree.open', { workspace_id: id, branch });
          },
        ],
        ...(workspace.worktree?.is_linked_worktree
          ? [
              [
                '删除 worktree',
                async () => {
                  if (
                    await dialogs.askConfirm({
                      title: '删除 worktree',
                      message: `删除 ${workspace.worktree.checkout_path}，保留分支。脏目录由 Herdr 拒绝。`,
                      danger: true,
                    })
                  )
                    await act('worktree.remove', { workspace_id: id });
                },
                true,
              ],
            ]
          : []),
        ...((state.chatWorkspaces || []).some(
          (w) =>
            w.workspaceId !== id &&
            w.worktree?.repo_key &&
            w.worktree.repo_key === workspace.worktree?.repo_key,
        ) && !workspace.worktree?.is_linked_worktree
          ? [
              [
                '关闭整个 worktree 组',
                () =>
                  close(
                    'workspace.close',
                    { workspace_id: id, close_group: true },
                    `整个工作区组 ${workspace.label}`,
                  ),
                true,
              ],
            ]
          : []),
        ['关闭 Space', () => close('workspace.close', { workspace_id: id }, workspace.label), true],
      ]);
    }
    function tabMenu(anchor, tab, localItems = []) {
      const pane = (state.allPanes || []).find((p) => p.tabId === tab.tab_id);
      const target = pane && bindingFor(pane);
      const codex = String(pane?.agent?.label || '').toLowerCase() === 'codex';
      const runtimeId = state.herdrRuntimeId;
      let interruptPreview;
      const restartTarget = pane && {
        ...target,
        name: tab.label || pane.agent?.name || pane.paneId,
      };
      const siblings = allTabs().filter((t) => t.workspace_id === tab.workspace_id);
      const index = siblings.findIndex((t) => t.tab_id === tab.tab_id);
      const moveItems = [
        ...(index > 0
          ? [
              ['移到首位', () => act('tab.move', { tab_id: tab.tab_id, insert_index: 0 }, pane)],
              [
                '向前移动',
                () => act('tab.move', { tab_id: tab.tab_id, insert_index: index - 1 }, pane),
              ],
            ]
          : []),
        ...(index < siblings.length - 1
          ? [
              [
                '向后移动',
                () => act('tab.move', { tab_id: tab.tab_id, insert_index: index + 1 }, pane),
              ],
            ]
          : []),
        ...(state.chatWorkspaces || [])
          .filter((w) => w.workspaceId !== tab.workspace_id)
          .map((w) => [
            '移到 ' + w.label,
            () =>
              act(
                'tab.move_to_workspace',
                { tab_id: tab.tab_id, workspace_id: w.workspaceId },
                pane,
              ),
          ]),
      ];
      const more = [
        ...(pane?.agent ? [['复制 Agent ID', () => copyText(pane.paneId)]] : []),
        ...(pane?.agent
          ? [
              [
                '重命名 Agent',
                async () => {
                  const name = await dialogs.askText({
                    title: '重命名 Agent',
                    label: '唯一 Agent 名称',
                    value: pane.agent.name,
                  });
                  if (name) await act('agent.rename', { target: pane.paneId, name }, pane);
                },
              ],
              [
                '状态检测详情',
                () => inspect('agent.explain', { target: pane.paneId }, 'Agent 状态详情'),
              ],
            ]
          : []),
        ...(pane
          ? [['在原生 Herdr 中定位', () => act('pane.focus', { pane_id: pane.paneId }, pane)]]
          : []),
      ];
      const layer = menu(
        anchor,
        tab.label || 'Tab',
        [
          ...(codex
            ? [
                [
                  '重启会话',
                  () =>
                    spaceAction(
                      { workspaceId: tab.workspace_id, label: pane.workspace },
                      'restart',
                      state.herdrRuntimeId,
                      { pane: restartTarget },
                    ),
                  false,
                  false,
                  '会话',
                ],
                [
                  'Fork 会话',
                  () => forkSession(target),
                  false,
                  pendingForks.has(
                    JSON.stringify([runtimeId, target.paneId, target.terminalId, target.sessionId]),
                  ),
                ],
                [
                  '中断会话',
                  () => interruptSession(target, interruptPreview, runtimeId),
                  false,
                  true,
                ],
              ]
            : []),
          ...(!pane?.agent && pane
            ? [
                [
                  '启动 Agent',
                  async () => {
                    const kind = await dialogs.askText({
                      title: '启动 Agent',
                      label: 'Herdr Agent 类型',
                      value: 'codex',
                    });
                    if (!kind) return;
                    const name = await dialogs.askText({
                      title: 'Agent 名称',
                      label: '唯一名称（小写字母、数字、下划线或连字符）',
                    });
                    if (name) await act('agent.start', { pane_id: pane.paneId, kind, name }, pane);
                  },
                ],
              ]
            : []),
          [
            '新建 Codex',
            () =>
              createTab({ workspaceId: tab.workspace_id }, { askName: false, startCodex: true }),
            false,
            false,
            'Tab',
          ],
          ['新建 Tab', () => createTab({ workspaceId: tab.workspace_id })],
          ['重命名 Tab', () => rename('tab.rename', { tab_id: tab.tab_id }, tab.label, pane)],
          ...(moveItems.length ? [['移动 Tab', () => menu(anchor, '移动 Tab', moveItems)]] : []),
          ...(root.matchMedia('(hover: none) and (pointer: coarse)').matches
            ? [
                [
                  'Space 操作',
                  () =>
                    workspaceMenu(
                      anchor,
                      (state.chatWorkspaces || []).find(
                        (w) => w.workspaceId === tab.workspace_id,
                      ) || { workspaceId: tab.workspace_id, label: pane?.workspace || 'Space' },
                    ),
                ],
              ]
            : []),
          ...(more.length ? [['会话工具', () => menu(anchor, tab.label || 'Tab', more)]] : []),
          [
            '关闭 Tab',
            () => close('tab.close', { tab_id: tab.tab_id }, `Tab ${tab.label}`, pane),
            true,
          ],
        ],
        localItems,
      );
      if (codex) {
        const button = [...layer.querySelectorAll('[role="menuitem"]')].find(
          (button) => button.textContent === '中断会话',
        );
        const current = () =>
          popovers.element === layer && layer.isConnected && state.herdrRuntimeId === runtimeId;
        const update = async () => {
          if (!current()) return;
          if (!busy && state.connected) {
            try {
              const preview = await request(
                '/api/agents/interrupt?' + new URLSearchParams({ ...target, runtimeId }),
              );
              if (current()) {
                interruptPreview = preview;
                button.disabled = busy || !state.connected || !preview.canInterrupt;
              }
            } catch {
              if (current()) {
                interruptPreview = null;
                button.disabled = true;
              }
            }
          } else button.disabled = true;
          if (current()) setTimeout(update, 750);
        };
        void update();
      }
    }
    function paneMenu(anchor, pane, localItems = []) {
      if (!pane) return;
      tabMenu(
        anchor,
        allTabs().find((t) => t.tab_id === pane.tabId) || {
          tab_id: pane.tabId,
          workspace_id: pane.workspaceId,
          label: pane.tab || pane.label || 'Tab',
        },
        localItems,
      );
    }
    async function inspect(method, params, title) {
      try {
        const data = await read(method, params);
        dialogs.open({
          title,
          build: (body) => {
            const pre = make('pre', 'herdr-inspection', JSON.stringify(data.result, null, 2));
            body.append(pre);
          },
        });
      } catch (error) {
        reportError(error.message);
      }
    }
    function selectTab(tab) {
      state.selectedWorkspaceId = tab.workspace_id;
      state.selectedTabId = tab.tab_id;
      const candidates = (state.allPanes || []).filter((p) => p.tabId === tab.tab_id);
      const pane =
        candidates.find((p) => p.paneId === state.tabPaneSelection?.[tab.tab_id]) ||
        candidates.find((p) => p.focused) ||
        candidates[0];
      if (pane) switchToPane(pane.paneId);
      else render();
      renderSidebar();
    }
    function selectWorkspace(id) {
      closeNavigation?.();
      closeFiles?.();
      state.selectedWorkspaceId = id;
      const workspace = (state.chatWorkspaces || []).find((w) => w.workspaceId === id);
      const candidates = allTabs().filter((t) => t.workspace_id === id);
      const tab =
        candidates.find((t) => t.tab_id === state.workspaceTabSelection?.[id]) ||
        candidates.find((t) => t.tab_id === workspace?.activeTabId) ||
        candidates[0];
      if (tab) selectTab(tab);
      else {
        state.selectedTabId = '';
        render();
        renderSidebar();
      }
    }
    const separationAttempts = new Set();
    function render() {
      if (
        creationFailure &&
        state.connected &&
        creationFailure.runtimeId === state.herdrRuntimeId
      ) {
        const created = selectedById(creationFailure.paneId);
        if (
          created?.terminalId === creationFailure.terminalId &&
          created.agent?.label?.toLowerCase() === 'codex'
        )
          feedback('');
      }
      const pane = selected();
      restoreFeedback.update(
        pane?.restoreError
          ? `Herdr 恢复失败：${pane.restoreError}。历史仍可阅读，请核对恢复参数后显式重试。`
          : '',
        JSON.stringify([
          state.config?.rootDirectory,
          state.herdrRuntimeId,
          pane?.paneId,
          pane?.terminalId,
          pane?.agent?.session?.value,
          pane?.restoreError,
        ]),
      );
      if (pendingSelection) {
        if (
          pendingSelection.runtimeId !== state.herdrRuntimeId ||
          (pendingSelection.selection &&
            (pendingSelection.selection.version !== state.selectionVersion ||
              pendingSelection.selection.paneId !== state.chatPaneId ||
              pendingSelection.selection.workspaceId !== state.selectedWorkspaceId ||
              pendingSelection.selection.tabId !== state.selectedTabId))
        )
          pendingSelection = null;
        else if (selectedById(pendingSelection.id)) {
          const id = pendingSelection.id;
          pendingSelection = null;
          switchToPane(id);
          return;
        }
      }
      if (
        pane &&
        (pane.paneId !== lastSelected || `${pane.workspaceId}:${pane.tabId}` !== lastPaneLocation)
      ) {
        lastPaneLocation = `${pane.workspaceId}:${pane.tabId}`;
        lastSelected = pane.paneId;
        state.selectedWorkspaceId = pane.workspaceId;
        state.selectedTabId = pane.tabId;
        (state.workspaceTabSelection ||= {})[pane.workspaceId] = pane.tabId;
        (state.tabPaneSelection ||= {})[pane.tabId] = pane.paneId;
      }
      renderTabs();
      const members = (state.allPanes || []).filter((p) => p.tabId === state.selectedTabId);
      conversation.hidden = !state.archived && !members.some((p) => p.paneId === state.chatPaneId);
      stage.querySelector('.herdr-empty-space')?.remove();
      if (!members.length && !state.archived)
        stage.append(make('p', 'herdr-empty-space', '这个 Space 还没有 Tab。可以新建 Tab。'));
      if (state.connected && !busy) {
        const legacy = allTabs().find(
          (t) =>
            (state.allPanes || []).filter((p) => p.tabId === t.tab_id).length > 1 &&
            !separationAttempts.has(separationKey(t.tab_id)),
        );
        if (legacy) {
          separationAttempts.add(separationKey(legacy.tab_id));
          const members = (state.allPanes || []).filter((p) => p.tabId === legacy.tab_id);
          void act(
            'tab.separate',
            { tab_id: legacy.tab_id },
            pane?.tabId === legacy.tab_id ? pane : undefined,
            {
              members: members.map((p) => [p.paneId, p.terminalId, p.agent?.session?.value || '']),
            },
          ).finally(render);
        }
      }
    }
    function separationKey(id) {
      return JSON.stringify([
        state.herdrRuntimeId,
        id,
        (state.allPanes || [])
          .filter((p) => p.tabId === id)
          .map((p) => [p.paneId, p.terminalId, p.agent?.session?.value || '']),
      ]);
    }
    root.addEventListener('resize', render);
    desktopMedia.addEventListener('change', render);
    return {
      render,
      act,
      read,
      inspect,
      allowsContextMenu,
      paneMenu,
      workspaceMenu,
      createWorkspace,
      selectWorkspace,
      selectTab,
      tabMenu,
      contextAnchor,
      desktop,
      tabNavigation,
    };
  }
  root.StudioHerdrShell = { create };
})(globalThis);
