'use strict';
const { parseLine } = require('./json-lines');

// 把 Claude Code 与 Codex 的会话存档解析成同一种消息模型，供聊天视图渲染。
//
// 这两份 jsonl 是 agent 自己的内部存档，**没有兼容性承诺**，agent 升级就可能改结构。
// 所以解析一律"认识才取，不认识就跳过"，绝不因为多出一种块类型而整条崩掉。
//
// ⚠️ 两边的字段名差别很容易踩空:Claude 的文本块是 `text`，Codex 的是 `input_text` /
// `output_text`。拿手写的假数据做单测会全绿，而线上永远解析不出东西 —— fixture 必须
// 从真实存档脱敏而来，保留字段名和块类型。

const path = require('path');
const os = require('os');
const fs = require('fs');
const { effectiveLines, stableId } = require('./conversation-state');
const { ToolLifecycle } = require('./tool-lifecycle');
const { outputPreview } = require('../public/chat/tool-presentation');
const { imageBlock, contentImages, textImages, toolOutput } = require('./chat-images');

// 工具的入参和结果动辄几十 KB(读文件、跑测试的输出)，整条推给手机不现实。
// 对话正文不截断，工具内容截断并标记，展开时再按需取。
const TOOL_TEXT_LIMIT = 2000;
const THINKING_LIMIT = 4000;

function clip(value, limit) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value ?? '', null, 1) ?? '');
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true, fullLength: text.length };
}

function textBlock(kind, value, limit) {
  const { text, truncated, fullLength } = clip(value, limit ?? Infinity);
  if (!text) return null;
  return truncated ? { kind, text, truncated: true, fullLength } : { kind, text };
}

// ---------------------------------------------------------------- Claude Code

// Claude 把工具结果放在**后续的 user 消息**里(`tool_result` 块)。直接按 role 渲染
// 会把 203 条工具回传显示成"用户说的话",所以要按 tool_use_id 回填到对应的工具块上。
/** recap 末尾那句「(disable recaps in /config)」是给操作者的开关提示,不是总结内容。 */
function stripRecapHint(text) {
  return text.replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
}

function createClaudeTranscriptParser({
  toolTextLimit = TOOL_TEXT_LIMIT,
  state,
  toolImages = true,
} = {}) {
  const messages = state?.messages || [];
  const toolIndex = state?.toolIndex || new Map();
  const background = state?.background || new Map();
  const owners = new WeakMap(),
    dirty = new Set(),
    positions = new WeakMap(messages.map((message, index) => [message, index]));
  for (const message of messages)
    for (const block of message.blocks) if (block.kind === 'tool') owners.set(block, message);
  const touch = (tool) => {
    const owner = tool && owners.get(tool);
    if (owner) dirty.add(owner);
  };
  let emitted = messages.length;
  // Records injected by the resume mechanism, plus whatever replies to them.
  const synthetic = state?.synthetic || new Set();
  function write(lines) {
    for (const raw of lines) {
      let entry;
      try {
        entry = parseLine(raw);
      } catch {
        continue;
      }
      const type = entry?.type;
      // Claude 2.1.258 把本轮吸收的补充消息记录为 queued_command 附件，
      // 不会再写普通 user 行。保留它在存档里的消费位置，供聊天流和队列共同确认。
      // enqueue/remove 只表示原生队列变化，不能单独作为用户消息已消费的凭据。
      if (type === 'attachment') {
        const attachment = entry.attachment;
        if (
          attachment?.type === 'queued_command' &&
          attachment.origin?.kind === 'human' &&
          attachment.commandMode === 'prompt' &&
          typeof attachment.prompt === 'string' &&
          attachment.prompt.trim()
        ) {
          messages.push({
            id: entry.uuid || attachment.source_uuid || `queued-${messages.length}`,
            role: 'user',
            ts: attachment.timestamp || entry.timestamp || null,
            blocks: [{ kind: 'text', text: unwrapPastedContent(attachment.prompt) }],
          });
        }
        continue;
      }
      // ⚠️ `turn_duration` 不进聊天流。终端里「用了多久、什么时候完的」只是完成那
      // 一瞬的状态行,随下一轮消失,**对话正文里并不留下这么一条**。我们曾按这条记录
      // 合成一条常驻消息,等于凭空多出终端没有的东西;耗时要看,看活动行。
      if (type === 'system' && entry.subtype === 'turn_duration') continue;
      // 收尾总结(recap):Claude 在一轮结束时写的那段「这次做了什么、下一步是什么」。
      // 它不是普通对话消息 —— type 是 system、subtype 是 away_summary,正文在**顶层**
      // content 而不是 message.content。按 user/assistant 过滤会把它整条漏掉,
      // 而它恰恰是终端上看得见、聊天流里最该有的一段。
      if (type === 'system' && entry.subtype === 'away_summary') {
        const text = stripRecapHint(String(entry.content || ''));
        if (text) {
          messages.push({
            id: entry.uuid || `recap-${messages.length}`,
            role: 'assistant',
            kind: 'recap',
            ts: entry.timestamp || null,
            blocks: [{ kind: 'text', text }],
          });
        }
        continue;
      }
      // 供应商侧的错误（限流、过载、请求失败）在存档里是一条 assistant 记录，
      // 标着 isApiErrorMessage 和 apiErrorStatus。它不是 Agent 说的话：混在
      // 普通回答里看不出这是一次失败，用户会以为模型真的这么回答了。
      if (type === 'assistant' && entry.isApiErrorMessage) {
        const raw = entry.message?.content;
        const text =
          typeof raw === 'string'
            ? raw
            : (raw || [])
                .filter((block) => block?.type === 'text')
                .map((block) => block.text || '')
                .join('\n');
        if (text.trim()) {
          messages.push({
            id: entry.uuid || `api-error-${messages.length}`,
            role: 'assistant',
            kind: 'error',
            status: entry.apiErrorStatus ?? null,
            ts: entry.timestamp || null,
            blocks: [{ kind: 'text', text: text.trim() }],
          });
        }
        continue;
      }
      if (type !== 'user' && type !== 'assistant') continue;
      // 恢复一个被打断的会话时，Claude 会向存档注入一条合成的
      // 「Continue from where you left off.」用户消息，标着 isMeta。用户没有
      // 说过这句话，显示出来就是凭空多一轮对话。队列、历史和会话身份模块
      // 早就在过滤 isMeta，展示这一路之前漏了。
      //
      // 它的回复本身没有标记，只能靠存档自己的父子链认出来：回应一条被隐藏的
      // 合成提示的消息，同样属于恢复机制的内部记录。不按正文措辞判断。
      // 只隐藏合成提示本身和直接回应它的那一条。再往后就是真实对话了，
      // 让隐藏顺着父子链一路传下去会把恢复之后的全部内容一起吃掉。
      if (entry.isMeta) {
        if (entry.uuid) synthetic.add(entry.uuid);
        continue;
      }
      if (entry.parentUuid && synthetic.has(entry.parentUuid)) continue;
      const message = entry.message;
      if (!message || typeof message !== 'object') continue;
      if (type === 'user') {
        const text =
          typeof message.content === 'string'
            ? message.content
            : (message.content || [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text || '')
                .join('\n');
        // Native settings interactions are controls, not user chat messages.
        if (
          /^<command-name>\/(?:model|effort)<\/command-name>\s*(?:<command-message>[^<]*<\/command-message>\s*)?(?:<command-args>[^<]*<\/command-args>\s*)?$/.test(
            text.trim(),
          )
        )
          continue;
        for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
          const id = match[1].match(/<task-id>([^<]+)<\/task-id>/)?.[1];
          const status = match[1].match(/<status>([^<]+)<\/status>/)?.[1];
          const tool = background.get(id);
          if (tool && ['completed', 'failed', 'killed', 'stopped'].includes(status)) {
            touch(tool);
            tool.running = false;
            tool.statusUnknown = false;
            tool.failed = status !== 'completed';
            background.delete(id);
          }
        }
      }

      const blocks = [];
      const content = message.content;
      // 用户消息在这里就拆掉 <pasted_content> 包装：发送队列读的是这一层的结果。
      const own = (text) => (type === 'user' ? unwrapPastedContent(text) : text);
      if (typeof content === 'string') {
        const block = textBlock('text', own(content));
        if (block) blocks.push(block);
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          if (item.type === 'text') {
            const block = textBlock('text', own(item.text));
            if (block) blocks.push(block);
          } else if (item.type === 'image') {
            blocks.push(...contentImages([item]));
          } else if (item.type === 'thinking') {
            const block = textBlock('thinking', item.thinking, THINKING_LIMIT);
            if (block) blocks.push(block);
          } else if (item.type === 'tool_use') {
            const block = {
              kind: 'tool',
              id: item.id,
              name: item.name || '工具',
              input: clip(item.input, toolTextLimit),
              result: null,
            };
            blocks.push(block);
            if (item.id) toolIndex.set(item.id, block);
          } else if (item.type === 'tool_result') {
            const target = toolIndex.get(item.tool_use_id);
            const output = toolOutput(item.content);
            const result = {
              ...clip(output, toolTextLimit),
              preview: outputPreview(output),
              isError: Boolean(item.is_error),
            };
            const images = toolImages ? contentImages(item.content) : [];
            // 找不到对应的调用(会话被截断、或存档从中间开始)就单独成块，不丢数据。
            if (target) {
              touch(target);
              target.result = result;
              if (images.length) target.images = images;
              const taskId = entry.toolUseResult?.backgroundTaskId;
              if (taskId) {
                target.running = true;
                background.set(taskId, target);
              }
              const task = entry.toolUseResult?.task;
              const previous = background.get(task?.task_id);
              if (previous && ['completed', 'failed', 'killed', 'stopped'].includes(task.status)) {
                touch(previous);
                previous.running = false;
                previous.statusUnknown = false;
                previous.failed = task.status !== 'completed';
                background.delete(task.task_id);
              }
            } else
              blocks.push({
                kind: 'tool',
                id: item.tool_use_id,
                name: '工具结果',
                input: null,
                result,
                images,
              });
          }
        }
      }
      if (type === 'assistant' && message.stop_reason === 'end_turn') {
        for (const tool of toolIndex.values())
          if (tool.running || tool.result == null) {
            touch(tool);
            tool.running = false;
            tool.statusUnknown = true;
          }
      }
      if (!blocks.length) continue;
      // 只带 tool_result 的 user 行是工具回传，不是人说的话，已经回填过就不再单独成条。
      const onlyToolResults =
        type === 'user' &&
        Array.isArray(content) &&
        content.every((item) => item && item.type === 'tool_result') &&
        blocks.every((block) => block.kind !== 'text');
      if (onlyToolResults) continue;
      messages.push({
        id: entry.uuid || `${type}-${messages.length}`,
        role: type,
        ts: entry.timestamp || null,
        blocks,
      });
      for (const block of blocks) if (block.kind === 'tool') owners.set(block, messages.at(-1));
    }
  }
  function changes() {
    const changed = [];
    for (let index = emitted; index < messages.length; index++)
      positions.set(messages[index], index);
    // Updated tools can belong to a message before the newly appended tail.
    for (const message of dirty) changed.push({ index: positions.get(message), message });
    for (let index = emitted; index < messages.length; index++)
      if (!dirty.has(messages[index])) changed.push({ index, message: messages[index] });
    emitted = messages.length;
    dirty.clear();
    return changed;
  }
  return {
    write,
    changes,
    snapshot: () => messages,
    ids: () => messages.map((message) => message.id),
    checkpoint: () => ({ messages, toolIndex, background, synthetic }),
  };
}
function parseClaudeTranscript(lines, options) {
  const parser = createClaudeTranscriptParser(options);
  parser.write(effectiveLines('claude', lines));
  return parser.snapshot();
}

// ---------------------------------------------------------------------- Codex

// Codex 用 `{type, payload}` 信封。`role: developer` 是注入的系统提示，不是对话，跳过。
// `reasoning.encrypted_content` 是加密的，只有 `summary` 可读。
/**
 * Codex 代码模式里的 `wait`：`exec` 单元没在时限内跑完，返回「Script running with
 * cell ID N」，之后模型反复调用 `wait({cell_id: N})` 去等它。终端对这些轮询一条都
 * 不显示 —— 等的时候底部只有一行实时的「Waiting for background terminal」，等完之后
 * 那条 `Ran …` 直接带上最终输出。我们原来把每次轮询都画成一行「wait 查看执行结果」，
 * 一个长任务能刷出几十行（2026-09-23 用户指出）。所以 `wait` 不进聊天流，它拿到的
 * 结果并回它等的那条命令；运行状态仍由 ToolLifecycle 按 cell id 追踪。
 */
const CELL_RUNNING = /Script running with cell ID ([\w-]+)/;
const WAIT_CELL = /\bcell_id["']?\s*:\s*["']?([\w-]+)/;

function compactionText(event = {}) {
  const start = event.started_at_ms,
    end = event.completed_at_ms;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= 0 ||
    end < start
  )
    return 'Context compacted';
  const seconds = Math.floor((end - start) / 1000),
    pad = (value) => String(value).padStart(2, '0');
  const elapsed =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
        : `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m ${pad(seconds % 60)}s`;
  return `Context compacted · ${elapsed}`;
}

function createCodexTranscriptParser({
  toolTextLimit = TOOL_TEXT_LIMIT,
  state,
  maxToolsPerMessage = Infinity,
  toolImages = true,
} = {}) {
  const messages = state?.messages || [];
  const toolIndex = state?.toolIndex || new Map();
  const cells = state?.cells || new Map();
  const lifecycle = new ToolLifecycle(state?.lifecycle);
  const snapshots = new WeakMap(),
    owners = new WeakMap(),
    dirty = new Set();
  const positions = new WeakMap(messages.map((message, index) => [message, index]));
  for (const message of messages)
    for (const block of message.blocks) if (block.kind === 'tool') owners.set(block, message);
  let emitted = state ? messages.length : 0;
  const touchTool = (tool) => {
    if (!tool) return;
    const owner = owners.get(tool);
    if (owner) dirty.add(owner);
    if (tool.waitsFor) touchTool(tool.waitsFor);
  };
  const transition = (method, ...args) => {
    if (method === 'finishTurn') for (const tool of lifecycle.calls) touchTool(tool);
    else for (const tools of lifecycle.pending.values()) for (const tool of tools) touchTool(tool);
    if (args[0]) touchTool(args[0]);
    lifecycle[method](...args);
  };
  let current = state?.current || null;
  let receiptMessage = state?.receiptMessage || null;
  let pendingCompaction = state?.pendingCompaction || null,
    lastCompaction = state?.lastCompaction || null;
  const compactions = state?.compactions || new Map();
  const addCompaction = (ts) => {
    const message = {
      id: `compacted-${recordId}`,
      role: 'assistant',
      kind: 'compacted',
      ts: ts || null,
      blocks: [{ kind: 'text', text: 'Context compacted' }],
    };
    messages.push(message);
    current = null;
    receiptMessage = null;
    lastCompaction = message;
    return message;
  };
  const ensureAssistant = (ts) => {
    if (current && current.role === 'assistant' && current.blocks.length < maxToolsPerMessage) {
      dirty.add(current);
      return current;
    }
    current = { id: `assistant-${recordId}`, role: 'assistant', ts: ts || null, blocks: [] };
    messages.push(current);
    return current;
  };
  let recordId = '';
  function write(lines) {
    for (const raw of lines) {
      recordId = stableId(raw);
      let entry;
      try {
        entry = parseLine(raw);
      } catch {
        continue;
      }
      // The checkpoint contains private replacement context, not chat text.
      // Keep only its native completion boundary, then enrich the same marker
      // when the following ItemCompleted receipt supplies an actual duration.
      if (entry?.type === 'compacted' && entry.payload && typeof entry.payload === 'object') {
        pendingCompaction = addCompaction(entry.timestamp);
        continue;
      }
      if (entry?.type === 'event_msg') {
        const event = entry.payload || {};
        const completed =
          event.type === 'item_completed' && event.item?.type === 'ContextCompaction';
        if (completed || event.type === 'context_compacted') {
          const id =
            completed && typeof event.item.id === 'string' && event.item.id ? event.item.id : null;
          const marker =
            (id && compactions.get(id)) ||
            pendingCompaction ||
            (!completed && lastCompaction) ||
            addCompaction(entry.timestamp);
          const text = compactionText(event);
          if (text !== 'Context compacted' && text !== marker.blocks[0].text) {
            marker.blocks[0].text = text;
            dirty.add(marker);
          }
          if (id) compactions.set(id, marker);
          if (pendingCompaction === marker) pendingCompaction = null;
          current = null;
          receiptMessage = null;
          continue;
        }
        // Native journals use both user_message and item_completed/UserMessage
        // receipts. The event item ID differs from the response_item message ID;
        // client_id identifies the Swift submission in either format.
        const item =
          event.type === 'item_completed' && event.item?.type === 'UserMessage' ? event.item : null;
        if (receiptMessage && item?.client_id) {
          dirty.add(receiptMessage);
          const recordedText = receiptMessage.blocks
            .filter((b) => b.kind === 'text')
            .map((b) => b.text)
            .join('\n');
          const receivedText = (item.content || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          if (
            recordedText === receivedText &&
            (!receiptMessage.operationId || receiptMessage.operationId === item.client_id)
          )
            receiptMessage.operationId = item.client_id;
          receiptMessage = null;
        }
        if (event.type === 'user_message' && receiptMessage && event.client_id) {
          dirty.add(receiptMessage);
          receiptMessage.operationId = event.client_id;
          receiptMessage = null;
        }
        if (['task_started', 'task_complete', 'turn_aborted'].includes(event.type)) {
          receiptMessage = null;
          pendingCompaction = null;
          lastCompaction = null;
        }
      }
      if (
        entry?.type === 'event_msg' &&
        ['task_complete', 'turn_aborted'].includes(entry.payload?.type)
      )
        transition('finishTurn');
      // ⚠️ 一轮被中断时**没有收尾的那段话** —— 正文就停在最后几条命令上。终端会写
      // 明一行「Conversation interrupted」，我们漏掉它的话，看起来就是「跑着跑着没了」，
      // 而会话状态又显示空闲，只能怀疑是我们丢了消息（2026-09-22 用户指出）。
      if (entry?.type === 'event_msg' && entry.payload?.type === 'turn_aborted') {
        messages.push({
          id: `aborted-${messages.length}`,
          role: 'assistant',
          kind: 'aborted',
          ts: entry.timestamp || null,
          blocks: [{ kind: 'text', text: '这一轮被中断了' }],
        });
        continue;
      }
      if (entry?.type !== 'response_item') continue;
      lastCompaction = null;
      receiptMessage = null;
      const payload = entry.payload;
      if (!payload || typeof payload !== 'object') continue;
      const ts = entry.timestamp || null;

      if (payload.type === 'message') {
        const role = payload.role;
        if (role !== 'user' && role !== 'assistant') continue;
        // Codex 把 AGENTS.md、环境上下文、记忆、技能说明、协作模式提示等等统统作为
        // role:user 的消息注入,直接按 role 渲染会把一堆 XML 当成用户说的话。
        // 它自己在 content_item_kinds 里标了来源,只有 user.text 是真人输入。
        // 这里用白名单而不是黑名单 —— 将来新增的注入类型能自动被挡住。
        const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
        if (
          role === 'user' &&
          Array.isArray(kinds) &&
          !kinds.some((kind) => ['user.text', 'user.image'].includes(kind))
        )
          continue;
        const blocks = [];
        for (const item of Array.isArray(payload.content) ? payload.content : []) {
          if (!item || typeof item !== 'object') continue;
          // ⚠️ Codex 的文本块叫 input_text / output_text，不叫 text。
          if (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') {
            const block = textBlock('text', item.text);
            if (block) blocks.push(block);
          } else blocks.push(...contentImages([item]));
        }
        if (!blocks.length) continue;
        if (role === 'user' || payload.phase === 'final_answer') transition('finishTurn');
        const message = { id: payload.id || `${role}-${recordId}`, role, ts, blocks };
        messages.push(message);
        current = message;
        if (role === 'user') receiptMessage = message;
      } else if (payload.type === 'reasoning') {
        const summary = Array.isArray(payload.summary)
          ? payload.summary.map((s) => (typeof s === 'string' ? s : s?.text || '')).join('\n')
          : payload.summary;
        const block = textBlock('thinking', summary, THINKING_LIMIT);
        if (block) ensureAssistant(ts).blocks.push(block);
      } else if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        const block = {
          kind: 'tool',
          id: payload.call_id || payload.id,
          name: payload.name || '工具',
          input: clip(payload.input ?? payload.arguments, toolTextLimit),
          status: payload.status || null,
          result: null,
        };
        const cell =
          block.name === 'wait' &&
          WAIT_CELL.exec(String(payload.input ?? payload.arguments ?? ''))?.[1];
        if (cell && cells.has(cell)) block.waitsFor = cells.get(cell);
        else {
          const owner = ensureAssistant(ts);
          owner.blocks.push(block);
          owners.set(block, owner);
        }
        transition('start', block, payload.input ?? payload.arguments);
        if (block.id) toolIndex.set(block.id, block);
      } else if (
        payload.type === 'custom_tool_call_output' ||
        payload.type === 'function_call_output'
      ) {
        const target = toolIndex.get(payload.call_id);
        const output = toolOutput(payload.output);
        const result = {
          ...clip(output, toolTextLimit),
          preview: outputPreview(output),
          isError: false,
        };
        const images = toolImages ? contentImages(payload.output) : [];
        if (target) {
          target.result = result;
          if (images.length) target.images = images;
          transition('result', target, payload.output);
          const running = CELL_RUNNING.exec(
            typeof payload.output === 'string'
              ? payload.output
              : JSON.stringify(payload.output ?? ''),
          );
          if (running) cells.set(running[1], target.waitsFor || target);
          // 轮询拿到的结果就是那条命令此刻的结果：最后一次轮询带着最终输出。
          if (target.waitsFor) {
            target.waitsFor.result = result;
            if (images.length) target.waitsFor.images = images;
          }
        } else
          ensureAssistant(ts).blocks.push({
            kind: 'tool',
            id: payload.call_id,
            name: '工具结果',
            input: null,
            result,
            images,
          });
      } else if (payload.type === 'image_generation_call' && typeof payload.result === 'string') {
        const block = imageBlock(`data:image/png;base64,${payload.result}`, '生成的图片');
        if (block) ensureAssistant(ts).blocks.push(block);
      }
    }
  }
  function copySnapshot(value, seen = new WeakMap()) {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const result =
      value instanceof Set
        ? new Set()
        : value instanceof Map
          ? new Map()
          : Array.isArray(value)
            ? []
            : {};
    seen.set(value, result);
    if (value instanceof Set) for (const child of value) result.add(copySnapshot(child, seen));
    else if (value instanceof Map)
      for (const [key, child] of value)
        result.set(copySnapshot(key, seen), copySnapshot(child, seen));
    else for (const key of Object.keys(value)) result[key] = copySnapshot(value[key], seen);
    if (Object.hasOwn(value, 'source'))
      Object.defineProperty(result, 'source', { value: copySnapshot(value.source, seen) });
    return result;
  }
  function freezeSnapshot(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freezeSnapshot(child, seen);
    if (Object.hasOwn(value, 'source')) freezeSnapshot(value.source, seen);
    return Object.freeze(value);
  }
  function snapshot({ shared = false } = {}) {
    // Unchanged messages keep immutable snapshots; only changed records are
    // copied. Strings are immutable and do not need to copy their payload.
    const result = messages
      .filter((message) => message.blocks.length)
      .map((message) => {
        if (!snapshots.has(message) || dirty.has(message)) {
          snapshots.set(message, freezeSnapshot(copySnapshot(message)));
          dirty.delete(message);
        }
        return snapshots.get(message);
      });
    return shared ? Object.freeze(result) : copySnapshot(result);
  }
  function changes() {
    const changed = [];
    for (let index = emitted; index < messages.length; index++)
      positions.set(messages[index], index);
    for (const message of dirty) changed.push({ index: positions.get(message), message });
    for (let index = emitted; index < messages.length; index++)
      if (!dirty.has(messages[index])) changed.push({ index, message: messages[index] });
    emitted = messages.length;
    dirty.clear();
    return changed;
  }
  return {
    write,
    snapshot,
    changes,
    ids: () => messages.map((message) => message.id),
    checkpoint: () => ({
      messages,
      toolIndex,
      cells,
      lifecycle: lifecycle.checkpoint(toolIndex.values()),
      current,
      receiptMessage,
      pendingCompaction,
      lastCompaction,
      compactions,
    }),
  };
}
function parseCodexTranscript(lines, options) {
  const parser = createCodexTranscriptParser(options);
  parser.write(effectiveLines('codex', lines));
  return parser.snapshot();
}

function parseTranscript(agent, lines, options) {
  if (agent === 'claude') return parseClaudeTranscript(lines, options);
  if (agent === 'codex') return parseCodexTranscript(lines, options);
  if (require('./providers/native').JSONL.includes(agent))
    return require('./providers/native').parseJsonl(agent, effectiveLines(agent, lines), options);
  return [];
}

// ------------------------------------------------------------------- 文件定位

// Herdr 的快照给出 agent 类型和会话 id,两者合起来才能定位存档:
// Claude 按 cwd 建目录(路径里的 / 换成 -),Codex 按日期分层、文件名里带 id。
function locateTranscript(agent, sessionId, cwd, home = os.homedir(), options = {}) {
  if (!sessionId) return null;
  if (require('./providers/native').JSONL.includes(agent))
    return require('./providers/native').locateJsonl(agent, sessionId, home);
  if (agent === 'claude') {
    if (!/^[\w-]+$/.test(sessionId)) return null;
    const dir = String(cwd).replace(/\//g, '-');
    const file = path.join(home, '.claude', 'projects', dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
    const root = path.join(home, '.claude', 'projects');
    try {
      return (
        fs
          .readdirSync(root)
          .map((dir) => path.join(root, dir, `${sessionId}.jsonl`))
          .find((candidate) => fs.existsSync(candidate)) || null
      );
    } catch {
      return null;
    }
  }
  if (agent === 'codex') {
    if (!/^[\w-]+$/.test(sessionId)) return null;
    const codexHome =
      options.codexHome ||
      (home === os.homedir() && process.env.CODEX_HOME) ||
      path.join(home, '.codex');
    const current = require('./codex-archive').currentArchive(
      options.sqliteHome || codexHome,
      sessionId,
      cwd,
      { archiveHome: codexHome },
    );
    if (current.known) return current.file;
    const root = path.join(codexHome, 'sessions');
    if (!fs.existsSync(root)) return null;
    // 存档路径是 sessions/年/月/日/rollout-<时间>-<id>.jsonl,**四层**。
    // 不递归整棵树 —— 会话数以千计,每次全扫太慢;按层展开并从新到旧找。
    const suffix = `-${sessionId}.jsonl`;
    const levels = [root];
    for (let depth = 0; depth < 4; depth += 1) {
      const next = [];
      for (const dir of levels) {
        let names;
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names.sort().reverse()) next.push(path.join(dir, name));
      }
      levels.length = 0;
      levels.push(...next);
    }
    for (const file of levels) {
      if (file.endsWith(suffix)) return file;
    }
    return null;
  }
  return null;
}

/**
 * 系统注入标记:归档里混着大量不是人说的话 —— Codex 的记忆溯源块、
 * Claude Code 塞进 user 消息里的后台任务通知、skill 正文、本地命令回显。
 * 它们在存档里的角色都是 user,但用户本人一个字都没打,读起来只是噪音。
 *
 * 🔑 判据必须是**这份固定的标签名白名单 + 成对整块删除**,绝不能泛化成
 * 「删掉所有尖括号标签」。实测归档里出现频次最高的尖括号是 C++ 模板
 * (<int64_t> / <uint32_t> / <typename>)、Triton 类型(<f32> / <i64>)、
 * HTML 与 mermaid(<td> / <li> / <br>)、以及文档里的占位符(<openid> / <alias>),
 * 那些都是正文内容,一旦泛化删除就会毁掉代码块。
 *
 * 同理,子标签(<summary> / <status> / <name> / <event>)不单独列进白名单——
 * 它们名字太通用,删外层容器时自然一起走,单独匹配只会误伤正文。
 */
const SYSTEM_BLOCK = new RegExp(
  '<(' +
    [
      'oai-mem-citation',
      'citation_entries',
      'rollout_ids', // Codex 记忆溯源
      'system-reminder', // 注入的系统提示
      'task-notification', // 后台任务/Monitor 完成通知
      'local-command-caveat',
      'local-command-stdout', // 本地命令的说明与回显
      'skill', // 被整篇贴进来的 skill 正文
    ].join('|') +
    ')>[\\s\\S]*?<\\/\\1>\\s*',
  'g',
);

/**
 * slash command 在存档里被拆成三个标签,但它是用户**主动打的**,属于「我的内容」,
 * 该留下,只是要还原成人看得懂的一行 `/goal 参数` 而不是三行尖括号。
 */
const SLASH_COMMAND =
  /<command-name>([^<]*)<\/command-name>\s*(?:<command-message>[^<]*<\/command-message>\s*)?(?:<command-args>([^<]*)<\/command-args>\s*)?/g;

function stripSystemMarkup(text) {
  if (typeof text !== 'string' || !text.includes('<')) return text;
  return text
    .replace(SYSTEM_BLOCK, '')
    .replace(
      SLASH_COMMAND,
      (_, name, args) => `${name.trim()} ${(args || '').trim()}`.trim() + '\n',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Claude Code 把较长的粘贴折叠成 `[Pasted text #N]`，写进存档时再展开成
 * `<pasted_content id="N">…</pasted_content id="N">`（2.1.280 实测）。会话页的发送
 * 走的正是粘贴，所以够长的多行消息都会被这样包一层。只拆开首尾成对、id 相同的
 * 那一层，正文原样保留：不拆的话，页面上露出标签，发送队列拿存档正文逐字比对
 * 也永远对不上，本地回显就一直挂在「等待确认」。
 */
const PASTED_CONTENT = /<pasted_content id="([^"\n]+)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;
function unwrapPastedContent(text) {
  if (typeof text !== 'string' || !text.includes('<pasted_content')) return text;
  return text.replace(PASTED_CONTENT, (_, id, body) => body).trim();
}

// 旧名字保留为别名:这个函数原来只管记忆引用,职责扩大后改名更准确,
// 但导出过的名字不好直接拿掉。
const stripMemoryCitations = stripSystemMarkup;

/**
 * 工具名归类。两家 agent 的工具名不一样(Claude 是 Bash/Read/Grep,Codex 是
 * shell/apply_patch 之类),按语义归到同一组,摘要文案才统一。
 */
function toolCategory(name) {
  const value = String(name || '').toLowerCase();
  if (/bash|shell|exec|command|run/.test(value)) return 'shell';
  if (/patch|edit|write|apply|create/.test(value)) return 'edit';
  if (/grep|glob|search|find/.test(value)) return 'search';
  if (/read|view|cat|open/.test(value)) return 'read';
  if (/task|subagent|agent/.test(value)) return 'task';
  if (/fetch|web|http|browse/.test(value)) return 'web';
  if (/todo|plan/.test(value)) return 'todo';
  return 'other';
}

const TOOL_PHRASES = {
  shell: (count) => `运行 ${count} 条命令`,
  edit: (count) => `改动 ${count} 处`,
  search: (count) => `搜索 ${count} 次`,
  read: (count) => `读取 ${count} 个文件`,
  task: (count) => `派出 ${count} 个子任务`,
  web: (count) => `访问 ${count} 个网页`,
  todo: () => '更新待办',
  other: (count) => `调用 ${count} 次工具`,
};

/**
 * 从工具入参里挑出最能说明「这一步在做什么」的那一小段。
 *
 * ⚠️ 入参在 parser 里已经被 clip() 序列化成 `{ text: '<JSON>' }`,不是原对象 ——
 * 直接读 input.command 永远是 undefined(踩过)。所以先把那串 JSON 解回来。
 */
/**
 * Codex 的工具调用外面裹着一层 JS：
 *
 *   text(await tools.exec_command({cmd:"server194 exec --script /tmp/x.sh", ...}));
 *   text(await tools.write_stdin({session_id:56774, chars:"", ...}));
 *   text(await tools.apply_patch("*** Begin Patch\n*** Update File: a.py\n..."));
 *
 * 把里面那件**真正做了的事**抽出来 —— 终端里显示的就是它（`• Ran server194 exec …`），
 * 而不是这层包装。包装原文仍旧留在 input 里，展开还能看到。
 *
 * ⚠️ 不要拿正则去抓引号里的内容：命令里常有转义引号和换行（`sed -n '1,5p'`、
 * heredoc），贪婪或非贪婪都会断在错的地方。这里按 JS 字符串字面量逐字扫。
 */
function readJsString(text, at) {
  const quote = text[at];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let out = '';
  for (let i = at + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      i += 1;
      continue;
    }
    if (ch === quote) return { value: out, end: i };
    out += ch;
  }
  return null;
}

function codexAction(text) {
  const source = String(text || '');
  const call = /tools\.(exec_command|write_stdin|apply_patch|sleep)\s*\(/.exec(source);
  if (!call) return null;
  const after = call.index + call[0].length;
  if (call[1] === 'sleep') return { verb: 'Waited', command: '' };
  if (call[1] === 'apply_patch') {
    const patch = readJsString(
      source,
      source.indexOf('"', after) >= 0 ? source.indexOf('"', after) : after,
    );
    const files = [
      ...String(patch?.value || '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm),
    ].map((match) => match[1].trim());
    return { verb: 'Edited', command: files.join('、') };
  }
  if (call[1] === 'write_stdin') {
    const session = /session_id\s*:\s*(\d+)/.exec(source.slice(after));
    return {
      verb: 'Waited for background terminal',
      command: session ? `session ${session[1]}` : '',
    };
  }
  const key = /cmd\s*:\s*/.exec(source.slice(after));
  if (!key) return { verb: 'Ran', command: '' };
  const quoted = readJsString(source, after + key.index + key[0].length);
  return { verb: 'Ran', command: (quoted?.value || '').trim() };
}

/**
 * ⚠️ **不要去猜命令做了什么。** 终端里那个 `Explored / Read x / Search y` 是 Codex
 * 自己对命令的归类 —— 它知道每次调用的意图，我们只看得到命令行。照着猜的代价是把
 * 「删文件」标成「读文件」；而且连一条正常的 `rg -n 'a|b' f.py` 都会因为模式里有 `|`
 * 而认不出来（2026-09-22 试过，随即撤掉）。命令照原样显示成 `Ran`，朴素但不说错话。
 */

/**
 * Codex 工具输出的外壳同样是它那层代码模式的产物：
 *
 *   [{"type":"input_text","text":"Script completed\nWall time 0.2 seconds\nOutput:\n"},
 *    {"type":"input_text","text":"{\"exit_code\":0,\"output\":\"…\"}"}]
 *
 * 终端里显示的是里面那个 `output`，以及据 `exit_code` 把行首的 `•` 画成绿或红。
 * 外壳原文仍留在 result 里，展开还能看到。
 *
 * ⚠️ 别拿正则去抓 `"output":"…"`：输出里满是转义引号和换行。逐层 JSON.parse，
 * 解不开就承认解不开（返回 null），不猜。
 */
function codexOutcome(text) {
  const source = String(text || '').trim();
  if (!source.startsWith('[')) return null;
  let envelope;
  try {
    envelope = JSON.parse(source);
  } catch {
    return null;
  }
  if (!Array.isArray(envelope)) return null;
  const outputs = [];
  let exitCode = null;
  for (const part of envelope) {
    const body = String(part?.text || '').trim();
    if (!body.startsWith('{')) continue;
    // 一次调用可能分几段回来，每段自己是一个 JSON 对象。
    for (const line of body.split('\n')) {
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      const value = chunk?.value ?? chunk;
      if (typeof value?.output === 'string') outputs.push(value.output);
      if (Number.isInteger(value?.exit_code)) exitCode = value.exit_code;
    }
  }
  if (exitCode === null && !outputs.length) return null;
  return { exitCode, output: outputs.join('').replace(/\s+$/, '') };
}

function toolDetail(input) {
  let value = input;
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    try {
      value = JSON.parse(value.text);
    } catch {
      return value.text.slice(0, 160);
    }
  }
  if (!value || typeof value !== 'object') return '';
  const text = String(
    value.command ??
      value.file_path ??
      value.path ??
      value.pattern ??
      value.description ??
      value.url ??
      value.query ??
      value.prompt ??
      '',
  );
  // 只取第一行:命令常常是多行的,列表里一行就够。
  return text.split('\n')[0].trim().slice(0, 160);
}

/**
 * 一条工具调用在列表里的样子。
 *
 * 没有结果的调用仍在执行；已经返回后台进程或等待编号的调用，
 * 必须继续跟踪至确认结束，不能把部分输出当作完成。
 */
function describeTool(tool) {
  return {
    id: tool.id || null,
    input: tool.input || null,
    result: tool.result || null,
    truncated: Boolean(tool.input?.truncated || tool.result?.truncated),
    name: String(tool.name || '工具'),
    category: toolCategory(tool.name),
    detail: toolDetail(tool.input),
    // Codex 特有：把它那层代码模式的包装拆开 —— 入参里真正做的事、输出里真正的正文
    // 与退出码。渲染器据此画成终端里的样子（`• Ran …` 加绿/红的点、`└ 输出`）。
    action: codexAction(tool.input?.text),
    outcome: codexOutcome(tool.result?.text),
    running: tool.running ?? tool.result == null,
    failed: Boolean(tool.failed || tool.result?.isError),
    statusUnknown: Boolean(tool.statusUnknown),
  };
}

/**
 * 把一串连续的工具调用压成一行,像终端里那样(`Ran 2 shell commands`)。
 * 列表仅携带已截断的入参和输出，完整内容通过详情接口按需读取；
 * 但「这一步做了什么」这条线索不能丢,否则只剩结论、看不出过程。
 */
function summarizeTools(tools) {
  const counts = new Map();
  for (const tool of tools) {
    const category = toolCategory(tool.name);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const parts = [...counts.entries()].map(([category, count]) => TOOL_PHRASES[category](count));
  return parts.join(' · ');
}

/**
 * 发给客户端的块:对话正文 + 工具调用的一行摘要。
 * 工具块仍然必须先被**解析**出来 —— 不解析就认不出哪些 user 行其实是工具回传,
 * 会冒出一堆假的用户发言。
 */
const shapedMessages = new WeakMap(),
  renderedMessages = new WeakMap();
function freezeProjection(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeProjection(child);
    Object.freeze(value);
  }
  return value;
}
function textOnly(messages, { mergeTools = true } = {}) {
  const origins = new WeakMap();
  const shaped = messages
    .map((message) => {
      if (Object.isFrozen(message) && shapedMessages.has(message))
        return shapedMessages.get(message);
      const blocks = [];
      let pending = [];
      const flush = () => {
        if (!pending.length) return;
        blocks.push({ kind: 'tools', tools: pending });
        pending = [];
      };
      const nativeImages = message.blocks.some((block) => block.kind === 'image');
      // 用户消息里的附件记录与图片链接会被拆成图片块，原文就不在文字块里了。
      // 发送队列要拿送进终端的原文去比对，所以把它另存一份，否则带附件的消息永远确认不了。
      const sources = [];
      for (const block of message.blocks) {
        if (block.kind === 'tool') {
          // 工具回传的图片（Claude 用 Read 读图、Codex 命令输出里的截图与二维码）不画进聊天流：
          // 它们是 Agent 自己看的材料，终端里也不显示（2026-09-24 用户要求）。正文里引用的图片与
          // 用户发的图片照常显示。
          if (block.images) {
            const { images, ...rest } = block;
            pending.push(rest);
          } else pending.push(block);
          continue;
        }
        if (block.kind === 'image') {
          flush();
          blocks.push(block);
          continue;
        }
        if (block.kind !== 'text') continue;
        const text = stripSystemMarkup(block.text);
        if (!text) continue;
        flush();
        sources.push(text);
        blocks.push(...(nativeImages ? [{ ...block, text }] : textImages(text)));
      }
      flush();
      const derived =
        message.role === 'user' && !nativeImages && blocks.some((block) => block.kind === 'image');
      const shaped = derived
        ? { ...message, blocks, sourceText: sources.join('\n') }
        : { ...message, blocks };
      if (Object.isFrozen(message)) {
        freezeProjection(shaped);
        shapedMessages.set(message, shaped);
      }
      return shaped;
    })
    .filter((message) => message.blocks.length > 0);

  // 连续的工具调用往往被拆在相邻的几条消息里(每调一次就是一条 assistant 消息,
  // 中间夹着已被滤掉的工具回传)。不跨消息合并的话,屏幕上会连着出现三行
  // 「运行 1 条命令」,而终端里那本来是一句 "Ran 3 shell commands"。
  const merged = [];
  for (const message of shaped) {
    const onlyTools = message.blocks.every((block) => block.kind === 'tools');
    const last = merged[merged.length - 1];
    const lastOnlyTools = last && last.blocks.every((block) => block.kind === 'tools');
    if (mergeTools && onlyTools && lastOnlyTools && last.role === message.role) {
      origins.delete(last);
      // Append to the private accumulator. Repeated array spreading copied the
      // entire accumulated tool group for every call in a long native turn.
      const tools = last.blocks[0].tools;
      for (const block of message.blocks) for (const tool of block.tools) tools.push(tool);
      continue;
    }
    const copy = {
      ...message,
      blocks: message.blocks.map((block) =>
        mergeTools && block.kind === 'tools' ? { ...block, tools: block.tools.slice() } : block,
      ),
    };
    if (Object.isFrozen(message)) origins.set(copy, message);
    merged.push(copy);
  }

  // 最后才把工具列表压成文案:合并要在计数之前做,否则数字就对不上了
  return merged.map((message) => {
    const original = origins.get(message);
    if (original && renderedMessages.has(original)) return renderedMessages.get(original);
    const result = {
      ...message,
      blocks: message.blocks.map((block) =>
        block.kind === 'tools'
          ? {
              kind: 'tools',
              summary: summarizeTools(block.tools),
              count: block.tools.length,
              // 逐条列出来,像终端那样一条一行;正在跑的那条(还没有结果)要能认出来。
              items: block.tools.map(describeTool),
            }
          : block,
      ),
    };
    if (original) {
      freezeProjection(result);
      renderedMessages.set(original, result);
    }
    return result;
  });
}

module.exports = {
  createCodexTranscriptParser,
  createClaudeTranscriptParser,
  codexAction,
  codexOutcome,
  parseTranscript,
  parseClaudeTranscript,
  parseCodexTranscript,
  locateTranscript,
  textOnly,
  stripSystemMarkup,
  stripMemoryCitations,
  summarizeTools,
  toolCategory,
  describeTool,
};
