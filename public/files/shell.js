/** 会话文件列表与搜索；文件内容统一交给工作区文件页。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioFilesShell = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @param {object} deps
   *   `state` / `els`   与 app.js 共用的那份状态和三个节点。
   *   `$`               面板自己那几个节点的查询器（它们不在 els 里）。
   *   `openFile`        进入共用文件页，沿用已有文件标签、预览与编辑器。
   */
  function create({
    state,
    els,
    $,
    chatText,
    request,
    openFile,
    storage,
    saveChatCache,
    filesReplaceChat,
    closePopover,
    closeSlashCommands,
    setChatDrawerOpen,
    desktopFiles,
    setAtBottom,
    scroll,
    synced = () => null,
  }) {
    // 文件页看的是哪个会话：活着的按 pane，归档里的按「provider:会话 ID」（它已经没有 pane 了）。
    const targetId = () =>
      state.archived
        ? `archived:${state.archived.provider}:${state.archived.sessionId}`
        : state.chatPaneId;
    const targetParams = (id) =>
      String(id).startsWith('archived:')
        ? { archived: String(id).slice('archived:'.length) }
        : {
            pane: id,
            sessionId:
              (state.allPanes || []).find((pane) => pane.paneId === id)?.agent?.session?.value ||
              '',
          };

    let maximizedChat = null,
      filesPosition = null;
    function setFilesPage(open) {
      if (open && !targetId()) return;
      if (state.filesOpen === open) return;
      const saved = !open && desktopFiles.matches ? maximizedChat : null;
      const position =
        saved?.position || (!open && filesReplaceChat() ? filesPosition : scroll.capture());
      if (open) filesPosition = position;
      const previousTop = saved?.top ?? els.chatLog.scrollTop;
      const pinned =
        saved?.pinned ?? els.chatLog.scrollHeight - previousTop - els.chatLog.clientHeight <= 1;
      if (open) {
        saveChatCache();
        state.filesScroll = previousTop;
      }
      const restoreScroll = filesReplaceChat();
      state.filesOpen = open;
      state.filesEpoch++;
      $('#chatFilesToggle').setAttribute('aria-expanded', String(open));
      $('#chatFilesToggle').setAttribute('aria-label', open ? '收起会话文件' : '展开会话文件');
      $('#chatFilesToggle').title = open ? '收起会话文件' : '展开会话文件';
      els.chatView.classList.toggle('files-open', open);
      $('#sessionFilesPage').hidden = !open;
      if (open) {
        setFilesMax(storedMax(), false);
        maximizedChat =
          desktopFiles.matches && storedMax() ? { top: previousTop, pinned, position } : null;
        closePopover();
        closeSlashCommands();
        els.commandInput.blur();
        setChatDrawerOpen(false);
        void loadList();
      } else {
        if (restoreScroll) els.chatLog.scrollTop = state.filesScroll || 0;
      }
      if (els.chatLog.clientHeight && position) scroll.restorePosition(position);
      // 面板开合会改变聊天区的可视高度，贴底与否要重新算一次告诉外壳。
      setAtBottom(
        maximizedChat && open
          ? maximizedChat.pinned
          : els.chatLog.scrollHeight - els.chatLog.scrollTop - els.chatLog.clientHeight <= 1,
      );
      if (!open) maximizedChat = null;
      renderSearch();
      renderBack();
    }
    // ——— 列表（docs/PRODUCT_SPEC.md 2.4）————————————————————————————————————————
    //
    // 一个列表，上面一个搜索框（2026-09-24 用户要求去掉「会话 / 搜索」两个标签）：框里没字时列出
    // 本会话里出现过的文档，输入就在同一个列表里显示搜索结果，清空回到原来那份。
    // 服务端筛选可预览的文件。每条两行：第一行是标题（Markdown 读 `# `，不是文件名），第二行小字是正文头一句，
    // 右端一个相对时间。标题与摘要都由服务端读好，这里只排版。
    state.docQuery = state.docQuery || '';
    let loadToken = 0,
      searchTimer = null,
      listAbort = null;
    function renderBack() {
      const back = $('#chatFilesListBack');
      back.hidden = !state.filesOpen || !desktopFiles.matches;
      back.setAttribute('aria-label', '返回会话');
      back.title = '返回会话';
    }
    desktopFiles.addEventListener('change', renderBack);

    /**
     * 最大化：面板占满原来聊天页的位置（电脑上；手机与平板上文件页本来就是整页）。
     * 按设备记住，下次打开面板照旧。标题栏双击也能切换，和桌面窗口的习惯一样。
     */
    const MAX_KEY = 'studioFilesMax';
    const maximize = document.querySelector('#chatFilesMaximize');
    function setFilesMax(on, remember = true) {
      if (
        desktopFiles.matches &&
        state.filesOpen &&
        on &&
        !els.chatView.classList.contains('files-max')
      ) {
        const log = els.chatLog;
        maximizedChat = {
          top: log.scrollTop,
          pinned: log.scrollHeight - log.scrollTop - log.clientHeight <= 1,
          position: scroll.capture(),
        };
      }
      els.chatView.classList.toggle('files-max', on);
      if (desktopFiles.matches && state.filesOpen && maximizedChat) {
        if (!on) scroll.restorePosition(maximizedChat.position);
        setAtBottom(maximizedChat.pinned);
        if (!on) maximizedChat = null;
      }
      if (maximize) {
        maximize.setAttribute('aria-pressed', String(on));
        maximize.setAttribute('aria-label', on ? '还原' : '最大化');
        maximize.title = on ? '还原' : '最大化';
      }
      if (remember) {
        try {
          storage?.set(MAX_KEY, on ? '1' : '');
        } catch {
          /* 存不了就只在本次会话里生效 */
        }
      }
    }
    const storedMax = () => {
      try {
        return storage?.get(MAX_KEY) === '1';
      } catch {
        return false;
      }
    };
    maximize?.addEventListener('click', () =>
      setFilesMax(!els.chatView.classList.contains('files-max')),
    );
    // 与聊天页标题栏里的「会话列表」按钮同一个动作（它此时跟着聊天页藏起来了）。
    document
      .querySelector('#chatFilesSidebarToggle')
      ?.addEventListener('click', () => document.querySelector('#chatDrawerToggle')?.click());
    document.querySelector('.session-files-head')?.addEventListener('dblclick', (event) => {
      if (!desktopFiles.matches || event.target.closest('button')) return;
      setFilesMax(!els.chatView.classList.contains('files-max'));
    });

    /**
     * 横滑这一步归不归列表管（public/nav/swipe.js）：没有标签可切了，所以列表上左滑吞掉、什么都不做；
     * 右滑返回 false，由调用方按「返回」处理（读文档时退一层，在列表上回到聊天页）。
     */
    function stepTab(delta) {
      return delta > 0;
    }
    const searchInput = document.querySelector('#docSearch');
    searchInput?.addEventListener('input', () => {
      state.docQuery = searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void loadList(), 180);
    });
    // Esc 先清空搜索，回到本会话的文档；框里没字时才交给面板（关面板或退一层）。
    searchInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !searchInput.value) return;
      event.preventDefault();
      event.stopPropagation();
      searchInput.value = '';
      state.docQuery = '';
      void loadList();
    });
    const searching = () => Boolean(state.docQuery.trim());
    function renderSearch() {
      if (searchInput) {
        searchInput.hidden = false;
        if (searchInput.value !== state.docQuery) searchInput.value = state.docQuery;
      }
    }

    // 上一次的结果：重开面板或清空搜索时先画它，数据回来再原地更新。按会话与查询条件区分，不串。
    // 会话本身的列表（不含搜索）还存进本机，APP 被回收后重新打开也能直接画出来。
    const STORE_KEY = 'studioDocLists';
    const listCache = new Map(),
      fetchedAt = new Map();
    const listKey = (paneId, query = state.docQuery.trim()) => [paneId, query].join('\u0000');
    try {
      for (const [key, entry] of Object.entries(
        JSON.parse(localStorage.getItem(STORE_KEY) || '{}'),
      ))
        if (entry?.result) listCache.set(key, entry.result);
    } catch {
      /* 本机存储不可用就只在内存里缓存 */
    }
    function remember(key, result) {
      listCache.delete(key);
      listCache.set(key, result);
      fetchedAt.set(key, Date.now());
      while (listCache.size > 24) {
        const old = listCache.keys().next().value;
        listCache.delete(old);
        fetchedAt.delete(old);
      }
      if (key.endsWith('\u0000'))
        try {
          const saved = {};
          for (const [k, v] of listCache) if (k.endsWith('\u0000')) saved[k] = { result: v };
          localStorage.setItem(STORE_KEY, JSON.stringify(saved));
        } catch {
          /* 存不下就算了，内存里还有 */
        }
    }

    /**
     * 选中会话时就把它的文件列表取回来，与正文同时加载（2026-09-25 用户要求）：
     * 原来要等滑到文件页才开始取，列表会在眼前「刷出来」。滑过去时直接画缓存。
     * 之后跟着正文走：`revision` 是正文最新一条的标识，会话有了新消息就在后台重取（至多 3 秒一次），
     * 文件页没打开也一样，滑过去时已是最新；没有新消息时 30 秒兜底一次（文档本身可能被改过）。
     * 左栏里其他会话的列表由正文预取顺带取（session-cache.js），同一个会话同时只有一个请求在路上。
     */
    const preloads = new Map();
    const revisions = new Map();
    function preloadList(revision, paneId = targetId()) {
      if (!paneId || (state.filesOpen && paneId === targetId()) || synced(paneId)) return;
      const key = listKey(paneId, '');
      const age = Date.now() - (fetchedAt.get(key) || 0);
      const changed =
        revision !== undefined && revisions.has(key) && revisions.get(key) !== revision;
      if (revision !== undefined && !revisions.has(key)) revisions.set(key, revision);
      if (preloads.has(paneId) || (changed ? age < 3000 : age < 30000)) return;
      if (revision !== undefined) revisions.set(key, revision);
      const task = { paneId };
      task.promise = request(
        `/api/doc-files?${new URLSearchParams({ ...targetParams(paneId), tab: 'session' })}`,
      )
        .then((result) => {
          remember(key, result);
          return result;
        })
        .finally(() => {
          if (preloads.get(paneId) === task) preloads.delete(paneId);
        });
      preloads.set(paneId, task);
      task.promise.catch(() => {});
    }

    function paintList(list, result) {
      // 内容没变就不重画：打开时先画缓存、数据回来再比一次，一样的就不再换一遍节点。
      const signature = `${targetId()}\u0000${state.docQuery.trim()}\u0000${JSON.stringify(result?.files || [])}\u0000${result?.total || 0}`;
      if (list.dataset.signature === signature && list.childElementCount) return;
      list.dataset.signature = signature;
      if (searching()) {
        renderRows(list, result?.files || [], null);
        if (!result?.files?.length)
          listFeedback(
            list,
            '没有匹配的文件。',
            () => {
              state.docQuery = '';
              void loadList();
              searchInput?.focus();
            },
            '清空搜索',
          );
        if (result?.total > (result.files || []).length)
          list.append(
            note(`共 ${result.total} 个匹配，只列出最接近的 ${result.files.length} 个。`),
          );
        return;
      }
      renderRows(list, result?.files || [], '这个会话里还没有出现过可预览的文件。');
    }

    async function loadList({ force = false } = {}) {
      clearTimeout(searchTimer);
      renderSearch();
      const paneId = targetId(),
        mine = ++loadToken;
      const list = $('#sessionFilesList');
      // 新的一次加载作废上一次：边打字边搜、或刚换了会话时，旧请求不再占着连接。
      listAbort?.abort();
      listAbort = new AbortController();
      const { signal } = listAbort;
      if (!paneId) return;
      const key = listKey(paneId),
        query = state.docQuery.trim();
      const stale = () =>
        mine !== loadToken ||
        paneId !== targetId() ||
        query !== state.docQuery.trim() ||
        !state.filesOpen;
      list.querySelectorAll('.list-feedback').forEach((node) => node.remove());
      list.removeAttribute('aria-busy');
      // 同步生效时这个会话的列表由推送保持最新（docs/LOCAL_FIRST.md）：直接画，不请求。
      const pushed = !force && !query && synced(paneId);
      if (pushed) {
        remember(key, pushed);
        paintList(list, pushed);
        return;
      }
      if (listCache.has(key)) paintList(list, listCache.get(key));
      // 没有缓存时不要留着上一个会话的列表。
      else {
        list.replaceChildren();
        list.dataset.signature = '';
      }
      // 刚预取过的直接用；预取还在路上就等它，不再发第二遍。
      if (!force && !query && Date.now() - (fetchedAt.get(key) || 0) < 5000) return;
      list.setAttribute('aria-busy', 'true');
      if (!listCache.has(key) || force)
        listFeedback(list, listCache.has(key) ? '正在更新文件…' : '正在读取文件…');
      try {
        const pending = !force && !query ? preloads.get(paneId)?.promise : null;
        const result = pending
          ? await pending
          : query
            ? await request(
                `/api/doc-files/search?${new URLSearchParams({ ...targetParams(paneId), q: query })}`,
                { signal },
              )
            : await request(
                `/api/doc-files?${new URLSearchParams({ ...targetParams(paneId), tab: 'session' })}`,
                { signal },
              );
        if (stale()) return;
        remember(key, result);
        list.querySelectorAll('.list-feedback').forEach((node) => node.remove());
        paintList(list, result);
      } catch (error) {
        if (stale()) return;
        list.querySelectorAll('.list-feedback').forEach((node) => node.remove());
        if (!listCache.has(key)) {
          list.dataset.signature = '';
          list.replaceChildren();
        }
        const message = listCache.has(key) ? '文件更新失败，仍显示上次结果。' : '文件读取失败。';
        listFeedback(list, message + (error.message || ''), () => void loadList({ force: true }));
      } finally {
        if (!stale()) list.removeAttribute('aria-busy');
      }
    }

    function listFeedback(list, message, action, label = '重试') {
      const box = document.createElement('div');
      box.className = 'list-feedback';
      box.setAttribute('role', 'status');
      box.append(chatText(document.createElement('span'), message));
      if (action) {
        const button = chatText(document.createElement('button'), label);
        button.type = 'button';
        button.className = 'chat-btn';
        button.addEventListener('click', action);
        box.append(button);
      }
      list.append(box);
    }

    function note(message) {
      const p = document.createElement('p');
      p.className = 'project-empty';
      p.textContent = message;
      return p;
    }

    function renderRows(list, files, empty, { clear = true } = {}) {
      if (clear) list.replaceChildren();
      if (!files.length && empty) {
        list.append(note(empty));
        return;
      }
      for (const file of files) list.append(row(file));
    }

    const downloadUrl = (file) =>
      (document.querySelector('meta[name="agent-studio-base-path"]')?.content || '') +
      `/api/doc-files/download?${new URLSearchParams({ ...targetParams(targetId()), path: file })}`;
    function row(file) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'doc-row';
      button.dataset.kind = file.kind;
      button.title = file.path;
      button.dataset.downloadName = file.name || file.path;
      button.dataset.downloadUrl = downloadUrl(file.path);
      const title = chatText(document.createElement('strong'), file.title || file.name);
      const time = chatText(document.createElement('time'), StudioDocView.ago(file.mtime));
      if (file.mtime) time.dateTime = new Date(file.mtime).toISOString();
      const summary = chatText(document.createElement('span'), file.summary || file.name);
      summary.className = 'doc-row-summary';
      button.append(title, time, summary);
      button.addEventListener('click', () => openFile(file.path));
      return button;
    }

    window.addEventListener('swift.file.open', (event) => {
      if (event.detail?.paneId === targetId() && event.detail.path) openFile(event.detail.path);
    });

    let lastRefresh = 0;
    function refreshSessionFiles() {
      if (!state.filesOpen || searching()) return;
      if (Date.now() - lastRefresh < 3000) return;
      lastRefresh = Date.now();
      void loadList();
    }
    function backPanel() {
      setFilesPage(false);
    }
    function closeFilePreview() {
      state.previewEpoch = (state.previewEpoch || 0) + 1;
      state.previewId = null;
      $('#sessionFileViewer').hidden = true;
      $('#sessionFilesList').hidden = false;
      renderBack();
    }

    /** 右滑这一下是不是离开文件页：停在列表上、没有在读文档（与 stepTab 同一套判断）。 */
    const leavesOnBack = () => true;
    /** 推来的新列表：记下；正开着这个会话的列表（没在搜、没在读文档）就原地重画。 */
    function acceptSynced(paneId, result) {
      remember(listKey(paneId, ''), result);
      if (state.filesOpen && targetId() === paneId && !searching()) {
        loadToken++;
        listAbort?.abort();
        const list = $('#sessionFilesList');
        list.removeAttribute('aria-busy');
        list.querySelectorAll('.list-feedback').forEach((node) => node.remove());
        paintList(list, result);
      }
    }
    return {
      setFilesPage,
      backPanel,
      closeFilePreview,
      refreshSessionFiles,
      preloadList,
      acceptSynced,
      stepTab,
      leavesOnBack,
      isOpen: () => state.filesOpen,
    };
  }

  return { create };
});
