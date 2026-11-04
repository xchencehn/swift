// Adapted from devswha/herdr-web-ui at 685293e0a7b912f28b3e19af7e07ae335cfb45e0.
// Copyright (c) 2026 devswha. MIT; see public/vendor/herdr-web-ui/LICENSE.
const { skillInvocationPrompt } = require('./skill-activity.js');
const { trimOutput } = require('./tool-output.js');
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const string = (...values) => values.find((value) => typeof value === 'string');
const resultText = (value) =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value
          .map((part) => (typeof record(part).text === 'string' ? record(part).text : ''))
          .join('')
      : '';
function isContextClear(value, source) {
  const entry = record(value);
  if (source === 'codex-transcript' || source === 'scrollback') return false;
  if (source !== 'claude-transcript')
    return entry.type === 'custom' && entry.customType === 'context_clear';
  const message = record(entry.message);
  if (
    entry.type !== 'user' ||
    entry.isMeta ||
    entry.isCompactSummary ||
    message.role !== 'user' ||
    typeof message.content !== 'string'
  )
    return false;
  return /^\s*<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/.test(
    message.content,
  );
}
function piMessage(value) {
  const entry = record(value);
  const message = record(entry.message);
  if (entry.type !== 'message' || message.display === false || entry.display === false) return null;
  const raw =
    typeof message.content === 'string'
      ? [
          {
            type: 'text',
            text: message.content,
          },
        ]
      : Array.isArray(message.content)
        ? message.content
        : [];
  const content = raw.map((value) => {
    const block = record(value);
    if (block.type === 'toolCall')
      return {
        ...block,
        name: string(block.toolName, block.name),
        id: string(block.toolCallId, block.id, block.callId),
        arguments: block.toolInput ?? block.input ?? block.arguments,
      };
    if (block.type === 'toolResult')
      return {
        ...block,
        toolCallId: string(block.toolCallId, block.callId, block.id),
        content: block.output ?? block.content ?? block.result,
      };
    return block;
  });
  return {
    ...message,
    toolCallId: string(message.toolCallId, message.callId),
    content,
  };
}
function piResults(message) {
  const blocks =
    message.role === 'toolResult'
      ? [message]
      : Array.isArray(message.content)
        ? message.content.filter((block) => record(block).type === 'toolResult')
        : [];
  return blocks.flatMap((value) => {
    const block = record(value);
    if (typeof block.toolCallId !== 'string') return [];
    const images = (Array.isArray(block.content) ? block.content : [])
      .map(piImageOf)
      .filter((image) => image !== null)
      .map((image) => image.media_type);
    return [
      {
        id: block.toolCallId,
        text: resultText(block.content),
        error: block.isError === true,
        images,
      },
    ];
  });
}
const PI_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function piImageOf(value) {
  const image = record(value);
  if (image.type !== 'image') return null;
  const type =
    typeof image.mimeType === 'string'
      ? image.mimeType
      : typeof image.media_type === 'string'
        ? image.media_type
        : null;
  if (type === null || !PI_IMAGE_TYPES.has(type) || typeof image.data !== 'string') return null;
  return {
    media_type: type,
    data: image.data,
  };
}
function piImageBlock(message, toolCallId, index) {
  if (piResults(message).every((result) => result.id !== toolCallId)) return null;
  const blocks =
    message.role === 'toolResult'
      ? [message]
      : (Array.isArray(message.content) ? message.content : []).filter(
          (block) => record(block).type === 'toolResult' && record(block).toolCallId === toolCallId,
        );
  const images = blocks
    .flatMap((value) => {
      const block = record(value);
      return (Array.isArray(block.content) ? block.content : []).map(piImageOf);
    })
    .filter((image) => image !== null);
  return index >= 0 ? (images[index] ?? null) : null;
}
const MAX_TURNS = 100;
function piNotice(value) {
  const entry = record(value);
  if (
    entry.type !== 'custom_message' ||
    entry.display === false ||
    typeof entry.content !== 'string'
  )
    return null;
  const text = entry.content
    .trim()
    .replace(/^<system-notice>\s*/, '')
    .replace(/\s*<\/system-notice>$/, '')
    .trim();
  if (text.length === 0) return null;
  return typeof entry.customType === 'string'
    ? {
        kind: 'notice',
        text,
        source: entry.customType,
      }
    : {
        kind: 'notice',
        text,
      };
}
const OMO_TASK_RESULT_MAX = 16_000;
const label = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
const amount = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function omoTaskTitles(message, titles) {
  if (message.role !== 'toolResult' || message.toolName !== 'task') return;
  const details = record(message.details);
  for (const value of Array.isArray(details.items) ? details.items : [details]) {
    const item = record(value);
    const id = label(item.task_id);
    const title = label(item.task_summary) ?? label(item.description);
    if (id !== null && title !== null) titles.set(id, title);
  }
}
function omoTaskResults(value, titles) {
  const entry = record(value);
  if (
    entry.type !== 'custom_message' ||
    entry.customType !== 'omo-senpi:wake' ||
    !Array.isArray(entry.details)
  )
    return null;
  const tasks = new Map();
  for (const group of entry.details) {
    if (
      record(group).customType !== 'senpi-task.completion' ||
      !Array.isArray(record(group).details)
    )
      continue;
    for (const value of record(group).details) {
      const task = record(value);
      const id = label(task.task_id);
      const raw = label(task.status);
      if (id === null || raw === null) continue;
      const stats = record(task.run_stats);
      const agent = label(task.agent_type) ?? label(task.category) ?? label(task.subagent_type);
      const name = label(task.name);
      const result = label(task.final_response) ?? label(task.error) ?? '';
      tasks.set(id, {
        id,
        title: titles.get(id) ?? (name !== null && name !== id ? name : (agent ?? id)),
        agent,
        model: label(record(task.resolved_model).display) ?? label(task.model),
        status:
          raw === 'completed'
            ? 'completed'
            : raw === 'cancelled' || raw === 'canceled' || raw === 'aborted'
              ? 'cancelled'
              : 'failed',
        duration_ms: amount(task.duration_ms) ?? amount(stats.runtime_ms),
        turns: amount(stats.turns),
        tool_calls: amount(stats.tool_calls),
        tokens: amount(stats.total_tokens) ?? amount(task.tokens),
        result: result.slice(0, OMO_TASK_RESULT_MAX),
        ...(result.length > OMO_TASK_RESULT_MAX
          ? {
              result_cut: true,
            }
          : {}),
      });
    }
  }
  return tasks.size > 0 ? [...tasks.values()] : null;
}
function agentTaskResult(notice, detail) {
  const result = notice.result;
  return {
    id: notice.taskId,
    title: detail?.title ?? /^Agent "(.*)"/.exec(notice.summary)?.[1]?.trim() ?? notice.taskId,
    agent: detail?.agent ?? null,
    model: null,
    status: notice.status,
    duration_ms: null,
    turns: null,
    tool_calls: null,
    tokens: null,
    result: result.slice(0, OMO_TASK_RESULT_MAX),
    ...(result.length > OMO_TASK_RESULT_MAX
      ? {
          result_cut: true,
        }
      : {}),
  };
}
function toolSummary(name, input) {
  if (name === 'task') {
    const items = Array.isArray(input['tasks']) ? input['tasks'].map(record) : [input];
    const titles = items
      .map((item) => label(item['task_summary']) ?? label(item['description']))
      .filter((title) => title !== null);
    if (titles.length > 0) return titles.join(' · ').slice(0, 120);
  }
  const first =
    input['command'] ??
    input['file_path'] ??
    input['notebook_path'] ??
    input['path'] ??
    input['pattern'] ??
    input['description'] ??
    input['url'];
  return typeof first === 'string' ? first.slice(0, 120) : name;
}
function parseOmpTranscript(text, maxTurns = MAX_TURNS, options = {}) {
  const turns = [];
  const pending = new Map();
  const taskTitles = options.taskTitles ?? new Map();
  let settled = false;
  const assistantTurn = (ts) => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === 'assistant' && !settled) return last;
    const turn = {
      role: 'assistant',
      ts: ts ?? null,
      parts: [],
    };
    turns.push(turn);
    return turn;
  };
  const contentParts = (content) =>
    Array.isArray(content)
      ? content.filter((part) => typeof part === 'object' && part !== null)
      : [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    if (isContextClear(entry, 'omp-transcript')) {
      turns.length = 0;
      pending.clear();
      continue;
    }
    const timestamp = entry.timestamp;
    const notice = piNotice(entry);
    if (notice !== null) {
      turns.push({
        role: 'user',
        ts: timestamp ?? null,
        parts: [notice],
      });
      continue;
    }
    const results = omoTaskResults(entry, taskTitles);
    if (results !== null) {
      turns.push({
        role: 'user',
        ts: timestamp ?? null,
        parts: [
          {
            kind: 'task_result',
            tasks: results,
          },
        ],
      });
      continue;
    }
    if (entry.type === 'compaction') {
      const summary = entry.summary;
      if (typeof summary === 'string' && summary.trim().length > 0) {
        turns.push({
          role: 'user',
          ts: timestamp ?? null,
          parts: [
            {
              kind: 'compact',
              text: summary,
            },
          ],
        });
      }
      continue;
    }
    const message = piMessage(entry);
    if (message === null) continue;
    const applyResults = () => {
      for (const result of piResults(message)) {
        const tool = pending.get(result.id);
        if (!tool) continue;
        pending.delete(result.id);
        trimOutput(tool, result.text, result.id, options.toolTextLimit);
        if (result.error) tool.error = true;
        if (options.toolImages === true && result.images.length > 0) {
          tool.images = result.images.map((media_type, index) => ({
            media_type,
            ref: `pi:${result.id}:${index}`,
          }));
        }
      }
    };
    if (message.role !== 'assistant') applyResults();
    omoTaskTitles(message, taskTitles);
    if (message.role === 'user') {
      const prompt =
        typeof message.content === 'string'
          ? message.content
          : contentParts(message.content)
              .map((part) =>
                part.type === 'text' && typeof part.text === 'string' ? part.text : '',
              )
              .filter((part) => part.length > 0)
              .join('\n');
      if (prompt.length === 0) continue;
      const invocation = skillInvocationPrompt(prompt);
      const asked =
        invocation === null
          ? prompt
          : invocation.request ||
            invocation.skills.map((skill) => `/skill:${skill.name}`).join(' ');
      turns.push({
        role: 'user',
        ts: timestamp ?? null,
        parts: [
          {
            kind: 'text',
            text: asked,
          },
          ...(invocation?.skills ?? []).map((skill) => ({
            kind: 'skill',
            skill,
          })),
        ],
      });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const turn = assistantTurn(timestamp);
      if (timestamp) turn.end_ts = timestamp;
      for (const block of message.content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          turn.parts.push({
            kind: 'text',
            text: b.text,
          });
        } else if (b.type === 'thinking') {
          const thinking =
            typeof b.thinking === 'string' ? b.thinking : typeof b.text === 'string' ? b.text : '';
          if (thinking.length > 0)
            turn.parts.push({
              kind: 'thinking',
              text: thinking,
            });
        } else if (b.type === 'toolCall' && typeof b.name === 'string') {
          const input = typeof b.arguments === 'object' && b.arguments !== null ? b.arguments : {};
          const summary =
            typeof b.intent === 'string' && b.intent.length > 0
              ? b.intent
              : toolSummary(b.name, input);
          const part = {
            kind: 'tool',
            name: b.name,
            id: b.id,
            summary: summary.slice(0, 120),
            input: JSON.stringify(input, null, 2),
            output: '',
          };
          turn.parts.push(part);
          if (typeof b.id === 'string') pending.set(b.id, part);
        }
      }
      applyResults();
      if (
        message.stopReason === 'error' &&
        typeof message.errorMessage === 'string' &&
        message.errorMessage.length > 0
      ) {
        turn.parts.push({
          kind: 'text',
          text: `Error: ${message.errorMessage}`,
        });
      }
      settled = message.stopReason === 'stop';
    }
  }
  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

module.exports = {
  record,
  resultText,
  isContextClear,
  piMessage,
  piResults,
  piImageBlock,
  MAX_TURNS,
  piNotice,
  omoTaskTitles,
  omoTaskResults,
  agentTaskResult,
  toolSummary,
  parseOmpTranscript,
};
