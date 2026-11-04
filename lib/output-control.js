'use strict';
const { OutputWindow, OUTPUT_HARD_BYTES, OUTPUT_STALL_MS } = require('./output-window');
const OVERLOADED = 4008;

/** Consumer credit and transport credit are separate; input never pauses.
 * @param {import('../shared/terminal-protocol').OutputControlOptions} options
 */
function createOutputControl({ ws, acknowledged, pause, resume, now = Date.now }) {
  const window = acknowledged ? new OutputWindow() : null;
  let stopped = false,
    paused = false,
    blockedAt = /** @type {number|null} */ (null);
  /** @param {string} reason */
  function close(reason) {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
      ws.close(OVERLOADED, reason);
    }
  }
  function check() {
    if (stopped) return;
    const blocked = Boolean(window?.blocked) || ws.bufferedAmount >= OUTPUT_HARD_BYTES / 4;
    if (blocked) {
      blockedAt ??= now();
      if (!paused) {
        paused = true;
        pause();
      }
      if (now() - blockedAt >= OUTPUT_STALL_MS) close('terminal output consumer stalled');
    } else {
      blockedAt = null;
      if (paused) {
        paused = false;
        resume();
      }
    }
  }
  /** @param {Buffer} bytes */
  function write(bytes) {
    if (stopped || ws.readyState !== 1) return false;
    if (
      (window && window.pending + bytes.length > OUTPUT_HARD_BYTES) ||
      ws.bufferedAmount + bytes.length > OUTPUT_HARD_BYTES
    ) {
      close('terminal output budget exceeded');
      return false;
    }
    if (window)
      ws.send(
        JSON.stringify({
          type: 'terminal.flow',
          streamId: window.id,
          offset: window.write(bytes.length),
        }),
      );
    ws.send(bytes, { binary: true });
    check();
    return true;
  }
  const timer = setInterval(check, 100);
  timer.unref?.();
  return {
    write /** @param {import('../shared/terminal-protocol').TerminalAck} message */,
    acknowledge(message = /** @type {import('../shared/terminal-protocol').TerminalAck} */ ({})) {
      if (!window || message.streamId !== window.id) return; // callbacks from a retired observer
      if (!window.acknowledge(message.streamId, message.offset)) {
        ws.close(1008, 'invalid terminal acknowledgement');
        return;
      }
      check();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    get streamId() {
      return window?.id;
    },
    get blocked() {
      return paused || stopped;
    },
  };
}
module.exports = { createOutputControl, OVERLOADED };
