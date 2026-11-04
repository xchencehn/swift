(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioSettingsSave = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function merge(a = {}, b = {}) {
    const settings = { ...a, ...b, ...(a.ui || b.ui ? { ui: { ...a.ui, ...b.ui } } : {}) };
    const seen = settings.ui?.studioSeenDone;
    // The server accepts at most 16384 characters per UI preference.
    // Completion identities are longer than session IDs, so a count alone is
    // insufficient. Keep the newest sync entries; the local read cache stays intact.
    if (typeof seen === 'string' && seen.length > 16384) {
      try {
        const entries = Object.entries(JSON.parse(seen)).sort(
          (a, b) => Number(b[1]) - Number(a[1]),
        );
        const kept = [];
        let length = 2;
        for (const pair of entries) {
          const size =
            JSON.stringify(pair[0]).length +
            1 +
            JSON.stringify(pair[1]).length +
            (kept.length ? 1 : 0);
          if (length + size > 16384) break;
          kept.push(pair);
          length += size;
        }
        settings.ui.studioSeenDone = JSON.stringify(Object.fromEntries(kept));
      } catch {
        /* Invalid values still go through normal server validation. */
      }
    }
    return settings;
  }

  function create({
    write,
    load = () => [],
    persist = () => {},
    onSaved = () => {},
    onError = () => {},
    debounceMs = 150,
    retryMs = 1000,
    maxRetryMs = 30000,
  }) {
    const roots = new Map();
    function entry(root) {
      if (!roots.has(root))
        roots.set(root, {
          pending: {},
          flight: null,
          promise: null,
          timer: null,
          failures: 0,
          blocked: false,
        });
      return roots.get(root);
    }
    function pending(root) {
      const e = roots.get(root);
      return e ? merge(e.flight || {}, e.pending) : {};
    }
    function save() {
      try {
        persist(
          [...roots.keys()]
            .map((root) => ({ root, settings: pending(root) }))
            .filter((row) => Object.keys(row.settings).length),
        );
        return true;
      } catch {
        return false;
      }
    }
    function schedule(root, ms) {
      const e = entry(root);
      clearTimeout(e.timer);
      e.timer = setTimeout(() => {
        e.timer = null;
        void flush(root).catch(() => {});
      }, ms);
      e.timer.unref?.();
    }
    function queue(root, patch) {
      if (!root) return;
      const e = entry(root);
      e.pending = merge(e.pending, patch);
      e.blocked = false;
      e.failures = 0;
      if (!save()) onError(root, '偏好设置暂存失败，请保留当前页面。');
      schedule(root, debounceMs);
    }
    function flush(root) {
      const e = roots.get(root);
      if (!e) return Promise.resolve();
      clearTimeout(e.timer);
      e.timer = null;
      if (e.promise) return e.promise;
      if (!Object.keys(e.pending).length) return Promise.resolve();
      e.flight = e.pending;
      e.pending = {};
      save();
      // One request per root. New changes stay in one merged patch rather than
      // forming an unbounded chain of stale requests behind a slow connection.
      e.promise = Promise.resolve()
        .then(() => write(root, e.flight))
        .then((result) => {
          if (!result?.settings || result.rootDirectory !== root)
            throw Object.assign(new Error('设置响应不完整。'), { code: 'INVALID_RESPONSE' });
          e.flight = null;
          e.failures = 0;
          e.blocked = false;
          save();
          onError(root, '');
          if (!Object.keys(e.pending).length) onSaved(root, result.settings);
          return result;
        })
        .catch((error) => {
          // The latest value wins, including edits made while the failed request
          // was in flight. Preference patches are idempotent; messages are not
          // retried by this component.
          e.pending = merge(e.flight, e.pending);
          e.flight = null;
          e.failures++;
          e.blocked = Boolean(
            error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status),
          );
          const local = save();
          onError(
            root,
            e.blocked
              ? '偏好设置未保存，请检查设置后重试。'
              : local
                ? '偏好设置暂未同步，已保存在本机，恢复后自动重试。'
                : '偏好设置暂未同步，请保留当前页面。',
          );
          throw error;
        })
        .finally(() => {
          e.promise = null;
          if (Object.keys(e.pending).length && !e.blocked)
            schedule(
              root,
              e.failures ? Math.min(maxRetryMs, retryMs * 2 ** Math.min(e.failures - 1, 8)) : 0,
            );
        });
      return e.promise;
    }
    function resume(root) {
      const e = roots.get(root);
      if (e && !e.blocked) {
        e.failures = 0;
        schedule(root, 0);
      }
    }
    try {
      for (const row of load() || [])
        if (typeof row?.root === 'string' && row.settings && typeof row.settings === 'object')
          entry(row.root).pending = merge({}, row.settings);
    } catch {
      /* Storage access failures are reported when a patch is saved. */
    }
    return {
      queue,
      flush,
      resume,
      pending,
      busy: (root) => {
        const e = roots.get(root);
        return Boolean(e && (e.flight || Object.keys(e.pending).length));
      },
      close: () => {
        for (const e of roots.values()) clearTimeout(e.timer);
      },
    };
  }
  return { create, merge };
});
