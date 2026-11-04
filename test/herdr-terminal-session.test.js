'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const net = require('node:net'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { once } = require('node:events');
const {
  PROTOCOL,
  openTerminalSession,
  createTerminalPreparation,
  packet,
  bytes,
  commandPacket,
  Reader,
} = require('../lib/herdr-terminal-session');

async function fixture(t, receive) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-terminal-wire-'));
  const api = path.join(directory, 'herdr.sock'),
    clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', (data) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32LE() + 4) {
        const end = pending.readUInt32LE() + 4,
          reader = new Reader(pending.subarray(4, end));
        pending = pending.subarray(end);
        receive(reader, socket);
      }
    });
  });
  server.listen(path.join(directory, 'herdr-client.sock'));
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return api;
}
test('Protocol 22 observation handles fragmented and coalesced frames without acquiring control', async (t) => {
  const commands = [];
  const socketPath = await fixture(t, (reader, socket) => {
    const tag = reader.uint();
    commands.push(tag);
    if (tag === 0) {
      assert.deepEqual(
        [reader.uint(), reader.uint(), reader.uint(), reader.uint(), reader.uint(), reader.bool()],
        [22, 320, 200, 0, 0, false],
      );
      reader.end();
      socket.write(packet(0, PROTOCOL, 1, 0));
    } else if (tag === 7) {
      assert.equal(reader.bytes().toString(), 'terminal-fixture');
      reader.end();
      const data = Buffer.concat([
        packet(1, 251, 320, 200, 1, bytes('中文')),
        packet(1, 252, 320, 200, 0, bytes(' next')),
      ]);
      socket.write(data.subarray(0, 7));
      setImmediate(() => socket.write(data.subarray(7)));
    } else if (tag === 4) socket.end();
  });
  const stream = openTerminalSession({
    socketPath,
    terminalId: 'terminal-fixture',
    mode: 'observe',
    cols: 320,
    rows: 200,
  });
  t.after(() => stream.close());
  const frames = [];
  await new Promise((resolve, reject) => {
    stream.on('failure', reject);
    stream.on('frame', (data, frame) => {
      frames.push({ data: data.toString(), ...frame });
      if (frames.length === 2) resolve();
    });
  });
  assert.deepEqual(
    frames.map((frame) => [frame.seq, frame.full, frame.data]),
    [
      [251, true, '中文'],
      [252, false, ' next'],
    ],
  );
  await stream.close();
  assert.deepEqual(commands, [0, 7, 4]);
});
test('Control commands retain UTF-8 bytes, page-key source, coordinates and modifier encoding', () => {
  const decode = (command) => new Reader(commandPacket(command).subarray(4));
  let r = decode({ type: 'terminal.input', text: '中文\r\x1b[A' });
  assert.equal(r.uint(), 1);
  assert.equal(r.bytes().toString(), '中文\r\x1b[A');
  r.end();
  r = decode({ type: 'terminal.resize', cols: 320, rows: 40 });
  assert.deepEqual(
    Array.from({ length: 6 }, () => r.uint()),
    [3, 320, 40, 0, 0, 0],
  );
  r.end();
  r = decode({
    type: 'terminal.scroll',
    source: 'page_key',
    direction: 'down',
    lines: 24,
    column: 310,
    row: 23,
    modifiers: 4,
  });
  assert.deepEqual([r.uint(), r.uint(), r.bytes().toString()], [6, 1, '\x1b[6~']);
  assert.deepEqual(
    Array.from({ length: 7 }, () => r.uint()),
    [1, 24, 1, 310, 1, 23, 4],
  );
  r.end();
  r = decode({
    type: 'terminal.mouse',
    action: 'drag',
    button: 'middle',
    column: 300,
    row: 10,
    modifiers: 2,
  });
  assert.deepEqual(
    Array.from({ length: 9 }, () => r.uint()),
    [16, 2, 2, 0, 300, 10, 0, 2, 1],
  );
  r.end();
});
test('Prepared channels select independent observers after handshake and release all spare connections', async (t) => {
  const selected = [],
    commands = [],
    sockets = new Set();
  const socketPath = await fixture(t, (reader, socket) => {
    const tag = reader.uint();
    commands.push(tag);
    if (tag === 0) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.write(packet(0, PROTOCOL, 1, 0));
    } else if (tag === 7) {
      const target = reader.bytes().toString();
      selected.push(target);
      socket.write(packet(1, 1, 100, 40, 1, bytes(target)));
    } else if (tag === 4) socket.end();
  });
  const preparation = createTerminalPreparation(socketPath);
  t.after(() => preparation.close());
  for (const target of ['terminal-a', 'terminal-b', 'terminal-c']) {
    const session = preparation.take();
    await session.ready;
    const frame = once(session, 'frame');
    session.activate(100, 200, target, 'observe');
    assert.equal((await frame)[0].toString(), target);
    await session.close();
    assert(sockets.size <= 3, 'Preparations stay bounded across selections');
  }
  await preparation.close();
  assert.deepEqual(selected, ['terminal-a', 'terminal-b', 'terminal-c']);
  assert(!commands.includes(8), 'Preparation and observation never acquire control');
  assert.throws(() => preparation.take(), /closed/);
});
test('A rejected handshake never sends a terminal target or input', async (t) => {
  const tags = [];
  const socketPath = await fixture(t, (reader, socket) => {
    tags.push(reader.uint());
    socket.write(packet(0, 23, 1, 0));
  });
  const stream = openTerminalSession({
    socketPath,
    terminalId: 'must-not-control',
    mode: 'control',
    cols: 80,
    rows: 24,
  });
  await assert.rejects(stream.ready);
  await stream.closed;
  assert.deepEqual(tags, [0]);
  assert.throws(() => stream.write({ type: 'terminal.input', text: 'never' }));
});

test('Prepared control negotiates no drawing and becomes ready without an ANSI frame', async (t) => {
  const commands = [];
  const socketPath = await fixture(t, (reader, socket) => {
    const tag = reader.uint();
    commands.push(tag);
    if (tag === 0) socket.write(packet(0, PROTOCOL, 1, 0));
    else if (tag === 20) {
      assert.equal(reader.bytes().toString(), 'terminal.control.configure');
      assert.deepEqual(JSON.parse(reader.bytes().toString()), { frames: false });
      reader.end();
    } else if (tag === 8) {
      const terminal_id = reader.bytes().toString();
      assert.equal(reader.bool(), false);
      reader.end();
      socket.write(
        packet(
          20,
          bytes('terminal.control.ready'),
          bytes(JSON.stringify({ terminal_id, cols: 120, rows: 35 })),
        ),
      );
    } else if (tag === 4) socket.end();
  });
  const session = openTerminalSession({ socketPath, mode: 'pending', cols: 80, rows: 24 });
  t.after(() => session.close());
  await session.ready;
  const ready = once(session, 'controlReady');
  session.on('frame', () => assert.fail('No rendered frame is required'));
  session.activate(120, 35, 'terminal-fixture', 'control', { frames: false });
  assert.equal((await ready)[0].terminal_id, 'terminal-fixture');
  await session.close();
  assert.deepEqual(commands, [0, 20, 3, 8, 4]);
});
test('Preparing input leaves ownership untouched until explicit activation with current geometry', async (t) => {
  const tags = [];
  const socketPath = await fixture(t, (reader, socket) => {
    const tag = reader.uint();
    tags.push(tag);
    if (tag === 0) socket.write(packet(0, PROTOCOL, 1, 0));
    if (tag === 3) {
      assert.deepEqual(
        Array.from({ length: 5 }, () => reader.uint()),
        [91, 30, 0, 0, 0],
      );
      reader.end();
    }
    if (tag === 8) {
      assert.equal(reader.bytes().toString(), 'fixture');
      assert.equal(reader.bool(), false);
      reader.end();
      socket.write(packet(1, 1, 91, 30, 1, bytes('ready')));
    }
    if (tag === 4) socket.end();
  });
  const stream = openTerminalSession({
    socketPath,
    terminalId: 'fixture',
    mode: 'pending',
    cols: 80,
    rows: 24,
  });
  t.after(() => stream.close());
  await stream.ready;
  assert.deepEqual(tags, [0]);
  assert.throws(() => stream.write({ type: 'terminal.input', text: 'not-yet' }));
  const frame = once(stream, 'frame');
  stream.activate(91, 30);
  await frame;
  assert.deepEqual(tags, [0, 3, 8]);
  assert.throws(() => stream.activate(91, 30));
  await stream.close();
});
test('Oversized frames fail before payload allocation', async (t) => {
  const socketPath = await fixture(t, (_reader, socket) => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff);
    socket.write(header);
  });
  const stream = openTerminalSession({
    socketPath,
    terminalId: 'fixture',
    mode: 'observe',
    cols: 80,
    rows: 24,
  });
  await assert.rejects(stream.ready);
  await stream.closed;
});
