'use strict';
// Rust owns credentials. Authentication failures return to the installed connection screen.
(() => {
  const original = window.fetch.bind(window);
  let leaving = false,
    initialConfig = window === window.top;
  const connectionId = location.pathname.match(/^\/e\/([a-f0-9]{64})(?:\/|$)/)?.[1];
  const page = crypto.getRandomValues(new Uint32Array(1))[0],
    started = performance.now();
  // Native storage keeps the newest 64 events, including failures late in a long session.
  window.StudioConnectionTrace = (stage, detail = {}) => {
    const numeric = (key, max) =>
      Number.isSafeInteger(detail[key]) && detail[key] >= 0 && detail[key] <= max
        ? detail[key]
        : null;
    const position = String(detail.stack || '').match(/:(\d+):(\d+)\)?(?:\n|$)/);
    void original('/desktop/connection-diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        page,
        stage,
        elapsed: Math.round(performance.now() - started),
        code:
          Number.isInteger(detail.code) && detail.code >= 0 && detail.code <= 65535
            ? detail.code
            : null,
        line: detail.lineno || Number(position?.[1]) || null,
        column: detail.colno || Number(position?.[2]) || null,
        retries: numeric('retries', 4294967295),
        received: numeric('received', Number.MAX_SAFE_INTEGER),
        network: numeric('network', 3),
        sync: numeric('sync', 4),
        observer: numeric('observer', 3),
        input: numeric('input', 3),
      }),
    }).catch(() => {});
  };
  window.addEventListener('error', (event) => window.StudioConnectionTrace('page-error', event));
  window.addEventListener('unhandledrejection', (event) =>
    window.StudioConnectionTrace('promise-error', event.reason || {}),
  );
  window.fetch = async (...args) => {
    const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
    const startup =
      initialConfig &&
      url.origin === location.origin &&
      url.pathname === `/e/${connectionId}/api/config`;
    if (startup) initialConfig = false;
    const response = await original(...args);
    if (
      response.status === 401 &&
      !args[1]?.handleAuthError &&
      url.origin === location.origin &&
      url.pathname.startsWith('/e/') &&
      !leaving
    ) {
      leaving = true;
      setTimeout(() => location.assign('/connect?auth=1'), 200);
    } else if (startup && !response.ok && !args[1]?.handleAuthError && !leaving) {
      // Only a failed initial restore returns to selection. A later interruption
      // keeps the running window, its local view and its drafts in place.
      leaving = true;
      location.assign(`/connect?failed=${connectionId}`);
    }
    return response;
  };
})();
