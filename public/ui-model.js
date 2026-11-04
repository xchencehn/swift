(function initStudioUiModel(root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.StudioUi = model;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const STORAGE_VERSION = 6;
  const DEFAULT_PREFS = Object.freeze({
    version: STORAGE_VERSION,
    haptics: true,
    keepAwake: false,
  });

  function cloneDefaults() {
    return { ...DEFAULT_PREFS };
  }

  function sanitizePrefs(value) {
    return {
      version: STORAGE_VERSION,
      haptics: typeof value?.haptics === 'boolean' ? value.haptics : DEFAULT_PREFS.haptics,
      keepAwake: typeof value?.keepAwake === 'boolean' ? value.keepAwake : DEFAULT_PREFS.keepAwake,
    };
  }

  function providerId(pane) {
    const native = String(pane?.agent?.label || '').toLowerCase();
    if (!pane?.agent) return 'shell';
    if (native === 'claude code') return 'claude';
    if (native) return native;
    const name = String(pane.agent.name || '').toLowerCase();
    if (/^claude(?: code)?(?:-|$)/.test(name)) return 'claude';
    if (/^codex(?:-|$)/.test(name)) return 'codex';
    return 'unknown';
  }

  // Only the protocol enumeration describes lifecycle. Free-form messages do not.
  const AGENT_STATUS_KINDS = Object.freeze({
    idle: 'idle',
    working: 'working',
    blocked: 'blocked',
    done: 'done',
    unknown: 'unknown',
  });
  function statusKind(pane) {
    if (!pane?.agent) return 'shell';
    const reported = String(
      pane.agent.status || pane.agent_status || pane.status || '',
    ).toLowerCase();
    return AGENT_STATUS_KINDS[reported] || 'unknown';
  }
  function activityKind(pane, connected = true) {
    return connected ? statusKind(pane) : 'offline';
  }

  // Completion is independent of archive recency and other Herdr clients' seen state.
  // Older servers need an observed working state; restored idle is never completion.
  function createCompletionTracker() {
    const states = new Map();
    let serial = 0;
    const epoch = Date.now();
    const identity = (pane) =>
      JSON.stringify([
        pane?.terminalId || pane?.paneId,
        providerId(pane),
        pane?.agent?.session?.value || pane?.agent?.name || '',
        pane?.agent?.completionScope || '',
      ]);
    const nativeKey = (pane) => {
      const agent = pane?.agent;
      if (!agent || !Object.hasOwn(agent, 'completionSeq')) return undefined;
      return Number.isSafeInteger(agent.completionSeq) &&
        agent.completionSeq > 0 &&
        agent.completionSeq === agent.stateChangeSeq
        ? `completion:${identity(pane)}:${agent.completionSeq}`
        : null;
    };
    function observe(panes) {
      const live = new Set();
      for (const pane of panes) {
        const id = identity(pane);
        live.add(id);
        const previous = states.get(id) || { worked: false, key: null };
        const status = statusKind(pane);
        if (status === 'working') {
          previous.worked = true;
          previous.key = null;
        }
        if (['idle', 'done'].includes(status) && previous.worked) {
          previous.key = `completion:${id}:observed:${epoch}:${++serial}`;
          previous.worked = false;
        }
        states.set(id, previous);
      }
      for (const id of states.keys()) if (!live.has(id)) states.delete(id);
    }
    function key(pane) {
      if (!['idle', 'done'].includes(statusKind(pane))) return null;
      const native = nativeKey(pane);
      return native === undefined ? states.get(identity(pane))?.key || null : native;
    }
    return { observe, key, unread: (pane, seen) => Boolean(key(pane) && !seen[key(pane)]) };
  }

  function messageSegments(message) {
    const segments = [];
    for (const block of message.blocks || []) {
      const tools = block.kind === 'tools';
      const last = segments.at(-1);
      if (last && (last.blocks[0].kind === 'tools') === tools) last.blocks.push(block);
      else segments.push({ ...message, blocks: [block] });
    }
    return segments;
  }

  // Conversation titles are a read-only projection; tab labels describe a layout.
  function sessionLabel(pane) {
    if (!pane?.agent)
      return pane?.agentTitle || pane?.title || pane?.tabTitle || pane?.tab || '终端';
    return (
      pane.sessionTitle ||
      pane.agentTitle ||
      pane.agent.name ||
      pane.title ||
      pane.paneId ||
      '未命名会话'
    );
  }
  function sessionTooltip(pane) {
    return [pane?.sessionFullTitle, pane?.workspace, pane?.tabTitle || pane?.tab, pane?.paneId]
      .filter(Boolean)
      .join(' · ');
  }

  function recentPanes(panes, outbox = {}) {
    const timestamp = (value) => (typeof value === 'number' ? value : Date.parse(value || '') || 0);
    const latest = (pane) =>
      Math.max(
        timestamp(pane.lastMessageAt),
        ...(outbox[pane.paneId] || [])
          .filter(
            (item) =>
              !['cancelled', 'failed', 'discarded'].includes(item.status) &&
              item.historyDiscardedAt == null &&
              (!item.sessionId || item.sessionId === pane.agent?.session?.value),
          )
          .map((item) => timestamp(item.createdAt)),
      );
    return panes
      .map((pane, index) => ({ pane, index, at: latest(pane) }))
      .sort((a, b) => b.at - a.at || a.index - b.index)
      .map((item) => item.pane);
  }

  // Presentation reconciliation: one archive record can replace one submission
  // or an explicitly combined native batch, never every repeated equal prompt.
  function visibleOutbox(items, messages) {
    const users = messages.filter((m) => m.role === 'user');
    // 终端提交会把两头的空白都去掉，比对要按它实际的行为来 —— 只去尾的话，
    // 带前导空白的消息在页面上会一直挂着「等待确认」（见 lib/message-queue.js）。
    // 带附件的消息，附件行已被拆成图片块，原文在 sourceText（与 lib/message-queue.js 的 userText 同一口径）。
    const text = (m) =>
      (
        m.sourceText ??
        (m.blocks || [])
          .filter((b) => b.kind === 'text')
          .map((b) => b.text)
          .join('\n')
      )
        .replace(/\r\n/g, '\n')
        .trim();
    const normalize = (value) =>
      String(value || '')
        .replace(/\r\n/g, '\n')
        .trim();
    const claimed = new Set(
      items.filter((i) => i.consumedMessageId).map((i) => i.consumedMessageId),
    );
    const hidden = new Set();
    const oldest = messages.find((m) => m.ts)?.ts;
    for (const item of items) {
      // Accept legacy discard markers too, while an older server or cached
      // response is still in use. Abandoned history is never a retry bubble.
      if (
        ['cancelled', 'dispatched', 'discarded'].includes(item.status) ||
        item.historyDiscardedAt != null ||
        item.error?.code === 'HISTORY_DISCARDED'
      )
        hidden.add(item.id);
      // A delivery receipt does not depend on the visible history window.
      // Pagination, compaction and rollback must not recreate a local bubble.
      if (item.status === 'consumed' && item.consumedMessageId) hidden.add(item.id);
      if (
        item.status === 'consumed' &&
        oldest &&
        new Date(item.consumedAt).getTime() < new Date(oldest).getTime()
      )
        hidden.add(item.id);
    }
    const groups = [];
    for (const item of items) {
      if (
        item.authoritative ||
        hidden.has(item.id) ||
        (item.status === 'consumed' && item.consumedMessageId) ||
        item.status === 'queued' ||
        (item.status === 'failed' && !item.deliveryUncertain)
      )
        continue;
      let group = item.batchId && groups.find((g) => g[0].batchId === item.batchId);
      if (!group) {
        group = [];
        groups.push(group);
      }
      group.push(item);
    }
    for (let start = 0; start < groups.length; start++) {
      if (groups[start].some((i) => hidden.has(i.id))) continue;
      for (let end = start; end < groups.length; end++) {
        const group = groups.slice(start, end + 1).flat();
        if (group.some((i) => hidden.has(i.id))) break;
        const parts = groups
          .slice(start, end + 1)
          .map((g) => normalize(g[0].dispatchText || g.map((i) => i.text).join('\n\n')));
        const match = users.find(
          (m, index) =>
            !claimed.has(m.id) &&
            group.every((i) => {
              const last = users.findIndex((u) => u.id === i.baseline?.lastMessageId);
              return (
                !(i.archiveBaselineIds || []).includes(m.id) &&
                (last < 0 || index > last) &&
                new Date(m.ts).getTime() >= new Date(i.sendingAt ?? i.createdAt).getTime() - 1000
              );
            }) &&
            ['\n\n', '\n'].some((separator) => text(m) === parts.join(separator)),
        );
        if (match) {
          claimed.add(match.id);
          group.forEach((i) => hidden.add(i.id));
          break;
        }
      }
    }
    return items.filter((i) => !hidden.has(i.id));
  }

  // 列表按关键词筛。会话之间没有父子层级（附属会话 2026-09-23 随 app-server 一起拆掉了）。
  function sessionTree(panes, keyword = '') {
    const matches = (pane) =>
      !keyword || sessionLabel(pane).toLowerCase().includes(keyword.toLowerCase());
    return panes.filter(matches);
  }

  // Herdr groups linked worktrees only when the same repo has a parent Space.
  function workspaceEntries(workspaces, collapsed = () => false, selectedId = '') {
    const groups = new Map();
    for (const workspace of workspaces) {
      const key = workspace.worktree?.repo_key;
      if (key) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(workspace);
      }
    }
    const emitted = new Set(),
      entries = [];
    for (const workspace of workspaces) {
      const key = workspace.worktree?.repo_key,
        members = groups.get(key) || [];
      const grouped =
        members.some((w) => w.worktree.is_linked_worktree) &&
        members.some((w) => !w.worktree.is_linked_worktree);
      if (!grouped) {
        entries.push({ workspace, indented: false });
        continue;
      }
      if (emitted.has(key)) continue;
      emitted.add(key);
      const folded = collapsed(`worktree:${key}`);
      for (const parent of members.filter((w) => !w.worktree.is_linked_worktree))
        entries.push({
          workspace: parent,
          group: members,
          groupKey: `worktree:${key}`,
          folded,
          indented: false,
        });
      for (const child of members.filter((w) => w.worktree.is_linked_worktree))
        if (!folded || child.workspaceId === selectedId)
          entries.push({ workspace: child, indented: true });
    }
    return entries;
  }

  function resetCountdown(epochSeconds, now = Date.now()) {
    const minutes = Math.max(0, Math.ceil((epochSeconds * 1000 - now) / 60000));
    if (minutes >= 1440)
      return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
    if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
    return `${minutes}m`;
  }
  return {
    elapsedTime: (at, now = Date.now()) => {
      if (!Number.isFinite(Number(at)) || !Number(at)) return '—';
      const minutes = Math.max(0, Math.floor((now - Number(at)) / 60000)),
        hours = Math.floor(minutes / 60);
      return hours >= 24
        ? `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`
        : hours
          ? `${hours}h`
          : `${minutes}min`;
    },
    visibleOutbox,
    sessionTree,
    workspaceEntries,
    resetCountdown,
    STORAGE_VERSION,
    DEFAULT_PREFS,
    messageSegments,
    sessionLabel,
    sessionTooltip,
    recentPanes,
    cloneDefaults,
    sanitizePrefs,
    providerId,
    statusKind,
    activityKind,
    createCompletionTracker,
  };
});
