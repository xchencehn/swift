'use strict';

// Codex rust-v0.163.0, commit 83086188ae0614bd882818ff1aa23f3194962012.
// Sources: tui/src/chatwidget/user_messages.rs:702-850,
// tui/src/history_cell/messages.rs:24-69,154-162, and source/*.rs beside this file.
// This reducer accepts the core and v2 UserInput wire shapes. It never classifies
// review prompts from their text; the caller applies review marker visibility.

const WHITE_SPACE_START = /^\p{White_Space}+/u;
const WHITE_SPACE_END = /\p{White_Space}+$/u;
const REQUEST_HEADING = '## My request for Codex:';
const REPLY_BEGIN = '<send_user_message_question_reply>';
const REPLY_END = '</send_user_message_question_reply>';
const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const rustTrimStart = (text) => text.replace(WHITE_SPACE_START, '');
const rustTrim = (text) => rustTrimStart(text).replace(WHITE_SPACE_END, '');

function sanitizeUserText(text) {
  let result = '';
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index);
    const char = String.fromCodePoint(code);
    index += char.length;
    if (code === 0x1b) {
      if (text[index] === '[') {
        index += 1;
        while (index < text.length) {
          const end = text.codePointAt(index);
          index += end > 0xffff ? 2 : 1;
          if (end >= 0x40 && end <= 0x7e) break;
        }
      }
      continue;
    }
    if ((code <= 0x1f || (code >= 0x7f && code <= 0x9f)) && code !== 0x09 && code !== 0x0a)
      continue;
    result += char;
  }
  return result;
}

function utf8Boundaries(text) {
  const result = new Map([[0, 0]]);
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    bytes += byteLength(char);
    index += char.length;
    result.set(bytes, index);
  }
  return result;
}

function byteSlice(text, start, end, boundaries = utf8Boundaries(text)) {
  if (start > end || !boundaries.has(start) || !boundaries.has(end)) return null;
  return text.slice(boundaries.get(start), boundaries.get(end));
}

function parseTaskLink(text, start, boundaries) {
  const rest = byteSlice(text, start, byteLength(text), boundaries);
  if (rest === null || !rest.startsWith('[@')) return null;
  const remaining = rest.slice(2);
  const chars = Array.from(remaining);
  let title = '';
  let index = 0;
  let consumed = 0;
  for (let step = 0; step <= 160; step += 1) {
    const char = chars[index++];
    if (char === undefined) return null;
    const charStart = consumed;
    consumed += char.length;
    if (char === '\\') {
      const escaped = chars[index++];
      if (escaped === undefined) return null;
      title += escaped;
      consumed += escaped.length;
    } else if (char === ']') {
      if (!title) return null;
      const suffix = remaining.slice(consumed);
      if (!suffix.startsWith('(')) return null;
      const close = suffix.indexOf(')');
      if (close === -1) return null;
      const path = suffix.slice(1, close);
      if (!/^thread:\/\/[A-Za-z0-9_-]{1,64}$/.test(path)) return null;
      return {
        title,
        end: start + byteLength(remaining.slice(0, charStart)) + byteLength(path) + 5,
      };
    } else {
      title += char;
    }
  }
  return null;
}

function decodeTaskLinks(text, elements) {
  if (!text.includes('thread://')) return { message: text, textElements: elements };
  const boundaries = utf8Boundaries(text);
  let decoded = '';
  let offset = 0;
  const decodedElements = [];
  for (const element of elements) {
    const { start, end } = element.byteRange;
    const prefix = byteSlice(text, offset, start, boundaries);
    const value = byteSlice(text, start, end, boundaries);
    if (prefix === null || value === null) continue;
    decoded += prefix;
    const decodedStart = byteLength(decoded);
    const link = parseTaskLink(text, start, boundaries);
    const placeholder = element.placeholder ?? value;
    decoded +=
      link && link.end === end && placeholder.startsWith('@') && placeholder.slice(1) === link.title
        ? '@' + link.title
        : value;
    decodedElements.push({
      ...element,
      byteRange: { start: decodedStart, end: byteLength(decoded) },
    });
    offset = end;
  }
  decoded += byteSlice(text, offset, byteLength(text), boundaries);
  return { message: decoded, textElements: decodedElements };
}

// Serde rejects duplicate struct keys. Preserve exact envelopes with such JSON
// as incomplete instead of silently adopting JSON.parse's last-key semantics.
function duplicateJsonKeys(json) {
  let index = 0;
  let duplicate = false;
  const space = () => {
    while (/\s/.test(json[index] || '') && index < json.length) index += 1;
  };
  const string = () => {
    const start = index++;
    while (index < json.length) {
      const char = json[index++];
      if (char === '\\') index += 1;
      else if (char === '"') return JSON.parse(json.slice(start, index));
    }
    return '';
  };
  const value = (depth = 0) => {
    if (depth > 128) throw new Error('Unsupported async reply JSON nesting.');
    space();
    if (json[index] === '{') {
      index += 1;
      const keys = new Set();
      space();
      if (json[index] === '}') {
        index += 1;
        return;
      }
      while (index < json.length) {
        space();
        const key = string();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        space();
        index += 1;
        value(depth + 1);
        space();
        if (json[index++] === '}') return;
      }
    } else if (json[index] === '[') {
      index += 1;
      space();
      if (json[index] === ']') {
        index += 1;
        return;
      }
      while (index < json.length) {
        value(depth + 1);
        space();
        if (json[index++] === ']') return;
      }
    } else if (json[index] === '"') string();
    else while (index < json.length && !/[\s,}\]]/.test(json[index])) index += 1;
  };
  value();
  return duplicate;
}

function asyncReply(text) {
  let value = rustTrim(text);
  if (value.startsWith('# Context from my IDE setup:\n')) {
    const delimiter = '\n## My request for Codex:\n';
    const index = value.lastIndexOf(delimiter);
    if (index === -1) return null;
    value = rustTrim(value.slice(index + delimiter.length));
  }
  if (!value.startsWith(REPLY_BEGIN) || !value.endsWith(REPLY_END)) return null;
  const json = value.slice(REPLY_BEGIN.length, -REPLY_END.length);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const replies = Array.isArray(parsed) ? parsed : [parsed];
  if (
    !replies.length ||
    replies.some(
      (reply) =>
        !reply ||
        Array.isArray(reply) ||
        typeof reply.questionItemId !== 'string' ||
        typeof reply.question !== 'string' ||
        typeof reply.answer !== 'string',
    )
  )
    return null;
  try {
    if (duplicateJsonKeys(json))
      return { incomplete: true, issue: 'Async reply contains duplicate JSON keys.' };
  } catch {
    return { incomplete: true, issue: 'Async reply JSON exceeds supported nesting.' };
  }
  return { message: replies.map((reply) => `> ${reply.question}\n\n${reply.answer}`).join('\n\n') };
}

function extractPromptRequest(message) {
  const index = message.lastIndexOf(REQUEST_HEADING);
  if (index === -1) return { message, offset: 0 };
  const start = index + REQUEST_HEADING.length;
  const remainder = message.slice(start);
  const leading = remainder.length - rustTrimStart(remainder).length;
  return { message: rustTrim(remainder), offset: byteLength(message.slice(0, start + leading)) };
}

function userInputDisplay(content) {
  const issues = [];
  let message = '';
  let textElements = [];
  const localImages = [];
  const remoteImageUrls = [];
  if (!Array.isArray(content)) {
    content = [];
    issues.push('UserInput content must be an array.');
  }
  for (const input of content) {
    if (!input || typeof input !== 'object') {
      issues.push('UserInput must be an object.');
      continue;
    }
    switch (input.type) {
      case 'text': {
        if (typeof input.text !== 'string') {
          issues.push('Text UserInput requires a string.');
          break;
        }
        const offset = byteLength(message);
        const boundaries = utf8Boundaries(input.text);
        const elements = Object.hasOwn(input, 'text_elements')
          ? input.text_elements
          : Object.hasOwn(input, 'textElements')
            ? input.textElements
            : [];
        if (!Array.isArray(elements)) issues.push('Text elements must be an array.');
        else
          for (const element of elements) {
            const range = element?.byteRange ?? element?.byte_range;
            if (
              !range ||
              !Number.isSafeInteger(range.start) ||
              !Number.isSafeInteger(range.end) ||
              range.start < 0 ||
              range.end < 0 ||
              (element.placeholder != null && typeof element.placeholder !== 'string')
            ) {
              issues.push('Text element has an unsupported byte range or placeholder.');
              continue;
            }
            textElements.push({
              byteRange: { start: offset + range.start, end: offset + range.end },
              placeholder:
                element.placeholder ?? byteSlice(input.text, range.start, range.end, boundaries),
            });
          }
        message += input.text;
        break;
      }
      case 'image':
        if (typeof input.url === 'string') remoteImageUrls.push(input.url);
        else if (typeof input.image_url === 'string') remoteImageUrls.push(input.image_url);
        else if (typeof input.fileId !== 'string' && typeof input.file_id !== 'string')
          issues.push('Image UserInput requires an inline URL or file ID.');
        break;
      case 'localImage':
      case 'local_image':
        if (typeof input.path === 'string') localImages.push(input.path);
        else issues.push('Local image UserInput requires a path.');
        break;
      case 'audio':
      case 'localAudio':
      case 'local_audio':
      case 'skill':
      case 'mention':
        break;
      default:
        issues.push('Unsupported UserInput type: ' + String(input.type));
    }
  }
  ({ message, textElements } = decodeTaskLinks(message, textElements));
  const reply = asyncReply(message);
  const request = extractPromptRequest(message);
  const displayReply = reply ?? asyncReply(request.message);
  if (displayReply?.incomplete) issues.push(displayReply.issue);
  if (displayReply && !displayReply.incomplete) {
    message = displayReply.message;
    textElements = [];
  } else {
    message = request.message;
    const end = request.offset + byteLength(message);
    textElements = textElements
      .filter(
        (element) => element.byteRange.start >= request.offset && element.byteRange.end <= end,
      )
      .map((element) => ({
        ...element,
        byteRange: {
          start: element.byteRange.start - request.offset,
          end: element.byteRange.end - request.offset,
        },
      }));
  }
  const visible =
    rustTrim(sanitizeUserText(message)).length > 0 ||
    textElements.length > 0 ||
    localImages.length > 0 ||
    remoteImageUrls.length > 0;
  return {
    message,
    textElements,
    localImages,
    remoteImageUrls,
    visible,
    complete: issues.length === 0,
    issues: issues.map((detail) => ({ code: 'UNSUPPORTED_USER_DISPLAY', detail })),
  };
}

module.exports = { userInputDisplay, sanitizeUserText, rustTrim };
