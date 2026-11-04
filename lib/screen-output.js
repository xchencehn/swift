'use strict';

// Structured status is a replaceable snapshot, not a lossless terminal stream.
// Keep one unacknowledged frame and one latest pending frame while suspended.
function createScreenOutput({ ws, terminalId, binding, observerId, requestId, diagnostics }) {
  let latest = null,
    inFlight = 0,
    lastKey = '',
    stopped = false,
    timer = null,
    recognitionTimer = null,
    unrecognized = null;
  function flush() {
    if (timer || stopped || inFlight || !latest || ws.readyState !== 1) return;
    if (ws.bufferedAmount > 256 * 1024) {
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, 50);
      timer.unref?.();
      return;
    }
    const screen = latest;
    latest = null;
    inFlight = screen.revision;
    ws.send(
      JSON.stringify({
        type: 'terminal.screen',
        terminalId,
        binding,
        observerId,
        requestId,
        flow: 'snapshot',
        ...screen,
      }),
      (error) => {
        if (error) {
          stopped = true;
          clearTimeout(timer);
        }
      },
    );
  }
  function publish(screen) {
    const projection = screen.projection.recognized
      ? screen.projection
      : { recognized: false, rows: [], statusRows: [], interaction: screen.projection.interaction };
    const key = JSON.stringify(projection);
    if (key === lastKey) return;
    lastKey = key;
    const diagnosticId = diagnostics?.observe({
      source: 'screen',
      terminalId,
      binding,
      requestId,
      revision: screen.revision,
      cols: screen.cols,
      rows: screen.rows?.length,
      interaction: projection.interaction,
    });
    latest = {
      revision: screen.revision,
      capturedAt: screen.capturedAt,
      cols: screen.cols,
      rows: [],
      projection,
    };
    if (diagnosticId) latest.diagnosticId = diagnosticId;
    flush();
  }
  return {
    write(screen) {
      if (stopped) return;
      if (screen.projection.recognized) {
        clearTimeout(recognitionTimer);
        recognitionTimer = null;
        unrecognized = null;
        publish(screen);
      } else {
        // A native redraw can briefly clear the composer/footer. Keep the last
        // complete projection through that burst, but report persistent unknown
        // layouts instead of pretending the last frame is still current.
        unrecognized = screen;
        if (!recognitionTimer)
          recognitionTimer = setTimeout(() => {
            recognitionTimer = null;
            if (!stopped && unrecognized) publish(unrecognized);
            unrecognized = null;
          }, 350);
      }
    },
    acknowledge(message) {
      if (
        message.observerId !== observerId ||
        !Number.isSafeInteger(message.revision) ||
        message.revision !== inFlight
      )
        return;
      inFlight = 0;
      flush();
    },
    stop() {
      stopped = true;
      latest = null;
      clearTimeout(timer);
      clearTimeout(recognitionTimer);
      unrecognized = null;
    },
    get pending() {
      return { inFlight, queued: latest ? 1 : 0 };
    },
  };
}
module.exports = { createScreenOutput };
