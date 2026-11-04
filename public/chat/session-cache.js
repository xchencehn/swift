/**
 * 会话正文的本机缓存：切走时存、切回来时先画缓存再在后台更新；空闲时预取「最近」里的会话；
 * 启动时先画上次的样子。三样用的是同一份 state.chatCache，按原生会话身份分条
 * （pane + 终端 + 会话 ID，外壳的 cacheKeyFor），根目录一换整份作废。
 *
 * 这些都只是设备本地的视图缓存：丢了只是回到原来的慢路径，不影响正确性。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioSessionCache = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 2026-09-25 用户要求：左栏里的每个会话都跟聊天页一样实时，点过去不该再整页加载。
  // 所以缓存装得下全部会话，有新消息的会话在后台 10 秒内跟上（原来只取最近 8 个、每个 30 秒一次）。
  // 代价是流量：一次完整窗口压缩后 14–89 KB（2026-09-25 实测 15 个会话），只在会话有新消息时才取；
  // 一个持续工作的会话大约每小时 20 MB。正文增量传输做完之后这个数会小得多。
  const LIMIT = 32;
  const PREFETCH_COUNT = 24,
    PREFETCH_INTERVAL_MS = 10000;
  const BOOT_KEY = 'agentStudioBoot';

  /**
   * @param {object} app
   *   state, els
   *   keyFor(pane) / currentKey()        缓存键
   *   request(path) / transcriptPath(paneId, sessionId, before)
   *   recentPanes(panes, outbox) / providerId(pane)    与左栏「最近」同一套排序与判定
   *   filesReplaceChat()                 文件页正盖在聊天页上（此时聊天页的滚动位置不可信）
   *   render: { picker(), status(status), messages(messages), session(pane), contentReady(ready) }
   */
  function create(app) {
    const { state, els } = app;
    const bootKey = app.bootKey || BOOT_KEY;
    const cache = () => state.chatCache;
    const put = (key, entry) => {
      cache().delete(key);
      cache().set(key, entry);
      if (cache().size > LIMIT) cache().delete(cache().keys().next().value);
    };
    const currentPane = () =>
      (state.chatAgents || []).find((pane) => pane.paneId === state.chatPaneId);

    /** 存下当前会话：已加载的历史与阅读位置是一条，按原生会话身份分开。 */
    function save() {
      if (!state.chatContentReady || !state.chatMessages?.length) return;
      const key = app.currentKey();
      const viewport = app.filesReplaceChat() ? cache().get(key)?.viewport : app.captureViewport();
      put(key, {
        messages: state.chatMessages.slice(),
        status: state.lastChatStatus,
        hasMore: state.chatHasMore,
        viewport,
        lastMessageAt: Number(currentPane()?.lastMessageAt) || 0,
      });
    }

    /** 当前会话有缓存就直接画出来。 */
    function restore() {
      const cached = cache().get(app.currentKey());
      if (!cached) return;
      state.chatMessages = cached.messages;
      state.chatOldestId = cached.messages[0]?.id || '';
      state.chatHasMore = cached.hasMore;
      els.chatLog.dataset.paneId = state.chatPaneId;
      state.lastChatStatus = cached.status;
      app.render.contentReady(true);
      app.render.status(cached.status || {});
      app.render.messages(cached.messages, { viewport: cached.viewport });
    }

    /**
     * 预取最近的几个会话：切过去时直接从缓存画出来，再在后台更新到最新。
     *
     * 切换会话原来要等一个来回（服务端解析存档 + 网络），手机上常常一两秒才出来
     *（2026-09-24 用户指出）。不给服务端和流量添负担：会话有了新消息才重取，同一个会话
     * 至少隔 30 秒，页面在后台或断网时不取，一次只取一个。
     */
    const prefetchedAt = new Map();
    let prefetching = false,
      prefetchTimer = 0;
    function schedulePrefetch() {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => void prefetch(), 1500);
    }
    async function prefetch() {
      // 同步生效后其他会话由推送保持最新（docs/LOCAL_FIRST.md）；排下预取时可能还没生效，执行时再看一次。
      if (app.syncActive?.()) return void prefetchArchived();
      if (prefetching || document.hidden || navigator.onLine === false || !state.snapshotReady)
        return;
      prefetching = true;
      try {
        const candidates = app
          .recentPanes(
            (state.chatAgents || []).filter((pane) => pane.agent?.session?.value),
            state.outbox,
          )
          .filter((pane) => pane.paneId !== state.chatPaneId)
          .slice(0, PREFETCH_COUNT);
        for (const pane of candidates) {
          if (document.hidden || app.syncActive?.()) break;
          const key = app.keyFor(pane),
            stamp = Number(pane.lastMessageAt) || 0;
          const cached = cache().get(key);
          if (cached && (cached.lastMessageAt || 0) >= stamp) continue;
          if (Date.now() - (prefetchedAt.get(key) || 0) < PREFETCH_INTERVAL_MS) continue;
          prefetchedAt.set(key, Date.now());
          // 预取是给「待会儿可能切过去」准备的，不能跟眼前的会话抢连接：换了会话就中止，下次再取。
          const signal = app.selectionSignal();
          const result = await app
            .request(app.transcriptPath(pane.paneId, pane.agent.session.value, ''), { signal })
            .catch(() => null);
          if (signal.aborted) {
            prefetchedAt.delete(key);
            break;
          }
          // 文件页的列表一起跟上，点过去再左滑也是现成的。
          app.preloadFiles?.(
            pane.paneId,
            `${result?.messages?.length || 0}:${result?.messages?.at(-1)?.id || ''}`,
          );
          if (!result?.supported || !Array.isArray(result.messages)) continue;
          // 这期间用户可能已经打开过它，真正打开时存下的（带阅读位置）更新，不覆盖。
          if (cache().get(key) !== cached || key === app.currentKey()) continue;
          const overlap =
            cached?.messages.findIndex((message) => message.id === result.messages[0]?.id) ?? -1;
          const retain =
            overlap >= 0 &&
            cached.viewport?.bottom === false &&
            cached.status?.historyEpoch === result.historyEpoch;
          put(key, {
            messages: retain
              ? cached.messages.slice(0, overlap).concat(result.messages)
              : result.messages,
            status: result,
            hasMore: retain ? cached.hasMore : Boolean(result.hasMore),
            viewport: retain ? cached.viewport : null,
            lastMessageAt: stamp,
          });
        }
      } finally {
        prefetching = false;
      }
      void prefetchArchived();
    }

    /**
     * 启动先画上次的样子：会话列表与当前会话存在本机，页面一打开就画出来，再在后台更新。
     *
     * 手机上被系统回收之后再切回来，原来要等配置、实时通道、快照、正文一路都回来才有内容，
     * 先白屏、再「啪」地全部出现（2026-09-24 用户指出）。只存当前会话最近 60 条和列表。
     * 只在页面转入后台时写：序列化再写 localStorage 手机上一次要一百多毫秒，原来每次渲染后
     * 都写，切会话时就卡这一下（2026-09-24 实测）。手机切走应用必然先转入后台。
     */
    function persistBoot() {
      save();
      const key = app.currentKey(),
        cached = cache().get(key);
      if (!cached?.messages?.length || !state.config?.rootDirectory || !state.snapshotReady) return;
      try {
        localStorage.setItem(
          bootKey,
          JSON.stringify({
            version: 1,
            rootDirectory: state.config.rootDirectory,
            profile: state.config.profile || null,
            paneId: state.chatPaneId,
            panes: state.allPanes || [],
            workspaces: state.chatWorkspaces || [],
            chat: {
              key,
              messages: cached.messages.slice(-60),
              status: cached.status || {},
              hasMore: Boolean(cached.hasMore) || cached.messages.length > 60,
            },
          }),
        );
      } catch {
        /* 存不下就下次慢一点，不影响使用 */
      }
    }

    /** 画出上次存下的样子；返回它属于哪个根目录，没有可画的返回 null。 */
    function paintFromBoot() {
      let saved;
      try {
        saved = JSON.parse(localStorage.getItem(bootKey) || 'null');
      } catch {
        return null;
      }
      if (!saved || saved.version !== 1 || !saved.chat?.messages?.length) return null;
      state.config = {
        ...(state.config || {}),
        rootDirectory: saved.rootDirectory,
        profile: saved.profile,
      };
      state.allPanes = saved.panes;
      state.chatWorkspaces = saved.workspaces;
      state.chatAgents = saved.panes.filter(
        (pane) => window.StudioProviders.get(app.providerId(pane)).history,
      );
      state.chatPaneId = saved.paneId;
      if (app.currentKey() !== saved.chat.key) {
        state.chatPaneId = '';
        return null;
      }
      cache().set(saved.chat.key, { ...saved.chat, viewport: null });
      state.snapshotCached = true;
      els.chatView.hidden = false;
      app.render.picker();
      restore();
      app.render.session(currentPane());
      return saved.rootDirectory;
    }

    /**
     * 归档会话的正文：它已经停机、内容不再变，取一次就够。列表靠前的几条在后台先取好，
     * 点开时直接画，文件页的列表一起取（2026-09-25 用户指出点开归档要刷新一下）。
     * 归档列表本身也在这里定期更新（至多一分钟一次），切到「归档」时已是最新。
     */
    const ARCHIVED_LIMIT = 24,
      ARCHIVED_PREFETCH = 8;
    const archivedCache = new Map();
    let archivedBusy = false;
    function archived(key, entry) {
      if (entry === undefined) return archivedCache.get(key);
      archivedCache.delete(key);
      archivedCache.set(key, entry);
      while (archivedCache.size > ARCHIVED_LIMIT)
        archivedCache.delete(archivedCache.keys().next().value);
    }
    async function prefetchArchived() {
      if (archivedBusy || document.hidden || navigator.onLine === false) return;
      archivedBusy = true;
      try {
        if (Date.now() - (state.historyAt || 0) > 60000) await app.refreshHistory?.();
        for (const session of (state.history || []).slice(0, ARCHIVED_PREFETCH)) {
          if (document.hidden) break;
          const key = `${session.provider}:${session.sessionId}`;
          if ((archivedCache.get(key)?.lastMessageAt || -1) >= (session.lastMessageAt || 0))
            continue;
          const query = new URLSearchParams({
            provider: session.provider,
            sessionId: session.sessionId,
            limit: '60',
          });
          const result = await app.request(app.archivedPath(query)).catch(() => null);
          if (!Array.isArray(result?.messages)) continue;
          archived(key, { ...result, lastMessageAt: session.lastMessageAt || 0 });
          app.preloadFiles?.(`archived:${key}`);
        }
      } finally {
        archivedBusy = false;
      }
    }

    return {
      archived,
      prefetchArchived,
      save,
      restore,
      schedulePrefetch,
      persistBoot,
      paintFromBoot,
    };
  }

  return { create };
});
