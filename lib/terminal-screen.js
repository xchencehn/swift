'use strict';

const { Terminal } = require('@xterm/headless');
const { xterm256 } = require('../public/ansi');
const { projectTerminalScreen } = require('../public/native-status');

function color(cell, background) {
  const rgb = background ? cell.isBgRGB() : cell.isFgRGB();
  const palette = background ? cell.isBgPalette() : cell.isFgPalette();
  const value = background ? cell.getBgColor() : cell.getFgColor();
  if (rgb) return `#${value.toString(16).padStart(6, '0')}`;
  if (palette) return `rgb(${xterm256(value).join(',')})`;
  return null;
}

// An observer owns a read-only VT buffer. Nothing produced by the emulator
// (including terminal query responses) is ever written to the real PTY.
class TerminalScreen {
  constructor({ cols = 250, rows = 120, onScreen = () => {}, snapshotIntervalMs = 0 } = {}) {
    this.cols = cols;
    this.height = rows;
    this.onScreen = onScreen;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.snapshotTimer = null;
    this.revision = 0;
    this.ready = false;
    this.closed = false;
    this.pending = Promise.resolve();
    this.terminal = this.create();
  }
  create() {
    return new Terminal({
      cols: this.cols,
      rows: this.height,
      scrollback: 0,
      allowProposedApi: true,
    });
  }
  feed(data, { full = false } = {}) {
    if (this.closed || (!this.ready && !full)) return Promise.resolve();
    if (full) this.ready = true;
    this.pending = this.pending.then(
      () =>
        new Promise((resolve) => {
          if (this.closed) return resolve();
          if (full) {
            this.terminal.dispose();
            this.terminal = this.create();
          }
          this.terminal.write(data, () => {
            if (!this.closed) {
              if (!this.snapshotIntervalMs) this.onScreen(this.snapshot());
              else if (!this.snapshotTimer)
                this.snapshotTimer = setTimeout(() => this.flush(), this.snapshotIntervalMs);
            }
            resolve();
          });
        }),
    );
    return this.pending;
  }
  flush() {
    if (!this.snapshotTimer || this.closed) return;
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    this.onScreen(this.snapshot());
  }
  snapshot() {
    const rows = [],
      buffer = this.terminal.buffer.active;
    for (let y = 0; y < this.height; y++) {
      const line = buffer.getLine(buffer.viewportY + y),
        spans = [];
      if (!line) break;
      for (let x = 0; x < this.cols; x++) {
        const cell = line.getCell(x);
        if (!cell || !cell.getWidth()) continue;
        const inverse = Boolean(cell.isInverse());
        const foreground = color(cell, inverse),
          background = color(cell, !inverse);
        const style = {
          ...(foreground ? { color: foreground } : {}),
          ...(background ? { background } : {}),
          ...(inverse ? { inverse: true } : {}),
          ...(cell.isBold() ? { bold: true } : {}),
          ...(cell.isDim() ? { dim: true } : {}),
          ...(cell.isItalic() ? { italic: true } : {}),
          ...(cell.isUnderline() ? { underline: true } : {}),
        };
        const text = cell.isInvisible() ? ' '.repeat(cell.getWidth()) : cell.getChars() || ' ';
        const last = spans.at(-1);
        if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.text += text;
        else spans.push({ text, style });
      }
      // Keep internal spacing and empty rows; trim only unpainted trailing cells.
      while (spans.length && !Object.keys(spans.at(-1).style).length && !spans.at(-1).text.trim())
        spans.pop();
      if (spans.length && !spans.at(-1).style.background)
        spans.at(-1).text = spans.at(-1).text.trimEnd();
      rows.push(spans.map(({ text, style }) => ({ text, ...style })));
    }
    while (rows.length && !rows.at(-1).some((span) => span.text.trim() || span.background))
      rows.pop();
    const screen = { revision: ++this.revision, cols: this.cols, rows, capturedAt: Date.now() };
    return { ...screen, projection: projectTerminalScreen(rows) };
  }
  close() {
    clearTimeout(this.snapshotTimer);
    this.closed = true;
    this.terminal.dispose();
  }
}

module.exports = { TerminalScreen };
