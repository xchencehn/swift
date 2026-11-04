/**
 * 会话页的横向手势：一次手势只走一步，两端不循环。
 *
 *   左栏里    左滑「spaces → agent → archive → files → 收起左栏」，右滑反向；
 *   聊天页    右滑打开左栏的 spaces 页并恢复位置，左滑进文件页；
 *   文件页    没有标签：在列表上右滑回到聊天页，读文档时右滑是返回上一层，左滑不做什么。
 *
 * 触摸时分三种：换页跟手（nav/page-drag.js）、换标签跟手（nav/tab-drag.js）、以及系统要求减少动效时的
 * 一步切换。嵌套滑动：里层（标签）先消费，到头了才交给外层（换页）。电脑触控板的横向滚动走一步切换。
 * 文字选择、横向滚动的代码与表格、纵向滚动都保留它们自己的手势。判据见 docs/INTERACTION_DESIGN.md。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioSwipe = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIDEBAR_MODES = ['workspace', 'recent', 'history', 'files'];
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * @param {HTMLElement} host  接收手势的容器（整个会话页）
   * @param {object} app        外壳提供的状态与动作，都在手势发生时才读，绑定时不必已经就绪
   *   state, els                     全局状态与常用节点
   *   isWide()                       宽屏（左栏常驻、可收起）
   *   filesSlide()                   文件页是滑入的一层（非电脑档）
   *   files()                        文件页外壳（stepTab / leavesOnBack）
   *   back()                         返回上一层
   *   setDrawerOpen(open) / setSidebarCollapsed(collapsed) / setFilesPage(open)
   *   renderPicker() / loadHistory()
   */
  function bind(host, app) {
    const { state, els } = app;
    const tree = document.getElementById('workspaceFilesTree');
    const buttons = [
      els.sidebarWorkspaces,
      els.sidebarRecent,
      els.sidebarHistory,
      document.getElementById('sidebarFiles'),
    ];
    const sidebarOpen = () =>
      app.isWide()
        ? !els.chatView.classList.contains('sidebar-collapsed')
        : els.chatSidebar.classList.contains('open');
    const setMode = (mode) => {
      state.sidebarMode = mode;
      app.renderPicker();
    };
    const revealMode = () => app.revealPickerMode();

    // 一步切换：减少动效、触控板，以及跟手没接手的情况。
    function step(dx, inSidebar) {
      const wide = app.isWide(),
        open = sidebarOpen();
      if (state.filesOpen && !inSidebar) {
        if (app.files().stepTab(dx < 0 ? 1 : -1)) return;
        if (dx > 0) app.back();
        return;
      }
      if (dx > 0) {
        if (!open) {
          if (wide) app.setSidebarCollapsed(false);
          else app.setDrawerOpen(true);
        } else if (inSidebar) {
          const from = SIDEBAR_MODES.indexOf(state.sidebarMode);
          if (from > 0) {
            setMode(SIDEBAR_MODES[from - 1]);
            revealMode();
          }
        }
      } else if (open && inSidebar) {
        const from = SIDEBAR_MODES.indexOf(state.sidebarMode);
        if (from >= 0 && from < SIDEBAR_MODES.length - 1) {
          setMode(SIDEBAR_MODES[from + 1]);
          revealMode();
        } else if (wide) app.setSidebarCollapsed(true);
        else app.setDrawerOpen(false);
      } else if (dx < 0 && !inSidebar) app.setFilesPage(true);
    }

    // 这一下是不是换页；是的话返回 nav/page-drag.js 的 kind。
    function planPage(dx, inSidebar) {
      if (reducedMotion()) return null;
      const narrow = !app.isWide(),
        slideFiles = app.filesSlide();
      const drawerOpen = els.chatSidebar.classList.contains('open');
      if (inSidebar)
        return narrow && drawerOpen && dx < 0 && state.sidebarMode === SIDEBAR_MODES.at(-1)
          ? 'close-sidebar'
          : null;
      if (state.filesOpen)
        return slideFiles && dx > 0 && app.files().leavesOnBack() ? 'close-files' : null;
      if (drawerOpen) return null;
      if (dx > 0) return narrow ? 'open-sidebar' : null;
      return slideFiles && (state.chatPaneId || state.archived) ? 'open-files' : null;
    }

    // 这一下是不是换标签；里层到头了给 null，由换页接手。
    function planTab(dx, inSidebar) {
      if (reducedMotion() || !window.StudioTabDrag) return null;
      // 文件页没有标签（一个列表加搜索框），横滑只剩换页与返回。
      if (!inSidebar) return null;
      const from = SIDEBAR_MODES.indexOf(state.sidebarMode),
        to = from + (dx < 0 ? 1 : -1);
      if (from < 0 || to < 0 || to >= SIDEBAR_MODES.length) return null;
      return {
        list: state.sidebarMode === 'files' ? tree : els.chatPickerList,
        targetList: SIDEBAR_MODES[to] === 'files' ? tree : els.chatPickerList,
        from,
        to,
        tabs: buttons,
        onFinish: revealMode,
        beforeSelect: () => app.capturePickerScroll?.(),
        select: (index) => {
          setMode(SIDEBAR_MODES[index]);
          return SIDEBAR_MODES[index] === 'history' ? app.loadHistory() : undefined;
        },
      };
    }

    function startPageDrag(kind, dx, at, downAt) {
      return window.StudioPageDrag.start({
        kind,
        dx,
        at,
        downAt,
        sidebar: els.chatSidebar,
        scrim: els.chatPickerScrim,
        page: document.querySelector('#sessionFilesPage'),
        conversation: document.querySelector('.chat-conversation'),
        setOpen: (which, open) =>
          which === 'files' ? app.setFilesPage(open) : app.setDrawerOpen(open),
      });
    }

    let wheelX = 0,
      wheelAt = 0,
      wheelUntil = 0;
    host.addEventListener(
      'wheel',
      (event) => {
        if (host.dataset.conversationMode === 'terminal' && !event.target.closest?.('#chatSidebar'))
          return;
        if (
          Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.5 ||
          event.target.closest?.(
            'input, textarea, pre, table, .popover, .herdr-tabs, .chat-status-scroll, .shell-terminal-keys, .shell-terminal-combos, .code-actions, #settingsPage, #workspaceFilesPage, #sendHistoryZone',
          )
        )
          return;
        event.preventDefault();
        // 手势间隔必须使用单调时钟，避免系统校时延长或跳过冷却。
        const now = performance.now();
        if (now < wheelUntil) return;
        wheelX = (now - wheelAt > 220 ? 0 : wheelX) + event.deltaX;
        wheelAt = now;
        if (Math.abs(wheelX) < 70) return;
        step(-wheelX, Boolean(event.target.closest?.('#chatSidebar')));
        wheelX = 0;
        wheelUntil = now + 400;
      },
      { passive: false },
    );

    let downX = 0,
      downY = 0,
      downAt = 0,
      fired = false,
      tracking = false,
      inSidebar = false,
      drag = null,
      startedOnNavigation = false,
      suppressNavigationClick = false;
    // Explicit controls supersede decorative settlement immediately.
    host.addEventListener(
      'pointerdown',
      (event) => {
        suppressNavigationClick = false;
        if (!event.target.closest?.('button, input, textarea, select, [role="separator"]')) return;
        window.StudioTabDrag?.finish();
        window.StudioPageDrag?.finish();
      },
      { capture: true, passive: true },
    );
    host.addEventListener(
      'keydown',
      () => {
        suppressNavigationClick = false;
        window.StudioTabDrag?.finish();
        window.StudioPageDrag?.finish();
      },
      true,
    );
    host.addEventListener(
      'touchstart',
      (event) => {
        if (host.dataset.conversationMode === 'terminal' && !event.target.closest?.('#chatSidebar'))
          return;
        if (event.touches.length !== 1) {
          tracking = false;
          drag?.cancel();
          drag = null;
          return;
        }
        const target = event.target;
        startedOnNavigation = Boolean(target.closest?.('.sidebar-modes'));
        suppressNavigationClick = false;
        const scrollable = target.closest?.('pre code, pre, table, .chat-composer-text');
        tracking =
          !target.closest?.(
            'input, textarea, select, .popover, .slash-commands, .herdr-tabs, .chat-status-scroll, .shell-terminal-keys, .shell-terminal-combos, .code-actions, #settingsPage, #workspaceFilesPage, #sendHistoryZone',
          ) && !(scrollable && scrollable.scrollWidth > scrollable.clientWidth + 1);
        inSidebar = Boolean(target.closest?.('#chatSidebar'));
        downX = event.touches[0].clientX;
        downY = event.touches[0].clientY;
        downAt = event.timeStamp;
        fired = false;
      },
      { passive: true },
    );
    host.addEventListener(
      'touchmove',
      (event) => {
        if (event.touches.length !== 1) {
          tracking = false;
          drag?.cancel();
          drag = null;
          return;
        }
        const dx = event.touches[0].clientX - downX,
          dy = event.touches[0].clientY - downY;
        if (drag) {
          drag.move(dx, event.timeStamp);
          return;
        }
        if (!tracking || fired || event.touches.length !== 1) return;
        if (Math.abs(dy) >= 56 && Math.abs(dy) > Math.abs(dx) * 1.5) {
          tracking = false;
          return;
        }
        // 横向一明确（10px 且压过纵向）就开始跟手：先看是不是换页，再看是不是换标签。
        if (Math.abs(dx) >= 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          const kind = planPage(dx, inSidebar);
          if (kind) {
            fired = true;
            drag = startPageDrag(kind, dx, event.timeStamp, downAt);
            return;
          }
          const tabs = planTab(dx, inSidebar);
          if (tabs) {
            fired = true;
            drag = window.StudioTabDrag.start({ ...tabs, offset: dx, at: event.timeStamp, downAt });
            return;
          }
        }
        if (Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
        fired = true;
        step(dx, inSidebar);
      },
      { passive: true },
    );
    const release = (event) => {
      suppressNavigationClick = startedOnNavigation && fired;
      tracking = false;
      if (drag) {
        drag.end(event.timeStamp);
        drag = null;
      }
    };
    host.addEventListener('touchend', release, { passive: true });
    // A consumed swipe on a tab must not activate its original button on release.
    host.addEventListener(
      'click',
      (event) => {
        if (!suppressNavigationClick || !event.target.closest?.('.sidebar-modes')) return;
        suppressNavigationClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    host.addEventListener(
      'touchcancel',
      () => {
        tracking = false;
        drag?.cancel();
        drag = null;
      },
      { passive: true },
    );
  }

  return { bind, SIDEBAR_MODES };
});
