'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { apiError } = require('./message-queue');
const { imageBlock, readImage } = require('./chat-images');
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;
const slots = new Set(['avatar', 'welcome']);
function readProfile(data) {
  return { name: '用户', avatar: null, welcome: null, revision: 0, ...data.config.profile };
}
function saveProfile(data, patch) {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).some((key) => key !== 'name' && !slots.has(key))
  )
    throw apiError(400, 'INVALID_PROFILE', '个人资料无效。');
  const next = {};
  if ('name' in patch) {
    if (
      typeof patch.name !== 'string' ||
      !patch.name.trim() ||
      patch.name.trim().length > 80 ||
      /[\x00-\x1f\x7f]/.test(patch.name)
    )
      throw apiError(400, 'INVALID_PROFILE_NAME', '用户名需要为 1–80 个字符。');
    next.name = patch.name.trim();
  }
  for (const slot of slots)
    if (slot in patch) {
      if (patch[slot] !== null)
        throw apiError(400, 'INVALID_PROFILE_IMAGE', '请通过上传选择图片。');
      next[slot] = null;
    }
  return commit(data, next);
}
function commit(data, patch) {
  const current = readProfile(data);
  const profile = { ...current, ...patch, revision: current.revision + 1 };
  data.saveConfig({ profile });
  return profile;
}
async function saveProfileImage(data, slot, request) {
  if (!slots.has(slot)) throw apiError(400, 'INVALID_PROFILE_IMAGE', '图片用途无效。');
  const tooLarge = () => apiError(413, 'PROFILE_IMAGE_TOO_LARGE', '图片不能超过 5 MiB。');
  if (Number(request.headers['content-length']) > MAX_PROFILE_IMAGE_BYTES) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PROFILE_IMAGE_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const mime = String(request.headers['content-type'] || '').split(';')[0];
  const block = imageBlock(`data:${mime};base64,${bytes.toString('base64')}`);
  if (!block) throw apiError(415, 'INVALID_PROFILE_IMAGE', '请选择 PNG、JPEG、GIF 或 WebP 图片。');
  const id = crypto.createHash('sha256').update(bytes).digest('hex');
  data.ensureDirectory(path.join(data.path, 'attachments/profile'));
  const file = data.file(`attachments/profile/${id}`);
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return commit(data, { [slot]: { id, mime: block.source.mime } });
}
async function readProfileImage(data, slot, id) {
  if (!slots.has(slot) || !/^[a-f0-9]{64}$/.test(id || ''))
    throw apiError(404, 'PROFILE_IMAGE_MISSING', '找不到图片。');
  const entry = readProfile(data)[slot];
  if (!entry || entry.id !== id)
    throw apiError(404, 'PROFILE_IMAGE_MISSING', '图片已改变，请刷新。');
  return readImage(
    new Map([[id, { path: data.file(`attachments/profile/${id}`), mime: entry.mime }]]),
    id,
  );
}
module.exports = {
  readProfile,
  saveProfile,
  saveProfileImage,
  readProfileImage,
  MAX_PROFILE_IMAGE_BYTES,
};
