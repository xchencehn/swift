'use strict';
const {
  OutputWindow,
  OUTPUT_HARD_BYTES,
  OUTPUT_STALL_MS,
  OUTPUT_PAUSE_MAX_MS,
} = require('./output-window');
const OVERLOADED = 4008;

/** Consumer credit and transport credit are separate; input never pauses.
 * @param {import('../shared/terminal-protocol').OutputControlOptions} options
 */
function createOutputControl({ ws, acknowledged, pause, resume, now = Date.now }) {
  const window = acknowledged ? new OutputWindow() : null;
  let stopped = false,
    paused = false,
    pausedAt = /** @type {number|null} */ (null),
    consumerStalledAt = /** @type {number|null} */ (null),
    transportStalledAt = /** @type {number|null} */ (null),
    previousBuffered = 0;
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
    const time = now();
    const consumerBlocked = Boolean(window?.blocked);
    const transportBlocked = ws.bufferedAmount >= OUTPUT_HARD_BYTES / 4;
    if (consumerBlocked) consumerStalledAt ??= time;
    else consumerStalledAt = null;
    if (transportBlocked) {
      if (transportStalledAt === null || ws.bufferedAmount < previousBuffered)
        transportStalledAt = time;
    } else transportStalledAt = null;
    previousBuffered = ws.bufferedAmount;
    if (consumerBlocked || transportBlocked) {
      pausedAt ??= time;
      if (!paused) {
        paused = true;
        pause();
      }
      if (
        (consumerStalledAt !== null && time - consumerStalledAt >= OUTPUT_STALL_MS) ||
        (transportStalledAt !== null && time - transportStalledAt >= OUTPUT_STALL_MS)
      )
        close('terminal output consumer stalled');
      else if (time - pausedAt >= OUTPUT_PAUSE_MAX_MS)
        close('terminal output pause budget exceeded');
    } else {
      pausedAt = null;
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
      const previous = window.acknowledged;
      if (!window.acknowledge(message.streamId, message.offset)) {
        ws.close(1008, 'invalid terminal acknowledgement');
        return;
      }
      // Only new consumer credit extends its stall deadline; duplicates and stale
      // offsets cannot keep a subscription alive, or hide a stalled transport.
      if (window.acknowledged > previous && consumerStalledAt !== null) consumerStalledAt = now();
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
