(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioVisualViewport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function isTouchDevice(win = typeof window === 'undefined' ? null : window) {
    if (!win) return false;
    return (
      (win.navigator?.maxTouchPoints || 0) > 0 ||
      Boolean(win.matchMedia?.('(pointer: coarse)').matches)
    );
  }

  /**
   * 把可视视口的高度写进 `--visual-viewport-height`,CSS 靠它定版面高度。
   *
   * 不能写死 `100dvh`:安卓 Chrome 的 dvh 不随软键盘收缩,写死就等于页面留在原处
   * 被键盘盖住。只在触摸设备上挂 —— 桌面没有软键盘,白挂两个监听。
   */
  function bindVisualViewport({
    rootElement = typeof document === 'undefined' ? null : document.documentElement,
    visualViewport = typeof window === 'undefined' ? null : window.visualViewport,
    viewportWindow = typeof window === 'undefined' ? null : window,
    onBeforeChange = () => {},
    onChange = () => {},
    enabled = isTouchDevice(),
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (handle) => cancelAnimationFrame(handle),
  } = {}) {
    if (!rootElement || !visualViewport || !enabled) return { sync() {}, destroy() {} };
    let frame = 0,
      previous = '',
      lastLayoutHeight = viewportWindow?.innerHeight || 0;
    let lastLayoutWidth = viewportWindow?.innerWidth || 0;
    let expandedLayoutHeight = 0;
    const focusTimers = [];
    const apply = () => {
      frame = 0;
      const layoutHeight = viewportWindow?.innerHeight || visualViewport.height;
      const layoutWidth = viewportWindow?.innerWidth || 0;
      const widthChanged = lastLayoutWidth && layoutWidth && layoutWidth !== lastLayoutWidth;
      // Android WebView can enlarge its layout viewport before visualViewport
      // reports the keyboard closing. Keep that height until the next editable
      // interaction; transient smaller measurements must not collapse the page.
      if (widthChanged) expandedLayoutHeight = 0;
      else if (layoutHeight > lastLayoutHeight + 16 && layoutHeight > visualViewport.height + 16)
        expandedLayoutHeight = layoutHeight;
      lastLayoutHeight = layoutHeight;
      lastLayoutWidth = layoutWidth;
      const height = Math.round(
        expandedLayoutHeight || Math.min(visualViewport.height, layoutHeight),
      );
      const top = Math.round(
        Math.max(0, Math.min(visualViewport.offsetTop || 0, layoutHeight - height)),
      );
      const key = `${height}:${top}`;
      if (height <= 0 || previous === key) return;
      const before = onBeforeChange();
      previous = key;
      rootElement.setAttribute?.('data-visual-viewport', '');
      if (height < 320) rootElement.setAttribute?.('data-compact-viewport', '');
      else rootElement.removeAttribute?.('data-compact-viewport');
      rootElement.style.setProperty('--visual-viewport-height', `${height}px`);
      rootElement.style.setProperty('--visual-viewport-offset-top', `${top}px`);
      onChange(before);
    };
    const sync = () => {
      if (frame) cancelFrame(frame);
      frame = requestFrame(apply);
    };
    visualViewport.addEventListener('resize', sync);
    visualViewport.addEventListener('scroll', sync);
    viewportWindow?.addEventListener('resize', sync);
    const editable = (target) =>
      Boolean(
        target?.matches?.(
          'input:not([readonly]), textarea:not([readonly]), [contenteditable="true"]',
        ),
      );
    const resetForInput = (event) => {
      if (editable(event.target) && expandedLayoutHeight) {
        expandedLayoutHeight = 0;
        sync();
      }
    };
    const onFocusOut = (event) => {
      if (!editable(event.target)) return;
      for (const timer of focusTimers.splice(0)) clearTimeout(timer);
      sync();
      for (const delay of [80, 180, 320, 500]) focusTimers.push(setTimeout(sync, delay));
    };
    viewportWindow?.document?.addEventListener('focusin', resetForInput);
    viewportWindow?.document?.addEventListener('pointerdown', resetForInput);
    viewportWindow?.document?.addEventListener('focusout', onFocusOut);
    sync();
    return {
      sync,
      destroy() {
        if (frame) cancelFrame(frame);
        for (const timer of focusTimers) clearTimeout(timer);
        visualViewport.removeEventListener('resize', sync);
        visualViewport.removeEventListener('scroll', sync);
        viewportWindow?.removeEventListener('resize', sync);
        viewportWindow?.document?.removeEventListener('focusin', resetForInput);
        viewportWindow?.document?.removeEventListener('pointerdown', resetForInput);
        viewportWindow?.document?.removeEventListener('focusout', onFocusOut);
        rootElement.removeAttribute?.('data-visual-viewport');
        rootElement.removeAttribute?.('data-compact-viewport');
        rootElement.style.removeProperty('--visual-viewport-height');
        rootElement.style.removeProperty('--visual-viewport-offset-top');
      },
    };
  }

  return { bindVisualViewport, isTouchDevice };
});
