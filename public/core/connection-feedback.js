(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioConnectionFeedback = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  // Presentation only. Callers keep transport readiness and write permission.
  function create({
    render,
    delayMs = 15000,
    recoveryMs = 1000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    let outage = false,
      visible = '',
      message = '',
      timer = null,
      recovered = null,
      actionable = false,
      initial = false;
    const paint = (value) => {
      if (visible !== value) {
        visible = value;
        render(value);
      }
    };
    const cancel = () => {
      clearTimer(timer);
      clearTimer(recovered);
      timer = recovered = null;
    };
    function update(connected, text = '', options = {}) {
      if (connected) {
        clearTimer(timer);
        timer = null;
        if (initial) {
          cancel();
          initial = outage = actionable = false;
          paint('');
          return;
        }
        if (!visible) {
          outage = actionable = false;
          return;
        }
        if (recovered == null)
          recovered = setTimer(() => {
            cancel();
            outage = actionable = false;
            paint('');
          }, recoveryMs);
        return;
      }
      clearTimer(recovered);
      recovered = null;
      message = text || '连接恢复中，输入已暂停。';
      if (options.actionable || options.initial) {
        initial = Boolean(options.initial);
        actionable = Boolean(options.actionable);
        paint(message);
        return;
      }
      if (actionable) return;
      if (visible) {
        paint(message);
        return;
      }
      if (!outage) {
        outage = true;
        timer = setTimer(() => {
          timer = null;
          paint(message);
        }, delayMs);
      }
    }
    return {
      update,
      reset() {
        cancel();
        initial = outage = actionable = false;
        paint('');
      },
    };
  }
  return { create };
});
