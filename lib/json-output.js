'use strict';
const { gzip } = require('node:zlib');

// Reliable JSON writes serialize through send completion. If incremental
// history outgrows the queue, the replica resumes with sync.reset/hello.
function createJsonOutput(ws, { budget = 4 * 1024 * 1024 } = {}) {
  let queue = [],
    bytes = 0,
    busy = false,
    stopped = false,
    resetPending = false;
  function flush() {
    if (busy || stopped) return;
    if (ws.readyState !== 1) {
      stop();
      return;
    }
    const item = queue.shift();
    if (!item) return;
    bytes -= item.bytes;
    busy = true;
    const send = (data, encoded = false) => {
      if (stopped || ws.readyState !== 1) {
        busy = false;
        item.done(false);
        stop();
        return;
      }
      const complete = (error) => {
        busy = false;
        if (item.reset) resetPending = false;
        item.done(!error);
        if (error) stop();
        else flush();
      };
      try {
        // The native gateway does not negotiate WebSocket extensions. This
        // envelope keeps gzip intact across it, without compressing it twice.
        if (encoded) ws.send(data, { compress: false }, complete);
        else ws.send(data, complete);
      } catch {
        busy = false;
        item.done(false);
        stop();
      }
    };
    if (
      item.sync &&
      ws.syncCompression === 'gzip' &&
      item.bytes >= 4096 &&
      item.bytes <= 4 * 1024 * 1024
    )
      gzip(item.data, { level: 1 }, (error, compressed) => {
        const encoded = error
          ? null
          : JSON.stringify({
              type: 'sync.compressed',
              encoding: 'gzip',
              bytes: item.bytes,
              data: compressed.toString('base64'),
            });
        if (encoded && Buffer.byteLength(encoded) < item.bytes) send(encoded, true);
        else send(item.data);
      });
    else send(item.data);
  }
  function stop() {
    stopped = true;
    for (const item of queue) item.done(false);
    queue = [];
    bytes = 0;
  }
  function send(value) {
    if (stopped || ws.readyState !== 1) return Promise.resolve(false);
    const sync = typeof value === 'object' && value?.type?.startsWith('sync.');
    if (sync && resetPending) return Promise.resolve(false);
    let data = typeof value === 'string' ? value : JSON.stringify(value),
      size = Buffer.byteLength(data),
      reset = false;
    if (sync && busy && bytes + size > budget) {
      const keep = [];
      for (const item of queue) {
        if (item.sync) item.done(false);
        else keep.push(item);
      }
      queue = keep;
      bytes = queue.reduce((n, item) => n + item.bytes, 0);
      ws.syncReady = false;
      resetPending = true;
      reset = true;
      data = JSON.stringify({ type: 'sync.reset', reason: 'transport-backpressure' });
      size = Buffer.byteLength(data);
    }
    // Coalescing scoped invalidations must invalidate all panes, not just one.
    if (value?.type === 'studio.changed') {
      const old = queue.find((item) => item.changed);
      if (old) {
        const data = JSON.stringify({ type: 'studio.changed' }),
          size = Buffer.byteLength(data);
        bytes += size - old.bytes;
        old.data = data;
        old.bytes = size;
        return Promise.resolve(true);
      }
    }
    return new Promise((done) => {
      queue.push({
        data,
        bytes: size,
        sync,
        reset,
        changed: value?.type === 'studio.changed',
        done,
      });
      bytes += size;
      flush();
    });
  }
  return {
    send,
    stop,
    get queuedBytes() {
      return bytes;
    },
  };
}
module.exports = { createJsonOutput };
