(function (root) {
  'use strict';
  root.StudioMessageNavigation = {
    create({ log, scroll, identity, hasMore, loadEarlier, readOutline, loadTarget, latest }) {
      const doc = log.ownerDocument,
        view = doc.defaultView;
      const host = doc.createElement('nav');
      host.className = 'message-navigation';
      host.hidden = true;
      host.setAttribute('aria-label', '用户消息导航');
      const marks = doc.createElement('div');
      marks.className = 'message-navigation-marks';
      const preview = doc.createElement('button');
      preview.type = 'button';
      preview.className = 'message-navigation-preview';
      preview.hidden = true;
      preview.id = 'userMessagePreview';
      preview.setAttribute('aria-label', '跳转到预览消息');
      const content = doc.createElement('span');
      content.className = 'message-navigation-preview-content';
      const title = doc.createElement('strong'),
        text = doc.createElement('span');
      text.className = 'message-navigation-preview-text';
      content.append(title, text);
      const hint = doc.createElement('span');
      hint.className = 'message-navigation-preview-hint';
      hint.textContent = '跳转到这条消息';
      preview.append(content, hint);
      host.append(marks, preview);
      log.after(host);
      let navigationRequest = 0;
      let outlineHasMore = null;
      let outline = [],
        lastMessages = [],
        outlineOwner = '',
        outlinePending = false;
      let owner = '',
        signature = '',
        entries = [],
        positions = new Map(),
        buttons = new Map(),
        frame = 0,
        busy = false;
      let selected = '',
        described = null,
        suppressHover = false,
        currentId = '';
      function hidePreview() {
        preview.hidden = true;
        described?.removeAttribute('aria-describedby');
        described = null;
        buttons.get(selected)?.removeAttribute('data-selected');
        selected = '';
      }
      function show(entry, button) {
        described?.removeAttribute('aria-describedby');
        buttons.get(selected)?.removeAttribute('data-selected');
        selected = entry.id;
        described = button;
        title.textContent = `用户消息 ${entry.index + 1} / ${entries.length}`;
        text.textContent = entry.text || '（图片或附件）';
        preview.hidden = false;
        hint.textContent = '跳转到这条消息';
        preview.disabled = false;
        button.setAttribute('aria-describedby', preview.id);
        button.setAttribute('data-selected', '');
      }
      function reveal(button) {
        if (!button) return;
        const top = button.offsetTop,
          bottom = top + button.offsetHeight;
        if (top < marks.scrollTop) marks.scrollTop = top;
        else if (bottom > marks.scrollTop + marks.clientHeight)
          marks.scrollTop = bottom - marks.clientHeight;
      }
      function dismiss() {
        hidePreview();
        suppressHover = true;
      }
      preview.onclick = () => buttons.get(selected)?.click();
      marks.addEventListener(
        'scroll',
        () => {
          if (!host.contains(doc.activeElement)) hidePreview();
          if (marks.scrollTop <= 0) void readEarlier();
        },
        { passive: true },
      );
      marks.addEventListener(
        'wheel',
        (e) => {
          if (e.deltaY < 0 && marks.scrollTop <= 0) void readEarlier();
        },
        { passive: true },
      );
      doc.addEventListener(
        'pointerdown',
        (e) => {
          if (!host.contains(e.target)) dismiss();
        },
        true,
      );
      doc.addEventListener('visibilitychange', () => {
        if (doc.hidden) dismiss();
      });
      view.addEventListener('blur', dismiss);
      function active() {
        frame = 0;
        if (!host.getClientRects().length || !log.clientHeight) return;
        const top = log.getBoundingClientRect().top + 24;
        // Geometry reads stay within visible chunks; skipped history is not laid out on scroll.
        let id = '';
        for (const chunk of log.children) {
          const rect = chunk.getBoundingClientRect();
          if (rect.bottom <= top || rect.top > top + log.clientHeight) continue;
          for (const node of chunk.querySelectorAll('[data-message-id]')) {
            if (node.getBoundingClientRect().bottom > top) {
              id = node.dataset.messageId;
              break;
            }
          }
          if (id) break;
        }
        const index = entries.findLastIndex(
          (e) => e.nodeIndex >= 0 && e.nodeIndex <= (positions.get(id) ?? -1),
        );
        const nextId = entries[index]?.id || '';
        if (nextId !== currentId) {
          buttons.get(currentId)?.removeAttribute('aria-current');
          buttons.get(nextId)?.setAttribute('aria-current', 'true');
          currentId = nextId;
        }
        if (preview.hidden && !host.contains(doc.activeElement) && index >= 0)
          reveal(buttons.get(nextId));
      }
      function schedule() {
        if (!frame) frame = requestAnimationFrame(active);
      }
      host.addEventListener('pointerleave', () => {
        if (!host.contains(doc.activeElement)) hidePreview();
      });
      host.addEventListener('focusout', (e) => {
        if (!host.contains(e.relatedTarget)) dismiss();
      });
      doc.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Escape' && host.contains(e.target) && !preview.hidden) {
            e.preventDefault();
            e.stopImmediatePropagation();
            dismiss();
          }
        },
        true,
      );
      host.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          dismiss();
          e.stopPropagation();
          return;
        }
        const list = [...buttons.values()],
          i = list.indexOf(doc.activeElement);
        const next =
          e.key === 'ArrowDown'
            ? i + 1
            : e.key === 'ArrowUp'
              ? i - 1
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? list.length - 1
                  : null;
        if (next != null) {
          e.preventDefault();
          list[Math.max(0, Math.min(list.length - 1, next))]?.focus();
        }
      });
      async function readEarlier() {
        if (busy || outlinePending || !(outlineHasMore ?? hasMore())) return;
        busy = true;
        marks.setAttribute('aria-busy', 'true');
        const key = owner;
        try {
          if (outlineHasMore) {
            const result = await readOutline(outline[0]?.id);
            if (key !== owner || !result?.navigation) return;
            outline = [...result.navigation, ...outline];
            outlineHasMore = Boolean(result.hasMore);
            signature = '';
            controller.update(lastMessages);
          } else await loadEarlier();
        } catch {
          if (key === owner) {
            hidePreview();
            title.textContent = '读取失败';
            text.textContent = '向上滚动重试';
            hint.textContent = '';
            preview.disabled = true;
            preview.hidden = false;
          }
        } finally {
          busy = false;
          marks.removeAttribute('aria-busy');
        }
      }
      log.addEventListener('scroll', schedule, { passive: true });
      const controller = {
        update(messages) {
          lastMessages = messages;
          const nextOwner = identity();
          if (nextOwner !== owner) {
            navigationRequest++;
            dismiss();
            outline = [];
            outlineOwner = '';
            outlineHasMore = null;
            currentId = '';
          }
          const loaded = messages
            .map((m, nodeIndex) => ({ ...m, nodeIndex }))
            .filter((m) => m.role === 'user' && m.id);
          const merged = new Map(
            outline.map((m) => [
              m.id,
              { id: m.id, nodeIndex: -1, blocks: [{ kind: 'text', text: m.text }] },
            ]),
          );
          for (const m of loaded) merged.set(m.id, m);
          const users = [...merged.values()];
          const next = JSON.stringify([nextOwner, users.map((m) => [m.id, m.blocks]), hasMore()]);
          if (signature === next) return;
          const step = marks.firstElementChild?.offsetHeight || 28;
          const changedOwner = nextOwner !== owner,
            anchorIndex = Math.floor(marks.scrollTop / step),
            anchor = entries[anchorIndex]?.id;
          const anchorOffset = marks.scrollTop - anchorIndex * step,
            previousSelected = selected;
          owner = nextOwner;
          signature = next;
          if (!previousSelected) hidePreview();
          entries = users.map((m, index) => ({
            id: m.id,
            index,
            nodeIndex: m.nodeIndex,
            text: (m.blocks || [])
              .filter((b) => b.kind === 'text')
              .map((b) => b.text || '')
              .join('\n')
              .slice(0, 640),
          }));
          positions = new Map(messages.map((m, i) => [m.id, i]));
          host.hidden = !entries.length;
          const previous = buttons;
          buttons = new Map();
          for (const [index, entry] of entries.entries()) {
            const b = previous.get(entry.id) || doc.createElement('button');
            b.type = 'button';
            b.className = 'message-navigation-mark';
            b.removeAttribute('aria-current');
            b.setAttribute(
              'aria-label',
              `跳转到用户消息 ${index + 1}：${entry.text.slice(0, 80) || '图片或附件'}`,
            );
            b.onpointerenter = (e) => {
              if (e.pointerType !== 'touch' && !suppressHover) show(entry, b);
            };
            b.onfocus = () => {
              reveal(b);
              show(entry, b);
            };
            b.onclick = async () => {
              const request = ++navigationRequest;
              if (entry.index === entries.length - 1) latest?.();
              let node = [...log.querySelectorAll('[data-message-id]')].find(
                (n) => n.dataset.messageId === entry.id,
              );
              if (!node && loadTarget) {
                const key = owner;
                b.setAttribute('aria-busy', 'true');
                try {
                  if (
                    !(await loadTarget(
                      entry.id,
                      () => request === navigationRequest && key === owner,
                    )) ||
                    key !== owner
                  )
                    return;
                } catch {
                  if (key === owner) {
                    title.textContent = '无法跳转，点击重试';
                    text.textContent = entry.text;
                    preview.hidden = false;
                  }
                  return;
                } finally {
                  b.removeAttribute('aria-busy');
                }
                node = [...log.querySelectorAll('[data-message-id]')].find(
                  (n) => n.dataset.messageId === entry.id,
                );
              }
              if (!node) return;
              scroll.jumpTo(node);
              for (const old of log.querySelectorAll('.message-navigation-target'))
                old.classList.remove('message-navigation-target');
              void node.offsetWidth;
              node.classList.add('message-navigation-target');
              dismiss();
              schedule();
            };
            buttons.set(entry.id, b);
          }
          const focused = [...previous].find(([, b]) => b === doc.activeElement)?.[0];
          const markList = [...buttons.values()];
          // Keep unchanged buttons attached while a pointer press or keyboard focus is active.
          for (const [id, b] of previous) if (!buttons.has(id)) b.remove();
          for (const [index, b] of markList.entries())
            if (marks.children[index] !== b) marks.insertBefore(b, marks.children[index] || null);
          if (!changedOwner && anchor) {
            const index = entries.findIndex((e) => e.id === anchor);
            if (index >= 0) {
              marks.scrollTop = index * step + anchorOffset;
            }
          }
          if (previousSelected) {
            const entry = entries.find((e) => e.id === previousSelected);
            if (entry) show(entry, buttons.get(entry.id));
            else dismiss();
          }
          if (focused && !changedOwner) buttons.get(focused)?.focus({ preventScroll: true });
          if (changedOwner) marks.scrollTop = marks.scrollHeight;
          currentId = '';
          schedule();
          if (!entries.length && hasMore()) void readNavigation();
        },
      };
      const readNavigation = async () => {
        if (!readOutline || outlinePending || outlineOwner === owner) return;
        const key = owner;
        outlinePending = true;
        try {
          const result = await readOutline();
          if (key !== owner || !result?.navigation) return;
          outline = result.navigation;
          outlineHasMore = Boolean(result.hasMore);
          outlineOwner = key;
          signature = '';
          controller.update(lastMessages);
        } catch {
          /* Loaded messages remain usable; entering the rail can retry. */
        } finally {
          outlinePending = false;
        }
      };
      host.addEventListener('pointerenter', () => {
        suppressHover = false;
        void readNavigation();
      });
      host.addEventListener('focusin', readNavigation);
      return controller;
    },
  };
})(typeof globalThis === 'undefined' ? this : globalThis);
