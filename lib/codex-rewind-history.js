'use strict';

// Candidate only. The caller supplies original, fully reconstructed native
// JSONL lines and the matching full parsed messages from one archive snapshot.
const { createHash } = require('node:crypto');
const Conversation = require('./conversation-state');
const { reviewVisibility } = require('./codex-review-visibility');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function rewindHistory(lines, messages, { branch = null, historyMode } = {}) {
  const projection = reviewVisibility(lines, { historyMode });
  const projectionIssues = [...projection.issues],
    seenItems = new Set(),
    seenReceipts = new Set();
  for (const user of projection.users) {
    for (const [id, seen] of [
      [user.nativeUserItemId, seenItems],
      [user.nativeReceiptRecordId, seenReceipts],
    ]) {
      if (!id) continue;
      if (seen.has(id)) projectionIssues.push({ code: 'DUPLICATE_NATIVE_USER_ID', id });
      seen.add(id);
    }
  }
  const projectedByItem = new Map(
    projection.users
      .filter((user) => user.nativeUserItemId)
      .map((user) => [user.nativeUserItemId, user]),
  );
  const projectedByReceipt = new Map(
    projection.users
      .filter((user) => user.nativeReceiptRecordId)
      .map((user) => [user.nativeReceiptRecordId, user]),
  );
  const byId = new Map();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const same = byId.get(message.id) || [];
    same.push(message);
    byId.set(message.id, same);
  }
  let targets = [];
  const issues = projectionIssues,
    nativeItems = new Map(),
    nativeReceipts = new Map();
  const awaitingReceipts = new Map(),
    sourceKeys = new WeakMap();
  let turnId = null;
  for (const record of Conversation.effectiveEntries('codex', lines)) {
    const entry = record.entry,
      payload = entry.payload || {};
    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      turnId = payload.turn_id || null;
    }
    if (entry.type === 'response_item' && payload.type === 'message') {
      if (payload.role !== 'user') continue;
      const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
      const messageId = payload.id || `user-${Conversation.stableId(record.raw)}`;
      const candidates = byId.get(messageId) || [],
        parsed = candidates.length === 1 ? candidates[0] : null;
      const content = Array.isArray(payload.content) ? payload.content : [];
      const sourceText = content
        .filter((item) => ['input_text', 'text', 'output_text'].includes(item?.type))
        .map((item) => item.text || '')
        .join('');
      // Images derived by Swift from an ordinary text path are still text in
      // Codex. Only original native non-text content needs media restoration.
      const directMedia = content.some((item) => !['input_text', 'text'].includes(item?.type));
      const target = {
        messageId,
        turnId,
        sourceText,
        visibleIndex: targets.length,
        nativeUserItemId: null,
        nativeReceiptRecordId: null,
        sourceRecordId: Conversation.stableId(record.raw),
        sourceOrdinal: Number.isSafeInteger(entry.ordinal) ? entry.ordinal : null,
        supported: true,
        reason: '',
        receiptVerified: false,
        explicitHuman:
          Array.isArray(kinds) && kinds.some((kind) => ['user.text', 'user.image'].includes(kind)),
      };
      if (!parsed) {
        target.supported = false;
        target.reason = '这条消息无法唯一对应原生记录，请刷新后重新选择。';
      } else if (directMedia || !sourceText.trim()) {
        target.supported = false;
        target.reason = '这条消息含有原生图片等附件，请在终端中编辑，以保留完整附件。';
      }
      const sourceKey = digest([turnId, sourceText]),
        awaiting = awaitingReceipts.get(sourceKey) || new Set();
      awaiting.add(target);
      awaitingReceipts.set(sourceKey, awaiting);
      sourceKeys.set(target, sourceKey);
      targets.push(target);
      continue;
    }
    if (entry.type !== 'event_msg') continue;
    const item =
      payload.type === 'item_completed' && payload.item?.type === 'UserMessage'
        ? payload.item
        : null;
    if (item || payload.type === 'user_message') {
      const recordId = Conversation.stableId(record.raw);
      const projected = item ? projectedByItem.get(item.id) : projectedByReceipt.get(recordId);
      // The official history mode determines which persisted events actually
      // produce UserHistoryCells; do not mix legacy fanout and canonical items.
      if (!projected) continue;
      const receiptText = item
        ? (item.content || [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text || '')
            .join('')
        : payload.message;
      const scoped = awaitingReceipts.get(digest([projected.turnId, receiptText]));
      const unscoped = awaitingReceipts.get(digest([null, receiptText]));
      const exactCount = (scoped?.size || 0) + (projected.turnId == null ? 0 : unscoped?.size || 0);
      const ambiguousSource = !(item?.id && nativeItems.has(item.id)) && exactCount > 1;
      const candidate = ambiguousSource
        ? null
        : (item?.id && nativeItems.get(item.id)) ||
          scoped?.values().next().value ||
          unscoped?.values().next().value;
      if (
        candidate &&
        (candidate.turnId == null || candidate.turnId === projected.turnId) &&
        typeof receiptText === 'string' &&
        receiptText === candidate.sourceText &&
        projected.turnId
      ) {
        if (!candidate.receiptVerified) {
          const sourceKey = sourceKeys.get(candidate),
            awaiting = awaitingReceipts.get(sourceKey);
          awaiting?.delete(candidate);
          if (!awaiting?.size) awaitingReceipts.delete(sourceKey);
        }
        candidate.receiptVerified = true;
        candidate.turnId = projected.turnId;
        candidate.turnIdSource = projected.turnIdSource;
        candidate.turnIdVerified = projected.turnIdVerified;
        candidate.nativeUserItemId = projected.nativeUserItemId || null;
        candidate.nativeReceiptRecordId = projected.nativeReceiptRecordId;
        candidate.visible = projected.visible;
        candidate.isSteer = projected.isSteer;
        if (candidate.nativeUserItemId) nativeItems.set(candidate.nativeUserItemId, candidate);
        nativeReceipts.set(candidate.nativeReceiptRecordId, candidate);
      } else if (projected.visible)
        issues.push({ code: 'NATIVE_USER_ORDER_UNVERIFIED', sourceRecordId: recordId });
    }
    if (['task_complete', 'turn_aborted'].includes(payload.type)) turnId = null;
  }
  // The shared projection owns native visibility, order and steer detection,
  // including review mode, invisible primary inputs and hidden review turns.
  const sources = targets;
  targets = projection.users
    .filter((user) => user.visible)
    .flatMap((user) => {
      const target = user.nativeUserItemId
        ? nativeItems.get(user.nativeUserItemId)
        : nativeReceipts.get(user.nativeReceiptRecordId);
      if (!target) {
        issues.push({
          code: 'NATIVE_USER_SOURCE_UNVERIFIED',
          nativeUserItemId: user.nativeUserItemId,
          nativeReceiptRecordId: user.nativeReceiptRecordId,
        });
        return [];
      }
      return [target];
    });
  for (const target of targets) {
    if (target.turnIdVerified !== true) {
      target.supported = false;
      target.reason = '这条旧消息缺少可核验的原生轮次，请在终端中编辑。';
    }
    if (target.isSteer) {
      target.supported = false;
      target.reason = 'Codex 不能独立编辑运行中追加的这条消息，请编辑这一轮的第一条输入。';
    }
  }
  const included = new Set(targets),
    excludedMessageIds = sources
      .filter((target) => !included.has(target))
      .map((target) => target.messageId);
  targets.forEach((target, index) => {
    target.visibleIndex = index;
  });
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.messageId))
      issues.push({ messageId: target.messageId, code: 'DUPLICATE_MESSAGE_ID' });
    ids.add(target.messageId);
  }
  const revision = digest(
    targets.map((target) => [
      target.messageId,
      target.turnId,
      target.sourceRecordId,
      target.nativeUserItemId || target.nativeReceiptRecordId,
    ]),
  );
  return { revision, branch, targets, complete: issues.length === 0, issues, excludedMessageIds };
}

module.exports = { rewindHistory, digest };
