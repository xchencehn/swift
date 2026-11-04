'use strict';
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const { applyTerminalState } = require('../public/chat/terminal-state');

function openTerminalState({ socketPath, terminalId, timeout = 5000 }) {
  const session = new EventEmitter();
  const socket = net.createConnection(socketPath),
    decoder = new StringDecoder('utf8');
  let buffer = '',
    stopped = false,
    received = false,
    timer;
  session.state = null;
  session.ready = new Promise((resolve, reject) => {
    session.once('ready', resolve);
    session.once('failure', reject);
  });
  session.ready.catch(() => {});
  function fail(error) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    session.emit('failure', error);
    socket.destroy();
  }
  session.closed = new Promise((resolve) =>
    socket.once('close', () => {
      if (!stopped && !received)
        fail(new Error('Native terminal observation closed before its snapshot'));
      stopped = true;
      clearTimeout(timer);
      resolve();
      session.emit('close');
    }),
  );
  socket.once('connect', () =>
    socket.write(
      `${JSON.stringify({
        id: 'swift-terminal-state',
        method: 'terminal.state.subscribe',
        params: { terminal_id: terminalId },
      })}\n`,
    ),
  );
  socket.on('error', fail);
  socket.on('data', (chunk) => {
    try {
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        if (Buffer.byteLength(buffer.slice(0, newline)) > MAX_FRAME_BYTES)
          throw new Error('Native terminal state exceeds limit');
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.error)
          throw new Error(message.error.message || 'Native terminal observation rejected');
        const state = applyTerminalState(session.state, message.result, terminalId);
        session.state = state;
        session.emit('state', message.result, state);
        if (!received) {
          received = true;
          clearTimeout(timer);
          session.emit('ready', session);
        }
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
        throw new Error('Native terminal state exceeds limit');
    } catch (error) {
      fail(error);
    }
  });
  timer = setTimeout(() => fail(new Error('Native terminal observation timed out')), timeout);
  timer.unref?.();
  session.pause = () => socket.pause();
  session.resume = () => socket.resume();
  session.close = () => {
    if (!received && !stopped) fail(new Error('Native terminal observation cancelled'));
    stopped = true;
    clearTimeout(timer);
    socket.destroy();
    return session.closed;
  };
  return session;
}

module.exports = { applyTerminalState, openTerminalState };
