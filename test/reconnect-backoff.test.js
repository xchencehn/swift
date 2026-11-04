'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs');
function harness() {
  let now = 1000,
    serial = 0;
  const timers = new Map(),
    events = new Map(),
    instances = [];
  const listeners = {
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name) => events.delete(name),
  };
  const context = {
    window: {},
    document: { hidden: false, ...listeners },
    ...listeners,
    Date: { now: () => now },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    setTimeout: (fn, delay) => {
      timers.set(++serial, { fn, delay });
      return serial;
    },
    clearTimeout: (id) => timers.delete(id),
    ArrayBuffer,
    Uint8Array,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/core/socket.js'), 'utf8'), context);
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      this.sent = [];
      instances.push(this);
    }
    close() {
      this.readyState = 3;
    }
    send(value) {
      this.sent.push(value);
    }
    open() {
      this.readyState = 1;
      this.onopen();
    }
    fail(code = 1006) {
      this.readyState = 3;
      this.onclose({ code });
    }
  }
  const socket = context.window.StudioSocket.create({ url: 'ws://fixture', SocketImpl: Socket });
  return {
    socket,
    instances,
    events,
    timers,
    document: context.document,
    advance: (ms) => (now += ms),
    retry() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      now += timer.delay;
      timer.fn();
      return timer.delay;
    },
  };
}
test('reconnect backs off through short handshakes, caps retries and resets after a stable connection', () => {
  const h = harness();
  h.socket.connect();
  const delays = [];
  for (let i = 0; i < 10; i++) {
    h.instances.at(-1).open();
    h.instances.at(-1).fail();
    delays.push(h.retry());
  }
  assert.equal(delays[0], 1400);
  assert(delays[2] > delays[1]);
  assert(delays.every((d) => d <= 5000));
  assert(delays.at(-1) >= 3750);
  h.document.hidden = true;
  h.instances.at(-1).fail();
  assert(h.retry() >= 20000);
  h.instances.at(-1).open();
  h.advance(10001);
  h.instances.at(-1).fail();
  assert.equal(h.retry(), 1400);
  h.socket.disconnect();
});
test('foreground and network recovery wake once without replaying input; auth and deliberate close remain closed', () => {
  const h = harness();
  h.socket.connect();
  h.instances.at(-1).fail();
  assert.equal(h.socket.send({ input: 'do not replay' }), false);
  const wake = h.events.get('online');
  wake();
  assert.equal(h.instances.length, 2);
  assert.equal(h.timers.size, 1, 'new connection owns a service handshake watchdog');
  wake();
  assert.equal(h.instances.length, 2);
  h.instances.at(-1).open();
  assert.deepEqual(h.instances.at(-1).sent, []);
  h.instances.at(-1).fail(4001);
  assert.equal(h.events.size, 0);
  wake();
  assert.equal(h.instances.length, 2);
  h.socket.connect();
  h.instances.at(-1).fail();
  const visible = h.events.get('visibilitychange');
  h.socket.disconnect();
  visible();
  assert.equal(h.instances.length, 3);
  assert.equal(h.events.size, 0);
  assert.equal(h.timers.size, 0);
});

test('a peer normal close retries observation without replay, while explicit disconnect and policy rejection stop', () => {
  const h = harness();
  h.socket.connect();
  h.instances.at(-1).open();
  h.instances.at(-1).fail(1000);
  assert.equal(h.timers.size, 1, 'A peer close is not an explicit local disconnect');
  h.retry();
  h.instances.at(-1).open();
  assert.deepEqual(h.instances.at(-1).sent, []);
  h.instances.at(-1).fail(1008);
  assert.equal(h.timers.size, 0);
  h.socket.connect();
  h.socket.disconnect();
  assert.equal(h.timers.size, 0);
});

test('service handshake watchdog expires and ready cancels it without replaying input', () => {
  const h = harness();
  h.socket.connect();
  h.instances.at(-1).open();
  assert.equal(h.retry(), 15000);
  assert.equal(h.instances.at(-1).readyState, 3);
  h.instances.at(-1).fail(4000);
  h.retry();
  h.instances.at(-1).open();
  h.instances.at(-1).onmessage({ data: JSON.stringify({ type: 'terminal.ready' }) });
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.instances.at(-1).sent, []);
  h.socket.disconnect();
});
