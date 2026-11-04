(function (root) {
  'use strict';
  // Transforms preview the native order; only a completed mouse gesture writes it.
  function create({ list, read, commit, render }) {
    const reduced = root.matchMedia('(prefers-reduced-motion: reduce)');
    let drag = null,
      frame = 0,
      suppressClick = false;
    const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
    const duration = () =>
      reduced.matches
        ? 0
        : parseFloat(getComputedStyle(list).getPropertyValue('--motion-reorder')) || 180;
    function release(d) {
      if (list.hasPointerCapture(d.pointerId)) list.releasePointerCapture(d.pointerId);
    }
    function clear() {
      const d = drag;
      if (!d) return;
      drag = null;
      cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(d.timer);
      release(d);
      list.classList.remove('tab-drag-active');
      document.body.classList.remove('herdr-dragging-tab');
      for (const item of d.items) {
        item.node.classList.remove('tab-drag-held', 'tab-drag-settling');
        item.node.style.removeProperty('transform');
      }
    }
    function finish() {
      clear();
      render();
    }
    function preview(d, settling = false) {
      const order = d.items.slice(),
        [held] = order.splice(d.from, 1);
      order.splice(d.to, 0, held);
      d.targetIds = order.map((item) => item.id);
      let left = d.items[0].left;
      for (const item of order) {
        const shift = item === held && !settling ? d.dx : left - item.left;
        item.node.style.transform = `translateX(${shift}px)`;
        left += item.width;
      }
    }
    function rollback() {
      const d = drag;
      if (!d) return;
      if (d.phase === 'armed') {
        clear();
        return;
      }
      if (d.phase === 'committing') {
        finish();
        return;
      }
      cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(d.timer);
      d.phase = 'canceling';
      release(d);
      d.node.classList.add('tab-drag-settling');
      for (const item of d.items) item.node.style.transform = 'translateX(0px)';
      d.timer = setTimeout(finish, duration());
    }
    // Called before the shell mutates DOM. Never reorder underneath a held tab.
    function sync() {
      const d = drag;
      if (!d) return false;
      const state = read(),
        orderValid =
          same(state.ids, d.ids) || (d.phase === 'committing' && same(state.ids, d.targetIds));
      if (
        !state.visible ||
        !state.connected ||
        state.runtimeId !== d.runtimeId ||
        state.workspaceId !== d.workspaceId ||
        !orderValid ||
        list.clientWidth !== d.listWidth ||
        (state.busy && d.phase !== 'committing')
      )
        clear();
      return Boolean(drag);
    }
    function tick(time) {
      frame = 0;
      const d = drag;
      if (!d || d.phase !== 'dragging') return;
      const box = list.getBoundingClientRect(),
        edge = Math.min(48, box.width / 4);
      const speed =
        d.x < box.left + edge
          ? -Math.min(1, (box.left + edge - d.x) / edge)
          : d.x > box.right - edge
            ? Math.min(1, (d.x - box.right + edge) / edge)
            : 0;
      const elapsed = Math.min(32, time - (d.time || time));
      d.time = time;
      if (speed) list.scrollLeft += speed * elapsed * 0.65;
      const held = d.items[d.from],
        first = d.items[0],
        last = d.items.at(-1);
      d.dx = Math.max(
        first.left - held.left,
        Math.min(
          last.left + last.width - held.width - held.left,
          d.x - d.startX + list.scrollLeft - d.scrollLeft,
        ),
      );
      const center = held.left + held.width / 2 + d.dx;
      const centers = d.items.map((item) => item.left + item.width / 2);
      while (d.to < centers.length - 1 && center > (centers[d.to] + centers[d.to + 1]) / 2 + 4)
        d.to++;
      while (d.to > 0 && center < (centers[d.to] + centers[d.to - 1]) / 2 - 4) d.to--;
      preview(d);
      frame = requestAnimationFrame(tick);
    }
    list.addEventListener('pointerdown', (event) => {
      if (drag || event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
      suppressClick = false;
      const node = event.target.closest('.herdr-tab');
      if (!node || event.target.closest('.herdr-tab-close')) return;
      const state = read();
      if (!state.visible || !state.connected || state.busy || state.ids.length < 2) return;
      const items = [...list.children].map((node) => {
        const box = node.getBoundingClientRect();
        return { node, id: node.dataset.tabId, left: box.left, width: box.width };
      });
      const from = items.findIndex((item) => item.node === node);
      drag = {
        ...state,
        node,
        items,
        from,
        to: from,
        targetIds: state.ids,
        pointerId: event.pointerId,
        phase: 'armed',
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        dx: 0,
        scrollLeft: list.scrollLeft,
        listWidth: list.clientWidth,
      };
    });
    root.addEventListener('pointermove', (event) => {
      const d = drag;
      if (!d || event.pointerId !== d.pointerId || !['armed', 'dragging'].includes(d.phase)) return;
      if (!(event.buttons & 1)) {
        rollback();
        return;
      }
      d.x = event.clientX;
      if (d.phase === 'armed') {
        if (Math.hypot(d.x - d.startX, event.clientY - d.startY) < 5) return;
        d.phase = 'dragging';
        suppressClick = true;
        list.setPointerCapture(d.pointerId);
        list.classList.add('tab-drag-active');
        document.body.classList.add('herdr-dragging-tab');
        d.node.classList.add('tab-drag-held');
        root.getSelection()?.removeAllRanges();
        frame = requestAnimationFrame(tick);
      }
      event.preventDefault();
    });
    root.addEventListener('pointerup', (event) => {
      const d = drag;
      if (!d || event.pointerId !== d.pointerId || !['armed', 'dragging'].includes(d.phase)) return;
      if (d.phase === 'armed') {
        clear();
        return;
      }
      event.preventDefault();
      const box = list.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top - 12 ||
        event.clientY > box.bottom + 12
      ) {
        rollback();
        return;
      }
      d.x = event.clientX;
      cancelAnimationFrame(frame);
      tick(performance.now());
      cancelAnimationFrame(frame);
      frame = 0;
      d.phase = 'settling';
      release(d);
      d.node.classList.add('tab-drag-settling');
      preview(d, true);
      d.timer = setTimeout(async () => {
        if (drag !== d) return;
        if (d.to === d.from) {
          finish();
          return;
        }
        if (!sync()) {
          render();
          return;
        }
        d.phase = 'committing';
        try {
          await commit(d.items[d.from].id, d.to, d.runtimeId);
        } finally {
          if (drag === d) {
            if (same(read().ids, d.targetIds)) finish();
            else {
              d.phase = 'settling';
              rollback();
            }
          }
        }
      }, duration());
    });
    list.addEventListener(
      'click',
      (event) => {
        if (!suppressClick && !drag) return;
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    list.addEventListener('dragstart', (event) => event.preventDefault());
    list.addEventListener(
      'contextmenu',
      () => {
        if (drag) rollback();
      },
      true,
    );
    list.addEventListener('lostpointercapture', () => {
      if (drag?.phase === 'dragging') rollback();
    });
    root.addEventListener('pointercancel', (event) => {
      if (drag?.pointerId === event.pointerId) rollback();
    });
    root.addEventListener('blur', rollback);
    root.addEventListener('resize', () => {
      if (drag) finish();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && drag) finish();
    });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && drag && drag.phase !== 'committing') {
          event.preventDefault();
          event.stopImmediatePropagation();
          rollback();
        }
      },
      true,
    );
    return { sync, active: () => Boolean(drag) };
  }
  root.StudioNativeTabDrag = { create };
})(globalThis);
