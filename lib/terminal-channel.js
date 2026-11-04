'use strict';
const { EventEmitter } = require('node:events');
const { attachShellTerminal } = require('./shell-terminal');
const { createTerminalPreparation } = require('./herdr-terminal-session');

// One authenticated WebSocket, one selected native terminal per client. The
// selection number accompanies both directions, including each binary frame.
// A cancelled asynchronous attach can neither publish output nor accept input.
function attachTerminalChannel({
  ws,
  url,
  herdr,
  cwd,
  env,
  maxInputBytes,
  attach = attachShellTerminal,
}) {
  let selectionId = 0,
    selected = null,
    stopped = false,
    scheduled;
  const releasing = new Map();
  const preparation = createTerminalPreparation(herdr.socketPath);
  function retire(target) {
    if (!target || target.retired) return target?.closed;
    target.retired = true;
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
  function stop() {
    if (stopped) return;
    stopped = true;
    clearImmediate(scheduled);
    return Promise.all([retire(selected), ...releasing.values(), preparation.close()]);
  }
  ws.shellTerminal = {
    stop,
    output: { acknowledge: (message) => selected?.shellTerminal?.output?.acknowledge(message) },
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
    if (message?.type === 'terminal.select') {
      const id = message.selectionId;
      if (!Number.isInteger(id) || id < 1 || id > 0xffffffff)
        return ws.close(1008, 'invalid terminal selection');
      if (id <= selectionId) return;
      const binding = message.target;
      if (
        binding !== null &&
        (!binding ||
          !['runtimeId', 'paneId', 'terminalId'].every(
            (key) =>
              typeof binding[key] === 'string' &&
              binding[key].length > 0 &&
              binding[key].length <= 256,
          ))
      )
        return ws.close(1008, 'invalid terminal target');
      selectionId = id;
      retire(selected);
      selected = null;
      // Retire the previous binding immediately, but do not put its teardown
      // or outstanding identity read ahead of the next terminal's observation.
      clearImmediate(scheduled);
      scheduled = setImmediate(() => {
        void (async () => {
          if (stopped || id !== selectionId || !binding) return;
          const target = new EventEmitter();
          target.retired = false;
          target.key = JSON.stringify([binding.runtimeId, binding.terminalId]);
          // Returning to the same PTY must not race an older controller's
          // release. Only acquiring control waits; its picture can arrive now.
          const controlReleased = releasing.get(target.key);
          Object.defineProperties(target, {
            readyState: { get: () => (target.retired || id !== selectionId ? 3 : ws.readyState) },
            bufferedAmount: { get: () => ws.bufferedAmount },
          });
          target.flowAcknowledged = ws.flowAcknowledged;
          target.send = (data, options) => {
            if (target.readyState !== 1) return;
            if (options?.binary || Buffer.isBuffer(data)) {
              const header = Buffer.alloc(4);
              header.writeUInt32LE(id);
              ws.send(Buffer.concat([header, Buffer.from(data)]), { binary: true });
            } else ws.send(JSON.stringify({ ...JSON.parse(String(data)), selectionId: id }));
          };
          target.close = (code, reason) => {
            if (target.readyState === 1) ws.close(code, reason);
          };
          selected = target;
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
          await attach({
            ws: target,
            url: endpoint,
            herdr,
            cwd,
            env,
            maxInputBytes,
            preparation,
            controlReleased,
          });
          if (stopped || id !== selectionId) await retire(target);
        })().catch(() => {
          if (!stopped && id === selectionId) ws.close(1013, 'terminal selection failed');
        });
      });
      return;
    }
    if (message?.selectionId === selectionId && selected?.readyState === 1)
      selected.emit('message', raw, false);
  });
  ws.send(JSON.stringify({ type: 'terminal.channel.ready', version: 1 }));
  return ws.shellTerminal;
}

module.exports = { attachTerminalChannel };
