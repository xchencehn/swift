'use strict';
window.StudioPopovers = {
  create({ input, container }) {
    const chatText = (element, text) => {
      element.textContent = text;
      return element;
    };
    let openPopoverEl = null;

    function closePopover() {
      if (!openPopoverEl) return;
      const previousFocus = openPopoverEl._returnFocus;
      const restoreFocus = openPopoverEl.contains(document.activeElement);
      openPopoverEl._releaseTarget?.();
      openPopoverEl._onClose?.();
      openPopoverEl.remove();
      openPopoverEl = null;
      if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      document.removeEventListener('keydown', onPopoverKey, true);
      document.removeEventListener('pointerdown', onPopoverOutside, true);
    }

    function onPopoverKey(event) {
      if (['Escape', 'ArrowLeft'].includes(event.key) && openPopoverEl?._onBack) {
        event.preventDefault();
        event.stopPropagation();
        openPopoverEl._onBack();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        const anchor = openPopoverEl?._returnFocus || openPopoverEl?._anchor;
        closePopover();
        anchor?.focus();
      }
      if (!openPopoverEl) return;
      if (openPopoverEl._content && event.key !== 'Escape') return;
      if (openPopoverEl._at && event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const buttons = [...openPopoverEl.querySelectorAll('button:not(:disabled)')].filter(
          (button) => !button.hidden,
        );
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        return;
      }
      if (event.target.matches('input') && ['Home', 'End', 'ArrowLeft'].includes(event.key)) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...openPopoverEl.querySelectorAll('button:not(:disabled)')].filter(
          (button) => !button.hidden,
        );
        let index = buttons.indexOf(document.activeElement);
        index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }
    }

    const repositionPopover = () => {
      // 跟随指针的菜单不重新摆位:窗口变化时鼠标早就不在原处了,挪过去反而莫名其妙。
      // 它跟着那一下点击,点完就该待在原地,要么被关掉。
      if (openPopoverEl?._at) return closePopover();
      if (openPopoverEl?._anchor) placePopover(openPopoverEl, openPopoverEl._anchor);
    };
    window.addEventListener('resize', repositionPopover);
    window.visualViewport?.addEventListener('resize', repositionPopover);

    function onPopoverOutside(event) {
      if (openPopoverEl?._content && openPopoverEl._anchor?.contains(event.target)) return;
      if (openPopoverEl && !openPopoverEl.contains(event.target)) {
        if (openPopoverEl._at) {
          // Dismiss the menu without activating the row underneath that gesture.
          event.preventDefault();
          event.stopPropagation();
          const consumeClick = (next) => {
            next.preventDefault();
            next.stopPropagation();
            cleanup();
          };
          const cleanup = () => document.removeEventListener('click', consumeClick, true);
          document.addEventListener('click', consumeClick, true);
          setTimeout(cleanup, 500);
        }
        closePopover();
      }
    }

    /**
     * 摆位置:默认贴着锚点上沿、右边界对齐(dsh 就是这么摆的)。
     * 上面放不下才翻到下面 —— 输入卡片贴着页面底部,向下弹通常会被视口切掉。
     */
    /**
     * 跟随指针摆位。菜单的**角**贴着指针那一点 —— 这是上下文菜单的惯例:
     * 指针在哪儿,菜单从哪儿长出来,眼睛不必先去别处找。
     *
     * 放不下就翻到指针的另一侧(而不是压着指针挪),这样指针始终落在菜单外侧的角上,
     * 不会盖住第一项 —— 盖住的话,松开右键那一下就可能误触。
     */
    function placeAtPoint(layer, at) {
      const margin = 8,
        viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft || 0) + margin,
        topEdge = (viewport?.offsetTop || 0) + margin;
      const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - margin * 2;
      const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - margin * 2;
      layer.style.maxWidth = `min(340px, ${rightEdge - leftEdge}px)`;
      layer.style.minWidth = `min(184px, ${rightEdge - leftEdge}px)`;
      layer.style.maxHeight = `min(420px, 60vh, ${bottomEdge - topEdge}px)`;
      const size = layer.getBoundingClientRect();
      const top = at.y + size.height <= bottomEdge ? at.y : at.y - size.height;
      const left = at.x + size.width <= rightEdge ? at.x : at.x - size.width;
      // The anchor can be outside the viewport after its tab strip scrolls.
      layer.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - size.height))}px`;
      layer.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - size.width))}px`;
    }

    function placePopover(layer, anchor) {
      // 输入框菜单由 CSS 锚定上沿，跟随键盘、草稿高度和菜单内容的布局变化。
      // visualViewport 的 resize 早于输入框在下一帧移动，不能在这里冻结屏幕坐标。
      if (layer.classList.contains('composer-popover')) return;
      const gap = 8;
      const box = anchor.getBoundingClientRect();
      const status = layer.classList.contains('session-status-popover');
      const viewport = window.visualViewport;
      const ceiling = status ? (viewport?.offsetTop || 0) + 8 : 8;
      const floor = status
        ? (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) - 8
        : window.innerHeight - 8;
      if (status)
        layer.style.maxHeight = `min(60dvh, 520px, ${Math.max(40, box.top - ceiling - gap, floor - box.bottom - gap)}px)`;
      const size = layer.getBoundingClientRect();
      let top = box.top - size.height - gap;
      if (top < ceiling) {
        const below = box.bottom + gap;
        top = below + size.height <= floor ? below : Math.max(ceiling, top);
      }
      let left = status ? box.left : box.right - size.width;
      left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));
      layer.style.top = `${Math.round(top)}px`;
      layer.style.left = `${Math.round(left)}px`;
    }

    /**
     * items: [{ id, label, sub?, aside?, current? }]，onPick 收到被选中的那一项。
     * 传空数组会显示 emptyText —— 拿不到候选时要说出来,而不是弹一个空盒子。
     */
    function openPopover(
      anchor,
      {
        title,
        label,
        items = [],
        emptyText = '没有可选项',
        onPick,
        onBack,
        backLabel,
        searchable = false,
        at = null,
        content = null,
        className = '',
        onClose,
      },
    ) {
      closePopover();
      const layer = document.createElement('div');
      const composer = anchor === input;
      layer.className = `popover${composer ? ' composer-popover' : ''}${at ? ' context-menu' : ''}${className ? ' ' + className : ''}`;
      layer.setAttribute('role', content ? 'region' : 'menu');
      layer.setAttribute('aria-label', label || title || '选择');
      layer._anchor = anchor;
      layer._at = at;
      layer._onBack = onBack;
      layer._content = content;
      layer._onClose = onClose;
      layer._returnFocus = !composer && !at ? document.activeElement : null;
      if (onBack) {
        const back = chatText(
          document.createElement('button'),
          backLabel || (composer ? '‹ 模型' : '← 返回模型'),
        );
        back.type = 'button';
        back.className = 'popover-back';
        back.addEventListener('click', onBack);
        layer.append(back);
      }
      // ⚠️ 跟随指针的菜单不放表头：它贴在右键的那一行上，再写一遍「这是谁」是重复。
      // 名字走 aria-label —— 屏幕阅读器没有「贴在哪儿」这个线索。
      if (title && !composer && !at && !anchor.closest('.chat-status-line')) {
        const head = document.createElement('div');
        head.className = 'popover-title';
        head.textContent = title;
        layer.append(head);
      }
      if (content) layer.append(content);
      if (!items.length && !content) {
        const empty = document.createElement('div');
        empty.className = 'popover-empty';
        empty.textContent = emptyText;
        layer.append(empty);
      }
      if (searchable && items.length) {
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'popover-search';
        search.placeholder = '搜索 Skills';
        search.setAttribute('aria-label', '搜索 Skills');
        search.addEventListener('input', () => {
          const query = search.value.toLowerCase();
          for (const button of layer.querySelectorAll('.popover-item'))
            button.hidden = !(button.dataset.search || button.textContent.toLowerCase()).includes(
              query,
            );
        });
        layer.append(search);
      }
      for (const item of items) {
        if (item.group) {
          const group = document.createElement('div');
          group.className = 'popover-group';
          group.setAttribute('role', 'separator');
          group.setAttribute('aria-label', item.group);
          group.textContent = item.group;
          layer.append(group);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `popover-item${item.sub && !composer ? ' has-sub' : ''}${item.danger ? ' danger' : ''}`;
        button.setAttribute('role', 'menuitem');
        button.disabled = Boolean(item.disabled);
        button.dataset.search = `${item.label} ${item.sub || ''}`.toLowerCase();
        if (item.current) button.setAttribute('aria-current', 'true');
        const label = document.createElement('span');
        label.className = 'popover-label';
        label.textContent = item.label;
        if (item.sub && !composer) {
          const sub = document.createElement('span');
          sub.className = 'popover-sub';
          sub.textContent = item.sub;
          label.append(sub);
        }
        button.append(label);
        if (item.aside) {
          const aside = document.createElement('span');
          aside.className = 'popover-aside';
          aside.textContent = item.aside;
          button.append(aside);
        }
        button.addEventListener('click', () => {
          closePopover();
          onPick?.(item);
        });
        layer.append(button);
      }
      // 🔑 点菜单不能把焦点从输入框拿走。焦点一走软键盘就收起,页面高度跟着变,
      // 菜单和输入框一起掉到屏幕底部 —— 人明明还在屏幕中间操作。搜索框是例外,
      // 它本来就要打字。
      layer.addEventListener('pointerdown', (event) => {
        if (!event.target.closest('input')) event.preventDefault();
      });
      (composer ? container : document.body).append(layer);
      openPopoverEl = layer;
      if (at && anchor?.contextElement) {
        let marked = null;
        const mark = () => {
          const next = anchor.contextSelector
            ? document.querySelector(anchor.contextSelector)
            : anchor.contextElement;
          if (!next?.isConnected) {
            closePopover();
            return;
          }
          if (marked !== next) {
            marked?.classList.remove('context-menu-target');
            marked = next;
            marked.classList.add('context-menu-target');
          }
        };
        const observer = new MutationObserver(mark);
        layer._releaseTarget = () => {
          observer.disconnect();
          marked?.classList.remove('context-menu-target');
        };
        mark();
        if (anchor.contextScope)
          observer.observe(anchor.contextScope, { childList: true, subtree: true });
      }
      if (at) placeAtPoint(layer, at);
      else placePopover(layer, anchor);
      if (content && !at && !composer) {
        const observer = new ResizeObserver(() => {
          if (openPopoverEl === layer) placePopover(layer, anchor);
        });
        observer.observe(layer);
        const release = layer._releaseTarget;
        layer._releaseTarget = () => {
          observer.disconnect();
          release?.();
        };
      }
      // 输入框上弹出的菜单一律不自动取焦点,理由同上;方向键仍然可用,onPopoverKey
      // 是在 document 上捕获的,焦点留在输入框也走得通。
      //
      // ⚠️ 其余菜单的落点必须**逐个按优先级找**:`querySelector('a, b, c')` 返回的是
      // 文档顺序里第一个命中任一条的元素,不是「先试 a 再试 b」。写成一条选择器时,
      // 焦点落在了列表首项和「‹ 模型」返回项上,而真正选中的那项另有高亮 ——
      // 一个菜单里两个高亮块,没人分得清哪个才是当前值。
      // 指针菜单先聚焦容器，不预选菜单项；方向键或 Tab 再进入选项。
      // 目标行高亮独立于 hover，并在整个菜单生命周期内保持。
      if (at) {
        layer.tabIndex = -1;
        layer.focus({ preventScroll: true });
      } else if (!composer) {
        const target =
          layer.querySelector('button[aria-current="true"]') ||
          layer.querySelector('input') ||
          layer.querySelector('.popover-item:not(:disabled)') ||
          layer.querySelector('button:not(:disabled)');
        target?.focus({ preventScroll: true });
      }
      document.addEventListener('keydown', onPopoverKey, true);
      // pointerdown 而不是 click:点在别处时要在那一下就关掉,而不是等它先触发别的东西。
      document.addEventListener('pointerdown', onPopoverOutside, true);
      return layer;
    }

    window.addEventListener('blur', () => {
      if (openPopoverEl?._at) closePopover();
    });
    document.addEventListener(
      'scroll',
      (event) => {
        if (openPopoverEl?._at && !openPopoverEl.contains(event.target)) closePopover();
      },
      true,
    );

    return {
      open: openPopover,
      close: closePopover,
      get element() {
        return openPopoverEl;
      },
    };
  },
};
