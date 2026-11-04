(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioChatScroll = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(log) {
    const win = log.ownerDocument.defaultView;
    const interactive =
      'input, textarea, select, button, summary, a, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="slider"]';
    let following = true,
      touching = false,
      dragging = false,
      active = false,
      timer = 0,
      revision = 0;
    let frame = 0,
      previousTime = 0,
      reading = null,
      lastHeight = log.clientHeight,
      touch = null;
    const bottom = () => log.scrollHeight - log.scrollTop - log.clientHeight <= 1;
    const blocked = () => active || touching || dragging;
    const atBottom = () => !blocked() && (bottom() || Boolean(frame));
    const stop = () => {
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
    };
    function capture() {
      const value = { bottom: atBottom(), height: log.scrollHeight, top: log.scrollTop, revision };
      if (!value.bottom && log.clientHeight) {
        const top = log.getBoundingClientRect().top;
        // Measure only the visible group; offscreen content-visibility groups stay skipped.
        for (const chunk of log.children) {
          const rect = chunk.getBoundingClientRect();
          if (rect.bottom <= top + 1 || rect.top >= top + log.clientHeight) continue;
          for (const node of chunk.querySelectorAll('[data-scroll-key]')) {
            const rect = node.getBoundingClientRect();
            if (rect.bottom > top + 1) {
              value.key = node.dataset.scrollKey;
              value.offset = rect.top - top;
              break;
            }
          }
          if (value.key) break;
        }
      }
      return value;
    }
    function remember() {
      if (log.clientHeight) reading = capture();
    }
    function anchor(value) {
      const node =
        value.key &&
        [...log.querySelectorAll('[data-scroll-key]')].find(
          (node) => node.dataset.scrollKey === value.key,
        );
      if (node) {
        const delta =
          node.getBoundingClientRect().top - log.getBoundingClientRect().top - value.offset;
        if (Math.abs(delta) > 0.5) log.scrollTop += delta;
      } else log.scrollTop = value.top;
    }
    function follow(smooth = true) {
      if (blocked()) return;
      const distance = log.scrollHeight - log.clientHeight - log.scrollTop;
      following = true;
      if (
        !smooth ||
        !win?.requestAnimationFrame ||
        win.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        distance > log.clientHeight ||
        distance < 1
      ) {
        stop();
        if (distance) log.scrollTop = log.scrollHeight;
        return;
      }
      if (frame) return;
      const step = (now) => {
        const delta = log.scrollHeight - log.clientHeight - log.scrollTop;
        if (blocked() || !log.isConnected || !log.clientHeight) {
          stop();
          return;
        }
        const elapsed = previousTime ? Math.min(64, now - previousTime) : 16;
        previousTime = now;
        if (Math.abs(delta) <= 1) {
          log.scrollTop = log.scrollHeight;
          stop();
          return;
        }
        // Integer scroll offsets must still converge on high-refresh displays.
        log.scrollTop +=
          Math.sign(delta) * Math.max(1, Math.abs(delta) * (1 - Math.exp(-elapsed / 50)));
        frame = win.requestAnimationFrame(step);
      };
      frame = win.requestAnimationFrame(step);
    }
    function settled() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (touching || dragging) return;
        active = false;
        following = bottom();
        remember();
      }, 180);
    }
    function gesture() {
      stop();
      revision++;
      active = true;
      following = false;
      settled();
    }
    log.addEventListener(
      'wheel',
      (event) => {
        if (
          event.defaultPrevented ||
          event.ctrlKey ||
          event.shiftKey ||
          Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
          !event.deltaY
        )
          return;
        gesture();
      },
      { passive: true },
    );
    log.addEventListener(
      'touchstart',
      (event) => {
        touch =
          event.touches.length === 1
            ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
            : null;
      },
      { passive: true },
    );
    log.addEventListener(
      'touchmove',
      (event) => {
        if (!touch || event.touches.length !== 1) return;
        const dx = event.touches[0].clientX - touch.x,
          dy = event.touches[0].clientY - touch.y;
        if (Math.abs(dy) >= 8 && Math.abs(dy) > Math.abs(dx)) {
          touching = true;
          gesture();
        }
      },
      { passive: true },
    );
    const endTouch = () => {
      touch = null;
      if (touching) {
        touching = false;
        settled();
      }
    };
    log.addEventListener('touchend', endTouch, { passive: true });
    log.addEventListener('touchcancel', endTouch, { passive: true });
    log.addEventListener(
      'pointerdown',
      (event) => {
        if (
          event.pointerType === 'mouse' &&
          event.button === 0 &&
          !event.target.closest(interactive)
        ) {
          dragging = true;
          gesture();
        }
      },
      { passive: true },
    );
    const endPointer = () => {
      if (dragging) {
        dragging = false;
        settled();
      }
    };
    log.ownerDocument.addEventListener('pointerup', endPointer, { passive: true });
    log.ownerDocument.addEventListener('pointercancel', endPointer, { passive: true });
    // Expanding a disclosure is deliberate reading, unlike copy/menu buttons.
    log.addEventListener('click', (event) => {
      if (event.target.closest('summary, .code-wrap, .tool-load')) gesture();
    });
    log.addEventListener('keydown', (event) => {
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.target.closest(interactive) &&
        ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
      )
        gesture();
    });
    log.addEventListener(
      'scroll',
      () => {
        const resized = lastHeight !== log.clientHeight;
        lastHeight = log.clientHeight;
        if (blocked()) settled();
        else if (!frame && (!resized || bottom())) following = bottom();
        remember();
      },
      { passive: true },
    );
    function restore(before, { duringGesture = false } = {}) {
      if (!before || before.revision !== revision || (blocked() && !duringGesture)) return;
      if (before.bottom) {
        if (log.scrollHeight !== before.height) follow();
      } else anchor(before);
      remember();
    }
    const observer = win?.ResizeObserver
      ? new win.ResizeObserver(() => {
          if (!log.clientHeight || blocked()) return;
          if (following) follow();
          else if (reading?.revision === revision) anchor(reading);
          remember();
        })
      : null;
    let observed = new Set();
    return {
      enterLatest: () => {
        clearTimeout(timer);
        stop();
        revision++;
        active = touching = dragging = false;
        following = true;
        reading = null;
        log.scrollTop = log.scrollHeight;
      },
      jumpTo: (node) => {
        clearTimeout(timer);
        stop();
        revision++;
        active = touching = dragging = false;
        following = false;
        reading = null;
        // Lay out the target chunk before measuring content-visibility descendants.
        node.closest('.chat-chunk')?.getBoundingClientRect();
        log.scrollTop += node.getBoundingClientRect().top - log.getBoundingClientRect().top - 16;
        remember();
      },
      atBottom,
      setFollowing: (value) => {
        following = Boolean(value);
        if (!following) stop();
      },
      capture: () => {
        const value = capture();
        reading = value;
        return value;
      },
      restore,
      restorePosition: (value) => {
        if (!value) return;
        clearTimeout(timer);
        stop();
        revision++;
        active = touching = dragging = false;
        following = Boolean(value.bottom);
        if (following) follow(false);
        else anchor(value);
        remember();
      },
      observe: () => {
        if (!observer) return;
        const next = new Set([log, ...log.querySelectorAll(':scope > .chat-chunk')]);
        for (const node of observed) if (!next.has(node)) observer.unobserve(node);
        for (const node of next) if (!observed.has(node)) observer.observe(node);
        observed = next;
      },
      captureResize: () => ({ following: following && !blocked(), revision, position: capture() }),
      followResize: (before) => {
        if ((before && before.revision !== revision) || blocked()) return;
        if (before ? before.following : following) follow(false);
        else if (before?.position) anchor(before.position);
        lastHeight = log.clientHeight;
        remember();
      },
    };
  }
  return { create };
});
