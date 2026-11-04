(() => {
  'use strict';

  const UI = window.StudioUi;
  const Providers = window.StudioProviders;
  const VisualViewport = window.StudioVisualViewport;
  const $ = (selector) => document.querySelector(selector);
  const basePath = $('meta[name="agent-studio-base-path"]')?.content || '';
  const appPath = (pathname) => `${basePath}${pathname}`;
  const authBasePath = basePath.replace(/\/herdr-sessions\/[^/]+$/, '');
  const tokenStorageKey = authBasePath.startsWith('/e/')
    ? `agentStudioToken:${authBasePath}`
    : 'agentStudioToken';
  const nativeConnectionAuth = Boolean(
    window.StudioApp?.savedConnections && window.StudioApp?.switchConnection,
  );
  if (nativeConnectionAuth) {
    // Old Android builds passed credentials through a fragment. Native
    // connections now use HttpOnly cookies; retire their browser copies.
    try {
      for (const key of Object.keys(localStorage))
        if (/^(swiftToken|agentStudioToken(?::.*)?)$/.test(key)) localStorage.removeItem(key);
    } catch {}
  }
  const frontendVersion = $('meta[name="agent-studio-assets-version"]')?.content || '';
  let rootUiSettings = {},
    applyingRootSettings = false,
    settingsSaver = null;
  /**
   * 2026-09-22 把浏览器里存的键从 `swift*` 改成 `agentStudio*`。
   *
   * ⚠️ **这两个键丢了代价很大**：`agentStudioToken` 没了就是当场退出登录、要重新
   * 输 token；`agentStudioDevice` 没了这个浏览器就变成一台新设备，主题、字号、栏宽、
   * 已读记录全部归零（它们按设备标识存在 devices/<标识>.json 里）。
   * 而 `public/` 是热生效的 —— 改名那一刻线上正在用的页面一刷新就找不到旧键了。
   * 所以认回旧键，不是可选项。
   */
  for (const [from, to] of [
    ['swiftToken', 'agentStudioToken'],
    ['swiftDevice', 'agentStudioDevice'],
  ]) {
    try {
      const legacy = localStorage.getItem(from);
      if (legacy !== null && localStorage.getItem(to) === null) localStorage.setItem(to, legacy);
    } catch {}
  }
  let deviceId;
  try {
    deviceId = localStorage.getItem('agentStudioDevice');
  } catch {}
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(deviceId || '')) {
    deviceId =
      globalThis.crypto?.randomUUID?.() ||
      `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      localStorage.setItem('agentStudioDevice', deviceId);
    } catch {}
  }
  document.cookie = `agentStudioDevice=${deviceId}; Path=${basePath || '/'}; SameSite=Lax; Max-Age=31536000`;
  const storage = {
    get(key, fallback = '') {
      if (nativeConnectionAuth && key === tokenStorageKey) return fallback;
      if (key !== 'agentStudioToken') return rootUiSettings[key] ?? fallback;
      try {
        return localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      if (nativeConnectionAuth && key === tokenStorageKey) return;
      if (key !== 'agentStudioToken') {
        if (rootUiSettings[key] === value) return;
        rootUiSettings[key] = value;
        queueRootSettings({ ui: { [key]: value } });
        return;
      }
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
  };
  const loadJson = (key, fallback) => {
    try {
      return JSON.parse(storage.get(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const query = new URLSearchParams(location.search);
  /**
   * 只渲染聊天视图的模式,给原生 APP 的 WebView 用。
   *
   * APP 的终端是原生实现(要逐字节渲染 PTY,WebView 做不好),聊天却正好相反 ——
   * 用原生控件复刻这边的 CSS 永远追不平,所以聊天直接嵌这张页面,
   * 两端从此是同一套实现,网页改了 APP 不必重新发包。
   */
  const embeddedChat = query.get('view') === 'chat';
  /**
   * 网页版只剩会话页这一张:
   *   /                 会话页:左栏 + 对话 + 输入卡片
   *   /?view=chat       APP 嵌的那张,同一套实现,只是铺满宿主的 WebView
   *
   * 试用版的运行中会话直接连接对应原生终端，左右侧栏、文件与历史归档继续复用。
   */

  const els = {
    shell: $('#appShell'),
    banner: $('#connectionBanner'),
    chatView: $('#chatView'),
    chatLog: $('#chatLog'),
    sidebarHistory: $('#sidebarHistory'),
    sidebarRecent: $('#sidebarRecent'),
    sidebarWorkspaces: $('#sidebarWorkspaces'),
    chatSidebar: $('#chatSidebar'),
    chatDrawerToggle: $('#chatDrawerToggle'),
    chatSidebarCollapse: $('#chatSidebarCollapse'),
    chatSearchToggle: $('#chatSearchToggle'),
    chatSearchBox: $('#chatSearchBox'),
    chatPickerScrim: $('#chatPickerScrim'),
    chatPickerList: $('#chatPickerList'),
    chatResizer: $('#chatResizer'),
    chatStatus: $('#chatStatus'),
    chatArchivedNotice: $('#chatArchivedNotice'),
    chatPickerSearch: $('#chatPickerSearch'),
    chatCurrentDot: $('#chatCurrentDot'),
    chatCurrentName: $('#chatCurrentName'),
    chatCurrentKind: $('#chatCurrentKind'),
    commandInput: $('#commandInput'),
    send: $('#sendButton'),
    slashCommands: $('#slashCommands'),
    attachButton: $('#attachButton'),
    attachInput: $('#attachInput'),
    composerError: $('#chatComposerError'),
    authDialog: $('#authDialog'),
    authForm: $('#authForm'),
    authError: $('#authError'),
    tokenInput: $('#tokenInput'),
  };

  let nativeCommands = null,
    messageEdit = null,
    composer = null,
    sessionActions = null;
  const messageEditDrafts = new Map();
  const connectionFragment = new URLSearchParams(location.hash.slice(1));
  const state = {
    namespace: basePath,
    token: nativeConnectionAuth
      ? ''
      : connectionFragment.get('token') || query.get('token') || storage.get(tokenStorageKey),
    config: null,
    prefs: UI.sanitizePrefs(loadJson('studioPrefs', null)),
    connected: false,
    snapshotReady: false,
    chatContentReady: false,
    filesOpen: false,
    filesEpoch: 0,
    chatCache: new Map(),
    fileCache: new Map(),
    previewCache: new Map(),
    attachments: {},
    drafts: {},
    settings: {},
    outbox: {},
    toolOpen: new Map(),
    toolDetails: new Map(),
    sidebarMode: 'workspace',
    selectionVersion: 0,
    sessionIds: {},
    toolRunning: new Map(),
    wakeLock: null,
    archived: null,
    archivedLoaded: '',
  };

  // 三个核心模块：HTTP 客户端、实时连接、客户端状态与同步游标。
  // 必须在这里创建 —— 页面早期就要用 api,而弹层与资料模块在装配时就接收它。
  const connectionState = window.StudioConnectionState.create({
    trace: (stage, detail) => globalThis.StudioConnectionTrace?.(stage, detail),
  });
  const httpClient = window.StudioApi.create({ basePath, deviceId, getToken: () => state.token });
  const authHeaders = (extra) => httpClient.headers(extra);
  const api = (pathname, options) => httpClient.request(pathname, options);
  const store = window.StudioStore.create(state);
  // 会话正文的本机缓存：切换时存取、预取「最近」、启动先画上次的样子（public/chat/session-cache.js）。
  const sessionCache = window.StudioSessionCache.create({
    state,
    els,
    bootKey:
      query.get('surface') === 'pane'
        ? `agentStudioBoot:${basePath}:pane:${query.get('pane')}`
        : basePath.includes('/machines/') ||
            basePath.includes('/herdr-sessions/') ||
            basePath.startsWith('/e/')
          ? `agentStudioBoot:${basePath}`
          : undefined,
    keyFor: (pane) => cacheKeyFor(pane),
    currentKey: () => chatCacheKey(),
    request: (path, options) => api(path, options),
    selectionSignal: () => selectionSignal(),
    transcriptPath: (...args) => transcriptPath(...args),
    preloadFiles: (paneId, revision) => preloadSessionFiles(revision, paneId),
    syncActive: () => sync.active(),
    captureViewport: () => chatScroll.capture(),
    archivedPath: (query) => appPath(`/api/history/transcript?${query}`),
    // 搜索框里有字时那是用户在搜，不在后台替他换掉结果。
    refreshHistory: () =>
      els.chatPickerSearch.value.trim() || sync.active() ? null : loadHistory(),
    recentPanes: (...args) => UI.recentPanes(...args),
    providerId: (pane) => UI.providerId(pane),
    filesReplaceChat: () => filesReplaceChat(),
    render: {
      picker: () => renderChatPicker(),
      status: (status) => renderChatStatus(status),
      messages: (messages, options) => renderChatMessages(messages, options),
      session: (pane) => renderSessionStatus(pane),
      contentReady: (ready) => setChatContentReady(ready),
    },
  });
  const sideSurfaces = new Map();
  function sideSurfaceKey(value = sideThreads.view()) {
    return `${state.config?.rootDirectory}:${cacheKeyFor(currentChatPane())}:${value?.sideId || 'legacy'}`;
  }
  function sideDraftPane(value = sideThreads.view()) {
    const pane = currentChatPane();
    return value?.sideId && pane
      ? {
          ...pane,
          agent: { ...pane.agent, session: { ...pane.agent.session, value: value.sideId } },
        }
      : null;
  }
  function captureSideSurface() {
    const key = sideSurfaceKey();
    const previous = sideSurfaces.get(key);
    sideSurfaces.delete(key);
    sideSurfaces.set(key, {
      paneId: state.chatPaneId,
      draft: els.commandInput.value,
      attachments: [...(state.attachments[state.chatPaneId] || [])],
      messages: state.chatContentReady
        ? (state.chatMessages || []).slice()
        : previous?.messages || null,
      viewport: state.chatContentReady ? chatScroll.capture() : previous?.viewport || null,
    });
    const cached = [...sideSurfaces.values()].filter((value) => value.messages);
    if (cached.length > 8) {
      cached[0].messages = null;
      cached[0].viewport = null;
    }
  }
  function saveChatCache() {
    if (sideThreads.active()) captureSideSurface();
    else sessionCache.save();
  }
  function persistChatBoot() {
    if (!sideThreads.active()) sessionCache.persistBoot();
  }
  function restoreChatCache() {
    if (sideThreads.active()) {
      const cached = sideSurfaces.get(sideSurfaceKey());
      state.chatMessages = cached?.messages || [];
      state.chatHasMore = false;
      setChatContentReady(Boolean(cached?.messages));
      invalidateChatRender();
      renderChatMessages(state.chatMessages);
      if (cached?.viewport) chatScroll.restorePosition(cached.viewport);
      return;
    }
    // 内存缓存里没有就退到本地副本（IndexedDB，跨启动保留，由同步推送保持最新）。
    const key = chatCacheKey();
    if (!state.chatCache.has(key)) {
      const record = replica.get(syncKeyFor(currentChatPane()));
      if (record?.messages?.length)
        state.chatCache.set(key, {
          messages: record.messages.slice(),
          status: null,
          hasMore: record.hasMore,
          viewport: null,
        });
    }
    sessionCache.restore();
  }

  /**
   * 本地优先同步（docs/LOCAL_FIRST.md）：服务端推来变化，写进本地副本；界面从副本画。
   * 同步没生效（旧服务、断线、测试夹具）时一切照旧走拉取路径。
   */
  const replica = window.StudioReplica.create({
    databaseName:
      basePath.includes('/machines/') ||
      basePath.includes('/herdr-sessions/') ||
      basePath.startsWith('/e/')
        ? `agent-studio-replica:${basePath}`
        : undefined,
    onPersistenceChange: (status) => {
      if (status.state === 'error') reportError('本机缓存未保存，当前内容保留在内存中。');
    },
  });
  let draftStorage;
  try {
    draftStorage = localStorage;
  } catch {}
  const draftStore = window.StudioDrafts.create({
    storage: draftStorage,
    namespace: basePath,
    onError: (name, operation) =>
      reportError(
        operation === 'read'
          ? '未能读取本机旧草稿，请保留当前输入。'
          : name === 'QuotaExceededError'
            ? '本机存储空间不足，草稿尚未保存，请复制备份并保留当前页面。'
            : '本机草稿存储不可用，请复制备份并保留当前页面。',
        'draft',
      ),
    onSaved: () => reportError('', 'draft'),
  });
  const startupDrafts = new Map();
  const startupDraftKey = (pane) =>
    JSON.stringify([
      state.config?.rootDirectory,
      state.herdrRuntimeId,
      pane?.paneId,
      pane?.terminalId,
    ]);
  function rememberStartupDraft(prompt) {
    const pane = currentChatPane();
    if (
      !prompt?.preSession ||
      !prompt.runtimeId ||
      pane?.agent?.session?.value ||
      pane?.terminalId !== prompt.terminalId
    )
      return;
    startupDrafts.set(startupDraftKey(pane), {
      pane: structuredClone(pane),
      process: prompt.runtimeId,
    });
    if (startupDrafts.size > 64) startupDrafts.delete(startupDrafts.keys().next().value);
  }
  function adoptStartupDraft(pane, identity) {
    const key = startupDraftKey(pane),
      previous = startupDrafts.get(key);
    if (!previous || !identity?.sessionId) return;
    if (
      previous.process !== identity.runtimeId ||
      pane.terminalId !== identity.terminalId ||
      identity.provider !== 'codex'
    ) {
      startupDrafts.delete(key);
      return;
    }
    if (nativeCommands?.active() || messageEdit?.active() || messageEdit?.busy()) return;
    startupDrafts.delete(key);
    // Keep a new session's own draft and anything typed after the transition.
    // Only a verified initialization of this same process can adopt the draft.
    if (els.commandInput.value || draftStore.get(pane)) return;
    const text = draftStore.get(previous.pane);
    if (text) {
      els.commandInput.value = text;
      saveDraft();
    }
  }
  const LAST_PANE_KEY =
    basePath.includes('/machines/') ||
    basePath.includes('/herdr-sessions/') ||
    basePath.startsWith('/e/')
      ? `studioLastPane:${basePath}`
      : 'studioLastPane';
  const rememberPane = () => {
    if (query.get('surface') === 'pane') return;
    try {
      if (state.chatPaneId) localStorage.setItem(LAST_PANE_KEY, state.chatPaneId);
    } catch {
      /* 记不住就按焦点 */
    }
  };
  const syncKeyFor = (pane) => {
    const sessionId = pane?.agent?.session?.value,
      provider = pane ? UI.providerId(pane) : '';
    return Providers.sessionKey(provider, sessionId);
  };
  const completions = UI.createCompletionTracker();
  const currentChatPane = () =>
    (state.allPanes || state.chatAgents || []).find((pane) => pane.paneId === state.chatPaneId);
  const sync = window.StudioSync.create({
    onState: (value) => connectionState.update({ sync: value }),
    replica,
    interest: () => (state.archived ? [] : [syncKeyFor(currentChatPane())].filter(Boolean)),
    send: (message) => liveSocket.send(message),
    onSnapshot: (snapshot) => {
      if (!(snapshot.panes || []).some((p) => p.paneId === state.chatPaneId))
        navigationWindow = null;
      prepareMessageEditSnapshot(snapshot);
      completions.observe(snapshot.panes || []);
      state.allPanes = snapshot.panes;
      state.chatWorkspaces = snapshot.workspaces;
      state.chatTabs = snapshot.tabs || [];
      state.chatLayouts = snapshot.layouts || [];
      state.herdrRuntimeId = snapshot.runtimeId || '';
      state.herdrVersion = snapshot.version || '';
      state.herdrProtocol = snapshot.protocol || 0;
      state.chatFocusedPaneId = snapshot.focusedPaneId;
      state.snapshotReady = true;
      if (!state.archived && !els.chatView.hidden && state.chatPaneId)
        renderSessionStatus(currentChatPane());
      reconcileNativeViewError();
      if (sync.active()) void refreshChat(true);
    },
    onSession: (key, event, record) => applySyncedSession(key, event, record),
    onFiles: (key, files) => {
      const pane = (state.allPanes || []).find((item) => syncKeyFor(item) === key);
      if (pane) filesShell.acceptSynced(pane.paneId, { ok: true, tab: 'session', files });
    },
    onHistory: (history) => applySyncedHistory(history),
    onReady: () => void refreshChat(true),
  });

  /** 推来的归档列表。用户正在归档栏里搜索时不替换他的结果。 */
  function applySyncedHistory(history) {
    if (!history || els.chatPickerSearch.value.trim()) return;
    state.historyEpoch = (state.historyEpoch || 0) + 1;
    state.historyLoading = false;
    state.historyError = '';
    state.history = history.sessions;
    state.historyNext = history.nextOffset;
    state.historyQuery = '';
    state.historyAt = Date.now();
    renderHistory();
  }

  /** 一个会话的正文变了：当前会话原地接上，其他会话更新各自的缓存（切过去时直接画）。 */
  let navigationWindow = null;
  function applySyncedSession(key, event, record) {
    if (
      navigationWindow === state.selectionVersion &&
      event.historyEpoch === state.lastChatStatus?.historyEpoch
    )
      return;
    navigationWindow = null;
    if (!state.archived && !sideThreads.active() && syncKeyFor(currentChatPane()) === key) {
      const sameEpoch =
        event.historyEpoch != null && event.historyEpoch === state.lastChatStatus?.historyEpoch;
      const index = event.replace
        ? -1
        : (state.chatMessages || []).findIndex((message) => message.id === event.after);
      const overlap =
        event.replace && sameEpoch && event.messages?.length
          ? (state.chatMessages || []).findIndex((message) => message.id === event.messages[0].id)
          : -1;
      if (overlap >= 0)
        state.chatMessages = state.chatMessages.slice(0, overlap).concat(event.messages);
      else if (index >= 0)
        state.chatMessages = state.chatMessages.slice(0, index + 1).concat(event.messages);
      else {
        // 整体替换，或本页翻出来的更早历史与变化接不上：以副本为准重来。
        state.chatMessages = record.messages.slice();
        state.chatOldestId = state.chatMessages[0]?.id || '';
        state.chatHasMore = record.hasMore;
      }
      state.chatMessages = boundLatestWindow(state.chatMessages);
      if (state.lastChatStatus) {
        state.lastChatStatus.historyRevision = event.revision;
        state.lastChatStatus.historyEpoch = event.historyEpoch;
      }
      setChatContentReady(true);
      renderChatMessages(state.chatMessages);
      return;
    }
    const pane = (state.allPanes || []).find((item) => syncKeyFor(item) === key);
    if (!pane) return;
    const cacheKey = cacheKeyFor(pane),
      cached = state.chatCache.get(cacheKey);
    if (!cached) return;
    const index = event.replace
      ? -1
      : cached.messages.findIndex((message) => message.id === event.after);
    // 接不上就丢掉内存里的这份，切过去时退到副本。
    if (index < 0) {
      state.chatCache.delete(cacheKey);
      return;
    }
    cached.messages = cached.messages.slice(0, index + 1).concat(event.messages);
    if (
      cached.viewport?.bottom !== false &&
      cached.messages.length > window.StudioSessionSync.LIMIT
    ) {
      cached.messages = cached.messages.slice(-window.StudioSessionSync.LIMIT);
      cached.hasMore = true;
    }
  }

  // A viewer following live output does not need hours of attached history.
  // Older messages remain available through the same upward pagination path.
  // Never trim while the user is reading or selecting an earlier message.
  function boundLatestWindow(messages) {
    const limit = window.StudioSessionSync.LIMIT;
    if (messages.length <= limit || !chatScroll.atBottom()) return messages;
    const retained = messages.slice(-limit);
    state.chatOldestId = retained[0].id;
    state.chatHasMore = true;
    return retained;
  }

  if (query.has('token') || connectionFragment.has('token')) {
    storage.set(tokenStorageKey, state.token);
    query.delete('token');
    const fragmentToken = connectionFragment.has('token');
    connectionFragment.delete('token');
    const fragment = fragmentToken
      ? connectionFragment.toString()
        ? `#${connectionFragment}`
        : ''
      : location.hash;
    history.replaceState(
      null,
      '',
      `${location.pathname}${query.toString() ? `?${query}` : ''}${fragment}`,
    );
  }

  // 复制走到这里就是没有 `navigator.clipboard` 可用:公网入口是明文 HTTP,
  // 而它在非安全上下文下**不存在**(localhost 例外,它算安全上下文)。
  // execCommand 必须在用户手势里同步执行,所以只能由点击处理器直接调。
  function legacyCopyText(text, { quiet = false } = {}) {
    const focused = document.activeElement;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    focused?.focus({ preventScroll: true });
    if (!copied && !quiet) reportError('复制失败，请长按选取');
    return copied;
  }

  // ---- 聊天视图 ----------------------------------------------------------
  const chatScroll = window.StudioChatScroll.create(els.chatLog);
  const composerHeight = window.StudioComposer.autoHeight(els.commandInput, {
    beforeResize: () => chatScroll.captureResize(),
    afterResize: (before) => {
      if (!filesReplaceChat()) chatScroll.followResize(before);
    },
  });
  const chatImages = window.StudioChatImages.createRenderer({
    host: els.chatLog,
    headers: () => authHeaders(),
    urlFor: (block, target) =>
      appPath(
        `/api/images?${new URLSearchParams({ pane: target.paneId, sessionId: target.sessionId, id: block.id })}`,
      ),
    preserveScroll: (update) => {
      const before = chatScroll.capture();
      update();
      chatScroll.restore(before);
    },
  });
  //
  // History comes from archives; managed Codex command output also arrives as
  // native app-server events over the authenticated WebSocket.
  // 左栏（public/nav/sidebar.js）保留 Spaces、Agents、归档三种切换和原有单行布局。
  // 它只决定显示什么、点了叫谁；右键菜单、会话切换、归档恢复都由这里注入。
  let workspaceFiles = null;
  const sidebar = StudioSidebar.create({
    state,
    els,
    UI,
    $,
    historySynced: () => sync.active() && Boolean(replica.history()),
    request: (path, options) => api(appPath(path), options),
    isDesktop: () => isDesktop(),
    chatText: (node, value) => chatText(node, value),
    renderChatMessages: (...args) => renderChatMessages(...args),
    renderSessionStatus: (pane) => renderSessionStatus(pane),
    renderStatusDot: (dot, pane) => renderStatusDot(dot, pane),
    switchToPane: (paneId) => switchToPane(paneId),
    alreadySeen: (pane) => alreadySeen(pane),
    completionUnread: (pane) => completions.unread(pane, seenDone),
    archivedKey: (session) => archivedKey(session),
    selectArchived: (session) => selectArchived(session),
    isGroupCollapsed: (id) => isGroupCollapsed(id),
    toggleGroup: (id) => toggleGroup(id),
    renderFiles: () => workspaceFiles?.showSidebar(),
  });
  const { renderNoHistoryPlaceholder, loadHistory, renderHistory, renderChatPicker } = sidebar;

  // 模型与推理档位（public/chat/agent-settings.js）：目录、当前设置、改它们的菜单。
  // 目录归模块自己缓存；`state.settings` 仍是共享的，写入走带 saving 保护的 remember。
  const agentSettings = StudioAgentSettings.create({
    state,
    els,
    UI,
    settingsStore: state.settings,
    remember: (paneId, value) => rememberSettings(paneId, value),
    openPopover: (anchor, spec) => popovers.open(anchor, spec),
    currentPopover: () => popovers.element,
    request: (path, options) => api(appPath(path), options),
    identity: () => chatCacheKey(),
    reportError: (message) => reportError(message),
    onApplied: () => {
      renderAgentActions();
      renderSessionStatus(currentChatPane());
    },
    paneOf: () => paneOf(),
    saveDraft: () => saveDraft(),
  });
  const {
    loadAgentCatalog,
    currentProvider,
    openModelPopover,
    applyAgentSettings,
    applyModelChoice,
    openEffortPopover,
    currentSettingsCatalog,
    openCurrentEffort,
    openSpeedPopover,
    openSkillsPopover,
  } = agentSettings;

  /** 长按当右键用。左栏与文件行都要它，所以留在外壳里。 */
  function bindLongPress(element, handler) {
    let timer = 0;
    let startX = 0;
    let startY = 0;
    const cancel = () => {
      clearTimeout(timer);
      timer = 0;
    };
    element.addEventListener(
      'touchstart',
      (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
        // 不震动:这是个查看菜单的动作,不是确认或出错,震一下只是打扰。
        // 按下的那一点交给菜单:长按出来的菜单同样贴着手指长出来,和右键一个规则。
        timer = setTimeout(() => {
          timer = 0;
          handler({ clientX: startX, clientY: startY });
        }, 520);
      },
      { passive: true },
    );
    element.addEventListener(
      'touchmove',
      (event) => {
        const touch = event.touches[0];
        if (!touch || !timer) return;
        // 手指移开就是在滚列表,不是长按
        if (Math.abs(touch.clientX - startX) > 8 || Math.abs(touch.clientY - startY) > 8) cancel();
      },
      { passive: true },
    );
    element.addEventListener('touchend', cancel, { passive: true });
    element.addEventListener('touchcancel', cancel, { passive: true });
  }

  /** 当前选中的那个 pane。容器与外壳都要用它，所以留在这里。 */
  const paneOf = () => (state.chatAgents || []).find((p) => p.paneId === state.chatPaneId);

  let chatTimer = 0;
  let chatLoadingMore = false;
  let chatSearchTimer = 0;

  // 聊天流的公共容器（public/chat/container.js）：原生消息列表、工具行与欢迎页。
  // 各家的消息长什么样归 renderers/，这里只管顺序、增量复用、滚动锚点与操作分发。
  // ⚠️ 依赖一律惰性引用 —— 装配点在它们的 const 之前，直接取值会撞 TDZ。
  const messageNavigation = StudioMessageNavigation.create({
    log: els.chatLog,
    scroll: chatScroll,
    readOutline: async (before) => {
      if (state.archived || sideThreads.active() || !currentChatPane()?.agent?.session?.value)
        return null;
      return api(
        transcriptPath(state.chatPaneId, currentChatPane().agent.session.value, '', false) +
          '&navigation=1' +
          (before ? '&before=' + encodeURIComponent(before) : ''),
      );
    },
    loadTarget: async (id, current) => {
      const version = state.selectionVersion,
        pane = currentChatPane();
      const result = await api(
        transcriptPath(pane.paneId, pane.agent.session.value, '', false) +
          '&around=' +
          encodeURIComponent(id) +
          '&historyEpoch=' +
          encodeURIComponent(state.lastChatStatus?.historyEpoch ?? ''),
        { signal: selectionSignal() },
      );
      if (version !== state.selectionVersion || !current()) return false;
      navigationWindow = version;
      state.chatMessages = result.messages || [];
      state.chatOldestId = state.chatMessages[0]?.id || '';
      state.chatHasMore = Boolean(result.hasMore);
      state.lastChatStatus = { ...state.lastChatStatus, ...result };
      renderChatMessages(state.chatMessages, { keepScroll: true });
      return true;
    },
    latest: () => {
      if (state.archived || sideThreads.active()) {
        chatScroll.enterLatest();
        return;
      }
      navigationWindow = null;
      const record = replica.get(syncKeyFor(currentChatPane()));
      if (record) {
        state.chatMessages = record.messages.slice();
        state.chatOldestId = state.chatMessages[0]?.id || '';
        state.chatHasMore = record.hasMore;
      }
      chatScroll.enterLatest();
      renderChatMessages(state.chatMessages);
      void refreshChat();
    },
    identity: () =>
      chatCacheKey() +
      (sideThreads.active() ? ':' + sideThreads.view()?.sideId : '') +
      ':' +
      (state.lastChatStatus?.historyEpoch ?? ''),
    hasMore: () => !state.archived && !sideThreads.active() && state.chatHasMore,
    loadEarlier: () => loadEarlierMessages(),
  });
  const chatContainer = StudioChatContainer.create({
    navigation: messageNavigation,
    state,
    els,
    UI,
    chatImages,
    scroll: chatScroll,
    paneOf: () => paneOf(),
    welcomeStatus: () => chatStatus.summary(),
    request: (path, options) =>
      api(
        appPath(
          path +
            (path.startsWith('/api/tool?') && sideThreads.active()
              ? '&sideId=' + encodeURIComponent(sideThreads.view()?.sideId || '')
              : ''),
        ),
        options,
      ),
    setAtBottom: (value) => chatScroll.setFollowing(value),
    identity: () => chatCacheKey() + (sideThreads.active() ? ':' + sideThreads.view()?.sideId : ''),
    canEditMessage: (message) =>
      message.role === 'user' &&
      currentProvider() === 'codex' &&
      !state.archived &&
      !sideThreads.active() &&
      !isTerminalPresentation(),
    canBeginEditMessage: () =>
      !messageEdit?.active() && !messageEdit?.busy() && messageEditContext().ready,
    onEditMessage: (id) => messageEdit?.editMessage(id),
    openToolFile: (path) => {
      const pane = paneOf();
      const resolved = StudioToolPresentation.resolvePath(
        path,
        state.archived?.cwd || pane?.baseCwd || pane?.cwd || state.config?.rootDirectory,
      );
      if (resolved) workspaceFiles?.open(resolved);
    },
    capMap: (map, limit) => capMap(map, limit),
    reportError: (message) => reportError(message),
    legacyCopyText: (text) => legacyCopyText(text, { quiet: true }),
    saveDraft: () => saveDraft(),
    refreshChat: (...args) => refreshChat(...args),
    renderChatPicker: () => renderChatPicker(),
    renderSessionStatus: (pane) => renderSessionStatus(pane),
  });
  // 名字保持不变，调用点一处都不用改。
  const {
    chatText,
    chatSegments,
    applyOutboxUpdate,
    setChatContentReady,
    renderChatMessages,
    reconcileChatChildren,
    tickWelcomeCaption,
    copyText,
  } = chatContainer;

  let currentGoal = null,
    goalDialog = null;
  function sizeGoalSummary() {
    const row = $('#chatGoal');
    if (row.hidden) return;
    // The text must end before the viewport's 5/8 line, including the left inset.
    const limit = Math.max(0, (window.innerWidth * 5) / 8 - row.getBoundingClientRect().left);
    row.style.setProperty('--goal-summary-limit', `${limit}px`);
  }
  const goalResize = new ResizeObserver(sizeGoalSummary);
  goalResize.observe($('#chatGoal'));
  goalResize.observe($('#chatGoal').parentElement);
  window.addEventListener('resize', sizeGoalSummary);
  function renderGoal(status) {
    const key = chatCacheKey();
    // An omitted field on a live response means a temporary read failure.
    // Explicit null clears; an empty status resets immediately on session change.
    const goal = Object.hasOwn(status, 'goal')
      ? status.goal
      : status.paneId && currentGoal?.key === key
        ? currentGoal.value
        : null;
    const valid = goal && typeof goal.objective === 'string' && typeof goal.label === 'string';
    const row = $('#chatGoal');
    row.hidden = !valid;
    if (!valid) {
      currentGoal = null;
      goalDialog?.update(key, null);
      return;
    }
    sizeGoalSummary();
    currentGoal = { key, value: goal };
    const summary = $('#chatGoalText'),
      label = $('#chatGoalState');
    if (summary.textContent !== goal.objective) summary.textContent = goal.objective;
    if (label.textContent !== goal.label) label.textContent = goal.label;
    label.dataset.status = goal.status;
    goalDialog?.update(key, goal);
  }
  $('#chatGoalSummary').addEventListener('click', () => {
    if (currentGoal) goalDialog.open(currentGoal.value);
  });

  // 原生观察只提供事实，结构化页面统一由 Swift 状态栏呈现。
  let nativeQuestionRead = null;
  const nativeDraftMoves = new Set();
  const nativeDraftKey = (pane) =>
    JSON.stringify([
      state.config?.rootDirectory,
      state.herdrRuntimeId,
      pane?.paneId,
      pane?.terminalId,
      pane?.runtimeId,
      pane?.agent?.session?.value || '',
    ]);
  const chatStatus = StudioChatStatus.create({
    nodes: {
      chatLog: els.chatLog,
      chatStatus: els.chatStatus,
      banner: els.banner,
      chatView: els.chatView,
    },
    scroll: chatScroll,
    context: () => state,
    renderGoal: (status) => renderGoal(status),
    onInteraction: () =>
      queueMicrotask(() => {
        renderSessionStatus(currentChatPane());
        void refreshNativeQuestion();
      }),
    UI,
  });
  const renderChatStatus = (status) => chatStatus.render(status);
  const presentationStorageKey = 'swiftChatPresentation';
  const defaultPresentation =
    (window.SWIFT_CHAT_PRESENTATION || document.documentElement.dataset.chatPresentation) ===
    'terminal'
      ? 'terminal'
      : 'structured';
  const readPresentation = () => {
    let value;
    try {
      value = sessionStorage.getItem(presentationStorageKey);
      if (value === 'terminal' || value === 'structured') return value;
      // Migrate the previous shared choice once into this window's storage.
      value = localStorage.getItem(presentationStorageKey);
    } catch {}
    const initial = value === 'terminal' || value === 'structured' ? value : defaultPresentation;
    try {
      sessionStorage.setItem(presentationStorageKey, initial);
    } catch {}
    return initial;
  };
  let presentation = readPresentation();
  // A side conversation uses its real native transcript. This temporary surface
  // never changes the user's saved presentation choice for the main thread.
  const mainSideAttachments = new Map();
  const sideThreads = window.StudioSideThread.create({
    entry: $('#chatSideToggle'),
    bar: $('#chatSideThread'),
    context: () => ({
      pane: currentChatPane(),
      root: state.config?.rootDirectory,
      runtimeId: state.herdrRuntimeId,
      connected: state.connected,
      archived: state.archived,
    }),
    request: (path, options) => api(appPath(path), options),
    onObserved: (value) => composer.recoverSession(value),
    onBeforeChange: () => {
      messageEdit?.cancel();
      if (sideThreads.active()) captureSideSurface();
      else {
        mainSideAttachments.set(chatCacheKey(), {
          paneId: state.chatPaneId,
          attachments: [...(state.attachments[state.chatPaneId] || [])],
        });
        state.drafts[state.chatPaneId] = els.commandInput.value;
        if (draftStore.get(currentChatPane()) !== els.commandInput.value)
          draftStore.set(currentChatPane(), els.commandInput.value);
        sessionCache.save();
      }
    },
    onFork: (value) => forkSideSession(value),
    canOptimistic: (action, value) =>
      presentation === 'structured' &&
      (action === 'main'
        ? state.chatCache.has(chatCacheKey())
        : Boolean(sideSurfaces.get(sideSurfaceKey(value))?.messages)),
    confirmClose: () =>
      openDialog({
        title: '结束临时会话',
        confirmText: '结束临时会话',
        build: (body) => {
          const p = document.createElement('p');
          p.textContent = '临时内容不会存档，结束后无法再次打开。主会话将继续保留。';
          body.append(p);
        },
        onConfirm: ({ close }) => close(true),
      }),
    onChange: (value, previous) => {
      messageEdit?.cancel();
      closeSlashCommands();
      renderAgentQuestion(null);
      renderGoal({});
      if (previous?.sideId && !value?.hasSide) {
        sideSurfaces.delete(sideSurfaceKey(previous));
        draftStore.set(sideDraftPane(previous), '');
      }
      state.responseSequence = (state.responseSequence || 0) + 1;
      if (value?.mode === 'side') {
        const cached = sideSurfaces.get(sideSurfaceKey(value));
        els.commandInput.value =
          cached?.draft ?? (sideDraftPane(value) ? draftStore.get(sideDraftPane(value)) : '');
        state.attachments[state.chatPaneId] = cached?.attachments || [];
        state.chatMessages = cached?.messages || [];
      } else {
        els.commandInput.value =
          state.drafts[state.chatPaneId] ?? draftStore.get(currentChatPane());
        const main = state.chatCache.get(chatCacheKey());
        state.attachments[state.chatPaneId] =
          mainSideAttachments.get(chatCacheKey())?.attachments || [];
        mainSideAttachments.delete(chatCacheKey());
        state.chatMessages = main?.messages || [];
      }
      renderAttachments();
      invalidateChatRender();
      setChatContentReady(false);
      restoreChatCache();
      if (!value?.structured || presentation === 'terminal') syncShellSurface();
      observeCurrentTerminal();
      void refreshChat();
    },
  });
  const isTerminalPresentation = (pane = currentChatPane()) =>
    Boolean(
      pane?.terminalId &&
      (!pane.agent ||
        (pane.paneId === state.chatPaneId &&
          sideThreads.active() &&
          !sideThreads.view()?.structured) ||
        presentation === 'terminal'),
    );
  const modeButton = $('#chatModeToggle');
  let modeIcon;
  const shellTerminal = window.StudioShellTerminal.create({
    host: $('#shellTerminal'),
    appPath,
    socketUrl,
    copyText,
    getRootDirectory: () => state.config?.rootDirectory,
    getChannelVersion: () =>
      state.config?.terminalMultiplexVersion ? 2 : state.config?.terminalChannelVersion,
    uploadClipboardFile: async (file, target) => {
      const query = new URLSearchParams({
        pane: target.paneId,
        terminalId: target.terminalId,
        runtimeId: target.runtimeId,
        sessionId: target.sessionId,
        name: file.name || 'clipboard.png',
      });
      const response = await api(appPath(`/api/attachments?${query}`), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      });
      return response.attachment;
    },
  });
  function syncShellSurface() {
    messageEdit?.sync();
    const pane = currentChatPane();
    sideThreads.render();
    const terminalMode = isTerminalPresentation(pane);
    modeButton.hidden = Boolean(
      state.archived ||
      !pane?.agent ||
      !pane?.terminalId ||
      (sideThreads.active() && !sideThreads.view()?.structured),
    );
    modeButton.setAttribute('aria-pressed', String(terminalMode));
    const modeLabel = terminalMode ? '切换到结构化模式' : '切换到终端模式';
    modeButton.setAttribute('aria-label', modeLabel);
    modeButton.title = `${modeLabel}（当前窗口所有会话）`;
    // Replacing a pressed SVG during a background refresh loses its click.
    if (modeIcon !== terminalMode)
      modeButton.innerHTML = terminalMode
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4h16v12H9l-5 4Z"/><path d="M8 8h8M8 12h5"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h5"/></svg>';
    modeIcon = terminalMode;
    const shell = Boolean(!state.archived && pane?.terminalId && isTerminalPresentation(pane));
    document.querySelector('.chat-conversation').classList.toggle('shell-pane', shell);
    shellTerminal.update(
      shell ? pane : null,
      state.herdrRuntimeId,
      shell &&
        Boolean(state.herdrRuntimeId) &&
        !document.hidden &&
        !state.settingsOpen &&
        !els.chatView.hidden,
    );
    return shell;
  }

  async function applyPresentation(value) {
    if (presentation === value) return;
    const wasTerminal = isTerminalPresentation();
    if (!wasTerminal && !state.archived) {
      messageEdit?.cancel();
      saveDraft();
      saveChatCache();
    }
    presentation = value;
    syncShellSurface();
    observeCurrentTerminal();
    if (wasTerminal && !isTerminalPresentation()) {
      setChatContentReady(false);
      restoreChatCache();
      await refreshTask;
      await refreshChat(false);
    }
  }
  modeButton.addEventListener('click', async () => {
    const pane = currentChatPane();
    if (
      !pane?.agent ||
      state.archived ||
      !pane.terminalId ||
      (sideThreads.active() && !sideThreads.view()?.structured)
    )
      return;
    const value = presentation === 'terminal' ? 'structured' : 'terminal';
    try {
      sessionStorage.setItem(presentationStorageKey, value);
    } catch {}
    await applyPresentation(value);
    if (value === 'terminal') shellTerminal.focus();
  });

  // 启动中的那行字每秒走一格。轮询是 4 秒一次，靠它推进的话数字会一跳三四秒。
  setInterval(() => {
    if (!document.hidden) tickWelcomeCaption();
  }, 1000);
  setInterval(() => {
    if (!document.hidden && !state.settingsOpen && isTerminalPresentation())
      void sideThreads.refresh();
  }, 1200);

  let refreshTask = null;
  /**
   * 归档会话的只读视图。
   *
   * 选中就能翻看过往记录，**但发不了消息** —— 那个会话已经停机了，要说话得先恢复
   * （右键 → 恢复）。所以这里只取正文，不碰状态行、提问、goal 和发送队列。
   *
   * 存档不会再变，所以同一条只取一次；轮询照常跑过来，但不重复拉。
   */
  async function performRefreshArchived() {
    const archived = state.archived;
    const version = state.selectionVersion;
    renderSessionStatus(null);
    renderArchivedNotice(archived);
    renderChatPicker();
    if (state.archivedLoaded === archivedKey(archived)) return;
    preloadSessionFiles(undefined, `archived:${archivedKey(archived)}`);
    try {
      const query = new URLSearchParams({
        provider: archived.provider,
        sessionId: archived.sessionId,
        limit: '60',
      });
      // 后台已经取好的直接画：归档不会再变。
      const result =
        sessionCache.archived(archivedKey(archived)) ||
        (await api(appPath(`/api/history/transcript?${query}`), { signal: selectionSignal() }));
      if (version !== state.selectionVersion) return;
      sessionCache.archived(archivedKey(archived), result);
      reportError('', 'history');
      state.archivedLoaded = archivedKey(archived);
      state.chatMessages = result.messages || [];
      state.chatOldestId = state.chatMessages[0]?.id || '';
      state.chatHasMore = Boolean(result.hasMore);
      setChatContentReady(true);
      renderChatMessages(state.chatMessages);
    } catch (error) {
      if (version !== state.selectionVersion) return;
      setChatContentReady(true);
      renderChatMessages([]);
      reportError(error.message, 'history');
    }
  }

  const archivedKey = (archived) => `${archived.provider}:${archived.sessionId}`;

  // 「电脑」的判据是**宽屏且有鼠标**，不是只看宽度 —— 1024 的触摸平板同样宽，
  // 却没有实体键盘和悬停，那里的手势是长按而不是右键。
  const isDesktop = () =>
    matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)').matches;

  function renderArchivedNotice(archived) {
    const box = els.chatArchivedNotice;
    box.hidden = !archived;
    box.replaceChildren();
    if (!archived) return;
    const strong = document.createElement('strong');
    strong.textContent = '这个会话已归档';
    box.append(
      strong,
      document.createTextNode('，只能查看。要继续此会话，请进入 Herdr 终端，在原生 Agent 中恢复。'),
    );
    els.chatStatus.hidden = false;
  }

  /** 选中归档里的一条：进只读视图，不影响当前活着的会话。 */
  function selectArchived(session) {
    workspaceFiles?.close(false);
    messageEdit?.cancel();
    closePopover();
    saveDraft();
    saveChatCache();
    setFilesPage(false);
    state.archived = {
      provider: session.provider,
      sessionId: session.sessionId,
      title: session.title || '',
      cwd: session.cwd || '',
    };
    state.chatPaneId = '';
    syncShellSurface();
    state.selectionVersion += 1;
    state.archivedLoaded = '';
    dropLoadedHistory();
    els.commandInput.value = '';
    els.chatLog.dataset.paneId = `archived:${archivedKey(state.archived)}`;
    invalidateChatRender();
    setChatContentReady(false);
    chatStatus.reset();
    renderChatStatus({});
    renderAgentQuestion(null);
    renderAgentStartup(null);
    renderGoal({});
    renderChatMessages([]);
    renderAgentActions();
    setChatDrawerOpen(false);
    void refreshChat();
  }

  /** 回到活着的会话：只读视图的痕迹要一次清干净，否则状态行会挂着归档那条说明。 */
  function leaveArchived() {
    if (!state.archived) return;
    state.archived = null;
    state.archivedLoaded = '';
    renderArchivedNotice(null);
  }

  /**
   * 当前选中的会话的请求都挂在这个 signal 上；换了会话，上一个会话还没回来的请求一律中止。
   * 只丢弃结果是不够的：它们还占着 WebView 对同一站点的连接，接着要发的正文与文件列表只能排队，
   * 扫码版每条连接还多一层中转（2026-09-25 连接回归排查，快速切换时文件列表要等一两秒）。
   */
  let selectionAbort = { version: -1, controller: null };
  function selectionSignal() {
    if (selectionAbort.version !== state.selectionVersion) {
      selectionAbort.controller?.abort();
      selectionAbort = { version: state.selectionVersion, controller: new AbortController() };
    }
    return selectionAbort.controller.signal;
  }

  function refreshChat(useKnownSnapshot = false) {
    const version = state.selectionVersion;
    if (refreshTask?.version === version) {
      refreshTask.again = true;
      return refreshTask.promise;
    }
    const task = { version };
    task.promise = performRefreshChat(useKnownSnapshot).finally(() => {
      if (refreshTask === task) {
        refreshTask = null;
        if (task.again && task.version === state.selectionVersion) void refreshChat();
      }
    });
    refreshTask = task;
    return task.promise;
  }

  /**
   * 正文接口的地址。
   *
   * 先确认 snapshot 身份，再并行读取存档正文与原生控制状态。
   * 两个响应分别检查会话身份；慢状态不会阻塞已取得的正文。
   */
  const transcriptPath = (paneId, sessionId, from, withState = false) =>
    appPath(
      `/api/transcript?pane=${encodeURIComponent(paneId)}&limit=60&state=${withState ? '1' : '0&terminal=0'}` +
        `&sessionId=${encodeURIComponent(sessionId || '')}&from=${encodeURIComponent(from || '')}`,
    );
  const controlRequests = new Map();
  function readControlSnapshot(pane, sessionId, signal) {
    const path = transcriptPath(pane.paneId, sessionId, '', true) + '&window=0';
    const key = JSON.stringify([path, state.herdrRuntimeId, pane.terminalId, pane.runtimeId]);
    const active = controlRequests.get(key);
    if (active && !active.signal.aborted) return active.promise;
    const entry = { signal };
    entry.promise = api(path, { signal }).finally(() => {
      if (controlRequests.get(key) === entry) controlRequests.delete(key);
    });
    controlRequests.set(key, entry);
    return entry.promise;
  }

  async function performRefreshChat(useKnownSnapshot = false) {
    if (navigationWindow === state.selectionVersion) return;
    navigationWindow = null;
    if (els.chatView.hidden) return;
    // 选中的是归档里的一条：它已经停机，没有 pane、没有状态行、没有发送队列。
    // 这些都以「有一个活着的 pane」为前提，走主路径只会一路拿空值。
    if (state.archived) return performRefreshArchived();
    const requestedAt = Date.now();
    const version = state.selectionVersion;
    const signal = selectionSignal();
    let stillCurrent = () => version === state.selectionVersion;
    try {
      const alignNativeFocus = canViewNative() && (!nativeViewReady || adoptNativeOnRefresh);
      const forceNativeSnapshot = nativeFocusRefresh;
      const snapshot =
        !alignNativeFocus &&
        !forceNativeSnapshot &&
        (useKnownSnapshot || sync.active()) &&
        state.snapshotReady
          ? {
              panes: state.allPanes || state.chatAgents,
              workspaces: state.chatWorkspaces,
              focusedPaneId: state.chatFocusedPaneId,
              tabs: state.chatTabs,
              layouts: state.chatLayouts,
              runtimeId: state.herdrRuntimeId,
              version: state.herdrVersion,
              protocol: state.herdrProtocol,
            }
          : await api(appPath('/api/snapshot'), { signal });
      if (version !== state.selectionVersion) return;
      if (forceNativeSnapshot) nativeFocusRefresh = false;
      if (snapshot.rootDirectory && snapshot.rootDirectory !== state.config?.rootDirectory) {
        applyRootDirectory(snapshot.rootDirectory, snapshot.settings);
        return;
      }
      if (snapshot.settings) applyRootSettings(snapshot.settings);
      // All panes and empty workspaces follow the Herdr snapshot.
      state.snapshotReady = true;
      prepareMessageEditSnapshot(snapshot);
      state.allPanes = snapshot.panes || [];
      completions.observe(state.allPanes);
      const panes = state.allPanes;
      const withTranscript = (pane) =>
        Boolean(pane.agent && Providers.get(UI.providerId(pane)).history);
      const readable = panes;
      if (!state.chatPaneId || !panes.some((pane) => pane.paneId === state.chatPaneId)) {
        setFilesPage(false);
        renderAgentQuestion(null);
        setChatContentReady(false);
        state.chatMessages = [];
        const requestedPane = new URLSearchParams(location.search).get('pane');
        let lastPane = '';
        try {
          lastPane = localStorage.getItem(LAST_PANE_KEY) || '';
        } catch {
          /* 无本机记录时使用原生焦点。 */
        }
        state.chatPaneId =
          query.get('surface') === 'pane' && requestedPane
            ? requestedPane
            : [requestedPane, lastPane, snapshot.focusedPaneId].find((id) =>
                readable.some((pane) => pane.paneId === id),
              ) ||
              readable[0]?.paneId ||
              '';
        renderAttachments();
      }
      const selected = panes.find((p) => p.paneId === state.chatPaneId);
      if (
        !selected ||
        UI.providerId(selected) !== 'claude' ||
        UI.statusKind(selected) !== 'blocked'
      )
        renderAgentStartup(null);
      const sessionId = selected?.agent?.session?.value || '';
      if (state.sessionIds[state.chatPaneId] && state.sessionIds[state.chatPaneId] !== sessionId) {
        setFilesPage(false);
        renderAgentQuestion(null);
        setChatContentReady(false);
        dropLoadedHistory();
        // pane 还在、只是换了会话身份：随身状态全部作废，但 sessionIds 留给紧接着的那一行改写。
        forgetPane(state.chatPaneId, { keepIdentity: true });
        renderAttachments();
        els.commandInput.value = '';
        invalidateChatRender();
        renderChatMessages([]);
      }
      state.sessionIds[state.chatPaneId] = sessionId;
      // Restore this native thread's draft after clearing the previous thread's
      // pane state; otherwise returning to an existing thread erases its draft.
      const identity = window.StudioDrafts.identity(currentChatPane());
      if (identity && state.composerIdentity !== identity) {
        draftStore.load(state.config?.rootDirectory);
        els.commandInput.value = draftStore.get(currentChatPane());
        state.drafts[state.chatPaneId] = els.commandInput.value;
        state.composerIdentity = identity;
        restoreMessageEditDraft();
      }
      state.chatAgents = panes;
      if (currentGoal && currentGoal.key !== chatCacheKey()) renderGoal({});
      state.chatWorkspaces = snapshot.workspaces || [];
      state.chatTabs = snapshot.tabs || [];
      state.chatLayouts = snapshot.layouts || [];
      state.herdrRuntimeId = snapshot.runtimeId || '';
      state.herdrVersion = snapshot.version || '';
      state.herdrProtocol = snapshot.protocol || 0;
      reconcileNativeViewError();
      if (!state.chatContentReady) renderChatMessages([]);
      state.chatFocusedPaneId = snapshot.focusedPaneId || '';
      if (alignNativeFocus && canViewNative()) {
        const returning = adoptNativeOnRefresh;
        const adopt = adoptNativeOnRefresh || !new URLSearchParams(location.search).get('pane');
        nativeViewReady = true;
        adoptNativeOnRefresh = false;
        if (
          adopt &&
          panes.some((p) => p.paneId === snapshot.focusedPaneId) &&
          snapshot.focusedPaneId !== state.chatPaneId
        ) {
          switchToPane(snapshot.focusedPaneId, { native: true, observeOnly: returning });
          return;
        }
        if (!returning) viewNativePane();
      }
      // 实时状态观察的是选中会话自己的终端，与终端焦点无关（见 observeCurrentTerminal）。
      observeCurrentTerminal();
      renderChatPicker();
      renderAgentActions();
      void sideThreads.refresh();
      const shellSurface = syncShellSurface();
      if (shellSurface) {
        reportError('', 'history');
        setChatContentReady(true);
        renderChatStatus({});
        return;
      }
      if (!state.chatPaneId) {
        reportError('', 'history');
        setChatContentReady(true);
        return renderChatMessages([]);
      }
      if (sideThreads.active() && sideThreads.view()?.structured) {
        const sideId = sideThreads.view().sideId,
          pane = currentChatPane();
        stillCurrent = () =>
          version === state.selectionVersion &&
          sideThreads.active() &&
          sideThreads.view()?.sideId === sideId;
        const result = await api(
          appPath(`/api/agents/side?pane=${encodeURIComponent(pane.paneId)}&transcript=1`),
          { signal },
        );
        if (
          version !== state.selectionVersion ||
          !sideThreads.active() ||
          sideThreads.view()?.sideId !== sideId ||
          result.sideId !== sideId
        )
          return;
        state.chatMessages = result.messages || [];
        state.chatHasMore = false;
        reportError('', 'history');
        setChatContentReady(true);
        renderChatMessages(state.chatMessages);
        saveChatCache();
        const controls = await readControlSnapshot(pane, pane.agent.session.value, signal);
        if (
          version === state.selectionVersion &&
          sideThreads.active() &&
          sideThreads.view()?.sideId === sideId
        )
          renderChatStatus({ ...controls, goal: null });
        return;
      }

      // 选中的是个还没有 agent 的标签页:没有对话可显示,给出下一步而不是一片空白。
      if (!panes.some((pane) => pane.paneId === state.chatPaneId && withTranscript(pane))) {
        reportError('', 'history');
        setChatContentReady(true);
        renderChatStatus({});
        return renderNoHistoryPlaceholder(panes.find((pane) => pane.paneId === state.chatPaneId));
      }
      if (els.chatLog.dataset.paneId !== state.chatPaneId) {
        // 换了会话:已加载的历史、最早位置和「还有更早」都属于上一个会话,全部作废
        els.chatLog.dataset.paneId = state.chatPaneId;
        dropLoadedHistory();
      }
      // 正文还没画（刚启动、刚改选）：副本或缓存里有就先画，不等下面的请求。
      if (!state.chatContentReady) restoreChatCache();
      const paneId = state.chatPaneId;
      sync.watch();
      // 文件页的列表与正文同时取，滑过去时已经在了。
      preloadSessionFiles();
      const extras = () =>
        Promise.all([
          api(appPath(`/api/agent-settings?pane=${encodeURIComponent(paneId)}`), { signal }).catch(
            () => null,
          ),
          UI.providerId(selected) === 'claude' && UI.statusKind(selected) === 'blocked'
            ? api(appPath(`/api/agents/startup?pane=${encodeURIComponent(paneId)}`), {
                signal,
              }).catch(() => null)
            : null,
          api(appPath(`/api/agents/questions?pane=${encodeURIComponent(paneId)}`), {
            signal,
          }).catch(() => undefined),
        ]);
      // 同步生效且本地副本有这个会话：正文由推送保持最新，这里只取状态部分。
      const syncKey = syncKeyFor(selected),
        synced = syncKey && sync.active() ? replica.get(syncKey) : null;
      const windowless = Boolean(synced && state.chatContentReady);
      const responseSequence = (state.responseSequence = (state.responseSequence || 0) + 1);
      const settingsRevision = agentSettings.revision();
      let latestControls = null;
      const responseTarget = {
        root: state.config?.rootDirectory,
        runtime: state.herdrRuntimeId,
        terminal: selected.terminalId,
        process: selected.runtimeId,
      };
      const currentResponse = () =>
        responseSequence === state.responseSequence &&
        version === state.selectionVersion &&
        state.config?.rootDirectory === responseTarget.root &&
        state.herdrRuntimeId === responseTarget.runtime &&
        paneId === state.chatPaneId &&
        currentChatPane()?.terminalId === responseTarget.terminal &&
        currentChatPane()?.runtimeId === responseTarget.process &&
        (currentChatPane()?.agent?.session?.value || '') === sessionId;
      stillCurrent = currentResponse;
      const matchesResponse = (data) =>
        !data.identity ||
        (data.identity.paneId === paneId &&
          data.identity.terminalId === responseTarget.terminal &&
          (data.identity.sessionId || '') === sessionId &&
          (!responseTarget.process || data.identity.runtimeId === responseTarget.process));
      void readControlSnapshot(selected, sessionId, signal)
        .then(async (data) => {
          if (!data.binding) {
            const [[settings, startup, question], queue] = await Promise.all([
              extras(),
              api(appPath(`/api/messages?pane=${encodeURIComponent(paneId)}`), { signal }),
            ]);
            data = {
              ...data,
              settings,
              startup: startup?.startup,
              ...(question !== undefined ? { question: question.question } : {}),
              outbox: queue.messages,
            };
          }
          if (!currentResponse() || (data.sessionId && data.sessionId !== sessionId)) return;
          if (!matchesResponse(data)) {
            nativeFocusRefresh = true;
            return;
          }
          adoptStartupDraft(selected, data.identity);
          const {
            messages,
            historyRevision,
            historyEpoch,
            total,
            hasMore,
            replace,
            windowless,
            ...controls
          } = data;
          latestControls = controls;
          state.lastChatStatus = { ...state.lastChatStatus, ...controls };
          renderChatStatus(state.lastChatStatus);
          renderAgentStartup(controls.startup || null);
          if (Object.hasOwn(controls, 'question')) renderAgentQuestion(controls.question || null);
          else if (currentQuestion && (currentQuestion.queued || currentQuestion.nativeModal))
            renderAgentQuestion({ ...currentQuestion, observation: 'stale' });
          if (settingsRevision === agentSettings.revision())
            rememberSettings(paneId, controls.settings);
          const local = (state.outbox[paneId] || []).filter(
            (item) =>
              ['submitting', 'uncertain', 'failed'].includes(item.status) ||
              new Date(item.createdAt).getTime() >= requestedAt,
          );
          if (controls.outbox)
            state.outbox[paneId] = [
              ...controls.outbox.map((item) =>
                applyOutboxUpdate(
                  (state.outbox[paneId] || []).find((old) => old.id === item.id) || {},
                  item,
                ),
              ),
              ...local.filter((item) => !controls.outbox.some((receipt) => receipt.id === item.id)),
            ];
          renderAgentActions();
          renderSessionStatus(selected);
        })
        .catch(() => {
          if (
            currentResponse() &&
            currentQuestion &&
            (currentQuestion.queued || currentQuestion.nativeModal)
          )
            renderAgentQuestion({ ...currentQuestion, observation: 'stale' });
        });
      const result = await api(
        transcriptPath(paneId, sessionId, state.chatMessages[0]?.id) +
          (windowless ? '&window=0' : ''),
        { signal },
      );
      if (result.sessionId && result.sessionId !== sessionId) return;
      if (!currentResponse()) return;
      if (!matchesResponse(result)) {
        nativeFocusRefresh = true;
        return;
      }
      reportError('', 'history');
      setChatContentReady(true);
      renderAgentActions();
      if (!result.supported) {
        renderChatStatus(result);
        els.chatLog.dataset.signature = '';
        const note = els.chatLog.querySelector('.chat-unavailable') || document.createElement('p');
        note.className = 'chat-empty chat-unavailable';
        note.textContent = result.reason || '暂时无法读取会话记录。';
        reconcileChatChildren([note, els.chatStatus]);
        return;
      }
      // 轮询拿的是最近一段,而用户可能已经往回翻出了更早的历史 —— 整体替换会把
      // 翻出来的内容冲掉。按 id 合并:已有的留着,只把新出现的追加到末尾。
      state.lastChatStatus = { ...result, ...latestControls };
      renderChatStatus(state.lastChatStatus);
      const fresh = result.messages || [];
      const incoming = result.windowless
        ? state.chatMessages || []
        : result.replace
          ? fresh
          : mergeMessages(state.chatMessages || [], fresh);
      const merged = result.windowless ? incoming : boundLatestWindow(incoming);
      state.chatMessages = merged;
      if (!result.windowless && (result.replace || !state.chatOldestId)) {
        state.chatOldestId = merged[0]?.id || '';
        state.chatHasMore = Boolean(result.hasMore) || merged.length < incoming.length;
      }
      if (syncKey && !result.windowless && result.historyRevision) {
        // 拉取路径拿到的是这个版本的末尾一段：记进副本，之后推来的变化就能接上。
        replica.put(syncKey, {
          revision: result.historyRevision,
          messages: merged,
          hasMore: state.chatHasMore,
          lastMessageAt: Number(selected?.lastMessageAt) || 0,
        });
      } else if (
        result.windowless &&
        synced &&
        result.historyRevision &&
        result.historyRevision !== replica.get(syncKey)?.revision
      ) {
        // 服务端已经是新版本、推送却没到：稍等一轮，仍对不上就重新追平这个会话。
        const pending = state.revisionLag;
        if (
          pending?.key === syncKey &&
          pending.revision === result.historyRevision &&
          Date.now() - pending.at > 3000
        ) {
          state.revisionLag = null;
          sync.resync(syncKey);
        } else if (pending?.key !== syncKey || pending.revision !== result.historyRevision)
          state.revisionLag = { key: syncKey, revision: result.historyRevision, at: Date.now() };
      }
      renderChatMessages(merged);
      saveChatCache();
      refreshSessionFiles();
      preloadSessionFiles(`${merged.length}:${merged.at(-1)?.id || ''}`);
      // 同步生效时其他会话由推送保持最新，不再预取。
      if (!sync.active()) sessionCache.schedulePrefetch();
    } catch (error) {
      if (!stillCurrent()) return;
      reportError(error.message || '读取对话失败', 'history');
    }
  }

  function mergeMessages(existing, fresh) {
    if (!fresh.length) return existing;
    const first = existing.findIndex((m) => m.id === fresh[0].id);
    if (first >= 0) return [...existing.slice(0, first), ...fresh];
    return [...existing, ...fresh];
  }

  /**
   * 往回翻一页。响应到达时捕获当前消息锚点，插入后恢复阅读位置，
   * 不使用请求开始时的几何，避免网络等待期间的滚动被覆盖。
   */
  async function loadEarlierMessages() {
    if (
      sideThreads.active() ||
      chatLoadingMore ||
      !state.chatHasMore ||
      !state.chatOldestId ||
      !state.chatPaneId
    )
      return;
    chatLoadingMore = true;
    const log = els.chatLog;
    try {
      const paneId = state.chatPaneId,
        version = state.selectionVersion,
        revision = state.lastChatStatus?.historyRevision,
        historyEpoch = state.lastChatStatus?.historyEpoch;
      const result = await api(
        appPath(
          `/api/transcript?pane=${encodeURIComponent(paneId)}` +
            `&limit=40&binding=${encodeURIComponent(state.lastChatStatus?.binding || '')}&before=${encodeURIComponent(state.chatOldestId)}&revision=${encodeURIComponent(revision || '')}` +
            (historyEpoch == null ? '' : `&historyEpoch=${encodeURIComponent(historyEpoch)}`),
        ),
      );
      if (
        paneId !== state.chatPaneId ||
        version !== state.selectionVersion ||
        (historyEpoch == null
          ? revision !== state.lastChatStatus?.historyRevision
          : historyEpoch !== state.lastChatStatus?.historyEpoch)
      )
        return;
      const earlier = result.supported ? result.messages || [] : [];
      if (!earlier.length) {
        state.chatHasMore = false;
        return;
      }
      state.chatMessages = [...earlier, ...(state.chatMessages || [])];
      state.chatOldestId = earlier[0].id;
      state.chatHasMore = Boolean(result.hasMore);
      const position = chatScroll.capture();
      log.dataset.signature = '';
      renderChatMessages(state.chatMessages, { keepScroll: true });
      chatScroll.restore(position, { duringGesture: true });
    } catch (error) {
      if (error.code === 'HISTORY_CHANGED') void refreshChat();
      else reportError(error.message || '加载更早的对话失败');
    } finally {
      chatLoadingMore = false;
    }
  }

  els.chatLog.addEventListener(
    'scroll',
    () => {
      if (els.chatLog.scrollTop < 140) loadEarlierMessages();
    },
    { passive: true },
  );

  // ---- 聊天页自己的对话框 -------------------------------------------------
  // 浏览器原生的 prompt/confirm 与这套配色完全不搭,而且在手机上是系统弹窗,
  // 样子各家不一。这里用同一个 <dialog> 壳,内容按用途现搭。
  const dialogs = window.StudioDialogs.create({ api, appPath });
  const {
    elements: dlg,
    close: closeDialog,
    open: openDialog,
    askLongText,
    askDirectory,
  } = dialogs;
  goalDialog = StudioGoalDialog.create({
    dialogs,
    identity: () => chatCacheKey(),
    target: () => {
      const pane = currentChatPane();
      return !messageEdit?.active() &&
        !messageEdit?.busy() &&
        currentProvider() === 'codex' &&
        !state.archived &&
        state.connected &&
        pane
        ? {
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            sessionId: pane.agent?.session?.value || '',
            runtimeId: state.herdrRuntimeId,
          }
        : null;
    },
    request: (suffix, options) => api(appPath('/api/agents/goal' + suffix), options),
    refresh: () => refreshChat(false),
  });
  state.herdrShell = window.StudioHerdrShell.create({
    state,
    interrupt: (value) => sessionActions?.interrupt(value),
    showSessionStatus: (anchor) => statusBar.showDetails(anchor),
    request: (path, options) => api(appPath(path), options),
    switchToPane,
    refresh: () => refreshChat(false),
    renderSidebar: renderChatPicker,
    dialogs,
    popovers: {
      open: (...args) => popovers.open(...args),
      close: () => popovers.close(),
      get element() {
        return popovers.element;
      },
    },
    reportError,
    closeNavigation: () => setChatDrawerOpen(false),
    openNavigation: () => setChatDrawerOpen(true),
    closeFiles: () => setFilesPage(false),
    openFiles: () => setFilesPage(!state.filesOpen),
    openSettings: () => openDeviceSettings(),
    closeSettings: () => closeDeviceSettings(),
    toggleNavigation: () => els.chatDrawerToggle.click(),
    copyText,
  });

  // Settings occupy the same main region as chat; the chat DOM and draft stay mounted.
  const deviceTheme = window.StudioDeviceTheme;
  $('#chatDeviceSettings').addEventListener('click', () => openDeviceSettings());
  let cleanupSettings = null,
    settingsReturnFocus = null,
    settingsScroll = null,
    settingsCategory = null;
  $('#settingsBack').addEventListener('click', () => {
    if (settingsCategory) settingsShowList?.();
    else closeDeviceSettings();
  });
  let settingsShowList = null;
  function closeDeviceSettings(restoreFocus = true) {
    if (!state.settingsOpen) return;
    state.settingsOpen = false;
    syncShellSurface();
    cleanupSettings?.();
    cleanupSettings = null;
    $('#settingsPage').hidden = true;
    els.chatView.classList.remove('settings-open');
    $('#chatDeviceSettings').removeAttribute('aria-current');
    if (
      settingsScroll?.pane === state.chatPaneId &&
      settingsScroll.root === state.config?.rootDirectory
    ) {
      chatScroll.restorePosition(settingsScroll.viewport);
    }
    if (restoreFocus) {
      const target = settingsReturnFocus?.getClientRects().length
        ? settingsReturnFocus
        : $('#chatDrawerToggle');
      target?.focus({ preventScroll: true });
    }
  }
  if (query.get('surface') !== 'pane')
    window.StudioHerdrContext.create({ state, api, basePath, renderSidebar: renderChatPicker });
  function openDeviceSettings() {
    workspaceFiles?.close(false);
    if (state.settingsOpen) return;
    settingsReturnFocus = document.activeElement;
    closePopover();
    closeSlashCommands();
    setFilesPage(false);
    setChatDrawerOpen(false);
    settingsScroll = {
      pane: state.chatPaneId,
      root: state.config?.rootDirectory,
      top: els.chatLog.scrollTop,
      viewport: chatScroll.capture(),
    };
    state.settingsOpen = true;
    syncShellSurface();
    els.chatView.classList.add('settings-open');
    $('#chatDeviceSettings').setAttribute('aria-current', 'page');
    const page = $('#settingsPage'),
      body = $('#settingsBody');
    body.replaceChildren();
    page.hidden = false;
    page.scrollTop = 0;
    settingsCategory = null;
    $('#settingsTitle').focus({ preventScroll: true });
    const nav = page.querySelector('.settings-nav'),
      tabs = [...nav.querySelectorAll('[data-settings-category]')];
    const title = $('#settingsTitle'),
      back = $('#settingsBack');
    const panels = tabs.map((tab) => {
      const panel = document.createElement('section');
      panel.id = tab.getAttribute('aria-controls');
      panel.className = 'settings-panel';
      panel.setAttribute('aria-label', tab.querySelector('.settings-row-title').textContent);
      panel.tabIndex = -1;
      panel.hidden = true;
      body.append(panel);
      return panel;
    });
    const panelsByCategory = Object.fromEntries(
      tabs.map((tab, index) => [tab.dataset.settingsCategory, panels[index]]),
    );
    const {
      appearance: appearancePanel,
      font: fontPanel,
      terminal: terminalPanel,
      connection: connectionPanel,
      update: updatePanel,
    } = panelsByCategory;
    const cleanupClientUpdates = window.StudioDesktopConnections?.buildUpdates
      ? window.StudioDesktopConnections.buildUpdates(updatePanel)
      : (() => {
          const p = document.createElement('p');
          p.textContent = '此客户端的网页界面随服务器更新。请在服务器设置中检查更新。';
          updatePanel.append(p);
          return () => {};
        })();
    appearancePanel.innerHTML =
      '<header class="settings-panel-head"><p>为 Swift 选择适合你的界面配色。</p></header>';
    let listScroll = 0;
    const summaries = Object.fromEntries(
      [...nav.querySelectorAll('[data-settings-value]')].map((node) => [
        node.dataset.settingsValue,
        node,
      ]),
    );
    function updateSummaries() {
      summaries.appearance.textContent = deviceTheme.current().label;
      summaries.font.textContent = `${window.StudioDeviceFont.current()} px`;
      const terminalSize = window.StudioTerminalFont.current();
      summaries.terminal.textContent = `${terminalSize || window.StudioTerminalFont.defaultSize()} px`;
    }
    function selectCategory(tab) {
      listScroll = page.scrollTop;
      settingsCategory = tab.dataset.settingsCategory;
      nav.hidden = true;
      body.hidden = false;
      for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
      title.textContent = tab.querySelector('.settings-row-title').textContent;
      back.setAttribute('aria-label', '返回设置');
      back.title = '返回设置';
      page.scrollTop = 0;
      title.focus({ preventScroll: true });
    }
    settingsShowList = (restoreFocus = true) => {
      const previous = tabs.find((tab) => tab.dataset.settingsCategory === settingsCategory);
      settingsCategory = null;
      nav.hidden = false;
      body.hidden = true;
      for (const panel of panels) panel.hidden = true;
      title.textContent = '设置';
      back.setAttribute('aria-label', '返回会话');
      back.title = '返回会话';
      updateSummaries();
      page.scrollTop = listScroll;
      if (restoreFocus) previous?.focus({ preventScroll: true });
    };
    const onCategoryClick = (event) => {
      const tab = event.target.closest('[data-settings-category]');
      if (tab && nav.contains(tab)) selectCategory(tab);
    };
    nav.addEventListener('click', onCategoryClick);
    settingsShowList(false);
    if (window.StudioDesktopConnections)
      window.StudioDesktopConnections.chooseDirectory = (profile, start) =>
        askDirectory({
          title: '根目录',
          start,
          request: window.StudioDesktopConnections.request,
          resolvePath: (suffix) => `/e/${profile.id}${suffix}`,
        });
    if (window.StudioDesktopConnections)
      window.StudioDesktopConnections.saveRoot = async (profile, rootDirectory) => {
        const current = location.pathname.startsWith(`/e/${profile.id}/`);
        if (current) await flushRootSettings();
        const config = await api(`/e/${profile.id}/api/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rootDirectory }),
        });
        if (current) applyRootDirectory(config.rootDirectory, config.settings);
        return config;
      };
    const cleanupConnection = window.StudioDesktopConnections
      ? window.StudioDesktopConnections.buildSettings(connectionPanel)
      : (() => {
          const title = document.createElement('h3'),
            p = document.createElement('p');
          title.textContent = '服务器';
          p.textContent =
            '开源版使用服务器与客户端直连。在服务器执行 swift，复制连接链接到客户端。';
          connectionPanel.append(title, p);
          return () => {};
        })();
    // Connection builders also serve onboarding, so promote only the settings heading here.
    buildConnectionDiagnostics(connectionPanel);
    const connectionTitle = connectionPanel.querySelector('h3'),
      connectionHeading = document.createElement('h2');
    connectionHeading.textContent = connectionTitle?.textContent || '服务器';
    connectionHeading.className = 'settings-section-title';
    if (connectionTitle) connectionTitle.replaceWith(connectionHeading);
    else connectionPanel.prepend(connectionHeading);
    const cleanupServerUpdates = !window.StudioDesktopConnections
      ? window.StudioServerUpdates.mount(connectionPanel, {
          request: api,
          path: appPath,
          version: state.config?.version,
        })
      : () => {};
    const section = document.createElement('section');
    section.className = 'device-color-settings device-settings-section';
    section.innerHTML =
      '<h3 id="deviceColorTitle">主题</h3><p>选择适合你的界面配色。</p><div class="device-theme-options" role="radiogroup" aria-labelledby="deviceColorTitle"></div>';
    const group = section.querySelector('.device-theme-options');
    for (const palette of deviceTheme.palettes) {
      const label = document.createElement('label');
      label.className = 'device-theme-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'deviceTheme';
      input.value = palette.id;
      input.addEventListener('change', () => {
        if (input.checked) deviceTheme.apply(palette.id);
      });
      const preview = document.createElement('span');
      preview.className = 'device-theme-preview';
      preview.setAttribute('aria-hidden', 'true');
      for (const [key, value] of Object.entries(palette.colors))
        preview.style.setProperty(`--${key}`, value);
      preview.innerHTML =
        '<i class="theme-preview-sidebar"></i><i class="theme-preview-text"></i><i class="theme-preview-bubble"></i><i class="theme-preview-input"></i>';
      const caption = document.createElement('span');
      caption.className = 'device-theme-caption';
      caption.textContent = palette.label;
      label.append(input, preview, caption);
      group.append(label);
    }
    function updateSelection() {
      for (const input of group.querySelectorAll('input'))
        input.checked = input.value === deviceTheme.current().id;
      updateSummaries();
    }
    updateSelection();
    window.addEventListener('herdr:themechange', updateSelection);
    appearancePanel.append(section);
    const font = document.createElement('section');
    font.className = 'device-settings-section';
    font.innerHTML =
      '<div class="device-font-label"><div><h3><label for="deviceFontSize">界面基准字号</label></h3><p id="deviceFontDescription">调整导航和控件的字号，聊天与文档正文按比例放大。</p></div><output id="deviceFontValue" for="deviceFontSize"></output></div><div class="device-font-controls"><input id="deviceFontSize" type="range" min="12" max="20" step="1" aria-describedby="deviceFontDescription"><button id="deviceFontReset" type="button">恢复默认</button></div>';
    const slider = font.querySelector('input'),
      value = font.querySelector('output');
    function updateFont() {
      slider.value = window.StudioDeviceFont.current();
      value.value = `${slider.value} px`;
      slider.setAttribute('aria-valuetext', value.value);
      updateSummaries();
    }
    slider.addEventListener('input', () => window.StudioDeviceFont.apply(slider.value));
    slider.addEventListener('change', () => {
      void flushRootSettings().catch(() => {});
    });
    slider.addEventListener('pointercancel', () => {
      void flushRootSettings().catch(() => {});
    });
    font
      .querySelector('button')
      .addEventListener('click', () =>
        window.StudioDeviceFont.apply(window.StudioDeviceFont.defaultSize),
      );
    updateFont();
    window.addEventListener('herdr:fontchange', updateFont);
    font.insertAdjacentHTML(
      'beforeend',
      '<div class="settings-font-preview" role="region" aria-label="界面字号预览"><p>这是一段会话文字，用于预览当前字号。</p><p class="settings-preview-secondary">调整后会立即应用，返回即可继续会话。</p></div>',
    );
    fontPanel.append(font);
    const terminalFont = document.createElement('section');
    terminalFont.className = 'device-settings-section';
    terminalFont.innerHTML =
      '<div class="device-font-label"><div><h3><label for="terminalFontSize">终端字体大小</label></h3><p id="terminalFontDescription">仅调整终端，随界面字号缩放；保存在当前设备。</p></div><output for="terminalFontSize"></output></div><div class="device-font-controls"><input id="terminalFontSize" type="range" min="7" max="24" step="0.5" aria-describedby="terminalFontDescription"><button type="button">恢复默认</button></div>';
    const terminalSlider = terminalFont.querySelector('input'),
      terminalValue = terminalFont.querySelector('output');
    function updateTerminalFont() {
      const size = window.StudioTerminalFont.current();
      terminalSlider.value = size || window.StudioTerminalFont.defaultSize();
      terminalValue.value = `${terminalSlider.value} px${size ? '' : '（默认）'}`;
      terminalSlider.setAttribute('aria-valuetext', terminalValue.value);
      updateSummaries();
      terminalFont.style.setProperty('--settings-terminal-size', terminalSlider.value);
    }
    terminalSlider.addEventListener('input', () =>
      window.StudioTerminalFont.apply(terminalSlider.value),
    );
    terminalSlider.addEventListener('change', () => {
      void flushRootSettings().catch(() => {});
    });
    terminalSlider.addEventListener('pointercancel', () => {
      void flushRootSettings().catch(() => {});
    });
    terminalFont
      .querySelector('button')
      .addEventListener('click', () => window.StudioTerminalFont.apply(0));
    updateTerminalFont();
    window.addEventListener('herdr:terminalfontchange', updateTerminalFont);
    terminalFont.insertAdjacentHTML(
      'beforeend',
      `<pre class="settings-terminal-preview" role="region" aria-label="终端字号预览">$ swift
你好，Swift
0123456789  Aa Bb Cc</pre>`,
    );
    terminalPanel.append(terminalFont);
    if (!window.StudioDesktopConnections) {
      const root = document.createElement('section');
      root.className = 'device-settings-section';
      root.innerHTML =
        '<h2 class="settings-section-title"><label for="chatRootDirectory">当前服务器根目录</label></h2><p id="deviceRootDescription">保存在当前服务器，用于此服务器的会话与设置；切换服务器后使用各自的根目录。</p><input id="chatRootDirectory" class="chat-root-directory" type="text" autocomplete="off" spellcheck="false" aria-describedby="deviceRootDescription"><div class="device-root-controls"><button id="deviceRootBrowse" class="chat-btn" type="button">选择目录</button><button id="deviceRootSave" class="chat-btn" type="button">保存</button><span id="deviceRootStatus" role="status"></span></div>';
      const input = root.querySelector('input'),
        save = root.querySelector('#deviceRootSave');
      input.value = state.config?.rootDirectory ?? '';
      const updateSave = () => {
        save.disabled = !input.value.trim() || input.value.trim() === state.config?.rootDirectory;
        root.querySelector('#deviceRootStatus').textContent = '';
      };
      input.addEventListener('input', updateSave);
      updateSave();
      root.querySelector('#deviceRootBrowse').addEventListener('click', async () => {
        const draft = input.value;
        const selected = await askDirectory({
          title: '根目录',
          start: draft || state.config?.rootDirectory,
        });
        if (input.isConnected && selected) {
          input.value = selected;
          updateSave();
        }
      });
      save.addEventListener('click', async () => {
        save.disabled = true;
        root.querySelector('#deviceRootStatus').textContent = '';
        try {
          await flushRootSettings();
          const result = await api(appPath('/api/config'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rootDirectory: input.value.trim() }),
          });
          applyRootDirectory(result.rootDirectory, result.settings);
          renderRootDirectory();
          root.querySelector('#deviceRootStatus').textContent = '已保存';
        } catch (error) {
          if (root.isConnected) root.querySelector('#deviceRootStatus').textContent = error.message;
        } finally {
          save.disabled = input.value.trim() === state.config?.rootDirectory;
        }
      });
      connectionPanel.append(root);
    }
    cleanupSettings = () => {
      cleanupClientUpdates();
      cleanupServerUpdates();
      cleanupConnection();
      nav.removeEventListener('click', onCategoryClick);
      settingsShowList = null;
      window.removeEventListener('herdr:themechange', updateSelection);
      window.removeEventListener('herdr:fontchange', updateFont);
      window.removeEventListener('herdr:terminalfontchange', updateTerminalFont);
    };
  }

  /**
   * 右键(与手机长按)的操作菜单。
   *
   * 🔑 **跟着指针出现**,不是居中的对话框。上下文菜单的意义就在于「对这一项做什么」,
   * 弹到屏幕正中会把这层关系切断:操作的是哪一行,要靠回想。
   *
   * 样式走弹层那一套(`.popover`),和输入框上的菜单、切会话的菜单同源 —— 一个软件
   * 里两套菜单样式,凑在一起就不像一个软件。
   *
   * 拿不到指针位置时(键盘触发)退回居中的对话框:没有「那一点」,跟随就无从谈起。
   */
  const GROUP_KEY = 'studioCollapsedGroups';
  const WIDTH_KEY = 'studioSidebarWidth';

  function collapsedGroups() {
    try {
      return new Set(JSON.parse(storage.get(GROUP_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  function isGroupCollapsed(workspaceId) {
    return collapsedGroups().has(workspaceId);
  }

  function toggleGroup(workspaceId) {
    const set = collapsedGroups();
    if (set.has(workspaceId)) set.delete(workspaceId);
    else set.add(workspaceId);
    try {
      storage.set(GROUP_KEY, JSON.stringify([...set]));
    } catch {
      /* 存不了就只在本次会话里生效 */
    }
  }

  /**
   * 左栏宽度由拖动决定,保存在当前根目录的设备配置中 —— 关掉软件、重启机器都还在,
   * 直到下一次再拖。窄屏的抽屉也听这个值(CSS 里 `.chat-sidebar.open` 用同一个变量)。
   *
   * 上限要跟着屏宽收:520 在手机上比整个屏还宽,拖到那儿列表就把正文全盖了。
   */
  function applySidebarWidth(px) {
    const roomy = Math.max(220, window.innerWidth - 64);
    const minimum =
      parseFloat(document.documentElement.style.getPropertyValue('--chat-sidebar-min-w')) || 180;
    const width = Math.max(minimum, Math.min(520, roomy, Math.round(px)));
    document.documentElement.style.setProperty('--chat-sidebar-w', `${width}px`);
    els.chatResizer?.setAttribute('aria-valuenow', String(width));
    try {
      storage.set(WIDTH_KEY, String(width));
    } catch {
      /* 存不了就只在本次会话里生效 */
    }
    return width;
  }

  (() => {
    const saved = Number(storage.get(WIDTH_KEY) || 0);
    if (saved) applySidebarWidth(saved);
  })();

  if (els.chatResizer) {
    const syncSidebarRange = () => {
      els.chatResizer.setAttribute(
        'aria-valuemin',
        String(
          parseFloat(document.documentElement.style.getPropertyValue('--chat-sidebar-min-w')) ||
            180,
        ),
      );
      els.chatResizer.setAttribute(
        'aria-valuemax',
        String(Math.min(520, Math.max(220, window.innerWidth - 64))),
      );
      els.chatResizer.setAttribute(
        'aria-valuenow',
        String(Math.round(els.chatSidebar.getBoundingClientRect().width)),
      );
    };
    new ResizeObserver(syncSidebarRange).observe(els.chatSidebar);
    els.chatResizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      applySidebarWidth(
        event.key === 'Home'
          ? 320
          : event.key === 'End'
            ? 520
            : els.chatSidebar.getBoundingClientRect().width +
              (event.key === 'ArrowRight' ? 16 : -16),
      );
    });
    els.chatResizer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      els.chatResizer.classList.add('dragging');
      els.chatResizer.setPointerCapture(event.pointerId);
      // 抓住的一刻震一下:手指压在边上看不见自己按中了没有,这一下就是回执。
      // (长按菜单那里的震动是打扰,所以去掉了;这里是操作确认,性质不同。)
      if (state.prefs.haptics && navigator.vibrate) navigator.vibrate(12);
      // 用拖动增量而不是「指针位置 - 容器左边界」:后者依赖容器在视口里的绝对偏移,
      // 而聊天视图是绝对定位嵌在终端舞台里的,那个偏移并不为零 —— 实测拖 120px
      // 宽度却跳了 252px。
      const startX = event.clientX;
      const startWidth = els.chatSidebar.getBoundingClientRect().width;
      const onMove = (move) => applySidebarWidth(startWidth + (move.clientX - startX));
      const onUp = () => {
        els.chatResizer.classList.remove('dragging');
        els.chatResizer.removeEventListener('pointermove', onMove);
        els.chatResizer.removeEventListener('pointerup', onUp);
        els.chatResizer.removeEventListener('pointercancel', onUp);
      };
      els.chatResizer.addEventListener('pointermove', onMove);
      els.chatResizer.addEventListener('pointerup', onUp);
      els.chatResizer.addEventListener('pointercancel', onUp);
    });
  }

  /**
   * 文件面板的宽度。右侧面板要装的是整篇文档，不是几个文件名，
   * 所以固定 420px 不够 —— 这条手柄让它拖到需要的宽度，按设备记住。
   *
   * 面板在右边，所以往左拖是变宽：增量取负。上限跟着窗口收，
   * 免得在窄一些的屏幕上把聊天正文整个挤没。
   */
  const FILES_WIDTH_KEY = 'studioFilesWidth';
  function applyFilesWidth(px) {
    const roomy = Math.max(320, window.innerWidth - 360);
    const width = Math.max(320, Math.min(880, roomy, Math.round(px)));
    document.documentElement.style.setProperty('--files-w', `${width}px`);
    try {
      storage.set(FILES_WIDTH_KEY, String(width));
    } catch {
      /* 存不了就只在本次会话里生效 */
    }
    return width;
  }

  (() => {
    const saved = Number(storage.get(FILES_WIDTH_KEY) || 0);
    if (saved) applyFilesWidth(saved);
    const handle = $('#sessionFilesResizer');
    if (!handle) return;
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.classList.add('dragging');
      handle.setPointerCapture(event.pointerId);
      if (state.prefs.haptics && navigator.vibrate) navigator.vibrate(12);
      // 与左栏那条同样用增量：聊天视图是绝对定位嵌在终端舞台里的，
      // 「指针位置 - 容器边界」会把那个偏移一起算进去。
      const startX = event.clientX;
      const startWidth = $('#sessionFilesPage').getBoundingClientRect().width;
      const onMove = (move) => applyFilesWidth(startWidth - (move.clientX - startX));
      const onUp = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  })();

  // The reading column has its own invisible handle, separate from the sidebar.
  // 各页面复用拖动把手；终端、聊天和设置分别保存宽度。
  (() => {
    const handle = $('#chatContentResizer');
    const terminalColumn = $('#shellTerminal');
    const settingsPage = $('#settingsPage'),
      settingsColumn = settingsPage.querySelector('.settings-content');
    const fileColumns = ['#projectView', '#sessionFilesList', '#sessionFileViewer']
      .map((selector) => $(selector))
      .filter(Boolean);
    const column = () =>
      state.settingsOpen
        ? settingsPage
        : (els.chatView.classList.contains('files-open') &&
            els.chatView.classList.contains('files-max') &&
            fileColumns.find((node) => !node.hidden && node.getClientRects().length)) ||
          (!terminalColumn.hidden && terminalColumn.getClientRects().length
            ? terminalColumn
            : els.chatLog);
    const desktop = matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)');
    const widthSetting = () =>
      column() === settingsPage
        ? {
            key: 'studioSettingsContentWidth',
            property: '--settings-content-width',
            label: '设置内容宽度',
          }
        : column() === terminalColumn
          ? {
              key: 'studioTerminalContentWidth',
              property: '--terminal-content-width',
              label: '终端宽度',
            }
          : { key: 'studioContentWidth', property: '--chat-content-width', label: '聊天内容宽度' };
    let frame = 0;
    const measure = () => {
      const rect = column().getBoundingClientRect();
      if (column() === settingsPage) {
        const content = settingsColumn.getBoundingClientRect();
        return { rect, left: content.left - rect.left, right: rect.right - content.right };
      }
      const style = getComputedStyle(column());
      return { rect, left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
    };
    const position = () => {
      frame = 0;
      const { rect, left, right } = measure();
      handle.hidden = !desktop.matches || rect.height <= 0 || rect.width <= 0;
      if (handle.hidden) return;
      const top =
        rect.top +
        (column() === settingsPage
          ? settingsPage.querySelector('.settings-bar').offsetHeight + 28
          : 0);
      Object.assign(handle.style, {
        left: `${rect.left + left - 12}px`,
        top: `${top}px`,
        height: `${rect.height / 4}px`,
      });
      handle.setAttribute('aria-valuemin', '360');
      handle.setAttribute('aria-valuemax', String(Math.round(rect.width - 48)));
      handle.setAttribute('aria-valuenow', String(Math.round(rect.width - left - right)));
      handle.setAttribute('aria-label', widthSetting().label);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(position);
    };
    const apply = (value) => {
      const maximum = Math.max(360, column().clientWidth - 48);
      const width = Math.round(Math.max(360, Math.min(maximum, value)));
      const { key, property } = widthSetting();
      document.documentElement.style.setProperty(property, `${width}px`);
      storage.set(key, String(width));
      schedule();
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.pointerType !== 'mouse' || !desktop.matches) return;
      event.preventDefault();
      event.stopPropagation();
      const { rect, left, right } = measure();
      const startWidth = rect.width - left - right,
        startX = event.clientX;
      handle.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('resizing-chat-content');
      const move = (e) => apply(startWidth - 2 * (e.clientX - startX));
      const finish = () => {
        document.documentElement.classList.remove('resizing-chat-content');
        handle.removeEventListener('pointermove', move);
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
          handle.removeEventListener(name, finish);
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
      };
      handle.addEventListener('pointermove', move);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
        handle.addEventListener(name, finish);
    });
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      const { rect, left, right } = measure();
      if (event.key === 'Home') {
        const { key, property } = widthSetting();
        document.documentElement.style.removeProperty(property);
        storage.set(key, 'auto');
        schedule();
      } else apply(rect.width - left - right + (event.key === 'ArrowLeft' ? 20 : -20));
    });
    const observer = new ResizeObserver(schedule);
    for (const node of [els.chatLog, terminalColumn, settingsPage, settingsColumn, ...fileColumns])
      observer.observe(node);
    desktop.addEventListener('change', schedule);
    window.addEventListener('resize', schedule);
    schedule();
  })();

  // 窄屏上左栏是抽屉;宽屏由 CSS 常驻,这些开关不起作用也无妨。
  /**
   * 侧栏在两种宽度下是两种东西,「收起」的含义也就不同:
   *   窄屏  它是盖在内容上的抽屉 —— 收起 = 关掉抽屉,点内容区(遮罩)就能关。
   *   宽屏  它是常驻的一列 —— 没有遮罩可点,所以原来根本没有收起的入口。
   * 现在宽屏下把那一列折叠掉,入口是标题栏里同一个按钮(它在主区里,
   * 折叠之后仍然点得到,不会跟着侧栏一起消失)。
   */
  const CHAT_SIDEBAR_WIDE_MIN_PX = 761; // 与 style.css 的媒体查询同值
  const isWideChat = () => window.innerWidth >= CHAT_SIDEBAR_WIDE_MIN_PX;

  function setChatDrawerOpen(open) {
    if (!open) sidebar.captureScroll({ defer: true });
    if (open && !els.chatSidebar.classList.contains('open')) {
      sidebar.captureScroll();
      state.sidebarMode = 'workspace';
    }
    els.chatSidebar.classList.toggle('open', open);
    els.chatPickerScrim.hidden = !open;
    if (open) {
      renderChatPicker();
      sidebar.restoreScroll();
      sidebar.revealNavigation();
    }
  }

  function setChatSidebarCollapsed(collapsed) {
    if (collapsed) sidebar.captureScroll({ defer: true });
    const opening = !collapsed && els.chatView.classList.contains('sidebar-collapsed');
    if (opening) state.sidebarMode = 'workspace';
    els.chatView.classList.toggle('sidebar-collapsed', collapsed);
    if (opening) renderChatPicker();
    if (!collapsed) {
      sidebar.restoreScroll();
      sidebar.revealNavigation();
    }
    storage.set('chat.sidebarCollapsed', collapsed ? '1' : '');
    if (els.chatDrawerToggle) {
      els.chatDrawerToggle.setAttribute('aria-expanded', String(!collapsed));
    }
  }

  for (const [button, mode] of [
    [els.sidebarRecent, 'recent'],
    [els.sidebarWorkspaces, 'workspace'],
    [els.sidebarHistory, 'history'],
    [$('#sidebarFiles'), 'files'],
  ]) {
    button.addEventListener('click', () => {
      state.sidebarMode = mode;
      renderChatPicker();
      if (mode === 'history') loadHistory();
    });
    button.addEventListener('keydown', (event) => {
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const tabs = [
          els.sidebarWorkspaces,
          els.sidebarRecent,
          els.sidebarHistory,
          $('#sidebarFiles'),
        ];
        const target =
          tabs[
            Math.max(
              0,
              Math.min(
                tabs.length - 1,
                tabs.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1),
              ),
            )
          ];
        target.click();
        target.focus({ preventScroll: true });
      }
    });
  }

  if (els.chatDrawerToggle) {
    els.chatDrawerToggle.addEventListener('click', () => {
      if (isWideChat()) {
        setChatSidebarCollapsed(!els.chatView.classList.contains('sidebar-collapsed'));
        return;
      }
      setChatDrawerOpen(!els.chatSidebar.classList.contains('open'));
    });
    setChatSidebarCollapsed(storage.get('chat.sidebarCollapsed') === '1');
  }
  // 宽屏上左栏展开时，收起按钮在左栏自己的头部；收起之后没地方放了，才落回会话顶栏左边
  //（2026-09-24 用户要求，与右边文件页的开关对称）。显示哪一个由样式表按 .sidebar-collapsed 决定，
  // 焦点跟着按钮走，键盘用户不会落在一个刚刚消失的按钮上。
  if (els.chatSidebarCollapse) {
    els.chatSidebarCollapse.addEventListener('click', () => {
      setChatSidebarCollapsed(true);
      (state.workspaceFilesOpen
        ? document.querySelector('.workspace-files-sidebar')
        : els.chatDrawerToggle
      )?.focus({ preventScroll: true });
    });
    els.chatDrawerToggle?.addEventListener('click', () => {
      if (isWideChat() && !els.chatView.classList.contains('sidebar-collapsed'))
        els.chatSidebarCollapse.focus({ preventScroll: true });
    });
  }
  if (els.chatPickerScrim)
    els.chatPickerScrim.addEventListener('click', () => setChatDrawerOpen(false));
  /**
   * 搜索框只做一件事:按名字筛这份列表。
   *
   * 原来它同时去服务端搜会话记录的正文 —— 打两个字就跳出一堆正文片段,
   * 想找的那个 agent 反而被埋了。找记录里说过什么是另一回事,
   * 不该挤进「挑一个会话」这个动作里。
   */
  function onChatSearchInput() {
    if (state.sidebarMode === 'history') {
      loadHistory();
      return;
    }
    renderChatPicker();
  }

  if (els.chatPickerSearch) els.chatPickerSearch.addEventListener('input', onChatSearchInput);
  // 搜索平时收成一颗放大镜(照 dsh 的左栏),点开才展开输入框。收起时顺手清掉筛选,
  // 否则列表还被上一次的关键字过滤着,而那个框已经看不见了。
  if (els.chatSearchToggle && els.chatSearchBox) {
    els.chatSearchToggle.addEventListener('click', () => {
      const open = els.chatSearchBox.hidden;
      els.chatSearchBox.hidden = !open;
      els.chatSearchToggle.setAttribute('aria-expanded', String(open));
      if (open) {
        els.chatPickerSearch.focus();
      } else if (els.chatPickerSearch.value) {
        els.chatPickerSearch.value = '';
        onChatSearchInput();
      }
    });
  }
  // 不带上下文地开:工作区与目录都落到「当前/默认」,对话框里再改。

  function setChatOpen(open) {
    // 已经开着就只刷新一次：启动时取到配置就开，实时通道连上后这里还会再被叫一次。
    if (open && chatTimer && !els.chatView.hidden) {
      refreshChat();
      return;
    }
    els.chatView.hidden = !open;
    if (!open) setChatDrawerOpen(false);
    clearInterval(chatTimer);
    chatTimer = 0;
    if (!open) return;
    els.chatLog.dataset.signature = '';
    refreshChat();
    // 存档按消息落盘,刷得再快也不会更早看到内容。现在内容没变就不动 DOM,
    // 这个间隔只影响新消息出现的延迟。
    // 事件推动状态更新；存档内容使用四秒兜底，后台标签页暂停轮询。
    //
    // ⚠️ 别因为「事件通道连着就不必轮询」去把它降频。这一下的开销全在后台，用户
    // 感知不到；而它换来的是事件漏掉时新消息出现的延迟 —— 那是用户直接看得见的。
    // 稳定性优先于省掉几次后台请求。
    chatTimer = setInterval(() => {
      if (!document.hidden) refreshChat();
    }, 4000);
  }

  // 等 PTY 首次连上再回调。已经连上了就立刻执行。
  const connectedWaiters = [];
  function onceConnected(fn) {
    if (state.connected) {
      fn();
      return;
    }
    connectedWaiters.push(fn);
  }
  function flushConnectedWaiters() {
    while (connectedWaiters.length) connectedWaiters.shift()();
  }

  // placeholder 只给电脑那张卡片:它靠这行字撑出输入区。
  // 手机维持原样(那边刻意没有 placeholder,屏幕本来就窄,多一行灰字只是占地方)。
  if (window.matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)').matches) {
    els.commandInput.placeholder = '发消息给这个会话';
  }
  // 嵌在 APP 的 WebView 里时铺满宿主,别的地方与浏览器里完全一样 —— 会话页
  // 两端就是同一套实现,这也是当初让 APP 嵌网页而不是拿原生控件复刻的理由。
  if (embeddedChat) document.body.classList.add('embedded-chat');
  // 输入卡片是往 PTY 写字的,得等连上才有意义,所以等 `terminal.ready` 再开。
  onceConnected(() => setChatOpen(true));

  // 会话列表的横向滑动。放在容器上用捕获阶段判断,
  // 子元素(消息列表、宽代码块、侧栏)各自的滚动照常工作。
  // 横向手势：一步切换、换页跟手、换标签跟手（public/nav/swipe.js）。这些依赖在手势发生时才读。
  window.StudioSwipe.bind(els.chatView, {
    state,
    els,
    isWide: () => isWideChat(),
    filesSlide: () => !desktopFiles.matches,
    files: () => filesShell,
    back: () => window.StudioNavigation.back(),
    setDrawerOpen: (open) => setChatDrawerOpen(open),
    setSidebarCollapsed: (collapsed) => setChatSidebarCollapsed(collapsed),
    setFilesPage: (open) => setFilesPage(open),
    renderPicker: () => renderChatPicker(),
    loadHistory: () => loadHistory(),
    revealPickerMode: () => sidebar.revealNavigation(),
    capturePickerScroll: () => sidebar.captureScroll({ detach: true }),
  });

  function loadRootConfig() {
    return api(appPath('/api/config'));
  }

  function applyRootSettings(settings, force = false) {
    if (!force && settingsSaver?.busy(state.config?.rootDirectory)) return;
    const normalized = window.StudioSettingsSave.merge(
      { theme: 'default', fontSize: 14, ui: {}, ...settings },
      settingsSaver?.pending(state.config?.rootDirectory),
    );
    if (!force && JSON.stringify(state.config?.settings) === JSON.stringify(normalized)) return;
    if (state.config) state.config.settings = normalized;
    applyingRootSettings = true;
    try {
      rootUiSettings = { ...normalized.ui };
      // 已读记录也在这一袋里：设置取回来之后才读得到。原来在脚本加载时就读，那时还是空的，
      // 于是每次整页重载后蓝点全亮，之后记已读还会用这张空表把服务端的记录覆盖掉。
      reloadSeen();
      window.StudioDeviceTheme.apply(normalized.theme, false);
      window.StudioDeviceFont.apply(normalized.fontSize, false);
      window.StudioTerminalFont.apply(normalized.terminalFontSize);
      state.prefs = UI.sanitizePrefs(loadJson('studioPrefs', null));
      document.documentElement.style.removeProperty('--chat-sidebar-w');
      document.documentElement.style.removeProperty('--chat-content-width');
      document.documentElement.style.removeProperty('--terminal-content-width');
      document.documentElement.style.removeProperty('--settings-content-width');
      document.documentElement.style.removeProperty('--files-w');
      const sidebar = Number(storage.get(WIDTH_KEY));
      if (sidebar) applySidebarWidth(sidebar);
      const files = Number(storage.get(FILES_WIDTH_KEY));
      if (files) applyFilesWidth(files);
      const content = Number(storage.get('studioContentWidth'));
      if (content >= 360)
        document.documentElement.style.setProperty('--chat-content-width', `${content}px`);
      const terminalContent = Number(
        storage.get('studioTerminalContentWidth', storage.get('studioContentWidth')),
      );
      if (terminalContent >= 360)
        document.documentElement.style.setProperty(
          '--terminal-content-width',
          `${terminalContent}px`,
        );
      const settingsContent = Number(storage.get('studioSettingsContentWidth'));
      if (settingsContent >= 360)
        document.documentElement.style.setProperty(
          '--settings-content-width',
          `${settingsContent}px`,
        );
      setChatSidebarCollapsed(storage.get('chat.sidebarCollapsed') === '1');
      els.chatPickerList.dataset.signature = '';
    } finally {
      applyingRootSettings = false;
    }
  }
  const settingsJournalKey = `studioPendingSettings:${basePath}:${deviceId}`;
  settingsSaver = window.StudioSettingsSave.create({
    write: (rootDirectory, settings) =>
      api(appPath('/api/settings'), {
        method: 'POST',
        keepalive:
          document.visibilityState === 'hidden' &&
          new Blob([JSON.stringify({ rootDirectory, settings })]).size < 60 * 1024,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootDirectory, settings }),
      }),
    load: () => JSON.parse(localStorage.getItem(settingsJournalKey) || '[]'),
    persist: (rows) => {
      if (rows.length) localStorage.setItem(settingsJournalKey, JSON.stringify(rows));
      else localStorage.removeItem(settingsJournalKey);
    },
    onSaved: (rootDirectory, settings) => {
      if (rootDirectory === state.config?.rootDirectory) applyRootSettings(settings);
    },
    onError: (rootDirectory, message) => {
      if (rootDirectory === state.config?.rootDirectory) reportError(message, 'preferences');
    },
  });
  function queueRootSettings(patch) {
    if (!applyingRootSettings && state.config?.rootDirectory)
      settingsSaver.queue(state.config.rootDirectory, patch);
  }
  function flushRootSettings() {
    return settingsSaver.flush(state.config?.rootDirectory);
  }
  window.addEventListener('online', () => settingsSaver.resume(state.config?.rootDirectory));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) settingsSaver.resume(state.config?.rootDirectory);
  });
  window.addEventListener('herdr:themechange', () =>
    queueRootSettings({ theme: deviceTheme.current().id }),
  );
  window.addEventListener('herdr:terminalfontchange', () =>
    queueRootSettings({ terminalFontSize: window.StudioTerminalFont.current() }),
  );
  window.addEventListener('herdr:fontchange', () =>
    queueRootSettings({ fontSize: window.StudioDeviceFont.current() }),
  );
  window.addEventListener('pagehide', () => {
    void flushRootSettings().catch(() => {});
  });

  function applyRootDirectory(rootDirectory, settings) {
    if (!rootDirectory) return;
    if (rootDirectory === state.config?.rootDirectory) {
      if (settings) applyRootSettings(settings);
      return;
    }
    void flushRootSettings().catch(() => {});
    reportError('', 'preferences');
    messageEdit?.cancel();
    saveDraft();
    saveChatCache();
    setFilesPage(false);
    Object.assign(state.config, {
      rootDirectory,
      dataDirectory: `${rootDirectory.replace(/\/+$/, '')}/.agent-studio`,
      defaultCwd: rootDirectory,
      temporaryCwd: rootDirectory,
    });
    draftStore.load(rootDirectory);
    state.drafts = {};
    state.composerIdentity = '';
    applyRootSettings(settings || {}, true);
    settingsSaver.resume(rootDirectory);
    state.selectionVersion++;
    state.historyEpoch = (state.historyEpoch || 0) + 1;
    state.history = [];
    state.historyAt = 0;
    state.historyLoading = false;
    state.historyNext = null;
    state.chatPaneId = '';
    state.chatAgents = [];
    state.allPanes = [];
    state.chatWorkspaces = [];
    state.chatFocusedPaneId = '';
    dropLoadedHistory();
    state.chatCache.clear();
    state.fileCache.clear();
    state.previewCache.clear();
    // 本地副本属于旧根：清掉并向服务端重新追平（服务端切换中心时也会发 sync.reset，重复一次无妨）。
    replica.clear(rootDirectory);
    sync.reset();
    sync.hello();
    els.commandInput.value = '';
    els.chatPickerSearch.value = '';
    els.chatPickerList.dataset.signature = '';
    els.chatLog.dataset.paneId = '';
    invalidateChatRender();
    chatStatus.reset({ forgetPane: true });
    renderChatStatus({});
    renderAgentStartup(null);
    renderAgentQuestion(null);
    renderGoal({});
    renderAttachments();
    setChatContentReady(true);
    renderChatMessages([]);
    renderChatPicker();
    renderAgentActions();
    renderRootDirectory();
    void refreshChat();
  }

  function renderRootDirectory() {
    const root =
      state.config?.rootDirectory || state.config?.temporaryCwd || state.config?.defaultCwd || '';
    const input = $('#chatRootDirectory');
    if (input) {
      input.value = root;
      input.title = root;
    }
  }
  const desktopFiles = matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)');
  const filesReplaceChat = () => state.filesOpen && !desktopFiles.matches;
  $('#chatFilesToggle').addEventListener('click', () => setFilesPage(!state.filesOpen));

  $('#chatFilesListBack').addEventListener('click', () => {
    backPanel();
    if (!state.filesOpen && desktopFiles.matches)
      $('#chatFilesToggle').focus({ preventScroll: true });
  });
  desktopFiles.addEventListener('change', () => {
    if (state.filesOpen) state.filesScroll = els.chatLog.scrollTop || state.filesScroll;
  });
  // 会话文件只保留列表与搜索，文件内容使用同一个工作区文件页。
  let sessionFileOrigin = null;
  const filesShell = StudioFilesShell.create({
    state,
    els,
    $,
    chatText,
    openFile: (path) => workspaceFiles?.open(path),
    // 推送来的会话文件列表（活着的会话才有；归档会话照旧请求）。
    synced: (paneId) => {
      if (!sync.active()) return null;
      const pushed = replica.files(
        syncKeyFor((state.allPanes || []).find((pane) => pane.paneId === paneId)),
      );
      return pushed ? { ok: true, tab: 'session', files: pushed.files } : null;
    },
    request: (path, options) => api(appPath(path), options),
    storage,
    saveChatCache: () => saveChatCache(),
    filesReplaceChat: () => filesReplaceChat(),
    closePopover: () => closePopover(),
    closeSlashCommands: () => closeSlashCommands(),
    setChatDrawerOpen: (open) => setChatDrawerOpen(open),
    setAtBottom: (value) => chatScroll.setFollowing(value),
    desktopFiles,
    scroll: chatScroll,
  });
  const {
    setFilesPage,
    backPanel,
    closeFilePreview,
    refreshSessionFiles,
    preloadList: preloadSessionFiles,
  } = filesShell;

  workspaceFiles = StudioWorkspaceFiles.create({
    state,
    namespace: state.namespace,
    copyText,
    askConfirm: dialogs.askConfirm,
    popovers: {
      open: (...args) => popovers.open(...args),
      close: () => popovers.close(),
      get element() {
        return popovers.element;
      },
    },
    request: (path, options) => api(appPath(path), options),
    fetchBlob: async (path, options = {}) => {
      const response = await fetch(appPath(path), {
        ...options,
        headers: authHeaders(),
        credentials: 'same-origin',
      });
      if (!response.ok) {
        let message = '文件读取失败。';
        try {
          message = (await response.json()).message || message;
        } catch {}
        throw new Error(message);
      }
      return response.blob();
    },
    closeDrawer: () => setChatDrawerOpen(false),
    beforeOpen: () => {
      sessionFileOrigin = state.filesOpen
        ? { identity: chatCacheKey(), scroll: $('#sessionFilesList').scrollTop }
        : null;
      closeDeviceSettings(false);
      setFilesPage(false);
      closePopover();
      closeSlashCommands();
      saveChatCache();
    },
    onClose: (restore) => {
      const origin = sessionFileOrigin;
      sessionFileOrigin = null;
      if (restore && origin?.identity === chatCacheKey()) {
        setFilesPage(true);
        $('#sessionFilesList').scrollTop = origin.scroll;
      }
    },
  });

  window.StudioNavigation = {
    back() {
      if (popovers.element) {
        closePopover();
        return true;
      }
      if (chatImages.closePreview()) return true;
      if (dlg.root.open) {
        closeDialog(null);
        return true;
      }
      if (window.StudioDesktopConnections?.closeAddServer?.()) return true;
      if (state.settingsOpen) {
        if (settingsCategory) settingsShowList?.();
        else closeDeviceSettings();
        return true;
      }
      if (workspaceFiles?.isOpen()) {
        if (els.chatSidebar.classList.contains('open')) setChatDrawerOpen(false);
        else workspaceFiles.close();
        return true;
      }
      if (state.filesOpen) {
        backPanel();
        return true;
      }
      if (els.chatSidebar.classList.contains('open')) {
        setChatDrawerOpen(false);
        return true;
      }
      return false;
    },
  };
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open], .popover')) return;
    if (state.settingsOpen) {
      if (settingsCategory) settingsShowList?.();
      else closeDeviceSettings();
      return;
    }
    if (workspaceFiles?.isOpen()) {
      if (els.chatSidebar.classList.contains('open')) setChatDrawerOpen(false);
      else workspaceFiles.close();
      return;
    }
    if (!state.filesOpen) return;
    backPanel();
  });

  // 图片和本地文件统一使用长按／右键菜单，认证信息不写入下载地址。
  window.StudioImageMenu.bind({
    selector:
      '.chat-image img, .chat-image-viewer img, #projectView img.doc-image, #projectView .doc-inline-image img, [data-download-url]',
    headers: () => authHeaders(),
    closeMenu: () => closePopover(),
    openMenu: (items, x, y, dialog) => {
      popovers.open(null, {
        items,
        at: { x, y },
        label: '保存文件',
        onPick: (item) => item.handler(),
      });
      if (dialog && popovers.element) dialog.append(popovers.element);
    },
    reportError: (message) => {
      if (message) reportError(message, 'download');
      else
        document.querySelectorAll('.operation-error[data-source="download"]').forEach((node) => {
          node.textContent = '';
          node.hidden = true;
        });
    },
  });

  /** 收起状态行并停掉本地读秒。换会话、换 pane 时都要先做这一下。 */

  let historyErrorTimer = 0,
    historyErrorSince = 0,
    historyErrorSelection = -1,
    historyErrorMessage = '',
    draftErrorMessage = '',
    composerErrorOwner = '';
  const errorOwner = () =>
    JSON.stringify([
      state.config?.rootDirectory,
      state.herdrRuntimeId,
      state.chatPaneId,
      currentChatPane()?.terminalId,
      currentChatPane()?.agent?.session?.value || '',
      sideThreads.active() ? sideThreads.view()?.sideId : '',
    ]);
  function reportError(message, source = 'operation') {
    if (source === 'draft') draftErrorMessage = message;
    if (source === 'history') {
      if (!message) {
        clearTimeout(historyErrorTimer);
        historyErrorTimer = 0;
        historyErrorSince = 0;
        historyErrorMessage = '';
      } else {
        if (historyErrorSelection !== state.selectionVersion || !historyErrorSince) {
          clearTimeout(historyErrorTimer);
          historyErrorTimer = 0;
          if (els.composerError?.dataset.source === 'history') {
            els.composerError.textContent = '';
            els.composerError.hidden = true;
          }
          historyErrorSelection = state.selectionVersion;
          historyErrorSince = Date.now();
        }
        historyErrorMessage = message;
        if (!state.connected) {
          if (els.composerError?.dataset.source === 'history') {
            els.composerError.textContent = '';
            els.composerError.hidden = true;
          }
          return;
        }
        if (Date.now() - historyErrorSince < 15000) {
          if (!historyErrorTimer)
            historyErrorTimer = setTimeout(
              () => {
                historyErrorTimer = 0;
                if (historyErrorSelection === state.selectionVersion && historyErrorMessage)
                  reportError(historyErrorMessage, 'history');
              },
              Math.max(1, 15000 - (Date.now() - historyErrorSince)),
            );
          return;
        }
      }
    }
    if (source === 'preferences' && !message) {
      for (const node of document.querySelectorAll('.operation-error[data-source="preferences"]')) {
        node.textContent = '';
        node.hidden = true;
      }
      return;
    }
    // Background reads recover independently from explicit operations. A
    // successful poll must clear its own failure, never a failed message send.
    const host = ['history', 'session-check', 'native-view', 'draft'].includes(source)
      ? null
      : source === 'download' && document.querySelector('.chat-image-viewer[open]')
        ? document.querySelector('.chat-image-viewer[open]')
        : state.settingsOpen
          ? document.querySelector('#settingsBody')
          : state.filesOpen
            ? document.querySelector('#sessionFilesPage')
            : null;
    let error = host?.querySelector(':scope > .operation-error') || els.composerError;
    if (host && error === els.composerError) {
      error = document.createElement('p');
      error.className = 'operation-error';
      error.setAttribute('role', 'alert');
      host.append(error);
    }
    if (!error) return;
    if (
      ['history', 'preferences', 'native-view', 'draft'].includes(source) &&
      !error.hidden &&
      error.dataset.source !== source
    )
      return;
    if (!message && error.dataset.source && error.dataset.source !== source) return;
    if (!message && error === els.composerError && draftErrorMessage) {
      message = draftErrorMessage;
      source = 'draft';
    }
    error.dataset.source = source;
    error.textContent = message || '';
    error.hidden = !message;
    if (error === els.composerError) {
      composerErrorOwner =
        message && !['draft', 'preferences'].includes(source) ? errorOwner() : '';
      error.title = message || '';
    }
  }

  function showBanner(message) {
    if (els.banner.textContent !== message) els.banner.textContent = message;
    els.banner.hidden = !message;
    els.chatStatus.hidden = els.chatArchivedNotice.hidden;
  }

  async function exportConnectionDiagnostics() {
    const diagnostic = JSON.parse(connectionState.export());
    if (nativeConnectionAuth) {
      try {
        const response = await fetch('/desktop/connection-diagnostics');
        if (response.ok) diagnostic.native = await response.json();
      } catch {}
    }
    const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }),
      url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'swift-connection-diagnostics.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function buildConnectionDiagnostics(panel) {
    const section = document.createElement('details'),
      summary = document.createElement('summary');
    summary.textContent = '连接诊断';
    section.append(summary);
    const list = document.createElement('dl');
    section.append(list);
    const paint = () => {
      list.replaceChildren();
      for (const row of connectionState.rows()) {
        const term = document.createElement('dt'),
          value = document.createElement('dd');
        term.textContent = row.label;
        value.textContent = row.value;
        list.append(term, value);
      }
    };
    section.addEventListener('toggle', () => {
      if (section.open) paint();
    });
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重新连接';
    retry.onclick = () => {
      connectPty();
      paint();
    };
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = '导出连接诊断';
    download.onclick = exportConnectionDiagnostics;
    const note = document.createElement('p');
    note.textContent = '仅含连接阶段、关闭码、重试次数与时间，不含正文、凭据或按键。';
    section.append(retry, download, note);
    panel.append(section);
  }

  const connectionFeedback = window.StudioConnectionFeedback.create({ render: showBanner });
  function setConnectionState(kind, message = '', { actionable = false } = {}) {
    const wasConnected = state.connected;
    state.connected = kind === 'connected';
    if (!wasConnected && state.connected) {
      flushConnectedWaiters();
      settingsSaver?.resume(state.config?.rootDirectory);
    }
    els.shell.dataset.connection = kind;
    els.commandInput.disabled = !state.connected;
    els.send.disabled = !state.connected;
    connectionFeedback.update(
      state.connected,
      actionable ? message : '连接恢复中，草稿保留，发送已暂停。',
      { actionable },
    );
    finishConnectionState();
  }
  function finishConnectionState() {
    sideThreads.render();
    if (!state.connected) chatStatus.screenUnavailable();
    renderSessionStatus((state.chatAgents || []).find((pane) => pane.paneId === state.chatPaneId));
    renderChatPicker();
  }

  function socketUrl() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const pathname = appPath('/api/terminal');
    const url = new URL(`${scheme}//${location.host}${pathname}`);
    // 观察缓冲区尺寸由服务端固定，不跟随浏览器宽度改变原生会话的尺寸。
    // observe=1：服务端不挂完整的 Herdr 客户端（它会抢前台、把正在跑的会话缩成 120×40），
    // 只读观察选中会话的终端（lib/terminal-transport.js 的 observeTerminal）。
    url.search = new URLSearchParams({
      cols: '120',
      rows: '40',
      observe: '1',
      screen: 'structured',
      flow: 'ack',
    });
    if (state.token) url.searchParams.set('token', state.token);
    return url;
  }

  /**
   * 让实时流观察当前选中会话的终端。换了会话、重连之后都调一次；终端没变就什么也不做。
   * 在收到这个终端的完整画面（terminal.observe.full）之前不认流里的字节：上一个终端的残帧可能还在路上。
   */
  let observedTerminal = '',
    observedBinding = '',
    observedRequestId = '';
  function observeCurrentTerminal() {
    if (!liveSocket.isOpen()) return;
    if (canViewNative() && (!nativeViewReady || nativeViewBusy || nativeViewPending)) return;
    const terminalId =
      state.archived || isTerminalPresentation() || !currentChatPane()?.agent
        ? ''
        : currentChatPane()?.terminalId || '';
    const binding = `${state.chatPaneId}:${currentChatPane()?.agent?.session?.value || ''}`;
    if (terminalId === observedTerminal && binding === observedBinding) return;
    observedTerminal = terminalId;
    observedBinding = binding;
    connectionState.update({ observer: terminalId ? 'waiting' : 'none' });
    observedRequestId =
      globalThis.crypto?.randomUUID?.() ||
      `observe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    chatStatus.claim('');
    chatStatus.invalidateStream();
    liveSocket.send({
      type: 'terminal.observe',
      terminalId,
      binding,
      requestId: observedRequestId,
    });
  }

  function disconnect(reason = 'reconnect') {
    liveSocket.disconnect(reason);
    state.connected = false;
  }

  // 接收即时活动状态和 studio.changed 通知。消息与停止操作通过定向 HTTP API 提交。
  // 连接、重连与代次过滤归 core/socket.js；这里只处理收到的内容。
  const liveSocket = window.StudioSocket.create({
    url: socketUrl,
    onReceive: () => connectionState.received(),
    onBinary: (bytes) => chatStatus.sniff(bytes),
    onState: (kind, message, detail) => {
      connectionState.transport(kind, detail);
      if (kind === 'offline') {
        releaseWakeLock();
        sync.reset();
        observedTerminal = '';
      }
      // 连上的判定由 terminal.ready 给出,握手成功还不代表 PTY 已就绪。
      if (kind !== 'connected')
        setConnectionState(
          kind,
          kind === 'offline' && !message ? '连接已断开，正在重连…' : message,
          { actionable: Boolean(detail?.blocked) },
        );
    },
    onMessage: (message) => {
      if (sync.handle(message)) return;
      if (message.type === 'terminal.screen') {
        if (message.flow === 'snapshot') {
          if (
            message.requestId !== observedRequestId ||
            message.terminalId !== observedTerminal ||
            message.binding !== observedBinding
          )
            return;
          if (chatStatus.owner() !== state.chatPaneId) {
            chatStatus.beginScreen(message.observerId);
            chatStatus.claim(state.chatPaneId);
          }
        }
        chatStatus.screen(message);
        connectionState.update({ observer: 'ready' });
        if (els.composerError.dataset.source === 'observation') reportError('', 'observation');
        if (
          message.terminalId === observedTerminal &&
          message.binding === observedBinding &&
          JSON.stringify(message.projection?.statusRows || []).includes('Side from ')
        )
          void sideThreads.refresh();
        return;
      }
      if (message.type === 'terminal.observe.full') {
        // 这个终端的完整画面到了：从这里开始认，之前按光标拼出来的行作废。
        if (
          message.terminalId !== observedTerminal ||
          (message.requestId && message.requestId !== observedRequestId)
        )
          return;
        if (message.screen && message.binding !== observedBinding) return;
        connectionState.update({ observer: 'ready' });
        if (els.composerError.dataset.source === 'observation') reportError('', 'observation');
        chatStatus.forgetScreen();
        chatStatus.beginScreen(message.screen ? message.observerId : '');
        if (currentChatPane()?.terminalId === observedTerminal) chatStatus.claim(state.chatPaneId);
        return;
      }
      if (message.type === 'terminal.observe.ended') {
        if (
          message.terminalId === observedTerminal &&
          (!message.binding || message.binding === observedBinding) &&
          chatStatus.screenUnavailable(message)
        ) {
          connectionState.update({ observer: 'failed' });
          observedTerminal = '';
          setTimeout(observeCurrentTerminal, 1000);
        }
        return;
      }
      if (message.type === 'terminal.ready') {
        globalThis.StudioConnectionTrace?.('terminal-ready');
        setConnectionState('connected');
        requestWakeLock();
        sync.hello();
        observedTerminal = '';
        observeCurrentTerminal();
      } else if (message.type === 'terminal.error') {
        connectionState.update({ observer: 'failed' });
        chatStatus.screenUnavailable();
        observedTerminal = '';
        if (message.recoverable !== false) setTimeout(observeCurrentTerminal, 1000);
        // An observation failure does not change the network or other terminal channels.
        reportError('原生状态观察暂不可用，其他连接保持运行。', 'observation');
      } else if (message.type === 'terminal.exit') {
        showBanner(`Herdr 客户端已退出（${message.exitCode ?? 'unknown'}）`);
      } else if (message.type === 'studio.config.changed') {
        applyRootDirectory(message.rootDirectory, message.settings);
      } else if (message.type === 'studio.changed') {
        // 服务端订到了 Herdr 的变更(某个 agent 开始干活/被挡住/跑完了)。
        // 这类通知**没有载荷**,数据要自己来拉 —— 逐条打补丁迟早和真相漂移,
        // 重拉一次快照只要 9ms。
        //
        // 队列自己的变更带 scope='outbox'、事件序号和真正动过的 pane。
        // 只有在**确知**这次变更与当前 pane 无关时才跳过重拉;其余一律重拉。
        //
        // ⚠️ 兜底轮询**不能**因此删掉:Herdr 没起、socket 断开重连的那几秒收不到事件。
        // 这条通道是让它变快,不是让它变成唯一依赖。
        if (store.skippable(message, state.chatPaneId)) return;
        refreshChat();
      }
    },
  });
  function connectPty() {
    connectionState.begin();
    liveSocket.connect();
  }

  /**
   * 从某个按钮向上弹出的列表。照 dsh 那几个弹层做的:那边的模型选择器就是从工具行
   * 的钮往上弹,内容是一行一项。
   *
   * 🔑 这套东西存在的理由:网页**不该**隔着 PTY 去驱动终端里的 TUI。以前点「恢复会话」
   * 是往 PTY 发 `/resume\r`,然后人还得在终端里用方向键选一遍 —— 那是把网页当成了
   * 终端的遥控器。现在改成网页自己弹列表、自己知道有哪些候选,点一下就完成。
   *
   * 一次只允许开一个,再开先关掉上一个。
   */
  const popovers = window.StudioPopovers.create({
    input: els.commandInput,
    container: $('#chatInput'),
  });
  const { open: openPopover, close: closePopover } = popovers;
  const nativeStatusView = window.StudioNativeStatusView.create({
    observation: () => chatStatus.summary(),
    request: (body) =>
      api(appPath('/api/command-interaction'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    target: () => {
      const pane = currentChatPane();
      return pane && state.connected && !state.archived && currentProvider() === 'codex'
        ? {
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            sessionId: pane.agent?.session?.value || '',
            runtimeId: state.herdrRuntimeId,
            processRuntimeId: pane.runtimeId,
          }
        : null;
    },
    identity: () =>
      `${state.config?.rootDirectory}:${state.herdrRuntimeId}:${chatCacheKey()}:${currentChatPane()?.runtimeId || ''}`,
    openPopover,
    closePopover,
    currentPopover: () => popovers.element,
    onChange: () => queueMicrotask(() => renderSessionStatus(currentChatPane())),
  });
  const nativeStatusRead = window.StudioNativeStatusRead.create({
    request: (body) =>
      api(appPath('/api/command-interaction'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    target: () => {
      const pane = currentChatPane();
      return pane && state.connected && !state.archived && currentProvider() === 'codex'
        ? {
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            sessionId: pane.agent?.session?.value || '',
            runtimeId: state.herdrRuntimeId,
            processRuntimeId: pane.runtimeId,
          }
        : null;
    },
    identity: () =>
      `${state.config?.rootDirectory}:${state.herdrRuntimeId}:${chatCacheKey()}:${currentChatPane()?.runtimeId || ''}`,
    onChange: () => queueMicrotask(() => renderSessionStatus(currentChatPane())),
  });
  const statusBar = window.StudioSessionStatusBar.create({
    nodes: {
      elapsed: $('#chatExecutionElapsed'),
      elapsedAction: $('#chatElapsedAction'),
      execution: $('#chatExecutionAction'),
      executionLabel: $('#chatExecutionState'),
      details: $('#chatCurrentName'),
      desktopInterrupt: $('#chatInterruptDesktop'),
      identity: $('#chatIdentityAction'),
      quota: $('#chatQuotaAction'),
      scroll: $('#chatStatusScroll'),
      notice: $('#chatStatusNotice'),
      feedback: els.composerError,
      hint: $('#chatStatusHint'),
      moveDraft: $('#chatMoveNativeDraft'),
      directory: $('#chatDirectoryAction'),
      context: $('#chatContextAction'),
    },
    openPopover,
    closePopover,
    currentPopover: () => popovers.element,
    checkOperation: (kind) =>
      kind === 'delivery' ? composer.checkDelivery() : sessionActions.check(),
    readAccount: (options) => {
      if (options?.refresh) void refreshChat(false);
      return nativeStatusRead.read(options);
    },
    interrupt: () => pauseCurrentSession(),
    latest: () => {
      chatScroll.enterLatest();
      if (chatStatus.interaction()?.reading === 'history') viewNativePane();
      renderSessionStatus(currentChatPane());
    },
    moveDraft: () => moveNativeDraft(),
  });

  /** 把当前查看的会话切到某个 pane。左栏点击与「恢复会话」弹层走的是同一条路径。 */
  /**
   * 按 pane 分组的状态。⚠️ **新增一处按 pane 或按 `paneId:` 前缀存的东西，登记到这里**
   * —— 清理散在各处的结果是必然漏掉某一个：此前会话身份变化时只清了 `toolOpen`，
   * `toolRunning` 与 `toolDetails` 留着旧会话的条目，而工具的 key 在没有 nativeId 时
   * 退回 `${owner.id}:${index}`，那是会跨会话重复的形状。
   */
  const PANE_STORES = () => [state.drafts, state.attachments, state.settings, state.outbox];
  const PANE_PREFIXED = () => [
    state.chatCache,
    state.fileCache,
    state.previewCache,
    state.toolOpen,
    state.toolDetails,
    state.toolRunning,
  ];

  /** 丢掉一个 pane 的全部随身状态。`keepIdentity` 用于会话换了身份但 pane 还在的情形。 */
  function forgetPane(paneId, { keepIdentity = false } = {}) {
    for (const [key, value] of sideSurfaces) if (value.paneId === paneId) sideSurfaces.delete(key);
    for (const [key, value] of mainSideAttachments)
      if (value.paneId === paneId) mainSideAttachments.delete(key);
    for (const store of PANE_STORES()) delete store[paneId];
    if (!keepIdentity) delete state.sessionIds[paneId];
    for (const store of PANE_PREFIXED()) {
      for (const key of store.keys()) if (key.startsWith(`${paneId}:`)) store.delete(key);
    }
  }

  /**
   * 已加载的历史窗口作废。⚠️ 三项必须一起清：只清 `chatMessages` 会让 `chatOldestId`
   * 还指着上一个会话的消息，「加载更早」从那儿接着往回翻。
   */
  function dropLoadedHistory() {
    state.chatMessages = [];
    state.chatOldestId = '';
    state.chatHasMore = false;
  }

  /**
   * 给按插入顺序增长的缓存封顶：Map 保持插入顺序，超了就从最旧的开始丢。
   *
   * ⚠️ 工具那三张表的键是 `${paneId}:${工具标识}`，**只增不减** —— 会话切换时
   * `forgetPane` 只清当前 pane 的那一片，别的 pane 留着。而 `toolDetails` 存的是
   * 工具的完整输入与输出，长周期任务跑几百个工具调用就能攒出几十 MB。
   */
  function capMap(map, limit) {
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  /**
   * 记下这个会话的模型设置。
   *
   * ⚠️ 正在保存时不要覆盖：那会抹掉 `saving` 标记，于是 `applyAgentSettings` 的
   * 「上一次还没存完就别再提交」失效，刚存好的结果也可能被一份在途的旧值盖回去。
   * 此前只有刷新那条路径检查了它，模型菜单与会话设置两处都是直接赋值。
   */
  function rememberSettings(paneId, settings) {
    if (!settings || state.settings[paneId]?.saving) return false;
    state.settings[paneId] = settings;
    return true;
  }

  /** 丢掉聊天区的渲染痕迹，下一次渲染从头来过而不是接着增量。 */
  function invalidateChatRender() {
    els.chatLog.dataset.signature = '';
    delete els.chatLog.dataset.rendered;
  }

  function chatCacheKey() {
    const pane = (state.chatAgents || []).find((p) => p.paneId === state.chatPaneId);
    return cacheKeyFor(pane, state.chatPaneId);
  }
  function cacheKeyFor(pane, paneId = pane?.paneId) {
    return `${basePath.includes('/machines/') || basePath.includes('/herdr-sessions/') || basePath.startsWith('/e/') ? basePath + ':' : ''}${paneId}:${pane?.terminalId || ''}:${pane?.agent?.session?.value || ''}`;
  }

  // Viewing a native pane is an intentional operation, separate from polling
  // and scrolling. Serialize selections so a slow A cannot finish after B.
  let nativeViewReady = false,
    adoptNativeOnRefresh = false;
  let nativeFocusRefresh = false;
  let nativeViewPending = null,
    nativeViewBusy = false,
    nativeWasAway = false,
    nativeViewErrorKey = '';
  const canViewNative = () =>
    query.get('surface') !== 'pane' &&
    !document.hidden &&
    !state.archived &&
    !state.settingsOpen &&
    state.connected;
  const nativeViewIdentity = () =>
    `${state.config?.rootDirectory}:${state.herdrRuntimeId}:${cacheKeyFor(currentChatPane(), state.chatPaneId)}`;
  function clearNativeViewError() {
    nativeViewErrorKey = '';
    reportError('', 'native-view');
  }
  function reconcileNativeViewError() {
    if (nativeViewErrorKey && nativeViewErrorKey !== nativeViewIdentity()) clearNativeViewError();
  }
  function sameNativeViewSelection(item) {
    const pane = currentChatPane();
    return (
      canViewNative() &&
      item.selectionVersion === state.selectionVersion &&
      item.rootDirectory === state.config?.rootDirectory &&
      item.expected.runtimeId === state.herdrRuntimeId &&
      pane?.paneId === item.target &&
      pane.terminalId === item.expected.terminalId
    );
  }
  async function locateNativePane(item) {
    const locate = (expected) =>
      api(appPath('/api/panes/view'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: item.target, expected }),
      });
    try {
      return await locate(item.expected);
    } catch (error) {
      // A new fork can report its session after the user selects its Tab.
      // Re-read once and complete that same selection only when the previously
      // empty identity becomes known in the same native runtime and terminal.
      // Existing sessions, replacement terminals and uncertain replies never
      // grant permission to replay navigation against a different target.
      if (
        error.code !== 'TARGET_CHANGED' ||
        item.expected.sessionId ||
        !sameNativeViewSelection(item)
      )
        throw error;
      const snapshot = await api(appPath('/api/snapshot'));
      const pane = (snapshot.panes || []).find((p) => p.paneId === item.target),
        sessionId = pane?.agent?.session?.value;
      const currentSession = currentChatPane()?.agent?.session?.value;
      if (
        !sameNativeViewSelection(item) ||
        snapshot.runtimeId !== item.expected.runtimeId ||
        (snapshot.rootDirectory && snapshot.rootDirectory !== item.rootDirectory) ||
        pane?.terminalId !== item.expected.terminalId ||
        pane.agent?.label?.toLowerCase() !== 'codex' ||
        typeof sessionId !== 'string' ||
        !sessionId ||
        (currentSession && currentSession !== sessionId)
      )
        throw error;
      item.resolvedKey = `${item.rootDirectory}:${snapshot.runtimeId}:${cacheKeyFor(pane)}`;
      return locate({ ...item.expected, sessionId });
    }
  }
  function viewNativePane() {
    const pane = currentChatPane();
    if (!canViewNative() || !pane?.terminalId || !state.herdrRuntimeId) return;
    clearNativeViewError();
    nativeViewPending = {
      key: nativeViewIdentity(),
      target: pane.paneId,
      rootDirectory: state.config?.rootDirectory,
      selectionVersion: state.selectionVersion,
      expected: {
        runtimeId: state.herdrRuntimeId,
        terminalId: pane.terminalId,
        sessionId: pane.agent?.session?.value || '',
      },
    };
    void drainNativeViews();
  }
  async function drainNativeViews() {
    if (nativeViewBusy) return;
    nativeViewBusy = true;
    try {
      while (nativeViewPending) {
        const item = nativeViewPending;
        nativeViewPending = null;
        if (!sameNativeViewSelection(item)) continue;
        if (item.key !== nativeViewIdentity()) {
          const pane = currentChatPane(),
            sessionId = pane.agent?.session?.value;
          if (item.expected.sessionId || pane.agent?.label?.toLowerCase() !== 'codex' || !sessionId)
            continue;
          // The identity may finish initializing while an earlier selection
          // drains. Preserve this user intent without replaying the old one.
          item.expected = { ...item.expected, sessionId };
          item.key = nativeViewIdentity();
        }
        try {
          await locateNativePane(item);
          if (
            sameNativeViewSelection(item) &&
            [item.key, item.resolvedKey].includes(nativeViewIdentity())
          ) {
            clearNativeViewError();
          }
        } catch (error) {
          if (
            sameNativeViewSelection(item) &&
            [item.key, item.resolvedKey].includes(nativeViewIdentity())
          ) {
            nativeViewErrorKey = item.resolvedKey || item.key;
            reportError(`原生会话定位失败：${error.message}`, 'native-view');
          }
        }
      }
    } finally {
      nativeViewBusy = false;
      observeCurrentTerminal();
      if (canViewNative() && state.herdrShell?.tabNavigation()) {
        nativeFocusRefresh = true;
        void refreshChat(false);
      }
    }
  }

  function switchToPane(paneId, { native = false, observeOnly = false } = {}) {
    if (!observeOnly) workspaceFiles?.close(false);
    closeDeviceSettings(false);
    closePopover();
    leaveArchived();
    if (!native) {
      nativeViewReady = true;
      adoptNativeOnRefresh = false;
    }
    if (paneId === state.chatPaneId) {
      const pane = currentChatPane();
      if (
        pane &&
        (state.selectedWorkspaceId !== pane.workspaceId || state.selectedTabId !== pane.tabId)
      ) {
        state.selectedWorkspaceId = pane.workspaceId;
        state.selectedTabId = pane.tabId;
        renderChatPicker();
      }
      if (!observeOnly) {
        chatScroll.enterLatest();
        if (isTerminalPresentation()) shellTerminal.focus();
      }
      if (!observeOnly) viewNativePane();
      setChatDrawerOpen(false);
      return;
    }
    messageEdit?.cancel();
    saveDraft();
    saveChatCache();
    setFilesPage(false);
    state.chatPaneId = paneId;
    rememberPane();
    setChatContentReady(false);
    renderAttachments();
    renderAgentStartup(null);
    renderAgentQuestion(null);
    state.selectionVersion += 1;
    // ⚠️ 这里原先只清 chatMessages，chatOldestId 与 chatHasMore 留着上一个会话的值：
    // 在刷新把它们纠正过来之前，「加载更早」会从上一个会话的位置接着往回翻。
    dropLoadedHistory();
    els.commandInput.value = state.drafts[paneId] || draftStore.get(currentChatPane()) || '';
    state.drafts[paneId] = els.commandInput.value;
    state.composerIdentity = window.StudioDrafts.identity(currentChatPane());
    restoreMessageEditDraft();
    invalidateChatRender();
    chatStatus.reset();
    renderChatStatus({});
    renderChatMessages([]);
    renderAgentActions();
    setChatDrawerOpen(false);
    renderChatPicker();
    restoreChatCache();
    if (!observeOnly) viewNativePane();
    observeCurrentTerminal();
    void refreshChat((state.chatAgents || []).some((p) => p.paneId === paneId));
  }

  /** 「会话」:候选就是左栏那份 —— 数据早就在手里,不必去问终端。 */
  function openSessionPopover(anchor) {
    const agents = state.chatAgents || [];
    openPopover(anchor, {
      title: '切到会话',
      items: agents.map((pane) => ({
        id: pane.paneId,
        label: UI.sessionLabel(pane),
        aside: pane.agent?.label || '终端',
        current: pane.paneId === state.chatPaneId,
      })),
      emptyText: '还没有会话',
      onPick: (item) => switchToPane(item.id),
    });
  }

  const slash = {
    paneId: '',
    catalog: null,
    loading: null,
    query: null,
    index: 0,
    items: [],
    dismissed: null,
    composing: false,
    fetchedAt: 0,
  };
  function closeSlashCommands() {
    els.slashCommands.hidden = true;
    els.commandInput.setAttribute('aria-expanded', 'false');
    els.commandInput.removeAttribute('aria-activedescendant');
  }
  function renderAgentActions() {
    if (slash.paneId !== state.chatPaneId) {
      nativeCommands?.reset();
      slash.paneId = state.chatPaneId;
      slash.catalog = null;
      slash.loading = null;
      slash.dismissed = null;
      closeSlashCommands();
    }
    if (currentProvider() === 'codex') nativeCommands?.warm?.();
    renderSlashCommands();
  }
  async function loadSlashCommands() {
    const paneId = state.chatPaneId;
    if (!paneId || slash.loading || slash.catalog) return;
    const request = {};
    slash.loading = request;
    try {
      const data = await api(appPath(`/api/commands?pane=${encodeURIComponent(paneId)}`));
      if (state.chatPaneId !== paneId || slash.loading !== request) return;
      if (data.provider === 'codex' && !data.commands.some((item) => item.name === 'effort'))
        data.commands.push({ name: 'effort', description: '选择当前模型的推理强度' });
      slash.catalog = data;
      slash.fetchedAt = Date.now();
    } catch {
      if (slash.loading === request) {
        slash.catalog = { commands: [], reason: '暂时无法读取命令' };
        slash.fetchedAt = Date.now();
      }
    } finally {
      if (slash.loading === request) {
        slash.loading = null;
        renderSlashCommands();
      }
    }
  }
  function renderSlashCommands() {
    if (messageEdit?.active() || messageEdit?.busy()) {
      closeSlashCommands();
      return;
    }
    if (currentProvider() === 'codex') {
      if (
        !slash.composing &&
        slash.dismissed !== els.commandInput.value &&
        (document.activeElement === els.commandInput || nativeCommands?.active()) &&
        nativeCommands?.sync()
      )
        return;
      closeSlashCommands();
      return;
    }
    const search = window.StudioSlashCommands.query(
      els.commandInput.value,
      els.commandInput.selectionStart,
    );
    if (
      slash.composing ||
      search === null ||
      !state.chatPaneId ||
      slash.dismissed === els.commandInput.value ||
      document.activeElement !== els.commandInput
    ) {
      closeSlashCommands();
      return;
    }
    if (slash.catalog && Date.now() - slash.fetchedAt > 60000) slash.catalog = null;
    if (slash.query !== search) {
      slash.query = search;
      slash.index = 0;
    }
    slash.items = window.StudioSlashCommands.filter(slash.catalog?.commands || [], search);
    slash.index = Math.max(0, Math.min(slash.index, slash.items.length - 1));
    els.slashCommands.replaceChildren();
    els.slashCommands.setAttribute(
      'aria-label',
      slash.catalog
        ? `${slash.catalog.provider === 'claude' ? 'Claude Code' : 'Codex'} 命令`
        : '命令候选',
    );
    if (!slash.catalog) {
      const loading = chatText(document.createElement('div'), '正在读取…');
      loading.className = 'slash-caption';
      els.slashCommands.append(loading);
    }
    if (slash.catalog && !slash.items.length) {
      const empty = chatText(
        document.createElement('div'),
        slash.catalog.reason || '没有匹配的命令',
      );
      empty.className = 'slash-caption';
      els.slashCommands.append(empty);
    }
    slash.items.forEach((command, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.className = 'slash-option';
      option.id = `slash-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === slash.index));
      const name = chatText(document.createElement('span'), `/${command.name}`);
      name.className = 'slash-name';
      option.append(name);
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => pickSlashCommand(index));
      els.slashCommands.append(option);
    });
    els.slashCommands.hidden = false;
    els.commandInput.setAttribute('aria-expanded', 'true');
    if (slash.items.length) {
      els.commandInput.setAttribute('aria-activedescendant', `slash-option-${slash.index}`);
      els.slashCommands
        .querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    } else els.commandInput.removeAttribute('aria-activedescendant');
    if (!slash.catalog && !slash.loading) void loadSlashCommands();
  }
  function pickSlashCommand(index = slash.index) {
    if (messageEdit?.active() || messageEdit?.busy()) return;
    const command = slash.items[index];
    if (!command) return;
    closeSlashCommands();
    els.commandInput.value = '';
    saveDraft();
    void runComposerAction(command);
  }

  async function runComposerAction(command) {
    if (messageEdit?.active() || messageEdit?.busy()) return;
    try {
      if (currentProvider() === 'codex') {
        els.commandInput.value = `/${command.name}`;
        els.commandInput.focus();
        nativeCommands.sync();
        nativeCommands.enter();
        return;
      }
      if (command.name === 'model') return await openModelPopover(els.commandInput);
      if (command.name === 'effort') return await openCurrentEffort();
      els.commandInput.value = `/${command.name} `;
      els.commandInput.focus();
      saveDraft();
    } catch (error) {
      reportError(error.message || '操作失败');
    }
  }

  nativeCommands = window.StudioCommandInteraction.create({
    input: els.commandInput,
    list: els.slashCommands,
    host: $('#chatInput'),
    request: (body) =>
      api(appPath('/api/command-interaction'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    target: () => {
      const pane = currentChatPane();
      return !messageEdit?.active() &&
        !messageEdit?.busy() &&
        currentProvider() === 'codex' &&
        !state.archived &&
        state.connected &&
        pane
        ? {
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            sessionId: pane.agent?.session?.value || '',
            runtimeId: state.herdrRuntimeId,
          }
        : null;
    },
    identity: () => `${chatCacheKey()}:${state.herdrRuntimeId}`,
    onBegin: () => {
      draftStore.set(currentChatPane(), '');
      state.drafts[state.chatPaneId] = '';
    },
    onChange: () => {
      if (nativeCommands && !nativeCommands.active()) saveDraft();
      else renderSessionStatus(currentChatPane());
    },
    closePopover,
  });
  nativeCommands = window.StudioCommandMenu.create({
    native: nativeCommands,
    input: els.commandInput,
    list: els.slashCommands,
    host: $('#chatInput'),
    openGoal: (command) =>
      goalDialog.open(currentGoal?.key === chatCacheKey() ? currentGoal.value : null, command),
    loadCatalog: (provider) => agentSettings.loadAgentCatalog(provider),
    applySettings: (target, changes, prepare) => {
      const pane = currentChatPane();
      if (
        target.runtimeId !== state.herdrRuntimeId ||
        target.terminalId !== pane?.terminalId ||
        target.sessionId !== pane?.agent?.session?.value
      )
        return false;
      return agentSettings.applyAgentSettings(changes, undefined, prepare);
    },
    request: (path, options) => api(appPath(path), options),
    target: () => {
      const pane = currentChatPane();
      return !messageEdit?.active() &&
        !messageEdit?.busy() &&
        currentProvider() === 'codex' &&
        !state.archived &&
        state.connected &&
        pane
        ? {
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            sessionId: pane.agent?.session?.value || '',
            runtimeId: state.herdrRuntimeId,
          }
        : null;
    },
    identity: () => `${chatCacheKey()}:${state.herdrRuntimeId}`,
    settings: () => state.settings[state.chatPaneId],
    onBegin: () => {
      draftStore.set(currentChatPane(), '');
      state.drafts[state.chatPaneId] = '';
    },
    onSettings: (target, value) => {
      if (
        currentChatPane()?.terminalId === target.terminalId &&
        (currentChatPane()?.agent?.session?.value || '') === target.sessionId
      )
        rememberSettings(target.paneId, value);
    },
    onChange: () => {
      if (!nativeCommands.active()) saveDraft();
      else renderSessionStatus(currentChatPane());
    },
    closePopover,
  });

  function saveDraft() {
    if (sideThreads.active()) {
      captureSideSurface();
      if (sideDraftPane()) {
        draftStore.load(state.config?.rootDirectory);
        draftStore.set(sideDraftPane(), els.commandInput.value);
      }
      renderSessionStatus(currentChatPane());
      return;
    }
    if (messageEdit?.draftChanged()) {
      renderSessionStatus(currentChatPane());
      closeSlashCommands();
      return;
    }
    if (nativeCommands?.active()) {
      renderSessionStatus(currentChatPane());
      renderSlashCommands();
      return;
    }
    if (state.chatPaneId) {
      messageEditDrafts.delete(
        JSON.stringify([
          state.config?.rootDirectory,
          window.StudioDrafts.identity(currentChatPane()),
        ]),
      );
      state.drafts[state.chatPaneId] = els.commandInput.value;
      draftStore.load(state.config?.rootDirectory);
      draftStore.set(currentChatPane(), els.commandInput.value);
      state.composerIdentity = window.StudioDrafts.identity(currentChatPane());
    }
    renderSessionStatus((state.chatAgents || []).find((p) => p.paneId === state.chatPaneId));
    renderSlashCommands();
  }

  composer = window.StudioComposer.create({
    state,
    els,
    reportError,
    currentProvider,
    currentChatPane,
    saveDraft,
    runComposerAction,
    renderAttachments,
    renderChatMessages,
    api,
    appPath,
    applyOutboxUpdate,
    refreshChat,
    renderSessionStatus,
    clearSubmittedDraft: (pane, draft, root) => {
      if (state.config?.rootDirectory === root && draftStore.get(pane) === draft)
        draftStore.set(pane, '');
    },
  });
  function interruptTarget(pane = currentChatPane()) {
    return pane?.agent?.session?.value
      ? {
          paneId: pane.paneId,
          terminalId: pane.terminalId,
          sessionId: pane.agent.session.value,
          runtimeId: state.herdrRuntimeId,
          processRuntimeId: pane.runtimeId,
          turnId:
            pane.paneId === state.lastChatStatus?.identity?.paneId
              ? state.lastChatStatus.turnId
              : undefined,
          binding:
            pane.paneId === state.lastChatStatus?.identity?.paneId
              ? state.lastChatStatus.binding
              : undefined,
        }
      : null;
  }
  sessionActions = window.StudioSessionActions.create({
    target: interruptTarget,
    scope: () => JSON.stringify([basePath, state.config?.rootDirectory]),
    request: (path, options) => api(appPath(path), options),
    onChange: () => renderSessionStatus(currentChatPane()),
    refresh: () => refreshChat(false),
  });
  async function forkSideSession(value) {
    const pane = currentChatPane();
    if (!value?.structured || !value.sideId || !pane) return;
    try {
      await window.StudioSessionFork.run({
        target: {
          paneId: pane.paneId,
          terminalId: pane.terminalId,
          sessionId: pane.agent.session.value,
          runtimeId: state.herdrRuntimeId,
          sideId: value.sideId,
        },
        request: ({ action, ...body }) =>
          action === 'start'
            ? api(appPath('/api/agents/fork'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              })
            : api(
                appPath('/api/agents/fork?' + new URLSearchParams({ requestId: body.requestId })),
              ),
      });
      void refreshChat();
    } catch (error) {
      reportError(error.message);
    }
  }
  let sideSending = false;
  async function sendSideMessage() {
    if (sideSending || !state.connected) return;
    const draft = els.commandInput.value,
      attachments = [...(state.attachments[state.chatPaneId] || [])];
    if (attachments.some((item) => item.status !== 'ready')) return;
    const text = [
      draft,
      ...attachments.map((item) => `附件：${item.name}\n文件路径：${JSON.stringify(item.path)}`),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!text.trim()) return;
    const key = sideSurfaceKey();
    sideSending = true;
    renderSessionStatus(currentChatPane());
    try {
      const result = await sideThreads.send(text);
      if (result?.submitted) {
        const cached = sideSurfaces.get(key);
        if (cached?.draft === draft) cached.draft = '';
        if (result.sideId) {
          const pane = sideDraftPane(result);
          if (pane && draftStore.get(pane) === draft) draftStore.set(pane, '');
        }
        if (cached) cached.attachments = [];
      }
      if (result?.submitted && key === sideSurfaceKey() && sideThreads.active()) {
        if (els.commandInput.value === draft) els.commandInput.value = '';
        state.attachments[state.chatPaneId] = [];
        saveDraft();
        renderAttachments();
      }
    } finally {
      sideSending = false;
      renderSessionStatus(currentChatPane());
      void refreshChat();
    }
  }
  function writeComposer() {
    if (nativeStatusView.active()) return;
    if (messageEdit?.busy()) return;
    if (messageEdit?.active()) return messageEdit.send();
    if (
      !document.querySelector('#agentStartup').hidden ||
      (currentQuestion && currentQuestion.blocking !== false)
    )
      return;
    const nativeInput = chatStatus.interaction();
    if (
      !nativeCommands?.active() &&
      nativeInput &&
      !nativeInput.stale &&
      ['menu', 'form', 'authentication', 'confirmation'].includes(nativeInput.inputTarget)
    )
      return;
    if (
      currentProvider() === 'codex' &&
      (nativeCommands.active() || els.commandInput.value.startsWith('/'))
    ) {
      els.commandInput.focus({ preventScroll: true });
      nativeCommands.sync();
      nativeCommands.enter();
      return;
    }
    if (sideThreads.active() && sideThreads.view()?.structured)
      return sendSideMessage().catch((error) => reportError(error.message));
    return composer.send();
  }

  function messageEditContext() {
    const pane = currentChatPane(),
      root = state.config?.rootDirectory || '';
    const observed = state.lastChatStatus?.identity;
    const bindingCurrent =
      observed?.paneId === pane?.paneId &&
      observed?.terminalId === pane?.terminalId &&
      observed?.runtimeId === (pane?.runtimeId || null) &&
      observed?.sessionId === pane?.agent?.session?.value;
    const pending =
      state.composerRequests?.get(`${root}:${window.StudioDrafts.identity(pane)}`) ||
      state.composerTerminalRequests?.get(
        JSON.stringify([root, state.herdrRuntimeId, pane?.paneId, pane?.terminalId]),
      );
    const ownRequest = messageEdit?.view()?.requestId;
    const blockedBySend = pending && pending.id !== ownRequest;
    const nativeBinding = pane
      ? {
          runtimeId: state.herdrRuntimeId,
          paneId: pane.paneId,
          terminalId: pane.terminalId,
          sessionId: pane.agent?.session?.value || '',
          binding: bindingCurrent ? state.lastChatStatus.binding : undefined,
        }
      : null;
    return {
      identity: JSON.stringify([
        basePath,
        root,
        state.herdrRuntimeId,
        pane?.paneId,
        pane?.terminalId,
        pane?.runtimeId,
        pane?.agent?.label,
        pane?.agent?.session?.value,
      ]),
      root,
      runtimeId: state.herdrRuntimeId,
      paneId: pane?.paneId,
      terminalId: pane?.terminalId,
      nativeBinding,
      pane: pane && {
        ...pane,
        agent: pane.agent && {
          ...pane.agent,
          session: pane.agent.session && { ...pane.agent.session },
        },
      },
      provider: currentProvider(),
      mode: isTerminalPresentation() ? 'terminal' : 'structured',
      connected: state.connected,
      archived: Boolean(state.archived),
      side: sideThreads.active(),
      composing: slash.composing,
      ready: Boolean(
        state.chatContentReady &&
        state.snapshotReady &&
        bindingCurrent &&
        pane?.agent?.session?.value &&
        !nativeCommands?.active() &&
        !nativeStatusView.active() &&
        !state.filesOpen &&
        !state.settingsOpen &&
        !currentQuestion &&
        !blockedBySend,
      ),
    };
  }
  function prepareMessageEditSnapshot(snapshot) {
    const previous = currentChatPane(),
      next = snapshot.panes?.find((pane) => pane.paneId === state.chatPaneId);
    if (
      previous &&
      (!next ||
        previous.terminalId !== next.terminalId ||
        previous.runtimeId !== next.runtimeId ||
        previous.agent?.session?.value !== next.agent?.session?.value ||
        (state.herdrRuntimeId && snapshot.runtimeId && state.herdrRuntimeId !== snapshot.runtimeId))
    )
      messageEdit?.cancel();
  }
  function writeMessageEditDraft(value, owner, options) {
    const current = messageEditContext(),
      here = current.root === owner.root && current.identity === owner.identity;
    const ownerDraftKey = JSON.stringify([owner.root, window.StudioDrafts.identity(owner.pane)]);
    if (!options.editing) {
      messageEditDrafts.set(ownerDraftKey, value);
      try {
        draftStore.load(owner.root);
        draftStore.set(owner.pane, value.text);
      } finally {
        draftStore.load(state.config?.rootDirectory);
      }
    }
    const live = (state.allPanes || state.chatAgents || []).find(
      (pane) => pane.paneId === owner.pane?.paneId,
    );
    const matches =
      state.config?.rootDirectory === owner.root &&
      live?.terminalId === owner.pane?.terminalId &&
      window.StudioDrafts.identity(live) === window.StudioDrafts.identity(owner.pane);
    if (matches) {
      if (!options.editing) state.drafts[owner.pane.paneId] = value.text;
      state.attachments[owner.pane.paneId] = [...value.attachments];
    }
    if (!here) return;
    messageEditDrafts.delete(ownerDraftKey);
    els.commandInput.value = value.text;
    els.commandInput.setSelectionRange(
      value.selectionStart ?? value.text.length,
      value.selectionEnd ?? value.text.length,
      value.selectionDirection || 'none',
    );
    els.commandInput.scrollTop = value.scrollTop || 0;
    composerHeight.schedule();
    renderAttachments();
    renderSessionStatus(currentChatPane());
  }
  function restoreMessageEditDraft() {
    const pane = currentChatPane(),
      key = JSON.stringify([state.config?.rootDirectory, window.StudioDrafts.identity(pane)]);
    const value = messageEditDrafts.get(key);
    if (!value || value.text !== els.commandInput.value) return;
    messageEditDrafts.delete(key);
    state.attachments[pane.paneId] = [...value.attachments];
    els.commandInput.setSelectionRange(
      value.selectionStart ?? value.text.length,
      value.selectionEnd ?? value.text.length,
      value.selectionDirection || 'none',
    );
    els.commandInput.scrollTop = value.scrollTop || 0;
    composerHeight.schedule();
    renderAttachments();
  }

  let currentQuestion = null;
  const questionDrafts = new Map();
  // Agent 提问。渲染交给来源自己的渲染器（两家机制不同，见 PRODUCT_SPEC 2.6），
  // 这里只管位置、草稿、提交和身份校验。
  //
  // 摘要与有限高度的回答区都固定在输入框上方，本地浏览不改变原生焦点。
  let questionState = null;
  let questionSignature = '';
  let messageEditReceiptTimer = 0,
    messageEditReceiptPending = false;
  function scheduleMessageEditReceipt() {
    if (messageEditReceiptTimer || messageEdit?.view()?.phase !== 'uncertain') return;
    messageEditReceiptTimer = setTimeout(async () => {
      messageEditReceiptTimer = 0;
      const before = messageEdit?.view();
      if (!before || before.phase !== 'uncertain') return;
      if (!state.connected || document.hidden || messageEditReceiptPending) {
        scheduleMessageEditReceipt();
        return;
      }
      messageEditReceiptPending = true;
      try {
        const receipt = await composer.checkReceipt(before.requestId);
        messageEdit.settle({ ...before, ...receipt });
      } finally {
        messageEditReceiptPending = false;
        scheduleMessageEditReceipt();
      }
    }, 800);
  }
  messageEdit = window.StudioMessageEdit.create({
    log: els.chatLog,
    input: els.commandInput,
    container: $('#chatInput'),
    popovers,
    context: messageEditContext,
    messageFor: (element) => chatContainer.messageFor(element),
    readDraft: () => ({
      text: els.commandInput.value,
      attachments: state.attachments[state.chatPaneId] || [],
      selectionStart: els.commandInput.selectionStart,
      selectionEnd: els.commandInput.selectionEnd,
      selectionDirection: els.commandInput.selectionDirection,
      scrollTop: els.commandInput.scrollTop,
    }),
    writeDraft: writeMessageEditDraft,
    prepare: ({ nativeBinding, signal, ...body }) =>
      api(appPath('/api/agents/rewind'), {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'prepare', ...nativeBinding, ...body }),
      }),
    send: (options) => composer.send(options),
    reportError,
    onChange: () => {
      closeSlashCommands();
      if (!messageEdit?.active() && !messageEdit?.busy()) saveDraft();
      else renderSessionStatus(currentChatPane());
      scheduleMessageEditReceipt();
    },
  });
  const queuedQuestions = window.StudioQuestionInteraction.create({
    box: $('#chatInlineQuestion'),
    summary: $('#chatQuestionSummary'),
    input: els.commandInput,
    ownerOf: () => {
      const pane = currentChatPane();
      return pane
        ? JSON.stringify([
            pane.paneId,
            pane.terminalId,
            pane.runtimeId || '',
            pane.agent?.session?.value || '',
          ])
        : '';
    },
    enabled: () =>
      !messageEdit?.active() &&
      !messageEdit?.busy() &&
      state.connected &&
      currentQuestion?.observation !== 'stale' &&
      !nativeCommands?.active() &&
      !state.archived &&
      !state.settingsOpen,
    draftScope: () => `${basePath}:${deviceId}:${state.config?.rootDirectory || ''}`,
    checkReceipt: (pane, requestId) =>
      api(appPath('/api/agents/questions?' + new URLSearchParams({ pane, requestId }))),
    request: (body) =>
      api(appPath('/api/agents/questions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    refresh: async () => {
      const pane = currentChatPane(),
        version = state.selectionVersion;
      const result = await api(
        appPath('/api/agents/questions?pane=' + encodeURIComponent(pane.paneId)),
        { signal: selectionSignal() },
      );
      if (version === state.selectionVersion) renderAgentQuestion(result.question);
      void refreshChat(false);
    },
  });
  async function moveNativeDraft() {
    if (!state.connected || state.archived || messageEdit?.active() || nativeCommands?.active())
      return;
    const pane = currentChatPane(),
      version = state.selectionVersion;
    if (!pane) return;
    const key = nativeDraftKey(pane);
    if (nativeDraftMoves.has(key)) return;
    const same = () =>
      version === state.selectionVersion && key === nativeDraftKey(currentChatPane());
    const call = (body) =>
      api(appPath('/api/agents/native-draft'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    nativeDraftMoves.add(key);
    renderSessionStatus(pane);
    let copied = false;
    try {
      // Dashboard panes omit process identity. Obtain the exact read-only
      // binding before preparing; a normal first observation is not an error.
      const matches = (value) =>
        value?.binding &&
        value.identity?.paneId === pane.paneId &&
        value.identity?.terminalId === pane.terminalId &&
        (value.identity?.sessionId || '') === (pane.agent?.session?.value || '');
      let observed = state.lastChatStatus;
      if (!matches(observed))
        observed = await api(
          transcriptPath(pane.paneId, pane.agent?.session?.value) + '&window=0',
          { signal: selectionSignal() },
        );
      if (!same()) return;
      if (!matches(observed)) throw new Error('无法确认原生会话身份，终端内容未改变。');
      const draft = await call({
        action: 'prepare',
        paneId: pane.paneId,
        binding: observed.binding,
      });
      if (!same()) return;
      if (!draft.text) {
        reportError('', 'native-draft');
        void refreshChat(false);
        return;
      }
      const current = els.commandInput.value;
      const merged =
        current === draft.text || current.endsWith('\n\n' + draft.text)
          ? current
          : current
            ? current + '\n\n' + draft.text
            : draft.text;
      if (!draftStore.set(pane, merged)) throw new Error('Swift草稿尚未保存，终端内容未清空。');
      els.commandInput.value = merged;
      state.drafts[pane.paneId] = merged;
      copied = true;
      saveDraft();
      await call({
        action: 'clear',
        paneId: draft.paneId,
        binding: draft.binding,
        revision: draft.revision,
      });
      if (same()) {
        reportError('', 'native-draft');
        els.commandInput.focus({ preventScroll: true });
        void refreshChat(false);
      }
    } catch (error) {
      if (same())
        reportError(
          copied ? '内容已保存到Swift，但尚未确认终端清空：' + error.message : error.message,
          'native-draft',
        );
    } finally {
      nativeDraftMoves.delete(key);
      renderSessionStatus(currentChatPane());
    }
  }
  async function refreshNativeQuestion() {
    const pane = currentChatPane(),
      observation = chatStatus.interaction(),
      modal = observation?.modal;
    if (
      !pane ||
      state.archived ||
      !state.connected ||
      isTerminalPresentation() ||
      nativeCommands?.active() ||
      observation?.stale ||
      !modal ||
      currentQuestion?.nativeModal?.key === modal.key
    )
      return;
    const identity = (target) =>
      JSON.stringify([
        state.herdrRuntimeId,
        state.config?.rootDirectory,
        target?.paneId,
        target?.terminalId,
        target?.runtimeId,
        target?.agent?.session?.value,
      ]);
    const version = state.selectionVersion,
      binding = identity(pane),
      key = JSON.stringify([version, binding, modal.key]);
    if (nativeQuestionRead?.key === key) return;
    const pending = { key };
    nativeQuestionRead = pending;
    try {
      // A native prompt can arrive while the transcript/control request
      // is unavailable. Read its choices directly; observation never answers it.
      const result = await api(
        appPath('/api/agents/questions?pane=' + encodeURIComponent(pane.paneId)),
        { signal: selectionSignal() },
      );
      if (
        version === state.selectionVersion &&
        identity(currentChatPane()) === binding &&
        chatStatus.interaction()?.modal?.key === modal.key &&
        result.question?.nativeModal?.key === modal.key
      ) {
        renderAgentQuestion(result.question);
        renderSessionStatus(currentChatPane());
      }
    } catch {
      /* Existing refresh and native observation can retry a read, never an answer. */
    } finally {
      if (nativeQuestionRead === pending) nativeQuestionRead = null;
    }
  }
  function renderAgentQuestion(prompt) {
    if (nativeCommands?.active()) prompt = null;
    // A failed transcript snapshot cannot invalidate choices independently
    // read from the same live native quota prompt.
    const observed = chatStatus.interaction();
    if (
      prompt?.observation === 'stale' &&
      prompt.nativeModal &&
      observed &&
      !observed.stale &&
      observed.modal?.key === prompt.nativeModal.key
    )
      prompt = { ...prompt, observation: undefined };
    rememberStartupDraft(prompt);
    const box = $('#chatInlineQuestion');
    if (prompt?.provider === 'codex' && (prompt.queued || prompt.nativeModal)) {
      currentQuestion = prompt;
      questionState = null;
      questionSignature = '';
      queuedQuestions.update(prompt);
      if (!prompt.collapsed) $('#chatStatus').hidden = false;
      return;
    }
    queuedQuestions.update(null);
    if (!prompt && queuedQuestions.active()) {
      currentQuestion = null;
      questionState = null;
      return;
    }
    // 换问题之前存一下草稿：切走再回来不该丢掉已经选好的。
    if (currentQuestion && questionState)
      questionDrafts.set(currentQuestion.draftKey, {
        choices: questionState.choices.slice(),
        text: questionState.text,
      });
    if (questionDrafts.size > 32) questionDrafts.delete(questionDrafts.keys().next().value);

    const sameOne = currentQuestion && prompt && currentQuestion.challenge === prompt.challenge;
    currentQuestion = prompt;
    if (!prompt) {
      questionState = null;
      box.hidden = true;
      box.replaceChildren();
      els.chatStatus.hidden = els.banner.hidden && els.chatArchivedNotice.hidden;
      return;
    }
    if (!sameOne) {
      const saved = questionDrafts.get(prompt.draftKey);
      questionState = {
        choices: saved
          ? saved.choices.slice()
          : (prompt.checked || []).map((on, i) => (on ? i : -1)).filter((i) => i >= 0),
        text: saved?.text || '',
        status: '',
        error: '',
        locked: false,
      };
    }
    if (prompt.delivery) {
      questionState.locked = true;
      questionState.status = prompt.delivery === 'sent' ? '已提交' : '提交状态待确认';
    } else if (prompt.editing) {
      questionState.locked = true;
      questionState.status = '终端正在编辑答案';
    }
    // 同一道题、卡片上显示的东西也没变，就不重画：会话在跑时这里几秒就来一次，每次重画都会把输入框
    // 整个换掉，打到一半的字和光标就断了 —— 一个字一个字打不进去、一把粘贴却可以（2026-09-25 用户指出）。
    // 终端里光标停在哪、面板收起还是展开，这些不显示在卡片上，变了也不必重画。
    const signature = JSON.stringify([
      prompt.challenge,
      prompt.provider,
      prompt.question,
      prompt.header,
      prompt.options,
      prompt.stage,
      prompt.review,
      prompt.index,
      prompt.total,
      prompt.allowText,
      prompt.multiSelect,
      prompt.isSecret,
      questionState.locked,
      questionState.status,
      questionState.error,
    ]);
    if (sameOne && questionSignature === signature && $('#chatInlineQuestion').childElementCount)
      return;
    questionSignature = signature;
    paintQuestion(prompt);
  }

  function paintQuestion(prompt) {
    const box = $('#chatInlineQuestion');
    // 确实要重画时（比如提交状态变了），把焦点和光标还回输入框。
    const typing =
      box.contains(document.activeElement) &&
      /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)
        ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
        : null;
    const { renderer } = window.StudioRenderers.for(
      prompt.provider || UI.providerId(paneOf()) || '',
    );
    const host = {
      state: questionState,
      onToggle(index) {
        if (questionState.locked) return;
        // 单选点一下就换掉，多选来回切。选了选项就清掉自填，两者互斥。
        questionState.choices = prompt.multiSelect
          ? questionState.choices.includes(index)
            ? questionState.choices.filter((i) => i !== index)
            : [...questionState.choices, index]
          : questionState.choices[0] === index
            ? []
            : [index];
        if (questionState.choices.length) questionState.text = '';
        questionState.error = '';
        paintQuestion(prompt);
      },
      onText(value) {
        questionState.text = value;
        if (value) questionState.choices = [];
      },
      onSubmit: () => submitQuestion(prompt),
    };
    box.replaceChildren(
      renderer.renderQuestion
        ? renderer.renderQuestion(prompt, host)
        : window.StudioRendererCommon.renderQuestion(prompt, host, {
            heading: '需要你的回答',
            describeOption: (option) => option.label,
          }),
    );
    const input = typing && box.querySelector('textarea:not(:disabled), input:not(:disabled)');
    if (input) {
      input.focus({ preventScroll: true });
      try {
        input.setSelectionRange(typing.start, typing.end);
      } catch {
        /* 密码框不支持 */
      }
    }
    box.hidden = false;
    $('#chatStatus').hidden = false;
  }

  async function submitQuestion(prompt) {
    if (questionState.locked) return;
    const text = (questionState.text || '').trim();
    if (prompt.stage !== 'review' && !questionState.choices.length && !text) {
      questionState.error = '先选一个，或者自己写一个答案';
      paintQuestion(prompt);
      return;
    }
    questionState.locked = true;
    questionState.status = '正在提交…';
    questionState.error = '';
    paintQuestion(prompt);
    try {
      const result = await api(appPath('/api/agents/questions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paneId: prompt.paneId,
          sessionId: prompt.sessionId,
          challenge: prompt.challenge,
          choices: questionState.choices,
          text,
          confirm: prompt.stage === 'review',
        }),
      });
      if (currentQuestion?.challenge !== prompt.challenge) return;
      questionState.status = result?.delivery === 'uncertain' ? '提交状态待确认' : '已提交';
      paintQuestion(prompt);
      questionDrafts.delete(prompt.draftKey);
    } catch (error) {
      if (currentQuestion?.challenge !== prompt.challenge) return;
      // 失败后解锁重试：下一次读取会决定这个问题是否还在。
      questionState.locked = false;
      questionState.status = '';
      questionState.error = error.message;
      paintQuestion(prompt);
    }
    refreshChat();
  }

  function renderAgentStartup(prompt) {
    const box = document.querySelector('#agentStartup');
    if (box.dataset.signature === (prompt?.challenge || '')) return;
    box.dataset.signature = prompt?.challenge || '';
    box.hidden = !prompt;
    box.replaceChildren();
    renderSessionStatus((state.chatAgents || []).find((p) => p.paneId === state.chatPaneId));
    if (!prompt) return;
    const title = document.createElement('strong');
    title.textContent = 'Claude Code 需要确认目录';
    const note = document.createElement('p');
    note.textContent = `是否信任 ${prompt.cwd}？确认后 Claude Code 可以读取、修改文件并执行命令。`;
    box.append(title, note);
    for (const [choice, label] of [
      ['reject', '退出'],
      ['trust', '信任此目录并继续'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-btn';
      button.textContent = label;
      button.addEventListener('click', async () => {
        box.querySelectorAll('button').forEach((el) => {
          el.disabled = true;
        });
        try {
          await api(appPath('/api/agents/startup'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ paneId: prompt.paneId, challenge: prompt.challenge, choice }),
          });
          renderAgentStartup(null);
        } catch (error) {
          reportError(error.message);
          box.querySelectorAll('button').forEach((el) => {
            el.disabled = false;
          });
        }
        refreshChat();
      });
      box.append(button);
    }
  }

  // 「已经看过」是**设备本地的视图状态**，和折叠分组、栏宽同类：另一台设备看过
  // 不代表这台也看过。`storage` 这一袋按「根目录 + 设备标识」存，正合这个语义
  // （键要在 lib/root-preferences.js 的白名单里，否则服务端 400）。
  //
  // 按会话身份存最后看到的那条消息时间 —— 之后再有新消息，它自然又变回
  // 「没看过」，不必另外清。
  const SEEN_KEY = 'studioSeenDone';
  // 本机也存一份，页面脚本一加载就读出来：左栏第一次画（本地缓存、本地副本）在设备配置取回来之前，
  // 只靠服务端那份的话，那一刻记录是空的，每次进来所有会话都先是蓝点（2026-09-25 用户指出）。
  const SEEN_LOCAL_KEY =
    basePath.includes('/machines/') ||
    basePath.includes('/herdr-sessions/') ||
    basePath.startsWith('/e/')
      ? `studioSeenDoneLocal:${basePath}`
      : 'studioSeenDoneLocal';
  let seenDone = {};
  try {
    seenDone = JSON.parse(localStorage.getItem(SEEN_LOCAL_KEY) || '{}') || {};
  } catch {
    seenDone = {};
  }
  function reloadSeen() {
    const stored = loadJson(SEEN_KEY, {}) || {};
    let changed = false;
    for (const [id, at] of Object.entries(stored))
      if (!(seenDone[id] >= at)) {
        seenDone[id] = at;
        changed = true;
      }
    if (changed) {
      saveSeenLocal();
      renderChatPicker();
    }
  }
  function saveSeenLocal() {
    try {
      localStorage.setItem(SEEN_LOCAL_KEY, JSON.stringify(seenDone));
    } catch {
      /* 存不了就只靠服务端那份 */
    }
  }
  function markSeen(pane) {
    const id = pane?.agent?.session?.value;
    const at = Number(pane?.lastMessageAt) || 0;
    const completion = completions.key(pane);
    let changed = false;
    if (id && at && !(seenDone[id] >= at)) {
      seenDone[id] = at;
      changed = true;
    }
    if (completion && !seenDone[completion]) {
      seenDone[completion] = Date.now();
      changed = true;
    }
    if (!changed) return;
    const ids = Object.keys(seenDone);
    if (ids.length > 400)
      seenDone = Object.fromEntries(
        ids
          .map((key) => [key, seenDone[key]])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 400),
      );
    try {
      storage.set(SEEN_KEY, JSON.stringify(seenDone));
    } catch {
      /* 本机副本仍可保存已读状态。 */
    }
    saveSeenLocal();
  }
  const alreadySeen = (pane) => {
    const id = pane?.agent?.session?.value;
    if (!id) return false;
    const at = Number(pane.lastMessageAt) || 0;
    // 还没有过消息，就没什么可看的 —— 新开的会话不该顶着「有消息等你看」。
    return at === 0 || seenDone[id] >= at;
  };

  // Lifecycle and device-local completion are independent of unread archive text.
  function renderStatusDot(dot, pane) {
    const base = pane ? UI.activityKind(pane, state.connected) : 'none';
    const settled = ['idle', 'done'].includes(base);
    const kind = settled ? (completions.unread(pane, seenDone) ? 'done' : 'idle') : base;
    const unread = pane?.agent && !alreadySeen(pane);
    const label = {
      working: '正在推理或执行',
      done: '本轮工作已完成，尚未查看',
      blocked: '等待用户回答或确认',
      idle: '空闲',
      shell: 'Shell',
      unknown: 'Agent 状态未知',
      offline: '连接已断开，状态尚未更新',
      none: '没有选中的终端',
    }[kind];
    dot.className = `status-dot ${kind}`;
    dot.dataset.status = kind;
    dot.dataset.unread = String(Boolean(unread));
    dot.title = label + (unread ? '；有未读消息' : '');
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', dot.title);
  }

  function renderSessionStatus(pane) {
    if (composerErrorOwner && composerErrorOwner !== errorOwner()) {
      composerErrorOwner = '';
      reportError('', els.composerError.dataset.source || 'operation');
    }
    messageEdit?.sync();
    composerHeight.schedule();
    syncShellSurface();
    const kind = pane ? UI.statusKind(pane) : 'none';
    // 正文已加载、页面可见且连接在线时才更新本设备已读状态。
    if (pane && state.connected && state.chatContentReady && !document.hidden) markSeen(pane);
    renderStatusDot(els.chatCurrentDot, pane);
    const observation = chatStatus.interaction();
    const statusView = chatStatus.summary();
    const knownExecution =
      observation &&
      !observation.stale &&
      ['main', 'side'].includes(observation.thread) &&
      ['idle', 'running'].includes(observation.execution);
    const hasText = Boolean(
      els.commandInput.value.trim() || state.attachments[state.chatPaneId]?.length,
    );
    const working = knownExecution
      ? observation.execution === 'running'
      : kind === 'working' || kind === 'blocked';
    const delivery = sideThreads.active() ? null : composer?.view(),
      interruption = sideThreads.active()
        ? null
        : sessionActions?.view({ working: knownExecution ? working : working ? true : undefined });
    els.send.dataset.mode = 'send';
    const readOnly = pane && !Providers.get(UI.providerId(pane)).send;
    els.send.disabled =
      readOnly ||
      !state.connected ||
      !pane ||
      !hasText ||
      ['pending', 'checking', 'uncertain'].includes(delivery?.phase);
    const awaitingStartup =
      nativeDraftMoves.has(nativeDraftKey(pane)) ||
      nativeStatusView.active() ||
      nativeStatusRead.active() ||
      !document.querySelector('#agentStartup').hidden ||
      Boolean(currentQuestion && currentQuestion.blocking !== false) ||
      Boolean(
        observation &&
        !observation.stale &&
        ['menu', 'form', 'authentication', 'confirmation'].includes(observation.inputTarget),
      );
    els.send.disabled ||=
      (!sideThreads.active() &&
        Boolean(
          state.composerRequests?.get(`${state.config?.rootDirectory}:${state.composerIdentity}`),
        )) ||
      awaitingStartup ||
      (state.attachments[state.chatPaneId] || []).some((item) => item.status !== 'ready');
    // Draft editing is local. A native confirmation blocks delivery, not typing.
    els.commandInput.disabled = readOnly || !pane;
    els.commandInput.placeholder = readOnly
      ? '该提供方的存档以只读方式显示'
      : window.matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)').matches
        ? '发消息给这个会话'
        : '';
    els.send.title = readOnly
      ? '该提供方以只读方式显示'
      : awaitingStartup
        ? '请先完成当前原生操作，草稿可以继续编辑'
        : delivery?.busy
          ? delivery.label
          : delivery?.canCheck
            ? '请先核对上一条消息的投递结果'
            : '发送消息';
    els.send.removeAttribute('aria-keyshortcuts');
    els.send.setAttribute('aria-busy', String(Boolean(delivery?.busy)));
    if (sideThreads.active() && sideThreads.view()?.structured) {
      els.send.disabled ||= sideSending || !sideThreads.ready();
      els.send.setAttribute('aria-busy', String(sideSending));
    }
    els.send.setAttribute('aria-label', els.send.title);
    const editing = messageEdit?.active(),
      editBusy = messageEdit?.busy();
    const editReady = !editing && !editBusy && messageEditContext().ready;
    for (const button of els.chatLog.querySelectorAll('.chat-message-edit-action')) {
      button.disabled = !editReady;
      button.title =
        editing || editBusy
          ? '请先结束当前编辑操作'
          : editReady
            ? '编辑并重新发送这条消息'
            : '正在确认当前会话，暂不可编辑';
    }
    els.attachButton.disabled = Boolean(editBusy);
    if (editing || editBusy) {
      els.send.dataset.mode = 'send';
      els.send.disabled =
        !state.connected ||
        editBusy ||
        !hasText ||
        (state.attachments[state.chatPaneId] || []).some((item) => item.status !== 'ready');
      els.send.title = editBusy ? '历史消息操作尚未完成' : '发送修改后的消息';
      els.send.setAttribute('aria-label', els.send.title);
      els.send.removeAttribute('aria-keyshortcuts');
      els.commandInput.placeholder = '修改这条历史消息';
    } else if (nativeCommands?.active()) {
      els.send.dataset.mode = 'command';
      els.send.disabled = !state.connected;
      els.send.title = '确认原生命令';
      els.send.setAttribute('aria-label', els.send.title);
      els.commandInput.placeholder = '直接操作 Codex；Esc 返回';
    }
    connectionState.update({
      input: !state.connected
        ? 'unavailable'
        : !hasText
          ? 'empty'
          : els.send.disabled
            ? 'blocked'
            : 'available',
    });
    const controls = $('#chatControls');
    controls.hidden = !pane?.agent || Boolean(state.archived) || isTerminalPresentation();
    const pendingInputs = $('#chatPendingInputs');
    const pending =
      !controls.hidden && currentProvider() === 'codex' && !statusView.stale
        ? statusView.pendingInputs || []
        : [];
    const pendingKey = JSON.stringify(pending);
    if (pendingInputs.dataset.content !== pendingKey) {
      pendingInputs.dataset.content = pendingKey;
      pendingInputs.replaceChildren(
        ...pending.map((section) => {
          const group = document.createElement('div');
          const heading = document.createElement('p');
          heading.className = 'chat-pending-heading';
          heading.textContent = section.title;
          if (section.hint) {
            const hint = document.createElement('span');
            hint.className = 'chat-pending-hint';
            hint.textContent = ` (${section.hint})`;
            heading.append(hint);
          }
          group.append(heading);
          for (const text of section.messages) {
            const message = document.createElement('p');
            message.className = 'chat-pending-message';
            message.textContent = text;
            group.append(message);
          }
          return group;
        }),
      );
    }
    pendingInputs.hidden = !pending.length;
    nativeStatusView.reconcile(controls.hidden);
    $('#chatSessionMore').hidden = !pane || Boolean(state.archived);
    const execution = !state.connected
      ? 'Offline'
      : currentQuestion && currentQuestion.blocking !== false
        ? 'Awaiting input'
        : observation?.stale
          ? 'Identifying'
          : observation &&
              ['menu', 'form', 'authentication', 'confirmation'].includes(observation.inputTarget)
            ? 'Awaiting input'
            : statusView.nativeDraft
              ? 'Native draft'
              : statusView.alert
                ? 'Error'
                : observation?.inputTarget === 'unknown'
                  ? 'Identifying'
                  : working
                    ? statusView.activity ||
                      (statusView.compacting ? 'Compacting context' : 'Working')
                    : kind === 'unknown'
                      ? 'Identifying'
                      : statusView.completed
                        ? statusView.activity || 'Worked'
                        : 'Ready';
    const settings = pane ? state.settings[pane.paneId] || {} : {};
    const knownModel = settings.requested?.model || settings.model || statusView.model;
    const knownEffort = settings.requested?.effort || settings.effort || statusView.effort;
    const operations = [
      delivery && {
        ...delivery,
        kind: 'delivery',
        name: '消息投递',
        label: {
          pending: 'Sending',
          checking: 'Checking delivery',
          uncertain: '投递结果尚未确认，草稿已保留。请先核对，再决定是否重试。',
          accepted: 'Accepted',
          failed: '发送失败，草稿已保留。',
        }[delivery.phase],
      },
      interruption && {
        ...interruption,
        kind: 'interrupt',
        name: '中断',
        label: {
          pending: 'Interrupting',
          checking: 'Checking interrupt',
          uncertain: '中断结果尚未确认，请先核对。',
          accepted: '已接收中断请求',
          confirmed: '当前轮次已结束',
          idle: '没有正在执行的轮次',
          failed: '中断失败',
        }[interruption.phase],
      },
      (settings.saving || settings.uncertain) && {
        kind: 'settings',
        name: '设置',
        phase: settings.saving ? 'pending' : 'uncertain',
        busy: Boolean(settings.saving),
        label: settings.saving
          ? 'Applying settings'
          : '设置结果尚未确认，请重新打开模型或推理强度核对。',
      },
    ].filter(Boolean);
    const priority = (item) =>
      ['uncertain', 'failed'].includes(item.phase) ? 0 : item.busy ? 1 : 2;
    operations.sort((a, b) => priority(a) - priority(b));
    const controlsReady = Boolean(
      !controls.hidden &&
      state.connected &&
      !readOnly &&
      !awaitingStartup &&
      !statusView.stale &&
      !editing &&
      !editBusy &&
      !nativeCommands?.active() &&
      pane?.agent?.session?.value,
    );
    const canOperate = Boolean(controlsReady && observation?.capabilities?.compose);
    const canReadStatus =
      canOperate ||
      Boolean(
        isTerminalPresentation() &&
        state.connected &&
        !state.archived &&
        pane?.agent?.session?.value &&
        !readOnly &&
        !awaitingStartup &&
        !editing &&
        !editBusy &&
        !nativeCommands?.active(),
      );
    const canInterrupt = Boolean(
      controlsReady &&
      (!observation || observation.capabilities?.compose) &&
      !settings.saving &&
      !settings.uncertain,
    );
    statusBar.render({
      view: { ...statusView, notice: nativeStatusView.notice() || statusView.notice },
      execution,
      connections: connectionState.rows(),
      exportDiagnostics: exportConnectionDiagnostics,
      operations,
      account: nativeStatusRead.view(),
      draftMoving: nativeDraftMoves.has(nativeDraftKey(pane)),
      sessionName:
        pane?.sessionFullTitle || pane?.sessionTitle || (pane ? UI.sessionLabel(pane) : ''),
      interrupt: {
        busy: Boolean(interruption?.busy),
        disabled:
          !working ||
          !canInterrupt ||
          observation?.reading === 'history' ||
          Boolean(
            interruption &&
            ['pending', 'checking', 'uncertain', 'accepted'].includes(interruption.phase),
          ),
        title:
          observation?.reading === 'history'
            ? '请先回到底部，再中断当前轮次。'
            : '中断当前轮次，保留 Goal 和后台终端。',
      },
      identity: `${state.config?.rootDirectory}:${state.herdrRuntimeId}:${chatCacheKey()}:${pane?.runtimeId || ''}`,
      hidden: !pane?.agent || Boolean(state.archived),
      provider: currentProvider(),
      model: knownModel,
      effort: knownEffort,
      cwd: pane?.cwd || pane?.baseCwd || '',
      canOperate,
      canReadStatus,
    });
    if (!controls.hidden) {
      const model = $('#chatModelAction'),
        effort = $('#chatEffortAction');
      model.hidden = effort.hidden = currentProvider() !== 'codex';
      if (model.textContent !== (knownModel || 'Model')) model.textContent = knownModel || 'Model';
      if (effort.textContent !== (knownEffort || 'Reasoning'))
        effort.textContent = knownEffort || 'Reasoning';
      model.title = knownModel ? `Model: ${knownModel}` : 'Model';
      effort.title = knownEffort ? `Reasoning: ${knownEffort}` : 'Reasoning';
      for (const [node, name] of [
        [model, `模型：${knownModel || '未提供'}`],
        [effort, `推理强度：${knownEffort || '未提供'}`],
      ]) {
        if (node.getAttribute('aria-label') !== name) node.setAttribute('aria-label', name);
      }
      model.disabled = effort.disabled = !state.connected || awaitingStartup;
      model.setAttribute('aria-busy', String(Boolean(settings.saving)));
      effort.setAttribute('aria-busy', String(Boolean(settings.saving)));
    }
  }

  // ↑ / ↓ 只翻当前原生存档里的用户消息（public/chat/input-history.js）。
  // 按会话身份分开，换会话时丢弃历史选择位置。
  const inputHistory = window.StudioInputHistory.create({
    key: () => JSON.stringify([state.config?.rootDirectory, state.herdrRuntimeId, chatCacheKey()]),
    entries: () => [
      ...(state.chatMessages || [])
        .filter((message) => message.role === 'user')
        .map(
          (message) =>
            message.sourceText ??
            (message.blocks || [])
              .filter((block) => block.kind === 'text')
              .map((block) => block.text)
              .join('\n'),
        ),
    ],
    // 翻出来的以「/」开头时不弹命令菜单，否则下一次 ↑ 就被菜单接走了。
    apply: (text) => {
      slash.dismissed = text;
      closeSlashCommands();
      saveDraft();
    },
  });
  window.StudioInputHistory.bindTouch({
    zone: $('#sendHistoryZone'),
    input: els.commandInput,
    history: inputHistory,
    key: () =>
      JSON.stringify([
        state.config?.rootDirectory,
        state.herdrRuntimeId,
        state.selectionVersion,
        chatCacheKey(),
        isTerminalPresentation(),
      ]),
    enabled: () =>
      !els.commandInput.disabled &&
      !els.commandInput.readOnly &&
      els.commandInput.getClientRects().length > 0 &&
      !slash.composing &&
      !messageEdit?.active() &&
      !messageEdit?.busy() &&
      !nativeCommands?.active() &&
      !state.archived &&
      !state.settingsOpen &&
      !state.filesOpen &&
      !sideThreads.active() &&
      !isTerminalPresentation() &&
      !state.composerRequests?.get(`${state.config?.rootDirectory}:${state.composerIdentity}`),
  });
  els.commandInput.addEventListener('input', () => {
    if (messageEdit?.active()) {
      reportError('');
      messageEdit.draftChanged({ userInput: true });
      renderSessionStatus(currentChatPane());
      return;
    }
    if (nativeCommands?.input()) return;
    reportError('');
    slash.dismissed = null;
    inputHistory.reset();
    saveDraft();
  });
  els.commandInput.addEventListener('focus', renderSlashCommands);
  els.commandInput.addEventListener('click', renderSlashCommands);
  els.commandInput.addEventListener('select', renderSlashCommands);
  els.commandInput.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) renderSlashCommands();
  });
  els.commandInput.addEventListener('blur', closeSlashCommands);
  els.commandInput.addEventListener('compositionstart', () => {
    slash.composing = true;
    if (!messageEdit?.active() && !messageEdit?.busy()) nativeCommands?.composition(true);
    closeSlashCommands();
  });
  els.commandInput.addEventListener('compositionend', () => {
    slash.composing = false;
    if (!messageEdit?.active() && !messageEdit?.busy()) nativeCommands?.composition(false);
    renderSlashCommands();
  });
  els.commandInput.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (messageEdit?.active() || messageEdit?.busy()) {
      if (
        StudioSessionShortcuts.shouldSubmit(event, {
          coarse: matchMedia('(pointer: coarse)').matches,
        })
      ) {
        event.preventDefault();
        writeComposer();
      }
      return;
    }
    if (nativeCommands?.keydown(event)) return;
    if (!els.slashCommands.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        slash.dismissed = els.commandInput.value;
        closeSlashCommands();
        return;
      }
      if (slash.items.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        slash.index =
          (slash.index + (event.key === 'ArrowDown' ? 1 : -1) + slash.items.length) %
          slash.items.length;
        renderSlashCommands();
        return;
      }
      if (
        slash.items.length &&
        (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))
      ) {
        event.preventDefault();
        pickSlashCommand();
        return;
      }
    }
    if (inputHistory.keydown(event, els.commandInput)) return;
    if (
      StudioSessionShortcuts.shouldSubmit(event, {
        coarse: matchMedia('(pointer: coarse)').matches,
      })
    ) {
      inputHistory.reset();
      event.preventDefault();
      writeComposer();
    }
  });
  // 选中文字后拖动，Edge 会接管成「松开鼠标以搜索文本」，松手就跳去搜索引擎（PWA 里同样如此）。
  // 保留原生 Tab 排序和输入框内的拖动，其他文字与图片不触发浏览器拖动搜索。
  document.addEventListener('dragstart', (event) => {
    if (!event.target?.closest?.('textarea, input, .herdr-tab')) event.preventDefault();
  });

  function openAuth(message = '') {
    els.authError.textContent = message;
    els.tokenInput.value = state.token;
    if (!els.authDialog.open) els.authDialog.showModal();
  }

  async function requestWakeLock() {
    if (!state.prefs.keepAwake || !('wakeLock' in navigator) || state.wakeLock) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
    } catch {}
  }

  function releaseWakeLock() {
    if (state.wakeLock) state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }

  VisualViewport.bindVisualViewport({
    onBeforeChange: () => {
      if (!els.chatView.hidden && !filesReplaceChat() && !isTerminalPresentation())
        return { target: chatCacheKey(), scroll: chatScroll.captureResize() };
    },
    onChange: (before) => {
      if (
        !before ||
        before.target !== chatCacheKey() ||
        filesReplaceChat() ||
        isTerminalPresentation()
      )
        return;
      // Read the new geometry before a resize-generated scroll event can be
      // mistaken for the user leaving the latest message.
      chatScroll.followResize(before.scroll);
      requestAnimationFrame(() => {
        if (before.target === chatCacheKey() && !filesReplaceChat() && !isTerminalPresentation())
          chatScroll.followResize(before.scroll);
      });
    },
  });

  function pauseCurrentSession() {
    return sideThreads.active() ? sideThreads.act('interrupt') : sessionActions.interrupt();
  }
  $('#chatModelAction').onclick = (event) => agentSettings.openModelPopover(event.currentTarget);
  $('#chatEffortAction').onclick = () => agentSettings.openCurrentEffort($('#chatEffortAction'));
  $('#chatSessionMore').onclick = (event) =>
    state.herdrShell.paneMenu(event.currentTarget, currentChatPane());
  let controlsFrame = 0;
  els.chatLog.addEventListener(
    'scroll',
    () => {
      if (!controlsFrame)
        controlsFrame = requestAnimationFrame(() => {
          controlsFrame = 0;
          renderSessionStatus(currentChatPane());
        });
    },
    { passive: true },
  );
  els.send.addEventListener('click', () => {
    inputHistory.reset();
    return writeComposer();
  });
  StudioSessionShortcuts.create({
    context: (event) => ({
      identity: chatCacheKey(),
      provider: currentProvider(),
      enabled:
        !els.chatView.hidden &&
        !state.archived &&
        state.connected &&
        ['codex', 'claude'].includes(currentProvider()),
      terminalFocus: Boolean(event.target.closest?.('.xterm')),
      editing: Boolean(event.target.closest?.('input, textarea, [contenteditable="true"]')),
      blocked:
        messageEdit?.active() ||
        messageEdit?.busy() ||
        state.settingsOpen ||
        state.filesOpen ||
        state.workspaceFilesOpen ||
        els.chatSidebar.classList.contains('open') ||
        sideThreads.active() ||
        slash.composing ||
        !els.slashCommands.hidden ||
        nativeCommands?.active() ||
        Boolean(
          document.querySelector('dialog[open], .popover, .native-command-panel:not([hidden])'),
        ) ||
        Boolean(
          event.target.closest?.('input, textarea, [contenteditable="true"]') &&
          event.target !== els.commandInput &&
          !event.target.closest('.xterm'),
        ),
    }),
    actions: {
      pause: pauseCurrentSession,
      effortUp: () => agentSettings.stepSetting('effort', 1),
      effortDown: () => agentSettings.stepSetting('effort', -1),
      modelPrevious: () => agentSettings.stepSetting('model', -1),
      modelNext: () => agentSettings.stepSetting('model', 1),
    },
    reportError,
  });
  els.commandInput.title =
    'Enter 发送 · Shift+Enter 换行 · Ctrl/Command+Enter 发送 · Alt+↑ 查看问题 · Esc 中断本轮';
  renderAgentActions();
  function renderAttachments() {
    const list = document.querySelector('#attachmentList');
    const items = state.attachments[state.chatPaneId] || [];
    list.replaceChildren();
    list.hidden = !items.length;
    for (const item of items) {
      const chip = document.createElement('span');
      chip.className = 'attachment-chip';
      chip.append(
        chatText(
          document.createElement('span'),
          item.name +
            (item.status === 'uploading'
              ? ' · 上传中'
              : item.status === 'failed'
                ? ' · 上传失败'
                : ''),
        ),
      );
      const remove = chatText(document.createElement('button'), '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除 ${item.name}`);
      remove.addEventListener('click', () => {
        state.attachments[state.chatPaneId] = items.filter((value) => value !== item);
        renderAttachments();
        saveDraft();
      });
      chip.append(remove);
      list.append(chip);
    }
  }
  els.attachButton.addEventListener('click', () => {
    if (!state.chatPaneId) return reportError('请先选择一个会话。');
    els.attachInput.click();
  });
  async function uploadAttachments(files) {
    const paneId = state.chatPaneId;
    const rootDirectory = state.config?.rootDirectory;
    const sessionId =
      (state.chatAgents || []).find((p) => p.paneId === paneId)?.agent?.session?.value || '';
    if (!paneId) return;
    const stillCurrent = (item) =>
      rootDirectory === state.config?.rootDirectory &&
      state.attachments[paneId]?.includes(item) &&
      ((state.chatAgents || []).find((p) => p.paneId === paneId)?.agent?.session?.value || '') ===
        sessionId;
    const pending = [];
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        reportError(`${file.name} 超过 20 MiB`);
        continue;
      }
      const item = { name: file.name, status: 'uploading' };
      // 本地预览：消息确认之前，回显气泡靠它把附件画成图片，和确认后的正式消息一个样子。
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.type))
        item.previewUrl = URL.createObjectURL(file);
      (state.attachments[paneId] ||= []).push(item);
      pending.push({ file, item });
    }
    if (paneId === state.chatPaneId) {
      renderAttachments();
      saveDraft();
    }
    for (const { file, item } of pending) {
      if (!stillCurrent(item)) continue;
      try {
        const query = new URLSearchParams({ pane: paneId, sessionId, name: file.name });
        const result = await api(appPath(`/api/attachments?${query}`), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        });
        if (stillCurrent(item)) Object.assign(item, result.attachment, { status: 'ready' });
      } catch (error) {
        item.status = 'failed';
        if (paneId === state.chatPaneId) reportError(error.message);
      }
      if (paneId === state.chatPaneId) {
        renderAttachments();
        saveDraft();
      }
    }
  }
  els.attachInput.addEventListener('change', () => {
    const files = [...(els.attachInput.files || [])];
    els.attachInput.value = '';
    void uploadAttachments(files);
  });
  els.commandInput.addEventListener('paste', (event) => {
    if (els.commandInput.disabled || !state.chatPaneId) return;
    const data = event.clipboardData;
    // Some browsers expose files only through items. Do not read both lists:
    // they normally refer to the same files and would produce duplicate uploads.
    let files = [...(data?.files || [])];
    if (!files.length)
      files = [...(data?.items || [])]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter(Boolean);
    if (!files.length) return; // Keep native text paste, selection and undo.
    event.preventDefault();
    const text = data.getData('text/plain');
    if (text) {
      els.commandInput.setRangeText(
        text,
        els.commandInput.selectionStart,
        els.commandInput.selectionEnd,
        'end',
      );
      els.commandInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    void uploadAttachments(files);
  });
  els.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (nativeConnectionAuth) {
      window.StudioApp.connectionSettings();
      return;
    }
    state.token = els.tokenInput.value.trim();
    storage.set(tokenStorageKey, state.token);
    try {
      const config = await loadRootConfig();
      await replica.load(config.rootDirectory);
      applyBootConfig(config);
      renderCachedSnapshot(replica.snapshot());
      els.authDialog.close();
      connectPty();
      setChatOpen(true);
    } catch (error) {
      els.authError.textContent = error.message;
    }
  });
  const frontendUpdates = window.StudioFrontendUpdates.create({
    version: frontendVersion,
    url: appPath('/frontend-version.json'),
    // 只在页面切到后台时重载：当着人的面整页清空、从零加载，是手机上「一切回来就白屏
    // 一两秒」的来源（2026-09-24 用户指出）。切回来时看到的已经是加载好的新页面。
    canReload: () =>
      state.snapshotReady &&
      document.hidden &&
      !document.body.classList.contains('herdr-operation-pending') &&
      !els.commandInput.value &&
      !Object.values(state.drafts).some(Boolean) &&
      !Object.values(state.attachments).some((items) => items.length) &&
      !Object.values(state.outbox)
        .flat()
        .some(
          (item) => item.submissionPending || item.deliveryPending || item.status === 'submitting',
        ) &&
      !state.composerRequests?.size &&
      !state.composerTerminalRequests?.size &&
      !messageEdit?.view()?.pending &&
      !messageEdit?.active() &&
      !messageEdit?.busy() &&
      !nativeCommands?.active() &&
      !queuedQuestions.hasDraft() &&
      !state.filesOpen &&
      !state.settingsOpen &&
      !document.querySelector('dialog[open], .popover') &&
      !document.activeElement?.matches('input, textarea'),
    reload: () => location.reload(),
  });
  // 回到前台时只检查有没有新版本、记下来；真正的重载留到下一次切到后台。
  const checkFrontend = () => {
    if (!document.hidden) frontendUpdates.check();
  };
  window.addEventListener('blur', () => {
    if (document.activeElement?.tagName !== 'IFRAME' || !document.hasFocus()) nativeWasAway = true;
  });
  const returnToSwift = () => {
    checkFrontend();
    if (!nativeWasAway || !canViewNative()) return;
    nativeWasAway = false;
    adoptNativeOnRefresh = true;
    void refreshChat(false);
  };
  window.addEventListener('focus', returnToSwift);
  window.addEventListener('pageshow', syncShellSurface);
  window.addEventListener('online', checkFrontend);
  document.addEventListener('visibilitychange', () => {
    syncShellSurface();
    if (document.hidden) {
      nativeWasAway = true;
      persistChatBoot();
      replica.flush();
      rememberPane();
      frontendUpdates.applyPending();
    } else returnToSwift();
  });
  window.addEventListener('pagehide', () => {
    persistChatBoot();
    replica.flush();
    rememberPane();
  });
  // 仅有待更新版本时重试，草稿/附件/提交操作结束之前不重载。
  setInterval(() => {
    if (frontendUpdates.isPending()) checkFrontend();
  }, 15000);

  const requestedPane = new URLSearchParams(location.search).get('pane');
  function renderCachedSnapshot(saved) {
    if (!saved?.panes?.length) return;
    state.config ||= {};
    state.config.rootDirectory ||= saved.rootDirectory || replica.rootDirectory();
    draftStore.load(state.config.rootDirectory);
    if (!state.history?.length && replica.history()) {
      state.history = replica.history().sessions;
      state.historyNext = replica.history().nextOffset;
      state.historyQuery = '';
    }
    if (!state.snapshotReady) {
      state.allPanes = saved.panes;
      state.chatWorkspaces = saved.workspaces;
      state.herdrRuntimeId = saved.runtimeId || '';
      state.chatTabs = saved.tabs || [];
      state.chatLayouts = saved.layouts || [];
      state.chatFocusedPaneId = saved.focusedPaneId;
      state.chatAgents = saved.panes;
      state.snapshotReady = true;
      if (!state.chatPaneId) {
        let last = '';
        try {
          last = localStorage.getItem(LAST_PANE_KEY) || '';
        } catch {}
        state.chatPaneId =
          requestedPane ||
          (
            state.chatAgents.find((pane) => pane.paneId === last) ||
            state.chatAgents.find((pane) => pane.paneId === saved.focusedPaneId) ||
            state.chatAgents[0]
          )?.paneId ||
          '';
      }
    }
    renderChatPicker();
    if (state.chatPaneId) {
      els.chatView.hidden = false;
      restoreChatCache();
      els.commandInput.value = draftStore.get(currentChatPane());
      state.drafts[state.chatPaneId] = els.commandInput.value;
      state.composerIdentity = window.StudioDrafts.identity(currentChatPane());
      restoreMessageEditDraft();
      renderSessionStatus(currentChatPane());
    }
  }
  function applyBootConfig(config) {
    if (state.config?.rootDirectory && state.config.rootDirectory !== config.rootDirectory) {
      messageEdit?.cancel();
      state.chatCache.clear();
      state.chatPaneId = '';
      state.allPanes = [];
      state.chatAgents = [];
      state.chatWorkspaces = [];
      state.snapshotCached = false;
      state.snapshotReady = false;
      state.drafts = {};
      state.composerIdentity = '';
      setChatContentReady(false);
      renderChatMessages([]);
      renderChatPicker();
    }
    state.config = config;
    draftStore.load(config.rootDirectory);
    applyRootSettings(config.settings || {}, true);
    settingsSaver.resume(config.rootDirectory);
    renderRootDirectory();
  }
  const bootController = window.StudioBoot.create({
    replica,
    paintLegacy: () => {
      if (!requestedPane) {
        const root = sessionCache.paintFromBoot();
        if (root) {
          draftStore.load(root);
          els.commandInput.value = draftStore.get(currentChatPane());
          state.drafts[state.chatPaneId] = els.commandInput.value;
        }
      }
    },
    renderCached: renderCachedSnapshot,
    loadConfig: loadRootConfig,
    applyConfig: applyBootConfig,
    connect: () => {
      connectPty();
      setChatOpen(true);
    },
    unauthorized: (error) => {
      setChatOpen(false);
      if (window.StudioApp?.authenticationRequired) window.StudioApp.authenticationRequired();
      else openAuth(error.message);
    },
    offline: (cached) => {
      setConnectionState(
        'offline',
        cached || state.snapshotCached
          ? '连接已断开，正在显示本机保存的内容。'
          : '暂时无法连接服务，正在重试。',
      );
    },
  });
  window.addEventListener('online', () => void bootController.verify());
  if (
    !window.__SWIFT_ACCOUNT_CONNECTION__ &&
    'serviceWorker' in navigator &&
    location.protocol !== 'file:'
  ) {
    navigator.serviceWorker
      .register(appPath('/sw.js'), { scope: `${basePath || ''}/`, updateViaCache: 'none' })
      .catch(() => {});
  }

  void bootController.start();
})();
