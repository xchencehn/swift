'use strict';

// Candidate only. This is a read-only projection of already reconstructed
// rollout records. It neither reads native storage nor calls app-server.
const { isDeepStrictEqual } = require('node:util');
const Conversation = require('./conversation-state');
const { userInputDisplay, rustTrim } = require('./codex-user-display');
const user = (item) => item.type === 'UserMessage';
const entered = (item) => item.type === 'EnteredReviewMode';
const exited = (item) => item.type === 'ExitedReviewMode';
const lifecycle = (type) => ['item_started', 'item_completed'].includes(type);
const start = (type) => ['task_started', 'turn_started'].includes(type);
const end = (type) => ['task_complete', 'turn_complete'].includes(type);

function normalizeInput(input) {
  if (!input || typeof input !== 'object') return input;
  switch (input.type) {
    case 'text': {
      const elements = input.text_elements === undefined ? [] : input.text_elements;
      return {
        type: 'text',
        text: input.text,
        text_elements: Array.isArray(elements)
          ? elements.map(
              (element) =>
                element && {
                  byte_range: element.byte_range ?? element.byteRange,
                  placeholder: element.placeholder ?? null,
                },
            )
          : elements,
      };
    }
    case 'image':
      return {
        type: 'image',
        ...(typeof (input.image_url ?? input.url) === 'string'
          ? { image_url: input.image_url ?? input.url }
          : { file_id: input.file_id ?? input.fileId }),
        detail: input.detail ?? null,
      };
    case 'localImage':
    case 'local_image':
      return { type: 'local_image', path: input.path, detail: input.detail ?? null };
    case 'audio':
      return { type: 'audio', audio_url: input.audio_url ?? input.url };
    case 'localAudio':
    case 'local_audio':
      return { type: 'local_audio', path: input.path };
    case 'skill':
      return { type: 'skill', name: input.name, path: input.path };
    case 'mention':
      return { type: 'mention', name: input.name, path: input.path };
    default:
      return input;
  }
}

// ThreadHistoryBuilder::build_user_inputs intentionally discards whitespace-only
// text, including its text elements, before constructing the canonical inputs.
function legacyInputs(payload) {
  const content = [];
  if (/[^\p{White_Space}]/u.test(payload.message))
    content.push({
      type: 'text',
      text: payload.message,
      text_elements: payload.text_elements || [],
    });
  const images = payload.images || [],
    files = payload.file_ids || [],
    order = payload.image_order || [];
  const ordered =
    order.length > 0 &&
    order.filter((kind) => kind === 'inline').length === images.length &&
    order.filter((kind) => kind === 'file').length === files.length &&
    order.every((kind) => ['inline', 'file'].includes(kind));
  const appendImage = (type, index) =>
    content.push(
      type === 'inline'
        ? {
            type: 'image',
            image_url: images[index],
            detail: payload.image_details?.[index] ?? null,
          }
        : {
            type: 'image',
            file_id: files[index],
            detail: payload.file_id_details?.[index] ?? null,
          },
    );
  if (ordered) {
    let inline = 0,
      file = 0;
    for (const type of order) appendImage(type, type === 'inline' ? inline++ : file++);
  } else {
    images.forEach((_, index) => appendImage('inline', index));
    files.forEach((_, index) => appendImage('file', index));
  }
  (payload.local_images || []).forEach((path, index) =>
    content.push({
      type: 'local_image',
      path,
      detail: payload.local_image_details?.[index] ?? null,
    }),
  );
  (payload.audio || []).forEach((audio_url) => content.push({ type: 'audio', audio_url }));
  (payload.local_audio || []).forEach((path) => content.push({ type: 'local_audio', path }));
  return content;
}

function inputEquality(first, second, platform = process.platform) {
  const left = first.map(normalizeInput),
    right = second.map(normalizeInput);
  if (isDeepStrictEqual(left, right)) return { equal: true, complete: true };
  const pathTypes = new Set(['local_image', 'local_audio', 'skill']);
  // Rust PathBuf equality compares components without resolving parent dirs.
  const components = (value) => {
    if (typeof value !== 'string') return value;
    const result = value.startsWith('/') ? ['/'] : /^\.(?:\/|$)/.test(value) ? ['.'] : [];
    return result.concat(
      value.split('/').filter((component) => component !== '' && component !== '.'),
    );
  };
  const replacePaths = (inputs, transform) =>
    inputs.map((input) =>
      input && pathTypes.has(input.type) ? { ...input, path: transform(input.path) } : input,
    );
  if (platform !== 'win32')
    return {
      equal: isDeepStrictEqual(replacePaths(left, components), replacePaths(right, components)),
      complete: true,
    };
  // Windows prefixes and separators have native-specific component semantics.
  // Exact paths above are proven; report only an otherwise-equal differing-path
  // pair as unresolved instead of silently shifting the native selector index.
  return {
    equal: false,
    complete: !isDeepStrictEqual(
      replacePaths(left, () => null),
      replacePaths(right, () => null),
    ),
  };
}

function nestedReviewComparison(previous, turn, platform) {
  const prompts = turn.items.filter(user);
  const candidate =
    previous.status === 'completed' &&
    turn.status === 'interrupted' &&
    turn.completedAt == null &&
    previous.items.some(entered) &&
    previous.items.some(exited) &&
    prompts.length === 2 &&
    prompts.every((prompt) => Array.isArray(prompt.content));
  return candidate
    ? inputEquality(prompts[0].content, prompts[1].content, platform)
    : { equal: false, complete: true };
}

function isHiddenNestedReviewTurn(previous, turn, { platform = process.platform } = {}) {
  return nestedReviewComparison(previous, turn, platform).equal;
}

// A direct port of app_backtrack.rs:535-614, including clipped-page semantics.
// startItem is {turnId,itemId}; earlier inputs in that turn still establish steer.
function projectReviewVisibility(turns, { startItem = null, platform = process.platform } = {}) {
  const users = [],
    issues = [];
  let startTurn = 0,
    firstItem = 0,
    reviewMode = false;
  if (startItem) {
    startTurn = turns.findIndex((turn) => turn.id === startItem.turnId);
    firstItem =
      startTurn < 0 ? -1 : turns[startTurn].items.findIndex((item) => item.id === startItem.itemId);
    if (firstItem < 0)
      return { users, complete: false, issues: [{ code: 'HISTORY_BOUNDARY_NOT_FOUND' }] };
  }
  for (let turnIndex = startTurn; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex],
      offset = turnIndex === startTurn ? firstItem : 0;
    const previous = turns[turnIndex - 1];
    const previousItems =
      turnIndex - 1 === startTurn ? previous?.items.slice(firstItem) : previous?.items;
    const nested =
      turnIndex > startTurn && previousItems.some(entered) && previousItems.some(exited)
        ? nestedReviewComparison(previous, turn, platform)
        : { equal: false, complete: true };
    if (!nested.complete)
      issues.push({ code: 'NESTED_REVIEW_PATH_EQUALITY_UNPROVEN', turnId: turn.id });
    const hiddenNestedReviewTurn = nested.equal;
    let seen = turn.items.slice(0, offset).filter(user).length;
    for (const item of turn.items.slice(offset)) {
      if (entered(item)) {
        reviewMode = true;
        continue;
      }
      if (exited(item)) {
        reviewMode = false;
        continue;
      }
      if (!user(item)) continue;
      const isSteer = seen++ > 0;
      // Native skips review-mode inputs before it computes their display.
      const display = reviewMode
        ? { visible: false, complete: true, issues: [] }
        : userInputDisplay(item.content);
      if (!hiddenNestedReviewTurn)
        issues.push(
          ...display.issues.map((issue) => ({
            ...issue,
            turnId: turn.id,
            nativeUserItemId: item.nativeUserItemId || null,
            nativeReceiptRecordId: item.nativeReceiptRecordId || null,
          })),
        );
      const visible = !reviewMode && !hiddenNestedReviewTurn && display.visible;
      users.push({
        turnId: turn.id,
        turnIdSource: turn.turnIdSource || 'explicit',
        turnIdVerified: turn.turnIdSource !== 'rollout-index',
        nativeUserItemId: item.nativeUserItemId || null,
        nativeReceiptRecordId: item.nativeReceiptRecordId || null,
        visible,
        isSteer,
        status: turn.status,
        completedAt: turn.completedAt ?? null,
        hiddenNestedReviewTurn,
        reviewMode,
        displayVisible: display.visible,
        editable:
          visible &&
          !isSteer &&
          turn.status !== 'inProgress' &&
          display.complete &&
          turn.turnIdSource !== 'rollout-index',
        displayComplete: display.complete,
      });
    }
  }
  return { users, complete: issues.length === 0, issues };
}

function decodeRecords(lines) {
  const records = [],
    issues = [];
  lines.forEach((raw, index) => {
    try {
      const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
      records.push({
        entry,
        index,
        rolloutIndex: records.length,
        recordId: Conversation.stableId(typeof raw === 'string' ? raw : JSON.stringify(raw)),
      });
    } catch {
      if (String(raw).trim()) issues.push({ code: 'MALFORMED_ROLLOUT_RECORD', index });
    }
  });
  return { records, issues };
}

function canonicalTurns(records, head) {
  const turns = new Map(),
    items = new Map(),
    issues = [];
  let ordinal = -1;
  for (const record of records) {
    const { entry, recordId } = record,
      payload = entry.payload || {};
    if (entry.type === 'session_meta') continue;
    if (!Number.isSafeInteger(entry.ordinal) || entry.ordinal < 0) {
      issues.push({ code: 'MISSING_CANONICAL_ORDINAL', sourceRecordId: recordId });
      continue;
    }
    if (entry.ordinal <= ordinal) {
      issues.push({ code: 'REGRESSED_CANONICAL_ORDINAL', sourceRecordId: recordId });
      continue;
    }
    ordinal = entry.ordinal;
    if (
      head.subagent_history_start_ordinal != null &&
      ordinal < head.subagent_history_start_ordinal
    )
      continue;
    if (entry.type !== 'event_msg') continue;
    if (start(payload.type) || end(payload.type) || payload.type === 'turn_aborted') {
      if (!payload.turn_id) continue; // project_rollout_line ignores aborts without a turn ID.
      const existing = turns.get(payload.turn_id);
      // SQLite accepts metadata updates only while the row remains inProgress.
      if (existing && existing.status !== 'inProgress') continue;
      const status = start(payload.type)
        ? 'inProgress'
        : payload.type === 'turn_aborted'
          ? 'interrupted'
          : payload.error
            ? 'failed'
            : 'completed';
      turns.set(payload.turn_id, {
        id: payload.turn_id,
        turnIdSource: 'explicit',
        status,
        completedAt: start(payload.type) ? null : (payload.completed_at ?? null),
        items: [],
        firstRecordIndex: existing?.firstRecordIndex ?? record.index,
      });
    } else if (payload.type === 'item_completed') {
      const item = payload.item;
      if (
        !payload.turn_id ||
        typeof item?.id !== 'string' ||
        !item.type ||
        (user(item) && !Array.isArray(item.content))
      ) {
        issues.push({ code: 'INVALID_CANONICAL_ITEM', sourceRecordId: recordId });
        continue;
      }
      if (payload.started_at_ms == null && !Number.isFinite(Date.parse(entry.timestamp))) {
        issues.push({ code: 'INVALID_CANONICAL_ITEM_TIMESTAMP', sourceRecordId: recordId });
        continue;
      }
      let turnItems = items.get(payload.turn_id);
      if (!turnItems) items.set(payload.turn_id, (turnItems = new Map()));
      const previous = turnItems.get(item.id);
      turnItems.set(item.id, {
        ...item,
        content: user(item) ? (item.content || []).map(normalizeInput) : item.content,
        firstRecordIndex: previous?.firstRecordIndex ?? record.index,
        nativeUserItemId: user(item) ? item.id : null,
        nativeReceiptRecordId: previous?.nativeReceiptRecordId ?? recordId,
      });
    }
  }
  const result = [...turns.values()].sort((a, b) => a.firstRecordIndex - b.firstRecordIndex);
  for (const turn of result)
    turn.items = [...(items.get(turn.id)?.values() || [])].sort(
      (a, b) => a.firstRecordIndex - b.firstRecordIndex,
    );
  return { turns: result, issues };
}

// A minimal ThreadHistoryBuilder adapter: it retains user inputs, review markers,
// turn metadata and turn existence. Other display items only occupy placeholders;
// their content is irrelevant to review visibility and never becomes a target.
function legacyTurns(records) {
  const turns = [],
    issues = [];
  let current = null;
  const fresh = (id, index) => ({
    id: id || `rollout-${index}`,
    turnIdSource: id ? 'explicit' : 'rollout-index',
    status: 'completed',
    completedAt: null,
    items: [],
    openedExplicitly: false,
    sawCompaction: false,
  });
  const finish = () => {
    if (current && (current.items.length || current.openedExplicitly || current.sawCompaction))
      turns.push(current);
    current = null;
  };
  const ensure = (index) => (current ||= fresh(null, index));
  const find = (id) => (current?.id === id ? current : turns.find((turn) => turn.id === id));
  const upsert = (turn, item) => {
    const index = turn.items.findIndex((previous) => previous.id === item.id);
    if (index < 0) turn.items.push(item);
    else turn.items[index] = item;
  };
  const marker = (payload, item, index) => {
    let turn = payload.turn_id ? find(payload.turn_id) : ensure(index);
    if (!turn) {
      finish();
      current = turn = fresh(payload.turn_id, index);
    }
    upsert(turn, item);
  };
  const legacyItemTypes = new Set([
    'HookPrompt',
    'FunctionCallOutput',
    'CommandExecution',
    'DynamicToolCall',
    'CollabAgentToolCall',
    'SubAgentActivity',
    'Extension',
  ]);
  const createsCurrent = new Set([
    'web_search_begin',
    'web_search_end',
    'view_image_tool_call',
    'image_generation_begin',
    'image_generation_end',
    'collab_agent_spawn_begin',
    'collab_agent_spawn_end',
    'collab_agent_interaction_begin',
    'collab_agent_interaction_end',
    'sub_agent_activity',
    'collab_waiting_begin',
    'collab_waiting_end',
    'collab_close_begin',
    'collab_close_end',
    'collab_resume_begin',
    'collab_resume_end',
    'context_compacted',
  ]);
  const createsScoped = new Set([
    'guardian_assessment',
    'apply_patch_approval_request',
    'patch_apply_begin',
    'patch_apply_end',
    'dynamic_tool_call_request',
    'dynamic_tool_call_response',
    'mcp_tool_call_begin',
    'mcp_tool_call_end',
  ]);
  for (const { entry, recordId, rolloutIndex: index } of records) {
    const payload = entry.payload || {};
    if (entry.type === 'compacted') {
      ensure(index).sawCompaction = true;
      continue;
    }
    // HookPrompt is the one ResponseItem variant that can create a legacy turn.
    // Its XML parser is outside this minimal adapter. Only an exact potential
    // hook envelope at a turn-creating boundary requires a full native decode;
    // ordinary user text and all response items inside explicit turns are safe.
    if (
      entry.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      (!current ||
        (!current.openedExplicitly && current.sawCompaction && current.items.length === 0)) &&
      Array.isArray(payload.content) &&
      payload.content.length &&
      payload.content.every(
        (part) =>
          part?.type === 'input_text' &&
          typeof part.text === 'string' &&
          /^(?:<\?xml[\s\S]*?\?>\s*)?<hook_prompt(?:\s|>)/u.test(rustTrim(part.text)),
      )
    ) {
      issues.push({ code: 'LEGACY_HOOK_XML_PROJECTION_UNPROVEN', sourceRecordId: recordId });
    }
    if (entry.type !== 'event_msg') continue;
    if (start(payload.type)) {
      if (typeof payload.turn_id !== 'string' || !payload.turn_id) {
        issues.push({ code: 'INVALID_TURN_START', sourceRecordId: recordId });
        continue;
      }
      finish();
      current = fresh(payload.turn_id, index);
      current.status = 'inProgress';
      current.openedExplicitly = true;
    } else if (end(payload.type) || payload.type === 'turn_aborted') {
      const turn = find(payload.turn_id) || current;
      if (turn) {
        if (payload.type === 'turn_aborted') turn.status = 'interrupted';
        else if (payload.error) turn.status = 'failed';
        else if (['completed', 'inProgress'].includes(turn.status)) turn.status = 'completed';
        turn.completedAt = payload.completed_at ?? null;
        if (end(payload.type) && turn === current) finish();
      }
    } else if (payload.type === 'user_message') {
      if (
        typeof payload.message !== 'string' ||
        (payload.text_elements !== undefined && !Array.isArray(payload.text_elements))
      ) {
        issues.push({ code: 'INVALID_LEGACY_USER', sourceRecordId: recordId });
        continue;
      }
      if (
        current &&
        !current.openedExplicitly &&
        !(current.sawCompaction && current.items.length === 0)
      )
        finish();
      ensure(index).items.push({
        type: 'UserMessage',
        id: `legacy-user-${recordId}`,
        content: legacyInputs(payload),
        nativeUserItemId: null,
        nativeReceiptRecordId: recordId,
      });
    } else if (['entered_review_mode', 'exited_review_mode'].includes(payload.type)) {
      marker(
        payload,
        {
          type: payload.type === 'entered_review_mode' ? 'EnteredReviewMode' : 'ExitedReviewMode',
          id: payload.item_id || `legacy-review-${recordId}`,
        },
        index,
      );
    } else if (lifecycle(payload.type)) {
      const item = payload.item;
      if (!item) continue;
      if (entered(item) || exited(item)) marker(payload, { ...item }, index);
      else if (legacyItemTypes.has(item.type) || (item.type === 'Plan' && item.text)) {
        const turn = find(payload.turn_id);
        if (turn) upsert(turn, { type: item.type, id: item.id });
      }
      // UserMessage lifecycle records do not produce legacy UserHistoryCells.
    } else if (payload.type === 'thread_rolled_back') {
      finish();
      turns.splice(Math.max(0, turns.length - Math.max(0, payload.num_turns || 0)));
    } else if (payload.type === 'error') {
      const info = payload.codex_error_info;
      const doesNotAffectStatus =
        info === 'thread_rollback_failed' ||
        (info && typeof info === 'object' && Object.hasOwn(info, 'active_turn_not_steerable'));
      if (current && !doesNotAffectStatus) current.status = 'failed';
    } else if (
      createsCurrent.has(payload.type) ||
      (['agent_message', 'agent_reasoning', 'agent_reasoning_raw_content'].includes(payload.type) &&
        (payload.message || payload.text))
    ) {
      ensure(index).items.push({ type: 'Other', id: `other-${recordId}` });
    } else if (createsScoped.has(payload.type)) {
      const turn = payload.turn_id ? find(payload.turn_id) : ensure(index);
      if (turn) turn.items.push({ type: 'Other', id: `other-${recordId}` });
    } else if (['exec_command_begin', 'exec_command_end'].includes(payload.type)) {
      const turn = find(payload.turn_id);
      if (turn) turn.items.push({ type: 'Other', id: `other-${recordId}` });
    }
  }
  finish();
  return { turns, issues };
}

function reviewVisibility(
  lines,
  { historyMode, startItem = null, platform = process.platform } = {},
) {
  const decoded = decodeRecords(lines);
  const head =
    decoded.records.filter((record) => record.entry.type === 'session_meta').at(-1)?.entry
      .payload || {};
  const mode = historyMode || head.history_mode || 'legacy';
  if (!['legacy', 'paginated'].includes(mode))
    return { turns: [], users: [], complete: false, issues: [{ code: 'UNKNOWN_HISTORY_MODE' }] };
  const normalized =
    mode === 'paginated' ? canonicalTurns(decoded.records, head) : legacyTurns(decoded.records);
  const projected = projectReviewVisibility(normalized.turns, { startItem, platform });
  const issues = [...decoded.issues, ...normalized.issues, ...projected.issues];
  return {
    ...projected,
    turns: normalized.turns,
    historyMode: mode,
    complete: issues.length === 0,
    issues,
  };
}

module.exports = {
  reviewVisibility,
  projectReviewVisibility,
  isHiddenNestedReviewTurn,
  legacyInputs,
  normalizeInput,
};
