'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs');
function fixture(version = 1) {
  let callbacks,
    created = 0,
    connected = 0,
    open = false;
  const sent = [];
  const root = {
    StudioSocket: {
      create(options) {
        callbacks = options;
        created++;
        return {
          connect() {
            connected++;
            open = true;
            callbacks.onState('connecting');
            callbacks.onState('connected');
          },
          dropStream() {},
          disconnect() {
            open = false;
          },
          isOpen: () => open,
          send(value) {
            if (!open) return false;
            sent.push(value);
            return true;
          },
        };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync('public/chat/terminal-channel.js', 'utf8'), {
    window: root,
    URL,
    DataView,
    setTimeout,
    clearTimeout,
  });
  const channel = root.StudioTerminalChannel.create({
    getChannelVersion: () => version,
    socketUrl: () => new URL('ws://fixture/api/terminal?observe=1'),
  });
  const view = (name) => {
    const frames = [],
      states = [];
    const socket = channel.createSocket({
      url: () =>
        new URL(
          `ws://fixture/api/terminal?pane=p-${name}&terminalId=${name}&runtimeId=r&cols=100&rows=30`,
        ),
      onState: (state) => states.push(state),
      onMessage: (value) => frames.push(value),
      onBinary: (value) => frames.push(Buffer.from(value).toString()),
    });
    return { frames, states, socket };
  };
  return {
    view,
    sent,
    channel,
    hello: () => callbacks.onMessage({ type: 'terminal.channel.ready', version }),
    message: (value) => callbacks.onMessage(value),
    frame(id, data) {
      const bytes = Buffer.alloc(4 + Buffer.byteLength(data));
      bytes.writeUInt32LE(id);
      bytes.write(data, 4);
      return callbacks.onBinary(bytes);
    },
    offline() {
      open = false;
      callbacks.onState('offline');
    },
    online() {
      open = true;
      callbacks.onState('connecting');
      callbacks.onState('connected');
    },
    get created() {
      return created;
    },
    get connected() {
      return connected;
    },
  };
}
test('views share one socket, filter late frames and tag input with the active selection', () => {
  const f = fixture(),
    a = f.view('A'),
    b = f.view('B');
  a.socket.connect();
  f.hello();
  const first = f.sent.at(-1).selectionId;
  f.frame(first, 'A');
  b.socket.connect();
  const second = f.sent.at(-1).selectionId;
  f.frame(first, 'late-A');
  f.frame(second, 'B');
  assert.deepEqual(a.frames, ['A']);
  assert.deepEqual(b.frames, ['B']);
  assert.equal(a.socket.send({ type: 'terminal.input', data: 'wrong' }), false);
  b.socket.send({ type: 'terminal.input', data: 'correct' });
  assert.equal(f.sent.at(-1).selectionId, second);
  a.socket.setVisible(true);
  const third = f.sent.at(-1).selectionId;
  f.frame(first, 'late-first-A');
  f.frame(third, 'current-A');
  assert.deepEqual(a.frames, ['A', 'current-A']);
  assert.equal(f.created, 1);
  assert.equal(f.connected, 1);
});
test('hidden views release selection; reconnect restores only the current target and never replays input', () => {
  const f = fixture(),
    a = f.view('A');
  a.socket.connect();
  f.hello();
  a.socket.send({ type: 'terminal.input', data: 'once' });
  const before = a.socket.generation;
  a.socket.setVisible(false);
  assert.equal(f.sent.at(-1).target, null);
  assert(a.socket.generation > before);
  assert.equal(a.socket.send({ type: 'terminal.input', data: 'hidden' }), false);
  a.socket.setVisible(true);
  f.offline();
  assert.equal(a.socket.send({ type: 'terminal.input', data: 'offline' }), false);
  f.online();
  f.hello();
  assert.equal(f.sent.at(-1).target.terminalId, 'A');
  assert.deepEqual(
    f.sent.filter((row) => row.type === 'terminal.input').map((row) => row.data),
    ['once'],
  );
  assert.equal(f.created, 1);
});
test('a new selection can recover after identity rejection closed the shared socket', () => {
  const f = fixture(),
    a = f.view('A'),
    b = f.view('B');
  a.socket.connect();
  f.hello();
  f.offline();
  b.socket.connect();
  f.hello();
  assert.equal(f.connected, 2);
  assert.equal(f.created, 1);
  assert.equal(f.sent.at(-1).target.terminalId, 'B');
  assert.equal(a.socket.send({ type: 'terminal.input', data: 'old' }), false);
});

test('persistent views update while hidden and switching requires neither resubscription nor parser reset', () => {
  const f = fixture(2),
    a = f.view('A'),
    b = f.view('B');
  a.socket.connect();
  f.hello();
  const first = f.sent.find((row) => row.type === 'terminal.subscribe').subscriptionId;
  const generation = a.socket.generation;
  b.socket.connect();
  const second = f.sent.filter((row) => row.type === 'terminal.subscribe').at(-1).subscriptionId;
  f.frame(first, 'BACKGROUND_A');
  f.frame(second, 'VISIBLE_B');
  assert.deepEqual(a.frames, ['BACKGROUND_A']);
  assert.deepEqual(b.frames, ['VISIBLE_B']);
  assert.equal(a.socket.isOpen(), true);
  assert.equal(a.socket.generation, generation);
  assert.equal(a.socket.send({ type: 'terminal.input', data: 'wrong' }), false);
  a.socket.setVisible(true);
  a.socket.send({ type: 'terminal.input', data: 'correct' });
  assert.equal(f.sent.at(-1).subscriptionId, first);
  assert.equal(f.sent.filter((row) => row.type === 'terminal.subscribe').length, 2);
  assert.equal(f.created, 1);
  assert.equal(f.connected, 1);
  f.channel.dispose();
});
test('persistent reconnect restores all subscribed terminals but never replays input', () => {
  const f = fixture(2),
    a = f.view('A'),
    b = f.view('B');
  a.socket.connect();
  f.hello();
  b.socket.connect();
  b.socket.send({ type: 'terminal.input', data: 'once' });
  f.offline();
  assert.equal(b.socket.send({ type: 'terminal.input', data: 'offline' }), false);
  f.online();
  f.hello();
  assert.deepEqual(
    f.sent.filter((row) => row.type === 'terminal.subscribe').map((row) => row.target.terminalId),
    ['A', 'B', 'B', 'A'],
  );
  assert.deepEqual(
    f.sent.filter((row) => row.type === 'terminal.input').map((row) => row.data),
    ['once'],
  );
  f.channel.dispose();
});
test('closing one overloaded background subscription preserves the foreground and recovers when selected', () => {
  const f = fixture(2),
    a = f.view('A'),
    b = f.view('B');
  a.socket.connect();
  f.hello();
  b.socket.connect();
  const first = f.sent.find((row) => row.type === 'terminal.subscribe').subscriptionId;
  f.message({ type: 'terminal.subscription.closed', subscriptionId: first, code: 4008 });
  assert.equal(a.socket.isOpen(), false);
  assert.equal(b.socket.isOpen(), true);
  a.socket.setVisible(true);
  const replacement = f.sent
    .filter((row) => row.type === 'terminal.subscribe')
    .at(-1).subscriptionId;
  assert.notEqual(replacement, first);
  f.frame(first, 'STALE');
  f.frame(replacement, 'CURRENT');
  assert.deepEqual(a.frames, ['CURRENT']);
  f.channel.dispose();
});
