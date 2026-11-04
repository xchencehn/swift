'use strict';
const { EventEmitter } = require('node:events');
const { attachShellTerminal } = require('./shell-terminal');
const { createTerminalPreparation } = require('./herdr-terminal-session');

// One transport, independently acknowledged terminal subscriptions. Native
// observation survives tab switches; only the foreground can acquire control.
function attachTerminalMultiplexer({
  ws,
  url,
  herdr,
  cwd,
  env,
  maxInputBytes,
  attach = attachShellTerminal,
}) {
  const targets = new Map(),
    streams = new Map(),
    releasing = new Map();
  const preparation = createTerminalPreparation(herdr.socketPath);
  let stopped = false,
    active = null,
    selection = 0,
    lastId = 0,
    scheduled,
    cursor = 0;
  const schedule = () => {
    if (!scheduled && !stopped) scheduled = setImmediate(flush);
  };
  function flush() {
    scheduled = null;
    if (stopped || ws.readyState !== 1 || ws.bufferedAmount >= 128 * 1024) return;
    const pending = [...targets.values()].filter((target) => target.queue.length);
    if (!pending.length) return;
    const others = pending.filter((target) => target !== active);
    if (others.length) {
      cursor %= others.length;
      others.push(...others.splice(0, cursor));
      cursor++;
    }
    const order = active?.queue.length ? [active, ...others] : others;
    let bytes = 0;
    for (const target of order) {
      if (bytes >= 128 * 1024 || ws.bufferedAmount >= 128 * 1024) break;
      const frame = target.queue.shift();
      if (!frame) continue;
      target.queuedBytes -= frame.bytes;
      bytes += frame.bytes;
      // Flow marker and bytes are indivisible: another terminal's marker
      // cannot be interleaved between these two WebSocket messages.
      for (const part of frame.parts) ws.send(part.data, part.options);
    }
    if ([...targets.values()].some((target) => target.queue.length)) schedule();
  }
  const drain = setInterval(schedule, 20);
  drain.unref?.();
  function retire(target) {
    if (!target || target.retired) return target?.closed;
    target.retired = true;
    target.foreground = false;
    target.queue.length = 0;
    target.queuedBytes = 0;
    for (const [id, owner] of streams) if (owner === target) streams.delete(id);
    target.emit('close');
    const closed = (target.closed = Promise.all([
      releasing.get(target.key),
      target.shellTerminal?.stop(),
    ]));
    releasing.set(target.key, closed);
    void closed
      .finally(() => {
        if (releasing.get(target.key) === closed) releasing.delete(target.key);
      })
      .catch(() => {});
    return closed;
  }
  function remove(target, code, reason) {
    if (!target || target.retired) return;
    targets.delete(target.id);
    if (active === target) active = null;
    retire(target);
    if (!stopped && ws.readyState === 1)
      ws.send(
        JSON.stringify({
          type: 'terminal.subscription.closed',
          subscriptionId: target.id,
          code,
          reason,
        }),
      );
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(drain);
    clearImmediate(scheduled);
    return Promise.all(
      [...targets.values()].map(retire).concat([...releasing.values(), preparation.close()]),
    );
  }
  function activate(id, subscriptionId) {
    if (!Number.isInteger(id) || id <= selection || id > 0xffffffff) return;
    selection = id;
    const previous = active;
    active = subscriptionId === null ? null : targets.get(subscriptionId) || null;
    if (previous && previous !== active) {
      previous.foreground = false;
      previous.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'terminal.focus', focused: false })),
        false,
      );
    }
    if (active) {
      active.foreground = true;
      active.controlSelection = id;
    }
    schedule();
  }
  async function subscribe(id, binding) {
    const target = new EventEmitter();
    Object.assign(target, {
      id,
      key: JSON.stringify([binding.runtimeId, binding.terminalId]),
      retired: false,
      foreground: false,
      controlSelection: 0,
      queue: [],
      queuedBytes: 0,
      flow: null,
      persistent: true,
    });
    Object.defineProperties(target, {
      readyState: { get: () => (stopped || target.retired ? 3 : ws.readyState) },
      bufferedAmount: { get: () => target.queuedBytes },
    });
    target.flowAcknowledged = true;
    target.send = (data, options) => {
      if (target.readyState !== 1) return;
      let parts;
      if (options?.binary || Buffer.isBuffer(data)) {
        const header = Buffer.alloc(4);
        header.writeUInt32LE(id);
        parts = [
          ...(target.flow ? [target.flow] : []),
          { data: Buffer.concat([header, Buffer.from(data)]), options: { binary: true } },
        ];
        target.flow = null;
      } else {
        const message = { ...JSON.parse(String(data)), subscriptionId: id };
        const part = { data: JSON.stringify(message) };
        if (message.type === 'terminal.flow') {
          streams.set(message.streamId, target);
          target.flow = part;
          return;
        }
        parts = [part];
      }
      const bytes = parts.reduce((sum, part) => sum + Buffer.byteLength(part.data), 0);
      if (target.queuedBytes + bytes > 1024 * 1024)
        return remove(target, 4008, 'terminal subscription output budget exceeded');
      target.queuedBytes += bytes;
      target.queue.push({ bytes, parts });
      schedule();
    };
    target.close = (code, reason) => remove(target, code, reason);
    targets.set(id, target);
    const endpoint = new URL(url);
    for (const [key, value] of Object.entries({
      pane: binding.paneId,
      terminalId: binding.terminalId,
      runtimeId: binding.runtimeId,
      stateFormat: binding.stateFormat === 'cells-v1' ? 'cells-v1' : '',
      cols: binding.cols,
      rows: binding.rows,
      retainControl: '1',
    }))
      endpoint.searchParams.set(key, String(value ?? ''));
    try {
      await attach({
        ws: target,
        url: endpoint,
        herdr,
        cwd,
        env,
        maxInputBytes,
        preparation,
        persistent: true,
        controlReleased: releasing.get(target.key),
      });
      if (target.retired) await target.shellTerminal?.stop();
    } catch {
      remove(target, 1013, 'terminal subscription failed');
    }
  }
  ws.shellTerminal = {
    stop,
    output: {
      acknowledge: (message) =>
        streams.get(message.streamId)?.shellTerminal?.output?.acknowledge(message),
    },
  };
  ws.once('close', stop);
  ws.on('message', (raw, binary) => {
    if (stopped || binary || raw.length > maxInputBytes * 2) return;
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message?.type === 'terminal.subscribe') {
      const id = message.subscriptionId,
        binding = message.target;
      if (
        !Number.isInteger(id) ||
        id < 1 ||
        id > 0xffffffff ||
        id <= lastId ||
        targets.size >= 64 ||
        !binding ||
        !['runtimeId', 'paneId', 'terminalId'].every(
          (key) =>
            typeof binding[key] === 'string' &&
            binding[key].length > 0 &&
            binding[key].length <= 256,
        )
      )
        return ws.close(1008, 'invalid terminal subscription');
      lastId = id;
      void subscribe(id, binding);
      return;
    }
    if (message?.type === 'terminal.activate') {
      activate(message.selectionId, message.subscriptionId);
      return;
    }
    const target = targets.get(message?.subscriptionId);
    if (!target || target.readyState !== 1) return;
    if (message.type === 'terminal.unsubscribe') {
      targets.delete(target.id);
      if (active === target) active = null;
      retire(target);
      return;
    }
    if (
      message.type === 'terminal.history.request' ||
      message.type === 'terminal.resize' ||
      (message.type === 'terminal.focus' && message.focused === false) ||
      (target === active && message.selectionId === selection)
    )
      target.emit('message', raw, false);
  });
  ws.send(JSON.stringify({ type: 'terminal.channel.ready', version: 2 }));
  return ws.shellTerminal;
}
module.exports = { attachTerminalMultiplexer };
