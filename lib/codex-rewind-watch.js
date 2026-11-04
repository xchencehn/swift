'use strict';

// One read-only observer belongs to one caller-owned submit operation.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const source = path.resolve(__dirname, '..');
const { WatchStreamParser } = require('./watch-stream');
const { TerminalScreen } = require('./terminal-screen');

const error = (code, message, cause) =>
  Object.assign(new Error(message), { code, status: 409, ...(cause ? { cause } : {}) });

function colorCode(value, background) {
  if (!value) return [];
  const hex = /^#([\da-f]{6})$/i.exec(value);
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value);
  const channels = hex
    ? [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16))
    : rgb?.slice(1).map(Number);
  if (!channels || channels.some((channel) => channel < 0 || channel > 255))
    throw error('REWIND_WATCH_STYLE', '原生观察画面的颜色无法确认。');
  return [background ? 48 : 38, 2, ...channels];
}

function rowsToAnsi(rows) {
  // Reconstructed screen text for ANSI-aware status parsers, not the original
  // watch byte stream. A VT replay must normalize these LF separators to CRLF.
  return rows
    .map(
      (row) =>
        row
          .map((span) => {
            // TerminalScreen exposes the effective colors and also retains inverse.
            // Undo that exchange before emitting SGR 7, otherwise colors swap twice.
            const foreground = span.inverse ? span.background : span.color;
            const background = span.inverse ? span.color : span.background;
            const codes = [
              0,
              ...(span.bold ? [1] : []),
              ...(span.dim ? [2] : []),
              ...(span.italic ? [3] : []),
              ...(span.underline ? [4] : []),
              ...(span.inverse ? [7] : []),
              ...colorCode(foreground, false),
              ...colorCode(background, true),
            ];
            return `\x1b[${codes.join(';')}m${span.text}`;
          })
          .join('') + '\x1b[0m',
    )
    .join('\n');
}

class NativeWatch {
  constructor({ herdr, pane, timeoutMs = 12000 }) {
    if (
      !herdr ||
      typeof herdr.bin !== 'string' ||
      !herdr.bin ||
      typeof herdr.env !== 'function' ||
      typeof herdr.socketPath !== 'string' ||
      !herdr.socketPath ||
      !/^[\w:.-]{1,128}$/.test(pane?.terminalId || '')
    )
      throw error('REWIND_WATCH_TARGET', '缺少明确的原生观察终端。');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw error('REWIND_WATCH_TIMEOUT', '原生观察超时时间无效。');
    const env = {
      ...herdr.env(),
      HERDR_SOCKET_PATH: herdr.socketPath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    // Bind to the same server as targeted RPC writes, without inheriting a
    // different caller pane or foreground-client context.
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID'])
      delete env[key];
    this.timeoutMs = timeoutMs;
    this.watchId = randomUUID();
    this.viewportRows =
      Number.isSafeInteger(pane.scroll?.viewport_rows) && pane.scroll.viewport_rows > 0
        ? pane.scroll.viewport_rows
        : 120;
    this.frameSequence = 0;
    this.closed = false;
    this.failure = null;
    this.seenFull = false;
    this.ready = false;
    this.wire = '';
    this.pending = Promise.resolve();
    this.full = new Promise((resolve) => {
      this.resolveFull = resolve;
    });
    this.failed = new Promise((_resolve, reject) => {
      this.rejectFailure = reject;
    });
    // Failure can precede the first read. Retain it without an unhandled rejection.
    this.failed.catch(() => {});
    this.screen = new TerminalScreen({ cols: 250, rows: 120 });
    this.parser = new WatchStreamParser({
      onFrame: (data, frame = {}) => this.applyFrame(data, frame),
      onEnd: () =>
        this.invalidate(error('REWIND_WATCH_ENDED', '原生观察流已结束，不能使用旧画面。')),
    });
    try {
      this.child = spawn(
        herdr.bin,
        ['terminal', 'session', 'observe', pane.terminalId, '--cols', '250', '--rows', '120'],
        { cwd: source, env, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch (cause) {
      this.invalidate(error('REWIND_WATCH_START', '无法启动原生只读观察。', cause));
      throw this.failure;
    }
    this.childClosed = new Promise((resolve) => {
      this.resolveChildClosed = resolve;
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stdout.on('end', () => {
      // finish() alone does not report EOF, and a final VT drain must not leave
      // an apparently live cached frame after the transport has disconnected.
      this.invalidate(error('REWIND_WATCH_ENDED', '原生观察流已断开，不能使用旧画面。'));
    });
    this.child.stdout.on('error', (cause) =>
      this.invalidate(error('REWIND_WATCH_STREAM', '原生观察流读取失败。', cause)),
    );
    this.child.on('error', (cause) =>
      this.invalidate(error('REWIND_WATCH_START', '原生只读观察进程不可用。', cause)),
    );
    this.child.on('close', () => {
      this.childExited = true;
      clearTimeout(this.killTimer);
      this.resolveChildClosed();
      this.invalidate(error('REWIND_WATCH_ENDED', '原生观察进程已退出，不能使用旧画面。'));
    });
    this.startupTimer = setTimeout(() => {
      if (!this.ready) this.invalidate(error('REWIND_WATCH_TIMEOUT', '等待原生完整画面超时。'));
    }, timeoutMs);
    this.startupTimer.unref?.();
  }

  consume(chunk) {
    if (this.failure || this.closed) return;
    this.wire += chunk;
    if (this.wire.length > 2 * 1024 * 1024)
      return this.invalidate(error('REWIND_WATCH_PROTOCOL', '原生观察记录过大，画面已失效。'));
    let newline;
    while (!this.failure && !this.closed && (newline = this.wire.indexOf('\n')) >= 0) {
      const line = this.wire.slice(0, newline);
      this.wire = this.wire.slice(newline + 1);
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (cause) {
        return this.invalidate(
          error('REWIND_WATCH_PROTOCOL', '原生观察记录不完整，画面已失效。', cause),
        );
      }
      if (!record || typeof record !== 'object' || typeof record.type !== 'string')
        return this.invalidate(error('REWIND_WATCH_PROTOCOL', '原生观察记录无效，画面已失效。'));
      if (
        record.type === 'terminal.frame' &&
        (record.encoding !== 'ansi' ||
          typeof record.bytes !== 'string' ||
          (record.full !== undefined && typeof record.full !== 'boolean') ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.bytes))
      )
        return this.invalidate(error('REWIND_WATCH_PROTOCOL', '原生观察帧无法解码，画面已失效。'));
      try {
        this.parser.push(line + '\n');
      } catch (cause) {
        return this.invalidate(error('REWIND_WATCH_PROTOCOL', '原生观察帧解析失败。', cause));
      }
    }
  }

  applyFrame(data, frame) {
    if (this.failure || this.closed) return;
    if (frame.full) this.seenFull = true;
    if (!this.seenFull) return;
    try {
      this.pending = this.screen.feed(data, frame).then(() => {
        if (this.failure || this.closed) return;
        this.frameSequence++;
        if (frame.full) {
          this.ready = true;
          clearTimeout(this.startupTimer);
          this.resolveFull();
        }
      });
      this.pending.catch((cause) =>
        this.invalidate(
          error('REWIND_WATCH_VT', '原生画面解码失败，不能继续使用观察结果。', cause),
        ),
      );
    } catch (cause) {
      this.invalidate(error('REWIND_WATCH_VT', '原生画面解码失败，不能继续使用观察结果。', cause));
    }
  }

  assertLive() {
    if (this.failure) throw this.failure;
    if (this.closed) throw error('REWIND_WATCH_CLOSED', '原生只读观察已关闭。');
  }

  async bounded(promise, deadline) {
    this.assertLive();
    let timer;
    try {
      await Promise.race([
        promise,
        this.failed,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => {
              const cause = error('REWIND_WATCH_TIMEOUT', '等待原生画面完成解码超时。');
              this.invalidate(cause);
              reject(cause);
            },
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
      this.assertLive();
    } finally {
      clearTimeout(timer);
    }
  }

  async read() {
    this.assertLive();
    const deadline = performance.now() + this.timeoutMs;
    await this.bounded(this.full, deadline);
    // Wait for an applied full and every frame already queued in the VT. If a
    // new frame arrived while awaiting, repeat before sampling rows and cursor.
    for (;;) {
      const pending = this.pending;
      await this.bounded(pending, deadline);
      if (pending === this.pending) break;
    }
    this.assertLive();
    const snapshot = this.screen.snapshot(),
      buffer = this.screen.terminal.buffer.active;
    const endColumns = [],
      isWrapped = [];
    for (let y = 0; y < snapshot.rows.length; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      let end = 0;
      for (let x = 0; line && x < this.screen.cols; x++) {
        const cell = line.getCell(x);
        if (cell?.getWidth() && !cell.isInvisible() && cell.getChars().trim())
          end = x + cell.getWidth();
      }
      // This wrap flag belongs to the 250-column observation VT, not Codex's
      // logical message newlines. End columns deliberately exclude whitespace.
      endColumns.push(end);
      isWrapped.push(Boolean(line?.isWrapped));
    }
    return {
      rows: snapshot.rows,
      raw: rowsToAnsi(snapshot.rows),
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      endColumns,
      isWrapped,
      frameSequence: this.frameSequence,
      watchId: this.watchId,
      viewportRows: this.viewportRows,
    };
  }

  stopChild() {
    if (!this.child || this.childExited || this.stopping) return;
    this.stopping = true;
    // This is only the observer spawned above, never a Herdr server or PTY.
    try {
      this.child.kill('SIGTERM');
    } catch {}
    this.killTimer = setTimeout(() => {
      if (!this.childExited) {
        try {
          this.child.kill('SIGKILL');
        } catch {}
      }
    }, 500);
    this.killTimer.unref?.();
  }

  invalidate(cause) {
    if (!this.failure) {
      this.failure = cause;
      this.rejectFailure(cause);
    }
    clearTimeout(this.startupTimer);
    this.wire = '';
    this.stopChild();
    if (!this.screen.closed) this.screen.close();
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.invalidate(error('REWIND_WATCH_CLOSED', '原生只读观察已关闭。'));
    }
    return this.childClosed || Promise.resolve();
  }
}

module.exports = { NativeWatch, rowsToAnsi };
