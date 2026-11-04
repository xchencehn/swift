(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioBoot = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  function create({
    replica,
    paintLegacy = () => {},
    renderCached,
    loadConfig,
    applyConfig,
    connect,
    unauthorized,
    offline,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = clearTimeout,
  }) {
    let running = null,
      timer = null,
      attempts = 0,
      stopped = false;
    function verify() {
      if (running) return running;
      cancel(timer);
      timer = null;
      running = (async () => {
        try {
          globalThis.StudioConnectionTrace?.('config-start');
          const config = await loadConfig();
          globalThis.StudioConnectionTrace?.('config-ready');
          if (stopped) return;
          globalThis.StudioConnectionTrace?.('cache-root-start');
          await replica.load(config.rootDirectory);
          globalThis.StudioConnectionTrace?.('cache-root-ready');
          applyConfig(config);
          renderCached(replica.snapshot());
          attempts = 0;
          globalThis.StudioConnectionTrace?.('connect-start');
          connect();
        } catch (error) {
          globalThis.StudioConnectionTrace?.('boot-error', error);
          if (stopped) return;
          if (error.code === 'UNAUTHORIZED') {
            unauthorized(error);
            return;
          }
          offline(Boolean(replica.snapshot()?.panes?.length), error);
          attempts++;
          timer = schedule(
            () => {
              timer = null;
              void verify();
            },
            Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5)),
          );
          timer?.unref?.();
        }
      })().finally(() => {
        running = null;
      });
      return running;
    }
    async function start() {
      globalThis.StudioConnectionTrace?.('boot-start');
      paintLegacy();
      globalThis.StudioConnectionTrace?.('cache-start');
      await replica.load();
      globalThis.StudioConnectionTrace?.('cache-ready');
      renderCached(replica.snapshot());
      return verify();
    }
    function stop() {
      stopped = true;
      cancel(timer);
      timer = null;
    }
    return { start, verify, stop };
  }
  return { create };
});
