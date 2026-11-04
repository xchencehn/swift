'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const LIMIT = 20 * 1024 * 1024;
const root = () =>
  (process.env.SWIFT_ATTACHMENTS_DIR ?? process.env.AGENT_STUDIO_ATTACHMENTS_DIR) ||
  path.join(__dirname, '../.local/data/attachments');
const tooLarge = () =>
  Object.assign(new Error('单个附件不能超过 20 MiB。'), {
    status: 413,
    code: 'ATTACHMENT_TOO_LARGE',
  });
async function saveAttachment(stream, name, directory = root()) {
  if (Number(stream.headers?.['content-length']) > LIMIT) throw tooLarge();
  const safeName = path
    .basename(String(name || '附件').replace(/\\/g, '/'))
    .replace(/[\x00-\x1f\x7f]/g, '_')
    .slice(0, 160);
  if (!safeName || ['.', '..'].includes(safeName))
    throw Object.assign(new Error('附件名称无效。'), { status: 400 });
  const id = crypto.randomUUID();
  const dir = path.join(directory, id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, safeName);
  let handle,
    size = 0;
  try {
    handle = await fs.open(file, 'wx', 0o600);
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > LIMIT) throw tooLarge();
      await handle.writeFile(chunk);
    }
    await handle.close();
    handle = null;
    return { id, name: safeName, path: await fs.realpath(file), size };
  } catch (error) {
    await handle?.close();
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}
module.exports = { saveAttachment, LIMIT };
