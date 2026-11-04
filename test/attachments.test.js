'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { saveAttachment, LIMIT } = require('../lib/attachments');
test('附件按原始字节保存，同名不覆盖，文件名不能越过上传目录，失败清理临时文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-attachment-'));
  process.env.AGENT_STUDIO_ATTACHMENTS_DIR = root;
  t.after(async () => {
    delete process.env.AGENT_STUDIO_ATTACHMENTS_DIR;
    await fs.rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from([0, 255, 1, 128, 10]);
  const first = await saveAttachment(
    Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
    '../../测试.png',
  );
  const second = await saveAttachment(Readable.from([bytes]), '../../测试.png');
  assert.equal(first.name, '测试.png');
  assert.notEqual(first.path, second.path);
  assert.ok(first.path.startsWith(root + '/'));
  assert.deepEqual(await fs.readFile(first.path), bytes);
  assert.equal((await fs.stat(first.path)).mode & 0o777, 0o600);
  const stream = Readable.from([Buffer.alloc(LIMIT), Buffer.from('x')]);
  await assert.rejects(saveAttachment(stream, 'too-large.bin'), { status: 413 });
  await assert.rejects(
    saveAttachment(
      Readable.from(
        (async function* () {
          yield bytes;
          throw new Error('aborted');
        })(),
      ),
      'aborted.bin',
    ),
    /aborted/,
  );
  assert.equal((await fs.readdir(root)).length, 2);
});

test('upload through a configured storage alias returns a canonical path without changing name or bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-alias-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, 'real'),
    alias = path.join(root, 'alias');
  await fs.mkdir(real);
  await fs.symlink(real, alias);
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4hoAAAAASUVORK5CYII=',
    'base64',
  );
  const attachment = await saveAttachment(Readable.from([bytes]), 'mmexport.jpg', alias);
  assert.equal(attachment.name, 'mmexport.jpg');
  assert.equal(attachment.path, await fs.realpath(attachment.path));
  assert(attachment.path.startsWith(real + path.sep));
  assert.deepEqual(await fs.readFile(attachment.path), bytes);
});

test('terminal clipboard upload validates runtime, terminal and Agent session while supporting bound Shell panes', async () => {
  const { Router } = require('../lib/http/router');
  const state = {
      runtimeId: 'native-runtime',
      panes: [{ paneId: 'p1', terminalId: 't1', agent: null }],
    },
    saved = [],
    sent = [];
  const router = new Router({
    json: (res, status, body) => sent.push({ status, body }),
    sendError: (res, error) => sent.push({ error: error.code }),
  });
  require('../lib/http/routes/messages').register(router, {
    herdr: { dashboard: async () => state },
    exactPane: async () => state.panes[0],
    apiError: (status, code, message) => Object.assign(new Error(message), { status, code }),
    json: (res, status, body) => sent.push({ status, body }),
    currentRoot: () => ({ data: { path: '/isolated-root' } }),
    saveAttachment: async (req, name, directory) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      saved.push({ name, directory, data: Buffer.concat(chunks) });
      return { path: '/isolated-root/attachments/image.png' };
    },
  });
  const upload = async (query) => {
    const req = Readable.from([Buffer.from([0, 255, 1])]);
    req.method = 'POST';
    await router.dispatch(
      req,
      {},
      new URL('http://fixture/api/attachments?pane=p1&name=image.png&' + query),
    );
    return sent.at(-1);
  };
  assert.equal((await upload('sessionId=')).error, 'SESSION_UNAVAILABLE');
  assert.equal((await upload('terminalId=t1&runtimeId=wrong')).error, 'TERMINAL_CHANGED');
  assert.equal(
    (await upload('terminalId=wrong&runtimeId=native-runtime')).error,
    'TERMINAL_CHANGED',
  );
  assert.equal((await upload('terminalId=t1&runtimeId=native-runtime')).status, 201);
  assert.deepEqual(saved[0].data, Buffer.from([0, 255, 1]));
  assert.equal(saved[0].directory, '/isolated-root/attachments');
  state.panes[0].agent = { session: { value: 's1' } };
  assert.equal(
    (await upload('terminalId=t1&runtimeId=native-runtime&sessionId=old')).error,
    'SESSION_CHANGED',
  );
  assert.equal((await upload('terminalId=t1&runtimeId=native-runtime&sessionId=s1')).status, 201);
  assert.equal((await upload('sessionId=s1')).status, 201);
  assert.equal(saved.length, 3);
});
