// Adapted from devswha/herdr-web-ui 685293e0. Copyright (c) 2026 devswha.
// MIT; see public/vendor/herdr-web-ui/LICENSE.
'use strict';
class WatchStreamParser {
  options;
  pending = '';
  decoder = new TextDecoder();
  ended = false;
  /** @param {import('../shared/terminal-protocol').WatchOptions} options */
  constructor(options) {
    this.options = options;
  }
  /** @param {string} chunk */
  push(chunk) {
    if (this.ended) return;
    this.pending += chunk;
    if (this.pending.length > 2 * 1024 * 1024) {
      this.ended = true;
      this.pending = '';
      this.options.onEnd();
      return;
    }
    let start = 0;
    for (;;) {
      const newline = this.pending.indexOf('\n', start);
      if (newline < 0) break;
      this.line(this.pending.slice(start, newline));
      start = newline + 1;
      if (this.ended) break;
    }
    this.pending = this.ended ? '' : this.pending.slice(start);
  }
  finish() {
    if (this.ended) return;
    this.line(this.pending);
    this.pending = '';
    if (!this.ended) this.flush();
  }
  flush() {
    const data = this.decoder.decode();
    if (data) this.options.onFrame(data);
  }
  /** @param {string} line */
  line(line) {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof record !== 'object' || record === null || !('type' in record)) return;
    if (
      record.type === 'terminal.frame' &&
      'encoding' in record &&
      record.encoding === 'ansi' &&
      'bytes' in record &&
      typeof record.bytes === 'string'
    ) {
      if (record.full) {
        this.decoder = new TextDecoder();
        this.options.onFull?.();
      }
      const data = this.decoder.decode(Buffer.from(record.bytes, 'base64'), {
        stream: true,
      });
      /** @type {{ full: boolean; cols?: number; rows?: number }} */
      const frame = { full: record.full === true };
      if (Number.isInteger(record.width) && record.width > 0 && record.width <= 400)
        frame.cols = record.width;
      if (Number.isInteger(record.height) && record.height > 0 && record.height <= 200)
        frame.rows = record.height;
      if (data || record.full) this.options.onFrame(data, frame);
    } else if (record.type === 'terminal.closed') {
      this.ended = true;
      this.flush();
      this.options.onEnd();
    }
  }
}

module.exports = { WatchStreamParser };
