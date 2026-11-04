(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioConnectionState = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  const values = {
    network: ['offline', 'connecting', 'open', 'blocked'],
    sync: ['offline', 'hello', 'welcome', 'ready', 'fallback'],
    observer: ['none', 'waiting', 'ready', 'failed'],
    input: ['unavailable', 'available', 'empty', 'blocked'],
  };
  const labels = {
    offline: '未连接',
    connecting: '正在连接',
    open: '已连接',
    blocked: '需要处理',
    hello: '正在握手',
    welcome: '正在追平',
    ready: '已就绪',
    fallback: '使用 HTTP 刷新',
    none: '当前无需观察',
    waiting: '正在读取',
    failed: '观察中断',
    unavailable: '暂不可发送',
    available: '可以发送',
    empty: '等待输入',
  };
  function create({ now = Date.now, trace = () => {} } = {}) {
    const state = { network: 'offline', sync: 'offline', observer: 'none', input: 'unavailable' };
    let generation = 0,
      retries = 0,
      received = 0,
      code = 0;
    const events = [];
    function snapshot() {
      return { ...state, generation, retries, received, code };
    }
    function numeric() {
      return {
        retries,
        received,
        network: values.network.indexOf(state.network),
        sync: values.sync.indexOf(state.sync),
        observer: values.observer.indexOf(state.observer),
        input: values.input.indexOf(state.input),
      };
    }
    function record(stage, detail = {}) {
      const safe = {
        at: now(),
        stage,
        ...numeric(),
        code: Number.isInteger(detail.code) ? detail.code : code,
      };
      events.push(safe);
      if (events.length > 64) events.shift();
      trace(stage, safe);
    }
    function update(patch, mine = generation) {
      if (mine !== generation) return false;
      let changed = false;
      for (const key of Object.keys(values))
        if (values[key].includes(patch[key]) && patch[key] !== state[key]) {
          state[key] = patch[key];
          changed = true;
        }
      if (changed) record('connection-state');
      return changed;
    }
    function begin() {
      generation++;
      retries = received = code = 0;
      update({ network: 'connecting', sync: 'offline', observer: 'none', input: 'unavailable' });
      return generation;
    }
    return {
      snapshot,
      numeric,
      record,
      update,
      begin,
      received() {
        received = now();
      }, // O(1), no allocation, notification, serialization or storage per packet.
      transport(kind, detail = {}) {
        if (Number.isInteger(detail.retries)) retries = detail.retries;
        if (Number.isInteger(detail.code)) code = detail.code;
        update({
          network: detail.blocked ? 'blocked' : kind === 'connected' ? 'open' : kind,
          ...(kind === 'offline'
            ? { sync: 'offline', observer: 'none', input: 'unavailable' }
            : {}),
        });
      },
      rows() {
        return Object.entries({
          network: '网络连接',
          sync: '数据同步',
          observer: '原生状态观察',
          input: '发送状态',
        }).map(([key, label]) => ({ label, value: labels[state[key]] }));
      },
      export() {
        record('diagnostic-export');
        return JSON.stringify(
          { schema: 1, current: { ...numeric(), code }, events: events.slice() },
          null,
          2,
        );
      },
    };
  }
  return { create };
});
