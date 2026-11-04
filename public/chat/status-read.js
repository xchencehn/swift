/** Explicit, asynchronous /status read, bound to the connected native process. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioNativeStatusRead = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  const id = () =>
    globalThis.crypto?.randomUUID?.() ||
    `status-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function accountOf(rows = []) {
    const lines = rows.map((row) =>
      (typeof row === 'string' ? row : row.map((span) => span.text || '').join(''))
        .replace(/^\s*[│|]/, '')
        .replace(/[│|]\s*$/, '')
        .trimEnd(),
    );
    // Codex aligns wrapped values in a separate column. Only continuations
    // belonging to this labelled Account field may supply its full value.
    for (let i = 0; i < lines.length; i++) {
      const match = /^(\s*)Account:\s*(.*)$/i.exec(lines[i]);
      if (!match) continue;
      const parts = match[2] ? [match[2]] : [];
      let column = parts.length ? lines[i].indexOf(match[2], match[1].length + 8) : null;
      for (let n = i + 1; n < lines.length; n++) {
        const next = /^(\s*)(\S.*)$/.exec(lines[n]);
        if (!next || next[1].length <= match[1].length) break;
        column ??= next[1].length;
        if (next[1].length !== column) break;
        parts.push(next[2]);
      }
      let value = parts.join(' ').trim();
      // A narrow terminal can split the email inside a word. Its native
      // optional plan starts with '(', so join only the email's wrapped pieces.
      const plan = value.indexOf('('),
        prefix = plan < 0 ? value : value.slice(0, plan);
      const email = prefix.replace(/\s+/g, '');
      if (/^[^\s@<>"()]+@[^\s@<>"()]+$/.test(email))
        value = email + (plan < 0 ? '' : ' ' + value.slice(plan));
      return value;
    }
    return '';
  }
  function create({ request, target, identity, onChange = () => {}, wait = pause }) {
    let current = null;
    const valid = (entry) => current === entry && entry.identity === identity();
    function reconcile() {
      if (current && !valid(current)) current = null;
    }
    function view() {
      reconcile();
      return current
        ? { phase: current.phase, account: current.account }
        : { phase: 'idle', account: '' };
    }
    const active = () => view().phase === 'reading';
    async function read({ refresh = false } = {}) {
      reconcile();
      if (current?.phase === 'reading') return current.promise;
      if (current && !refresh) return view();
      const bound = target();
      if (!bound) return view();
      const checkOnly = current?.phase === 'unconfirmed';
      const entry = checkOnly
        ? current
        : { identity: identity(), target: { ...bound }, clientId: id(), account: '' };
      entry.phase = 'reading';
      current = entry;
      // Open the local popover before any native I/O, and never replay execute.
      entry.promise = Promise.resolve().then(async () => {
        try {
          let value;
          try {
            value = await request({
              ...entry.target,
              clientId: entry.clientId,
              ...(checkOnly
                ? { action: 'read', leaseId: entry.view?.leaseId }
                : { action: 'execute', text: '/status', requestId: id() }),
            });
          } catch (error) {
            if (!valid(entry)) return;
            if (checkOnly) throw error;
            // A missing HTTP reply does not prove that native Enter failed.
            // Inspect this client's lease; never execute the command again.
            try {
              value = await request({ ...entry.target, clientId: entry.clientId, action: 'read' });
            } catch {
              throw error;
            }
          }
          entry.view = value;
          for (let n = 0; valid(entry) && value.pending && n < 40; n++) {
            await wait(125);
            if (!valid(entry)) return;
            const next = await request({
              ...entry.target,
              clientId: entry.clientId,
              action: 'read',
              leaseId: value.leaseId,
              revision: value.revision,
            });
            if (!next.unchanged) entry.view = value = next;
          }
          if (!valid(entry)) return;
          entry.account =
            !value.pending && !value.failed && value.mode === 'result' ? accountOf(value.rows) : '';
          entry.phase = entry.account
            ? 'ready'
            : value.pending || value.mode === 'query'
              ? 'unconfirmed'
              : 'unavailable';
        } catch (error) {
          if (valid(entry)) entry.phase = error.code ? 'unavailable' : 'unconfirmed';
        } finally {
          if (valid(entry)) onChange();
        }
        return view();
      });
      onChange();
      return entry.promise;
    }
    return { view, active, read };
  }
  return { create, accountOf };
});
