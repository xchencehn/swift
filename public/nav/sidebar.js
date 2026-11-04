/**
 * 左栏：Spaces、Agents、归档三种列表，以及会话行的渲染。
 *
 * 显示 Herdr 的全部 pane，包括 Shell 与空工作区，分组只使用 Herdr 的 workspaceId。
 * Agents 列出原生 Agent，Spaces 保留全部 Pane，「归档」从原生存档列已经停机的 —— 那一栏此前叫「历史」，
 * 而「历史」说的是时间顺序，描述不了「活着 / 已停机」这个区别。元素标识
 * `#sidebarHistory` 与 `/api/history` 是稳定标识，不随展示名改动。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioSidebar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 列表读取 Herdr 的分组、终端和原生归档；终端管理由 Herdr 原生客户端处理。
   */
  function create({
    state,
    els,
    UI,
    $,
    request,
    isDesktop,
    chatText,
    renderChatMessages,
    renderSessionStatus,
    renderStatusDot,
    switchToPane,
    alreadySeen,
    completionUnread = () => false,
    archivedKey,
    selectArchived,
    isGroupCollapsed,
    toggleGroup,
    historySynced = () => false,
    renderFiles = () => {},
  }) {
    // Navigation scroll belongs to the selected page, not to the previous drawer opening.
    const navigation = els.sidebarWorkspaces.parentElement;
    const navigationMore = $('#sidebarNavigationMore');
    const navigationButtons = [...navigation.querySelectorAll('button')];
    let navigationMode = null;
    function updateNavigationOverflow() {
      const needed = navigation.scrollWidth > navigation.parentElement.clientWidth + 1;
      navigationMore.hidden = !needed;
      const back = navigation.scrollLeft + navigation.clientWidth >= navigation.scrollWidth - 1;
      navigationMore.dataset.direction = back ? 'back' : 'forward';
      navigationMore.setAttribute('aria-label', back ? '切换到 spaces' : '切换到 files');
    }
    function revealNavigation() {
      // Keep the header fixed while its selection glider follows the content gesture.
      if (navigation.classList.contains('tab-gliding')) return;
      updateNavigationOverflow();
      const selected = navigation.querySelector('[aria-selected="true"]');
      if (!selected || !navigation.clientWidth) return;
      // A saved narrow sidebar still needs room for one complete label and its controls.
      const widest = Math.max(
        ...navigationButtons.map((button) => button.getBoundingClientRect().width),
      );
      const minimum = Math.max(
        180,
        Math.ceil(els.chatSidebar.getBoundingClientRect().width - navigation.clientWidth + widest),
      );
      const minimumValue = `${minimum}px`;
      if (document.documentElement.style.getPropertyValue('--chat-sidebar-min-w') !== minimumValue)
        document.documentElement.style.setProperty('--chat-sidebar-min-w', minimumValue);
      const item = selected.getBoundingClientRect(),
        box = navigation.getBoundingClientRect();
      if (selected === navigationButtons[0]) navigation.scrollLeft = 0;
      else
        navigation.scrollLeft +=
          item.left < box.left
            ? item.left - box.left
            : item.right > box.right
              ? item.right - box.right
              : 0;
      updateNavigationOverflow();
    }
    navigationMore.addEventListener('click', () => {
      const target =
        navigationMore.dataset.direction === 'back'
          ? navigationButtons[0]
          : navigationButtons.at(-1);
      target.click();
      revealNavigation();
    });
    navigation.addEventListener('scroll', updateNavigationOverflow, { passive: true });
    const navigationResize = new ResizeObserver(revealNavigation);
    navigationResize.observe(navigation.parentElement);
    for (const button of navigationButtons) navigationResize.observe(button);

    // 三页共用列表节点；滚动位置属于根目录、页面与筛选条件，而不是该节点。
    const scrollPositions = new Map();
    let renderedView = null,
      pendingScroll = null;
    function captureScroll({ detach = false, defer = false } = {}) {
      if (renderedView && els.chatPickerList.clientHeight && !pendingScroll) {
        scrollPositions.set(renderedView, {
          top: els.chatPickerList.scrollTop,
          left: els.chatPickerList.scrollLeft,
        });
      }
      if (defer) pendingScroll = scrollPositions.get(renderedView) || null;
      // 跟手换页会先移走原节点；此后空容器的 0 不能覆盖刚保存的位置。
      if (detach) renderedView = null;
    }
    function restoreScroll() {
      if (!pendingScroll || !els.chatPickerList.clientHeight) return;
      // 归档搜索先显示加载占位，结果到达前不能用被夹到 0 的位置覆盖原记录。
      if (
        state.sidebarMode === 'history' &&
        state.historyLoading &&
        els.chatPickerList.scrollHeight - els.chatPickerList.clientHeight < pendingScroll.top
      )
        return;
      els.chatPickerList.scrollTop = pendingScroll.top;
      els.chatPickerList.scrollLeft = pendingScroll.left;
      pendingScroll = null;
    }
    function beginList(mode, query) {
      captureScroll();
      renderedView = JSON.stringify([state.config?.rootDirectory || '', mode, query]);
      pendingScroll = scrollPositions.get(renderedView) || { top: 0, left: 0 };
      // 搜索条件仅缓存有限条位置，三种页面的空筛选位置始终保留。
      if (!scrollPositions.has(renderedView)) scrollPositions.set(renderedView, pendingScroll);
      if (scrollPositions.size > 36) {
        for (const key of scrollPositions.keys()) {
          if (JSON.parse(key)[2] && key !== renderedView) {
            scrollPositions.delete(key);
            break;
          }
        }
      }
    }
    // 桌面折叠时列表没有布局；展开后再恢复，隐藏期间的刷新不能把位置改成 0。
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(restoreScroll).observe(els.chatPickerList);

    function folderIcon(collapsed) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'chat-tree-icon');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'currentColor');
      path.setAttribute(
        'd',
        collapsed
          ? 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.2 1.4H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.4H3a1.5 1.5 0 0 1-1.5-1.5v-8.4Z'
          : 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.2 1.4H13a1.5 1.5 0 0 1 1.5 1.5v.6H4.3a1.5 1.5 0 0 0-1.45 1.12L1.5 11.9V3.5Zm1.2 8.4 1.3-5.1h11.1l-1.3 5.1A1.5 1.5 0 0 1 12.35 13H3.05a.36.36 0 0 1-.35-.45Z',
      );
      svg.append(path);
      return svg;
    }

    // Workspaces come from Herdr even when empty; Agents are flat.
    function groupByWorkspace(panes) {
      const groups = new Map(
        (state.chatWorkspaces || []).map((workspace) => [
          workspace.workspaceId,
          { workspaceId: workspace.workspaceId, label: workspace.label, panes: [] },
        ]),
      );
      for (const pane of panes) {
        const key = pane.workspaceId || pane.workspace || '未归类';
        if (!groups.has(key))
          groups.set(key, { workspaceId: key, label: pane.workspace || '未归类', panes: [] });
        groups.get(key).panes.push(pane);
      }
      return [...groups.values()].map((group) => [group.label, group.panes, group.workspaceId]);
    }

    function panesInTabOrder(panes) {
      // Use the same snapshot order as the top Tab bar. Native numbers identify
      // tabs but do not track tab.move; cached panes can still use the old order.
      const workspaces = new Map(
        (state.chatWorkspaces || []).map((workspace, index) => [workspace.workspaceId, index]),
      );
      const tabs = new Map((state.chatTabs || []).map((tab, index) => [tab.tab_id, index]));
      for (const pane of panes) {
        if (!workspaces.has(pane.workspaceId)) workspaces.set(pane.workspaceId, workspaces.size);
        if (!tabs.has(pane.tabId)) tabs.set(pane.tabId, tabs.size);
      }
      // Stable sorting keeps split Panes together without changing their order
      // or mutating the snapshot used by focus, history and draft handling.
      return [...panes].sort(
        (a, b) =>
          workspaces.get(a.workspaceId) - workspaces.get(b.workspaceId) ||
          tabs.get(a.tabId) - tabs.get(b.tabId),
      );
    }

    /**
     * 选中的是个还没有 agent 的终端标签页。
     *
     * 它在 Herdr 里是真实存在的一格(多半是 cd 过去备用的 shell),只是没有对话可看。
     * 没有可读存档时说明当前状态，仍允许通过会话菜单启动 Agent。
     */
    function renderNoHistoryPlaceholder(pane) {
      if (!pane) return renderChatMessages([]);
      els.chatLog.dataset.signature = '';
      els.chatLog.dataset.paneId = pane.paneId;
      els.chatLog.textContent = '';
      state.chatMessages = [];

      const box = document.createElement('div');
      box.className = 'chat-blank';
      const running = Boolean(pane.agent);
      const supported = Boolean(globalThis.StudioProviders?.get(UI.providerId(pane))?.history);
      const title = document.createElement('p');
      title.className = 'chat-blank-title';
      title.textContent = running
        ? pane.restoreError
          ? 'Agent 恢复失败'
          : `${pane.agent.label || 'Agent'}：${supported ? '尚无可读对话' : '尚未适配结构化历史'}`
        : '这个标签页还没有 agent';
      const where = document.createElement('p');
      where.className = 'chat-blank-path';
      where.textContent = pane.baseCwd || pane.cwd || '';
      const note = document.createElement('p');
      note.className = 'chat-blank-note';
      note.textContent =
        pane.restoreError ||
        (running
          ? supported
            ? 'Herdr 已识别这个 Agent；Swift 尚未取得可读存档。关联完成后会自动显示聊天记录。'
            : 'Herdr 能识别并运行这个 Agent。Swift 尚不支持它的历史解析，不能在这里发送消息。'
          : '此 Tab 尚无可读会话记录，可通过会话菜单启动 Agent。');
      box.append(title, where, note);
      els.chatLog.append(box);
      els.chatLog.append(els.chatStatus);
    }

    // 归档列表存在本机：切到「归档」时先画上次的，后台再更新（2026-09-25 用户指出切过去要刷新一下）。
    const HISTORY_KEY = state.namespace
      ? `studioHistoryList:${state.namespace}`
      : 'studioHistoryList';
    if (!state.history?.length)
      try {
        const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null');
        if (Array.isArray(saved?.sessions)) {
          state.history = saved.sessions;
          state.historyNext = saved.next ?? null;
          state.historyQuery = '';
        }
      } catch {
        /* 本机存储不可用就每次现取 */
      }

    async function loadHistory(append = false, { force = false } = {}) {
      const query = els.chatPickerSearch.value.trim();
      if (state.historyLoading && state.historyQuery === query) return;
      if (!force && state.historyError && state.historyQuery === query) {
        renderHistory();
        return;
      }
      if (
        !force &&
        !append &&
        state.historyQuery === query &&
        Date.now() - (state.historyAt || 0) < 10000
      ) {
        renderHistory();
        return;
      }
      // 同步生效时归档列表由推送保持最新（docs/LOCAL_FIRST.md）：不搜、不翻页就不请求。
      if (!force && !append && !query && state.historyQuery === query && historySynced()) {
        renderHistory();
        return;
      }
      const epoch = (state.historyEpoch = (state.historyEpoch || 0) + 1);
      state.historyLoading = true;
      if (state.historyQuery !== query) {
        state.history = [];
        state.historyNext = null;
      }
      state.historyQuery = query;
      state.historyError = '';
      renderHistory();
      try {
        const result = await request(
          '/api/history?' +
            new URLSearchParams({ q: query, offset: append ? state.historyNext || 0 : 0 }),
        );
        if (epoch !== state.historyEpoch) return;
        state.history = append ? [...(state.history || []), ...result.sessions] : result.sessions;
        state.historyNext = result.nextOffset;
        state.historyAt = Date.now();
        if (!query && !append)
          try {
            localStorage.setItem(
              HISTORY_KEY,
              JSON.stringify({ sessions: result.sessions, next: result.nextOffset }),
            );
          } catch {
            /* 存不下就算了 */
          }
      } catch (error) {
        if (epoch === state.historyEpoch) {
          state.historyError = error.message || '读取失败';
          state.historyFailedAppend = append;
        }
      } finally {
        if (epoch === state.historyEpoch) {
          state.historyLoading = false;
          renderHistory();
        }
      }
    }
    function renderHistory() {
      if (state.sidebarMode !== 'history') return;
      const active = new Set(
        (state.chatAgents || []).map((p) => `${UI.providerId(p)}:${p.agent?.session?.value}`),
      );
      const sessions = (state.history || []).filter(
        (s) => !active.has(`${s.provider}:${s.sessionId}`),
      );
      const signature = JSON.stringify([
        'history',
        Math.floor(Date.now() / 60000),
        sessions,
        state.historyQuery,
        state.historyNext,
        state.historyLoading,
        state.historyError,
      ]);
      if (els.chatPickerList.dataset.signature === signature) return;
      beginList('history', state.historyQuery || '');
      els.chatPickerList.dataset.signature = signature;
      els.chatPickerList.replaceChildren();
      for (const session of sessions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'session-item history-item';
        const key = `${session.provider}:${session.sessionId}`;
        button.dataset.historyId = key;
        const name = chatText(document.createElement('span'), session.title || '新会话');
        name.className = 'session-name';
        const stamp = chatText(
          document.createElement('span'),
          UI.elapsedTime(session.lastMessageAt),
        );
        stamp.className = 'chat-picker-kind';
        button.title = `${session.title}\n${session.cwd}`;
        button.append(name, stamp);
        if (state.archived && archivedKey(state.archived) === key)
          button.setAttribute('aria-current', 'true');
        // 点一下**只是翻看**：归档里的会话已经停机，正文能读，消息发不出去。
        // 恢复是另一回事 —— 它要在原目录重开一个进程，必须是明确的动作。
        button.addEventListener('click', () => selectArchived(session));
        els.chatPickerList.append(button);
      }
      if (state.historyError) {
        const message = state.historyFailedAppend
          ? '更多归档读取失败。'
          : sessions.length
            ? '归档更新失败，仍显示已读取的会话。'
            : '归档读取失败。';
        historyFeedback(
          message + state.historyError,
          () => void loadHistory(state.historyFailedAppend, { force: true }),
          '重试',
        );
      } else if (!sessions.length) {
        if (!state.historyLoading && state.historyQuery)
          historyFeedback(
            '没有匹配的归档会话。',
            () => {
              els.chatPickerSearch.value = '';
              void loadHistory();
              els.chatPickerSearch.focus();
            },
            '清空搜索',
          );
        else {
          const note = document.createElement('p');
          note.className = 'history-empty';
          note.textContent = state.historyLoading ? '正在读取归档…' : '没有已关闭的会话';
          els.chatPickerList.append(note);
        }
      }
      if (state.historyNext != null && !state.historyError) {
        const more = chatText(
          document.createElement('button'),
          state.historyLoading ? '正在读取…' : '加载更多',
        );
        more.type = 'button';
        more.className = 'chat-btn';
        more.disabled = state.historyLoading;
        more.onclick = () => loadHistory(true);
        els.chatPickerList.append(more);
      }
      restoreScroll();
    }

    function historyFeedback(message, action, label) {
      const box = document.createElement('div');
      box.className = 'list-feedback';
      box.setAttribute('role', 'status');
      const button = chatText(document.createElement('button'), label);
      button.type = 'button';
      button.className = 'chat-btn';
      button.addEventListener('click', action);
      box.append(chatText(document.createElement('span'), message), button);
      els.chatPickerList.append(box);
    }

    function renderChatPicker() {
      const agents = state.chatAgents || [];
      renderFiles();
      // 启动时从本机缓存画出来的列表（snapshotCached）也算：它就是上次的样子，比空着强。
      if (!state.snapshotReady && !state.snapshotCached) {
        els.chatCurrentName.textContent = '';
        els.chatCurrentKind.textContent = '';
        return;
      }
      const current = agents.find((pane) => pane.paneId === state.chatPaneId);
      renderSessionStatus(current);
      state.herdrShell?.render();
      $('#chatFilesToggle').disabled = !current && !state.archived;
      // 看的是归档里的一条时，标题归它 —— 那条没有 pane，按 current 算出来是「选择会话」。
      // 这里也能右键，所以悬浮提示要说出来 —— 不说的话没人会去试。
      if (state.archived) {
        els.chatCurrentName.textContent = state.archived.title || '归档会话';
        els.chatCurrentName.title = [state.archived.title, state.archived.cwd]
          .filter(Boolean)
          .join('\n');
      } else {
        els.chatCurrentName.textContent = current ? UI.sessionLabel(current) : '选择会话';
        // 悬浮显示 Agent 自己那个长名字；没有长名时退回短语，免得悬浮出来一片空白。
        els.chatCurrentName.title = current
          ? UI.sessionTooltip(current) || UI.sessionLabel(current)
          : '';
      }
      els.sidebarRecent.setAttribute('aria-selected', String(state.sidebarMode === 'recent'));
      els.sidebarWorkspaces.setAttribute(
        'aria-selected',
        String(state.sidebarMode === 'workspace'),
      );
      els.sidebarHistory.setAttribute('aria-selected', String(state.sidebarMode === 'history'));
      document
        .querySelector('#sidebarFiles')
        ?.setAttribute('aria-selected', String(state.sidebarMode === 'files'));
      if (navigationMode !== state.sidebarMode) {
        navigationMode = state.sidebarMode;
        revealNavigation();
      }
      els.chatPickerList.hidden = state.sidebarMode === 'files';
      if (state.sidebarMode === 'files') return;
      els.chatPickerList.dataset.mode = state.sidebarMode;
      if (state.sidebarMode === 'history') {
        renderHistory();
        if (
          !state.historyLoading &&
          !state.historyError &&
          Date.now() - (state.historyAt || 0) >= 10000
        )
          loadHistory();
        return;
      }
      els.chatCurrentKind.textContent = current
        ? current.agent?.label || '终端'
        : `${agents.filter((pane) => pane.agent?.session?.value).length} 个会话`;

      const keyword = els.chatPickerSearch.value.trim().toLowerCase();
      // 使用上一版 Herdr 列表的对象名称与上下文搜索，列表布局保持用户原设计。
      const agentLabel = (pane) =>
        pane.displayAgent || pane.agent?.name || pane.agent?.label || pane.title || pane.paneId;
      const agentContextLabel = (pane) =>
        [pane.workspace, pane.tabTitle || pane.tab, agentLabel(pane)].filter(Boolean).join(' · ');
      const matches = (pane) =>
        !keyword ||
        [agentContextLabel(pane), UI.sessionLabel(pane), pane.agent?.label].some((value) =>
          String(value || '')
            .toLowerCase()
            .includes(keyword),
        );
      const visible = panesInTabOrder(agents).filter(
        (pane) => (state.sidebarMode !== 'recent' || pane.agent) && matches(pane),
      );
      // 搜索时只留有命中的分组:空工作区在平时要显示(否则新建的看不见),
      // 但在筛选结果里留一排空标题只是噪音。
      // 内容没变就不重建:否则每轮轮询都会把正在滚动的列表在手底下换掉。
      // 签名要带上「有没有对话可看」:一个终端标签页里起了 agent 之后,
      // paneId 和标题都可能没变,只有这一位变了,漏掉它侧栏就不刷新。
      //
      // ⚠️ 也要带上「看过没看过」。消息已读与本轮完成分别记录，状态一直是 idle 时
      // 其余几项全不变 —— 漏掉它，左栏的点子会停在旧颜色：看过了还是蓝的，
      // 或者来了新消息还是灰的。
      const signature = JSON.stringify([
        state.sidebarMode,
        state.connected,
        keyword,
        state.chatPaneId,
        isDesktop(),
        state.selectedWorkspaceId,
        state.chatWorkspaces,
        state.chatTabs,
        state.remoteAgents,
        state.remoteAgentError,
        (state.chatWorkspaces || []).map((w) => [
          isGroupCollapsed(w.workspaceId),
          isGroupCollapsed(`worktree:${w.worktree?.repo_key}`),
        ]),
        visible.map((p) => [
          p.paneId,
          agentContextLabel(p),
          p.workspaceId,
          p.tabId,
          UI.sessionLabel(p),
          p.tokens,
          p.restoreError,
          UI.statusKind(p),
          alreadySeen(p),
          completionUnread(p),
          p.agent?.completionSeq,
          p.agent?.stateChangeSeq,
          p.agent?.session?.value,
        ]),
      ]);
      if (els.chatPickerList.dataset.signature === signature) return;
      els.chatPickerList.dataset.signature = signature;
      beginList(state.sidebarMode, keyword);
      els.chatPickerList.textContent = '';

      if (
        !visible.length &&
        ((state.sidebarMode === 'recent' && !state.remoteAgents?.length) ||
          (state.sidebarMode === 'workspace' && !state.chatWorkspaces?.length))
      ) {
        const empty = document.createElement('p');
        empty.className = 'chat-empty';
        empty.textContent =
          state.sidebarMode === 'recent' ? '没有匹配的 Agent。' : '没有匹配的 Space。';
        els.chatPickerList.append(empty);
        restoreScroll();
        return;
      }

      if (visible.length) {
        const heading = document.createElement('div');
        heading.className = 'chat-tree-group';
        heading.textContent = keyword ? `会话 · ${visible.length}` : '';
        if (keyword) els.chatPickerList.append(heading);
      }
      const appendPane = (pane) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'session-item';
        item.dataset.paneId = pane.paneId;
        if (pane.agent) item.dataset.agentMenu = '';
        if (pane.paneId === state.chatPaneId) item.classList.add('active');
        const dot = document.createElement('span');
        renderStatusDot(dot, pane);
        const name = document.createElement('span');
        name.className = 'session-name';
        const isTerminal = !pane.agent;
        const readable = Boolean(pane.agent?.session?.value);
        name.textContent =
          state.sidebarMode === 'recent'
            ? agentContextLabel(pane)
            : pane.label || pane.title || UI.sessionLabel(pane);
        const kind = document.createElement('span');
        kind.className = 'chat-picker-kind';
        // 终端的类型位留空:名字里已经写着「终端」,再标一次是重复。
        kind.textContent =
          isTerminal || (state.sidebarMode === 'recent' && pane.agent?.label === agentLabel(pane))
            ? ''
            : pane.agent?.label || '';
        if (!readable) item.classList.add('terminal-tab');
        item.title = [
          agentContextLabel(pane),
          UI.sessionTooltip(pane),
          pane.restoreError,
          ...Object.entries(pane.tokens || {}).map(([key, value]) => `${key}: ${value}`),
        ]
          .filter(Boolean)
          .join('\n');
        item.append(name, kind, dot);
        // 与「会话」弹层走同一条路径,别留两份。
        item.addEventListener('click', () => switchToPane(pane.paneId));
        item.addEventListener('contextmenu', (event) => {
          if (!state.herdrShell?.allowsContextMenu(event)) return;
          event.preventDefault();
          state.herdrShell?.paneMenu(state.herdrShell.contextAnchor(event), pane);
        });
        els.chatPickerList.append(item);
        return item;
      };
      if (state.sidebarMode === 'recent') {
        for (const pane of visible) appendPane(pane);
        for (const remote of state.remoteAgents || []) {
          if (
            keyword &&
            ![remote.machine, agentContextLabel(remote.pane), UI.sessionLabel(remote.pane)]
              .join(' ')
              .toLowerCase()
              .includes(keyword)
          )
            continue;
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'session-item';
          const name = document.createElement('span');
          name.className = 'session-name';
          name.textContent = agentContextLabel(remote.pane);
          const machine = document.createElement('span');
          machine.className = 'chat-picker-kind';
          machine.textContent = remote.machine;
          const dot = document.createElement('span');
          const raw = UI.statusKind(remote.pane);
          dot.className = 'status-dot';
          dot.dataset.status = !remote.online
            ? 'offline'
            : remote.completionUnread
              ? 'done'
              : raw === 'done'
                ? 'idle'
                : raw;
          dot.classList.add(dot.dataset.status);
          dot.setAttribute('role', 'img');
          dot.setAttribute('aria-label', dot.dataset.status);
          item.title = [
            remote.machine,
            agentContextLabel(remote.pane),
            remote.online ? '' : '机器已离线，显示上次数据。',
          ]
            .filter(Boolean)
            .join('\n');
          item.append(name, machine, dot);
          item.onclick = () => location.assign(remote.href);
          els.chatPickerList.append(item);
        }
        if (state.remoteAgentError) {
          const note = document.createElement('p');
          note.className = 'chat-tree-empty';
          note.textContent = state.remoteAgentError;
          els.chatPickerList.append(note);
        }
        restoreScroll();
        return;
      }
      for (const entry of UI.workspaceEntries(
        state.chatWorkspaces || [],
        isGroupCollapsed,
        state.selectedWorkspaceId || current?.workspaceId,
      )) {
        const nativeWorkspace = entry.workspace;
        const workspace = nativeWorkspace.label,
          workspaceId = nativeWorkspace.workspaceId;
        const panes = visible.filter((pane) => pane.workspaceId === workspaceId);
        if (keyword && !workspace.toLowerCase().includes(keyword) && !panes.length) continue;
        const collapsed = isGroupCollapsed(workspaceId);
        const heading = document.createElement('div');
        heading.className = 'chat-tree-group';
        heading.dataset.workspaceId = workspaceId;
        if (entry.indented) heading.classList.add('linked-worktree');
        const headingText = document.createElement('button');
        headingText.type = 'button';
        headingText.className = 'chat-tree-toggle';
        headingText.setAttribute('aria-expanded', String(!collapsed));
        // 文件夹图标:展开是打开的、收起是合上的,兼做折叠指示,省掉一个三角箭头。
        // dsh 的侧边栏就是这么表达工作区的。
        const icon = folderIcon(collapsed);
        const groupLabel = document.createElement('span');
        groupLabel.className = 'chat-tree-name';
        groupLabel.textContent = workspace;
        const dot = document.createElement('span');
        dot.className = 'status-dot';
        const members = agents.filter(
          (p) =>
            p.workspaceId === workspaceId ||
            (entry.folded && entry.group?.some((w) => w.workspaceId === p.workspaceId)),
        );
        const priority = { blocked: 5, working: 4, done: 3, unknown: 2, idle: 1, shell: 0 };
        dot.dataset.status = !state.connected
          ? 'offline'
          : members.reduce(
              (best, pane) => {
                const raw = UI.statusKind(pane),
                  status = completionUnread(pane) ? 'done' : raw === 'done' ? 'idle' : raw;
                return (priority[status] || 0) > (priority[best] || 0) ? status : best;
              },
              members.length ? 'idle' : nativeWorkspace.status || 'idle',
            );
        dot.classList.add(dot.dataset.status);
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', dot.dataset.status);
        headingText.title = [
          workspace,
          nativeWorkspace.worktree?.checkout_path,
          ...Object.entries(nativeWorkspace.tokens || {}).map(([key, value]) => `${key}: ${value}`),
        ]
          .filter(Boolean)
          .join('\n');
        headingText.append(icon, groupLabel, dot);
        headingText.addEventListener('click', () => {
          toggleGroup(workspaceId);
          if (entry.groupKey) toggleGroup(entry.groupKey);
          els.chatPickerList.dataset.signature = '';
          renderChatPicker();
        });
        // 工作区行保持干净(dsh 就是这样),操作走右键;手机上长按等效。
        const showMenu = (event) => {
          if (!state.herdrShell?.allowsContextMenu(event)) return;
          event.preventDefault();
          event.stopPropagation();
          const native = (state.chatWorkspaces || []).find((w) => w.workspaceId === workspaceId);
          if (native)
            state.herdrShell?.workspaceMenu(state.herdrShell.contextAnchor(event), native);
        };
        heading.addEventListener('contextmenu', showMenu);
        heading.append(headingText);
        els.chatPickerList.append(heading);
        if (collapsed) continue;
        if (!panes.length) {
          const empty = document.createElement('div');
          empty.className = 'chat-tree-empty';
          empty.textContent = '还没有会话';
          empty.setAttribute('role', 'button');
          empty.tabIndex = 0;
          const select = () => state.herdrShell?.selectWorkspace(workspaceId);
          empty.onclick = select;
          empty.onkeydown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              select();
            }
          };
          els.chatPickerList.append(empty);
        }
        if (state.herdrShell) {
          const tabs = state.chatTabs?.length
            ? state.chatTabs
            : [
                ...new Map(
                  panes.map((p) => [
                    p.tabId,
                    {
                      tab_id: p.tabId,
                      workspace_id: workspaceId,
                      label: p.tabTitle || p.tab || UI.sessionLabel(p),
                    },
                  ]),
                ).values(),
              ];
          for (const tab of tabs.filter((t) => t.workspace_id === workspaceId)) {
            const members = panes.filter((p) => p.tabId === tab.tab_id);
            // A legacy split is temporarily readable while it is converted to
            // native Tabs. It never creates another navigation hierarchy.
            for (const member of members) {
              const row = appendPane(member);
              row.dataset.tabId = tab.tab_id;
              row.querySelector('.session-name').textContent =
                members.length === 1
                  ? tab.label || member.tabTitle || UI.sessionLabel(member)
                  : member.label || UI.sessionLabel(member);
            }
          }
        } else for (const pane of panes) appendPane(pane);
      }

      restoreScroll();
    }

    return {
      folderIcon,
      groupByWorkspace,
      captureScroll,
      restoreScroll,
      revealNavigation,
      renderNoHistoryPlaceholder,
      loadHistory,
      renderHistory,
      renderChatPicker,
    };
  }

  return { create };
});
