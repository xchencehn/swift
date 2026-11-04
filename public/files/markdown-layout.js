(function (root) {
  'use strict';
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  function create({ view, content, id, onWidth, onOutline, onOutlineWidth }) {
    const reader = make('div', 'workspace-markdown-reader');
    const outline = make('nav', 'workspace-file-outline');
    outline.id = `${id}-outline`;
    outline.setAttribute('aria-label', '文档目录');
    const handle = make('div', 'workspace-markdown-resizer');
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Markdown 阅读宽度，左右键调整，Home 恢复默认');
    const outlineHandle = make('div', 'workspace-outline-resizer');
    outlineHandle.tabIndex = 0;
    outlineHandle.setAttribute('role', 'separator');
    outlineHandle.setAttribute('aria-orientation', 'vertical');
    outlineHandle.setAttribute('aria-label', '目录宽度，左右键调整，Home 恢复默认');
    outlineHandle.setAttribute('aria-controls', outline.id);
    view.classList.add('workspace-markdown-view');
    reader.append(content);
    view.append(reader, outline, handle, outlineHandle);
    const headings = [...content.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    const minimumLevel = headings.reduce(
      (level, node) => Math.min(level, Number(node.tagName[1])),
      6,
    );
    const title = make('div', 'workspace-outline-title', '目录');
    const dismiss = make('button', 'workspace-outline-close chat-icon-btn', '×');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', '收起目录');
    dismiss.addEventListener('click', () => toggle(false));
    title.append(dismiss);
    outline.append(title);
    const links = headings.map((heading, index) => {
      heading.id = `${id}-heading-${index}`;
      heading.tabIndex = -1;
      const link = make('button', 'workspace-outline-link', heading.textContent.trim() || '无标题');
      link.type = 'button';
      link.title = link.textContent;
      link.style.setProperty('--heading-depth', Number(heading.tagName[1]) - minimumLevel);
      link.addEventListener('click', () => {
        reader.scrollTop +=
          heading.getBoundingClientRect().top - reader.getBoundingClientRect().top - 20;
        heading.focus({ preventScroll: true });
        if (compact()) toggle(false);
        updateCurrent();
      });
      outline.append(link);
      return link;
    });
    if (!headings.length) outline.append(make('p', 'workspace-outline-empty', '此文档没有标题。'));
    let frame = 0,
      selected = -1,
      dragging = null,
      outlineDragging = null;
    const desktop = matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)');
    const compact = () => view.clientWidth <= 760;
    const expanded = () => getComputedStyle(outline).display !== 'none';
    function toggle(value = !expanded()) {
      view.classList.toggle('outline-open', value);
      view.classList.toggle('outline-closed', !value);
      if (!value && outline.contains(document.activeElement))
        view
          .closest('.workspace-files-page')
          .querySelector('.workspace-file-outline-toggle')
          .focus({ preventScroll: true });
      onOutline(expanded());
      schedule();
    }
    outline.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        toggle(false);
      }
    });
    function updateCurrent() {
      if (view.hidden || document.hidden || !headings.length) return;
      // Headings remain in document order. Binary search avoids scanning a long document on every scroll.
      const top = reader.getBoundingClientRect().top + 48;
      let low = 0,
        high = headings.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (headings[middle].getBoundingClientRect().top <= top) low = middle + 1;
        else high = middle;
      }
      const next = Math.max(0, low - 1);
      if (next === selected) return;
      links[selected]?.removeAttribute('aria-current');
      selected = next;
      links[next].setAttribute('aria-current', 'location');
      if (expanded()) {
        const item = links[next].getBoundingClientRect(),
          box = outline.getBoundingClientRect();
        if (item.top < box.top + 42) outline.scrollTop += item.top - box.top - 42;
        else if (item.bottom > box.bottom - 12) outline.scrollTop += item.bottom - box.bottom + 12;
      }
    }
    function position() {
      if (view.hidden || !view.clientWidth) return;
      const box = reader.getBoundingClientRect(),
        column = content.getBoundingClientRect(),
        host = view.getBoundingClientRect();
      outlineHandle.hidden = compact() || !expanded();
      if (!outlineHandle.hidden) {
        const bounds = outline.getBoundingClientRect();
        outlineHandle.style.left = `${bounds.left - host.left - 6}px`;
        outlineHandle.setAttribute('aria-valuemin', '160');
        outlineHandle.setAttribute('aria-valuemax', String(Math.floor(outlineLimit())));
        outlineHandle.setAttribute('aria-valuenow', String(Math.round(bounds.width)));
      }
      handle.hidden = !desktop.matches || box.width < 400;
      if (!handle.hidden) {
        Object.assign(handle.style, {
          left: `${column.left - host.left - 10}px`,
          height: `${Math.max(100, box.height / 4)}px`,
        });
        handle.setAttribute('aria-valuemin', '360');
        handle.setAttribute('aria-valuemax', String(Math.floor(box.width - 48)));
        handle.setAttribute('aria-valuenow', String(Math.round(column.width)));
      }
      onOutline(expanded());
      updateCurrent();
    }
    function schedule() {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          position();
        });
    }
    function apply(value) {
      onWidth(Math.round(Math.max(360, Math.min(reader.clientWidth - 48, value))));
      schedule();
    }
    function finish(event) {
      if (!dragging || (event && event.pointerId !== dragging.pointerId)) return;
      const pointer = dragging.pointerId;
      dragging = null;
      document.documentElement.classList.remove('resizing-chat-content');
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    }
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.pointerType !== 'mouse' || !desktop.matches) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = {
        pointerId: event.pointerId,
        x: event.clientX,
        width: content.getBoundingClientRect().width,
      };
      handle.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('resizing-chat-content');
    });
    handle.addEventListener('pointermove', (event) => {
      if (dragging) apply(dragging.width - 2 * (event.clientX - dragging.x));
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
      handle.addEventListener(name, finish);
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home') {
        onWidth(null);
        schedule();
      } else apply(content.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 20 : -20));
    });
    const outlineLimit = () => Math.min(480, view.clientWidth / 2);
    function resizeOutline(width) {
      onOutlineWidth(Math.round(Math.max(160, Math.min(outlineLimit(), width))));
      schedule();
    }
    function finishOutline(event) {
      if (!outlineDragging || (event && event.pointerId !== outlineDragging.pointerId)) return;
      const pointer = outlineDragging.pointerId;
      outlineDragging = null;
      document.documentElement.classList.remove('resizing-chat-content');
      if (outlineHandle.hasPointerCapture(pointer)) outlineHandle.releasePointerCapture(pointer);
    }
    outlineHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || compact() || !expanded()) return;
      event.preventDefault();
      event.stopPropagation();
      outlineDragging = {
        pointerId: event.pointerId,
        x: event.clientX,
        width: outline.getBoundingClientRect().width,
      };
      outlineHandle.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('resizing-chat-content');
    });
    outlineHandle.addEventListener('pointermove', (event) => {
      if (outlineDragging && event.pointerId === outlineDragging.pointerId)
        resizeOutline(outlineDragging.width - (event.clientX - outlineDragging.x));
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
      outlineHandle.addEventListener(name, finishOutline);
    outlineHandle.addEventListener('keydown', (event) => {
      if (compact() || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home') {
        onOutlineWidth(null);
        schedule();
      } else resizeOutline(outline.clientWidth + (event.key === 'ArrowLeft' ? 20 : -20));
    });
    reader.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(reader);
    observer.observe(content);
    desktop.addEventListener('change', schedule);
    schedule();
    return {
      toggle,
      expanded,
      outlineId: outline.id,
      close() {
        finish();
        finishOutline();
        cancelAnimationFrame(frame);
        observer.disconnect();
        desktop.removeEventListener('change', schedule);
        reader.removeEventListener('scroll', schedule);
        view.classList.remove('workspace-markdown-view', 'outline-open', 'outline-closed');
      },
    };
  }
  root.StudioFileMarkdown = { create };
})(globalThis);
