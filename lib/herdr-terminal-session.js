'use strict';
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validKey } = require('../public/chat/terminal-keyboard');

// Herdr protocol 22: src/protocol/wire.rs and client/terminal_sessions.rs,
// upstream 7b116c05bfda646af39d2524c54e70c751f57ee8. Other protocol versions
// use the installed CLI. This is the direct-terminal subset, not a TUI client.
const PROTOCOL = 22,
  MAX_FRAME = 32 * 1024 * 1024;
function uint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid terminal integer');
  if (value < 251) return Buffer.from([value]);
  if (value <= 65535) {
    const out = Buffer.alloc(3);
    out[0] = 251;
    out.writeUInt16LE(value, 1);
    return out;
  }
  if (value <= 0xffffffff) {
    const out = Buffer.alloc(5);
    out[0] = 252;
    out.writeUInt32LE(value, 1);
    return out;
  }
  const out = Buffer.alloc(9);
  out[0] = 253;
  out.writeBigUInt64LE(BigInt(value), 1);
  return out;
}
function bytes(value) {
  const data = Buffer.from(value);
  return Buffer.concat([uint(data.length), data]);
}
function packet(...parts) {
  const data = Buffer.concat(
    parts.map((value) => (typeof value === 'number' ? uint(value) : value)),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
class Reader {
  constructor(data) {
    this.data = data;
    this.offset = 0;
  }
  take(size) {
    if (size > this.data.length - this.offset) throw new Error('Incomplete terminal message');
    const part = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return part;
  }
  uint() {
    const first = this.take(1)[0];
    if (first < 251) return first;
    if (first === 251) return this.take(2).readUInt16LE();
    if (first === 252) return this.take(4).readUInt32LE();
    if (first === 253) {
      const value = Number(this.take(8).readBigUInt64LE());
      if (Number.isSafeInteger(value)) return value;
    }
    throw new Error('Invalid terminal integer');
  }
  bool() {
    const value = this.take(1)[0];
    if (value > 1) throw new Error('Invalid terminal boolean');
    return Boolean(value);
  }
  bytes() {
    return this.take(this.uint());
  }
  end() {
    if (this.offset !== this.data.length) throw new Error('Unexpected terminal message payload');
  }
}
function commandPacket(command) {
  switch (command.type) {
    case 'terminal.key': {
      if (!validKey(command.key) || !['press', 'repeat', 'release'].includes(command.kind))
        throw new Error('Invalid terminal key');
      const names = [
        'Backspace',
        'Enter',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Tab',
        'BackTab',
        'Delete',
        'Insert',
        'Escape',
      ];
      const index = names.indexOf(command.key);
      const key =
        index >= 0
          ? uint(index)
          : /^F\d+$/.test(command.key)
            ? Buffer.concat([uint(16), uint(Number(command.key.slice(1)))])
            : Buffer.concat([uint(15), Buffer.from(command.key)]);
      // Existing protocol-22 ClientShellPaneInput and ClientPaneInputEvent::Key.
      // The extension accepts it only on a controller bound to this terminal.
      return packet(
        13,
        bytes(command.paneId),
        1,
        0,
        key,
        command.modifiers,
        ['press', 'repeat', 'release'].indexOf(command.kind),
        1,
        command.shiftedCodepoint == null
          ? uint(0)
          : Buffer.concat([uint(1), uint(command.shiftedCodepoint)]),
        command.text == null ? uint(0) : Buffer.concat([uint(1), bytes(command.text)]),
        1,
        0,
        0,
      );
    }
    case 'terminal.input':
      return packet(1, bytes(command.text));
    case 'terminal.resize':
      return packet(3, command.cols, command.rows, 0, 0, 0);
    case 'terminal.release':
      return packet(4);
    case 'terminal.scroll': {
      const down = command.direction === 'down';
      const source =
        command.source === 'page_key'
          ? Buffer.concat([uint(1), bytes(down ? '\x1b[6~' : '\x1b[5~')])
          : uint(0);
      return packet(
        6,
        source,
        down ? 1 : 0,
        command.lines,
        1,
        command.column,
        1,
        command.row,
        command.modifiers,
      );
    }
    case 'terminal.mouse': {
      const action = ['down', 'up', 'drag', 'move'].indexOf(command.action);
      const kind =
        action === 3
          ? uint(3)
          : Buffer.concat([
              uint(action),
              uint(['left', 'right', 'middle'].indexOf(command.button)),
            ]);
      return packet(16, kind, 0, command.column, command.row, 0, command.modifiers, 1);
    }
    default:
      throw new Error('Unknown terminal command');
  }
}
function openTerminalSession({ socketPath, terminalId, mode, cols, rows }) {
  const session = new EventEmitter();
  const clientPath = path.join(
    path.dirname(socketPath),
    path.parse(socketPath).name + '-client.sock',
  );
  const socket = net.createConnection(clientPath);
  let buffer = Buffer.alloc(0),
    welcomed = false,
    closing = false,
    activated = mode !== 'pending',
    timer;
  session.closed = new Promise((resolve) =>
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
      session.emit('close');
    }),
  );
  session.ready = new Promise((resolve, reject) => {
    session.once('ready', resolve);
    session.once('failure', reject);
    socket.once('close', () => reject(new Error('Terminal connection closed')));
  });
  session.ready.catch(() => {});
  const fail = () => {
    if (!closing) session.emit('failure', new Error('Native terminal connection failed'));
    socket.destroy();
  };
  socket.once('error', fail);
  socket.once('connect', () => socket.write(packet(0, PROTOCOL, cols, rows, 0, 0, 0)));
  socket.on('data', (chunk) => {
    try {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE();
        if (!size || size > MAX_FRAME) throw new Error('Invalid terminal frame size');
        if (buffer.length < size + 4) break;
        const reader = new Reader(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        const tag = reader.uint();
        if (!welcomed) {
          if (tag !== 0 || reader.uint() !== PROTOCOL || reader.uint() !== 1 || reader.bool())
            throw new Error('Terminal handshake rejected');
          reader.end();
          welcomed = true;
          if (mode !== 'pending')
            socket.write(
              mode === 'observe' ? packet(7, bytes(terminalId)) : packet(8, bytes(terminalId), 0),
            );
          // The caller still waits for the control frame before sending input,
          // so mouse coordinates use the geometry actually applied by Herdr.
          session.emit('ready', session);
        } else if (tag === 1) {
          const seq = reader.uint(),
            cols = reader.uint(),
            rows = reader.uint(),
            full = reader.bool(),
            data = reader.bytes();
          reader.end();
          if (!cols || !rows || cols > 400 || rows > 200)
            throw new Error('Invalid terminal geometry');
          session.emit('frame', data, { seq, cols, rows, full });
        } else if (tag === 20) {
          const kind = reader.bytes().toString(),
            data = reader.bytes().toString();
          reader.end();
          if (kind === 'terminal.control.ready') {
            const ready = JSON.parse(data);
            if (
              ready.terminal_id !== terminalId ||
              !Number.isInteger(ready.cols) ||
              ready.cols < 1 ||
              ready.cols > 400 ||
              !Number.isInteger(ready.rows) ||
              ready.rows < 1 ||
              ready.rows > 200
            )
              throw new Error('Invalid terminal control readiness');
            session.emit('controlReady', ready);
          }
        } else if (tag === 3) {
          fail();
          return;
        }
        // Notifications and graphics are not part of a terminal text stream.
      }
    } catch {
      fail();
    }
  });
  session.write = (command, repeat = 1) => {
    if (closing || socket.destroyed || !welcomed || !activated)
      throw new Error('Terminal connection unavailable');
    const frame = commandPacket(command);
    socket.write(repeat === 1 ? frame : Buffer.concat(Array.from({ length: repeat }, () => frame)));
  };
  session.activate = (
    cols,
    rows,
    target = terminalId,
    selectionMode = 'control',
    { frames = true } = {},
  ) => {
    if (!welcomed || activated || closing || socket.destroyed)
      throw new Error('Terminal preparation unavailable');
    if (!target || !['observe', 'control'].includes(selectionMode))
      throw new Error('Invalid terminal selection');
    activated = true;
    terminalId = target;
    // A pending terminal client has no target and owns no PTY size. Apply its
    // latest viewport before selecting the exact writable terminal, without takeover.
    socket.write(
      Buffer.concat([
        ...(frames
          ? []
          : [packet(20, bytes('terminal.control.configure'), bytes('{"frames":false}'))]),
        commandPacket({ type: 'terminal.resize', cols, rows }),
        selectionMode === 'observe' ? packet(7, bytes(target)) : packet(8, bytes(target), 0),
      ]),
    );
  };
  session.close = () => {
    if (!closing) {
      closing = true;
      socket.resume();
      if (welcomed && !socket.destroyed) socket.end(packet(4));
      else socket.destroy();
      timer = setTimeout(() => socket.destroy(), 1500);
      timer.unref?.();
    }
    return session.closed;
  };
  session.pause = () => socket.pause();
  session.resume = () => socket.resume();
  Object.defineProperty(session, 'writableLength', { get: () => socket.writableLength });
  return session;
}

// A channel keeps two unbound, silent handshakes ready. The terminal runtimes
// stay in Herdr; no hidden terminal output is observed or cached on this server.
function createTerminalPreparation(socketPath) {
  const spare = [];
  let stopped = false;
  return {
    take() {
      if (stopped) throw new Error('Terminal channel closed');
      const session =
        spare.shift() || openTerminalSession({ socketPath, mode: 'pending', cols: 100, rows: 200 });
      while (spare.length < 2) {
        const next = openTerminalSession({ socketPath, mode: 'pending', cols: 100, rows: 200 });
        spare.push(next);
        next.once('close', () => {
          const index = spare.indexOf(next);
          if (index >= 0) spare.splice(index, 1);
        });
      }
      return session;
    },
    close() {
      stopped = true;
      return Promise.all(spare.splice(0).map((session) => session.close()));
    },
  };
}
module.exports = {
  PROTOCOL,
  openTerminalSession,
  createTerminalPreparation,
  commandPacket,
  packet,
  bytes,
  Reader,
};
