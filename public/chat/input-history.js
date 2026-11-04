/**
 * 输入框的 ↑ / ↓：翻出这个会话里自己发过的消息（2026-09-24 用户要求），与终端里的习惯一致。
 *
 * 历史只来自这个会话自己：原生存档里的用户消息。
 * 所以每个会话各有一份，刷新后还在、各台设备一样，在终端里直接敲的也算。
 *
 *   ↑  光标在第一行时，换成上一条（从最新往回）；第一次按下时记住正在写的草稿。
 *   ↓  正在翻历史、光标在最后一行时，换成下一条；翻过最新一条就还原草稿。
 *   多行消息里光标不在首行/末行时，方向键照常在行间移动。
 *   一旦动手改了内容，就不再算在翻历史，下一次 ↑ 从最新一条重新开始。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioInputHistory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 相邻重复的只留一条，空的不要。顺序从旧到新。 */
  function normalize(entries) {
    const out = [];
    for (const raw of entries || []) {
      const text = String(raw ?? '').trim();
      if (text && out[out.length - 1] !== text) out.push(text);
    }
    return out;
  }

  /**
   * @param {object} options
   *   entries()      这个会话里发过的消息，从旧到新
   *   key()          当前是哪个会话；换了会话，翻到一半的状态作废
   *   apply(text)    把文字放进输入框之后要做的事（保存草稿、调整高度等）
   */
  function create({ entries, key = () => '', apply = () => {} }) {
    let index = -1,
      draft = '',
      owner = null,
      list = [];

    function reset() {
      index = -1;
      draft = '';
      owner = null;
      list = [];
    }

    function put(input, text, caretAtStart) {
      input.value = text;
      const at = caretAtStart ? 0 : text.length;
      input.setSelectionRange(at, at);
      apply(text);
    }

    /** 显式切换一条历史；触摸导航不受文本光标所在行的限制。 */
    function move(direction, input) {
      if (![-1, 1].includes(direction) || input.disabled || input.readOnly) return false;
      if (owner !== null && owner !== key()) reset();
      if (direction < 0) {
        if (index < 0) {
          list = normalize(entries());
          if (!list.length) return false;
          draft = input.value;
          owner = key();
          index = list.length;
        }
        if (index === 0) return true;
        index -= 1;
        put(input, list[index], true);
        return true;
      }
      if (index < 0) return false;
      index += 1;
      if (index >= list.length) {
        const text = draft;
        reset();
        put(input, text, false);
        return true;
      }
      put(input, list[index], false);
      return true;
    }

    /** 处理一次按键；多行编辑和文字选择仍交给文本框。 */
    function keydown(event, input) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return false;
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return false;
      const { selectionStart: start, selectionEnd: end, value } = input;
      if (
        start !== end ||
        (event.key === 'ArrowUp' ? value.slice(0, start) : value.slice(end)).includes('\n')
      )
        return false;
      if (!move(event.key === 'ArrowUp' ? -1 : 1, input)) return false;
      event.preventDefault();
      return true;
    }

    return { keydown, move, reset, navigating: () => index >= 0 };
  }

  /** Touch gestures only choose local history; the button retains its native click action. */
  function bindTouch({ zone, input, history, key, enabled }) {
    const document = zone.ownerDocument,
      view = document.defaultView;
    let gesture = null,
      blockedUntil = 0;
    const cancel = () => {
      if (gesture) gesture.cancelled = true;
    };
    const invalidate = () => {
      if (gesture) gesture.historyInvalidated = true;
    };
    const sameInput = (current) => current.owner === key() && current.value === input.value;
    function sample(current, event) {
      const dx = event.clientX - current.x,
        dy = event.clientY - current.y;
      if (Math.hypot(dx, dy) > 10) {
        current.moved = true;
        if (!current.axis) current.axis = Math.abs(dy) >= Math.abs(dx) * 1.4 ? 'vertical' : 'other';
        if (current.axis === 'other') current.cancelled = true;
      }
      return { dx, dy };
    }
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (gesture && event.pointerId !== gesture.id) cancel();
      },
      { capture: true, passive: true },
    );
    zone.addEventListener(
      'pointerdown',
      (event) => {
        if (event.isPrimary === false) return;
        // A fresh press is a new intent; it must not inherit an older swipe's click suppression.
        blockedUntil = 0;
        if (event.pointerType !== 'touch' || event.button !== 0) return;
        const box = zone.getBoundingClientRect();
        if (
          !box.width ||
          !box.height ||
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          return;
        gesture = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          owner: key(),
          value: input.value,
          allowed: enabled(),
          cancelled: false,
          historyInvalidated: false,
          moved: false,
          axis: null,
        };
        // Keep the text input and soft keyboard focused. Cancelling pointerdown
        // suppresses compatibility mouse events; a stationary button tap still emits click.
        if (gesture.allowed) event.preventDefault();
      },
      { capture: true, passive: false },
    );
    document.addEventListener(
      'pointermove',
      (event) => {
        if (!gesture || event.pointerId !== gesture.id) return;
        sample(gesture, event);
        if (!sameInput(gesture) || !enabled()) invalidate();
        if (gesture.moved) event.preventDefault();
      },
      { capture: true, passive: false },
    );
    document.addEventListener(
      'pointerup',
      (event) => {
        if (!gesture || event.pointerId !== gesture.id) return;
        const current = gesture,
          { dx, dy } = sample(current, event);
        gesture = null;
        const sameOwner = current.owner === key();
        // A stationary tap keeps the button's existing action, including an IME
        // commit that updates the text between pointerdown and pointerup.
        if (!current.moved && !current.cancelled && sameOwner) return;
        blockedUntil = Date.now() + 1000;
        event.preventDefault();
        if (
          current.allowed &&
          enabled() &&
          !current.cancelled &&
          !current.historyInvalidated &&
          sameInput(current) &&
          Math.abs(dy) >= 28 &&
          Math.abs(dy) >= Math.abs(dx) * 1.4
        )
          history.move(dy < 0 ? -1 : 1, input);
      },
      { capture: true, passive: false },
    );
    document.addEventListener(
      'pointercancel',
      (event) => {
        if (!gesture || event.pointerId !== gesture.id) return;
        gesture = null;
        blockedUntil = Date.now() + 1000;
      },
      { capture: true, passive: true },
    );
    zone.addEventListener(
      'click',
      (event) => {
        if ((event.detail !== 0 || event.pointerType === 'touch') && Date.now() < blockedUntil) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    zone.addEventListener('contextmenu', (event) => event.preventDefault());
    input.addEventListener('compositionstart', invalidate);
    input.addEventListener('input', invalidate);
    view.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancel();
    });
  }

  return { create, normalize, bindTouch };
});
