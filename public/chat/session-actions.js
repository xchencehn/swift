(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioSessionActions = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  function create({ request, target, scope = () => '', onChange = () => {}, refresh = () => {} }) {
    const operations = new Map();
    const keyOf = (value) =>
      value &&
      JSON.stringify([
        scope(),
        value.runtimeId,
        value.paneId,
        value.terminalId,
        value.processRuntimeId,
        value.sessionId,
      ]);
    function update(entry, phase, message = '') {
      entry.phase = phase;
      entry.message = message;
      operations.set(entry.key, entry);
      try {
        const key = 'studioInterrupt:' + entry.key;
        if (['pending', 'uncertain', 'checking'].includes(phase))
          localStorage.setItem(key, JSON.stringify({ body: entry.body }));
        else localStorage.removeItem(key);
      } catch {}
      if (operations.size > 64) {
        const settled = [...operations].find(([, item]) =>
          ['confirmed', 'failed', 'idle'].includes(item.phase),
        );
        if (settled) operations.delete(settled[0]);
      }
      onChange();
    }
    function current() {
      const value = target(),
        key = keyOf(value);
      if (!key) return null;
      if (!operations.has(key)) {
        try {
          const saved = JSON.parse(localStorage.getItem('studioInterrupt:' + key) || 'null');
          if (
            saved?.body?.requestId &&
            saved.body.paneId === value.paneId &&
            saved.body.sessionId === value.sessionId
          )
            operations.set(key, { key, body: saved.body, phase: 'uncertain' });
        } catch {}
      }
      return operations.get(key) || null;
    }
    function view({ working } = {}) {
      const entry = current();
      if (!entry) return null;
      if (entry.phase === 'accepted' && working === false)
        update(entry, 'confirmed', '当前轮次已结束。');
      return {
        phase: entry.phase,
        busy: ['pending', 'checking'].includes(entry.phase),
        canCheck: entry.phase === 'uncertain',
        label:
          entry.message ||
          {
            pending: '正在中断当前轮次…',
            checking: '正在核对中断结果…',
            accepted: '中断请求已接收，正在等待原生状态更新。',
            uncertain: '中断结果待确认，请核对后继续。',
            confirmed: '当前轮次已结束。',
            idle: '当前没有正在执行的轮次。',
            failed: '中断未执行。',
          }[entry.phase],
      };
    }
    function apply(entry, result) {
      if (result.reason === 'native-state')
        update(entry, 'failed', '当前原生界面无法确认中断操作，请回到最新或在终端处理。');
      else if (result.reason === 'turn-changed')
        update(entry, 'idle', '会话已进入新一轮，请确认后再中断。');
      else if (result.interrupted === true) update(entry, 'accepted');
      else update(entry, 'idle');
    }
    async function interrupt(value = target()) {
      const key = keyOf(value);
      if (!key || !value.paneId || !value.sessionId) return;
      const previous = operations.get(key);
      if (
        previous &&
        (['pending', 'checking', 'uncertain'].includes(previous.phase) ||
          (previous.phase === 'accepted' &&
            (!value.turnId || !previous.body.turnId || value.turnId === previous.body.turnId)))
      )
        return previous.promise;
      const body = {
        ...value,
        requestId:
          globalThis.crypto?.randomUUID?.() ||
          `interrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
      const entry = { key, body };
      update(entry, 'pending');
      const work = (async () => {
        try {
          const result = await request(
            body.binding ? '/api/messages/interrupt' : '/api/agents/interrupt',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...body, currentTurn: true }),
            },
          );
          apply(entry, result);
          return result;
        } catch (error) {
          update(
            entry,
            error.deliveryUncertain === false ? 'failed' : 'uncertain',
            error.deliveryUncertain === false
              ? error.message
              : `${error.message || '响应未收到。'} 中断结果待确认，请核对后继续。`,
          );
          return { ok: false, uncertain: entry.phase === 'uncertain', message: error.message };
        } finally {
          void Promise.resolve()
            .then(refresh)
            .catch(() => {});
        }
      })();
      entry.promise = work;
      return work;
    }
    async function check() {
      const entry = current();
      if (!entry || entry.phase !== 'uncertain') return;
      update(entry, 'checking');
      try {
        const data = await request(
          '/api/messages/interrupt?' +
            new URLSearchParams({
              paneId: entry.body.paneId,
              terminalId: entry.body.terminalId || '',
              sessionId: entry.body.sessionId,
              requestId: entry.body.requestId,
            }),
        );
        if (data.status === 'complete') apply(entry, data.result);
        else if (data.status === 'failed' && data.deliveryUncertain === false)
          update(entry, 'failed', data.message);
        else update(entry, 'uncertain');
      } catch {
        update(entry, 'uncertain');
      } finally {
        void Promise.resolve()
          .then(refresh)
          .catch(() => {});
      }
    }
    return { interrupt, check, view };
  }
  return { create };
});
