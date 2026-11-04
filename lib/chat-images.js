'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { fileURLToPath } = require('node:url');
const { apiError } = require('./message-queue');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const mimeTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  return null;
}
function dimensions(bytes) {
  let width, height;
  if (imageMime(bytes) === 'image/png' && bytes.length >= 24) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  }
  if (imageMime(bytes) === 'image/gif' && bytes.length >= 10) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  }
  if (imageMime(bytes) === 'image/jpeg') {
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i] !== 255) break;
      const marker = bytes[i + 1];
      if (marker === 255) {
        i++;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break;
      const size = bytes.readUInt16BE(i + 2);
      if (size < 2) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        height = bytes.readUInt16BE(i + 5);
        width = bytes.readUInt16BE(i + 7);
        break;
      }
      i += size + 2;
    }
  }
  return width > 0 && height > 0 && width <= 32768 && height <= 32768 ? { width, height } : {};
}
function imageBlock(url, alt = '图片') {
  if (typeof url !== 'string') return null;
  let source,
    geometry = {};
  const data = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (data) {
    if (data[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return null;
    const header = Buffer.from(data[2].slice(0, 256 * 1024), 'base64');
    if (imageMime(header) !== data[1]) return null;
    source = { data: data[2], mime: data[1] };
    geometry = dimensions(header);
  } else {
    let file = url;
    try {
      if (file.startsWith('file:')) file = fileURLToPath(file);
    } catch {
      return null;
    }
    if (file.startsWith('sandbox:/')) file = file.slice('sandbox:'.length);
    if (
      !path.isAbsolute(file) ||
      /[\0\r\n]/.test(file) ||
      !mimeTypes[path.extname(file).toLowerCase()]
    )
      return null;
    source = { path: path.normalize(file), mime: mimeTypes[path.extname(file).toLowerCase()] };
  }
  const block = {
    kind: 'image',
    id: hash(source.path || url),
    alt: String(alt || '图片').slice(0, 160),
    ...geometry,
  };
  // Raw image bytes/paths are private server state, never transcript JSON.
  Object.defineProperty(block, 'source', { value: source });
  return block;
}
function contentImages(content) {
  const found = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (!item || !['input_image', 'output_image', 'image', 'image_url'].includes(item.type))
      continue;
    const url =
      item.source?.type === 'base64'
        ? `data:${item.source.media_type};base64,${item.source.data}`
        : item.image_url?.url || item.image_url || item.source?.url || item.url;
    const block = imageBlock(url, item.alt || '图片');
    if (block && !found.some((existing) => existing.id === block.id)) found.push(block);
  }
  return found;
}
function toolOutput(content) {
  if (!Array.isArray(content)) return content;
  return content.map((item) =>
    ['input_image', 'output_image', 'image', 'image_url'].includes(item?.type)
      ? { type: 'image', text: '（一张图片，由 Agent 自己查看，不在聊天流中显示）' }
      : item,
  );
}
function textImages(text) {
  const blocks = [];
  // Only explicit image links and attachment records are file references. Code
  // fences and inline code stay literal; arbitrary mentioned paths are not read.
  const pattern =
    /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|!?\[([^\]\n]*)\]\((<[^>\n]+>|[^\s()]+)\)|附件：([^\n]+)\n文件路径：["“]([^"”\n]+)["”]/g;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) continue;
    const url = match[5] || match[3]?.replace(/^<|>$/g, '');
    const block = imageBlock(url, match[4] || match[2] || '图片');
    if (!block) continue;
    if (match.index > from) blocks.push({ kind: 'text', text: text.slice(from, match.index) });
    blocks.push(block);
    from = match.index + match[0].length;
  }
  if (from < text.length) blocks.push({ kind: 'text', text: text.slice(from) });
  return blocks;
}
function imageSources(messages) {
  return new Map(
    messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.kind === 'image' && block.source)
      .map((block) => [block.id, block.source]),
  );
}
async function readImage(sources, id, { attachmentsDirectory } = {}) {
  const source = sources.get(id);
  if (!source) throw apiError(404, 'IMAGE_NOT_IN_SESSION', '找不到这张会话图片。');
  let bytes, handle;
  try {
    if (source.data) bytes = Buffer.from(source.data, 'base64');
    else {
      // The configured storage root can be an administrator-managed alias.
      // Only resolve that root; every component below it must remain unchanged.
      const canonical = await fs.realpath(source.path);
      if (canonical !== source.path) {
        const root = attachmentsDirectory && path.resolve(attachmentsDirectory);
        const relative = root && path.relative(root, source.path);
        if (
          !relative ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          canonical !== path.join(await fs.realpath(root), relative)
        )
          throw apiError(400, 'INVALID_IMAGE_PATH', '图片路径已改变。');
      }
      handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
        throw apiError(413, 'IMAGE_TOO_LARGE', '图片超出预览限制。');
      bytes = await handle.readFile();
    }
    const mime = imageMime(bytes);
    if (bytes.length > MAX_IMAGE_BYTES || !mime || (source.data && mime !== source.mime))
      throw apiError(415, 'INVALID_IMAGE', '文件不是支持的图片格式。');
    return { bytes, mime, etag: `"${hash(bytes)}"` };
  } catch (error) {
    if (error.code === 'ENOENT') throw apiError(404, 'IMAGE_MISSING', '图片已删除或移动。');
    throw error;
  } finally {
    await handle?.close();
  }
}
module.exports = {
  imageBlock,
  contentImages,
  textImages,
  toolOutput,
  imageSources,
  readImage,
  MAX_IMAGE_BYTES,
};
