'use strict';

// 存档（JSONL）的一行只解析一次。
//
// 读一份存档要经过好几道：有效历史筛选、正文解析、归档索引、会话状态、设置、提问、目标……
// 原来每一道各自 JSON.parse 每一行，一个 78MB 的存档要解析六七遍，读一次近两秒，而且是同步的，
// 期间服务端对谁都不响应（2026-09-24 实测）。
//
// 存档缓存（lib/conversation-store.js）读到完整的新行时登记进来，留住文件期间一直有效，
// 丢掉文件时注销；各处的 parseLine 先查登记表，查不到才自己解析（不登记，免得无界增长）。
// ⚠️ 共用的前提是解析出的对象**只读**：解析器只改自己新建的对象（块、消息），从不改写存档条目。

const crypto = require('node:crypto');

const parsed = new Map();
const ids = new Map();

/** 解析一行。格式不对照样抛错，由调用方处理。 */
function parseLine(raw) {
  const hit = parsed.get(raw);
  return hit !== undefined ? hit : JSON.parse(raw);
}

/** 按原文算的稳定标识（Codex 的记录没有自己的 id）。登记过的行只算一次。 */
function lineId(raw) {
  let id = ids.get(raw);
  if (id === undefined) {
    id = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
    if (parsed.has(raw)) ids.set(raw, id);
  }
  return id;
}

/** 登记新读到的完整行；解析失败的行不登记。 */
function register(lines) {
  for (const raw of lines) {
    if (parsed.has(raw)) continue;
    try {
      parsed.set(raw, JSON.parse(raw));
    } catch {}
  }
}

/** 注销一个文件的行。别的文件也有同样一行时，它只是下次重新解析，结果不受影响。 */
function release(lines) {
  for (const raw of lines) {
    parsed.delete(raw);
    ids.delete(raw);
  }
}

module.exports = { parseLine, lineId, register, release };
