'use strict';
// 两家提问模块共用的小工具。各家的解析与作答分别在 claude.js、codex.js（2026-09-25 拆开：
// 两家的提问机制完全不同，混在一起写，一家的格式一变另一家的判断就跟着出错）。
const crypto = require('node:crypto');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const compact = (text) => String(text || '').replace(/\s+/g, '');
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 答案的基本校验：两家同一套。返回规整后的 { choices, custom }。 */
function validateAnswer(prompt, payload) {
  const choices = payload.choices;
  const custom = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (custom && prompt.allowText === false) throw fail('请从当前选项中选择。', 400);
  if (
    !Array.isArray(choices) ||
    choices.some((i) => !Number.isInteger(i) || i < 0 || i >= (prompt.options || []).length) ||
    new Set(choices).size !== choices.length ||
    custom.length > 8000 ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(custom)
  )
    throw fail('答案格式不正确。', 400);
  if (custom && choices.length) throw fail('请选择选项或填写其他答案。', 400);
  if (!custom && (!choices.length || (!prompt.multiSelect && choices.length !== 1)))
    throw fail('请选择答案。', 400);
  return { choices, custom };
}

/** 从 from 移到 to 要按的方向键。 */
const moves = (from, to) => Array(Math.abs(to - from)).fill(to > from ? 'down' : 'up');

module.exports = { fail, compact, digest, pause, validateAnswer, moves };
