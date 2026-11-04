(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioFrontendUpdates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  function create({
    version,
    url,
    canReload,
    reload,
    fetch: fetchVersion = (...args) => fetch(...args),
  }) {
    let checking = false,
      pending = false,
      reloading = false;
    async function check() {
      if (checking || reloading || !version) return;
      checking = true;
      try {
        const response = await fetchVersion(url, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return;
        const data = await response.json();
        if (typeof data.version !== 'string' || !data.version) return;
        pending = data.version !== version;
        if (pending && canReload()) {
          reloading = true;
          reload();
        }
      } catch {
        /* 断网时保留当前可用页面，下次回前台再检查。 */
      } finally {
        checking = false;
      }
    }
    /** 已知有新版本时直接重载，不再先去问一次：切到后台之后网络请求未必来得及回来。 */
    function applyPending() {
      if (pending && !reloading && canReload()) {
        reloading = true;
        reload();
      }
    }
    return { check, applyPending, isPending: () => pending };
  }
  return { create };
});
