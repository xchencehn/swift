(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioSessionShortcuts = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  function actionFor(event) {
    if (event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey) return null;
    if (event.key === 'Escape' && !event.ctrlKey && !event.shiftKey) return 'pause';
    if (event.shiftKey && !event.ctrlKey)
      return (
        {
          ArrowUp: 'effortUp',
          ArrowDown: 'effortDown',
          ArrowLeft: 'modelPrevious',
          ArrowRight: 'modelNext',
        }[event.key] || null
      );
    return null;
  }
  function shouldSubmit(event, { coarse = false } = {}) {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.altKey
    )
      return false;
    return Boolean(
      event.ctrlKey || event.metaKey || !coarse || ['Enter', 'NumpadEnter'].includes(event.code),
    );
  }
  function create({ context, actions, reportError, document: doc = document }) {
    const pending = new Set();
    function keydown(event) {
      if (event.defaultPrevented) return false;
      const action = actionFor(event);
      if (!action) return false;
      const state = { ...context(event) };
      if (
        !state.enabled ||
        state.blocked ||
        state.terminalFocus ||
        (state.editing && action !== 'pause')
      )
        return false;
      if (action !== 'pause' && state.provider !== 'codex') return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      const key = state.identity + ':' + action;
      if (event.repeat) return true;
      if (action !== 'pause') {
        // Selection is local. The settings service serializes native writes and
        // coalesces later choices while the first operation is in flight.
        Promise.resolve()
          .then(() => {
            const live = context(event);
            if (live.identity !== state.identity || !live.enabled || live.blocked) return false;
            return actions[action]();
          })
          .catch((error) => {
            if (context(event).identity === state.identity) reportError(error.message);
          });
        return true;
      }
      if (pending.has(key)) return true;
      pending.add(key);
      Promise.resolve()
        .then(() => {
          if (context(event).identity === state.identity) return actions[action]();
        })
        .catch((error) => {
          if (context(event).identity === state.identity) reportError(error.message);
        })
        .finally(() => pending.delete(key));
      return true;
    }
    doc.addEventListener('keydown', keydown, true);
    return { keydown, dispose: () => doc.removeEventListener('keydown', keydown, true) };
  }
  return { actionFor, shouldSubmit, create };
});
