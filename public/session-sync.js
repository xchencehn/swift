// Generated from shared/session-sync.ts; do not edit.
(function (root) {
  const exports = {};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIMIT = void 0;
exports.applyDelta = applyDelta;
exports.applySnapshot = applySnapshot;
exports.LIMIT = 200;
/**
 * 把一次变化应用到本地的消息上。
 * @returns {object[]|null} 新的消息列表；接不上（锚点不在本地、版本对不上）返回 null。
 */
function applyDelta(local, event) {
    if (event.replace)
        return event.messages.slice(-exports.LIMIT);
    if (!local || (event.base && local.revision !== event.base))
        return null;
    const index = local.messages.findIndex((message) => message.id === event.after);
    if (index < 0)
        return null;
    return local.messages
        .slice(0, index + 1)
        .concat(event.messages)
        .slice(-exports.LIMIT);
}
/** 快照的变化：只带变了的 pane、消失的 pane 与顺序（lib/sync/hub.js 的 snapshotChange）。 */
function applySnapshot(previous, change) {
    if (change.full)
        previous = null;
    const byId = new Map((change.full ? [] : previous?.panes || []).map((pane) => [pane.paneId, pane]));
    for (const id of change.removed || [])
        byId.delete(id);
    for (const pane of change.panes || [])
        byId.set(pane.paneId, pane);
    return {
        hash: change.hash,
        rootDirectory: change.rootDirectory ?? previous?.rootDirectory ?? '',
        focusedPaneId: change.focusedPaneId ?? previous?.focusedPaneId ?? '',
        workspaces: change.workspaces || previous?.workspaces || [],
        runtimeId: change.runtimeId ?? previous?.runtimeId,
        version: change.version ?? previous?.version,
        protocol: change.protocol ?? previous?.protocol,
        focusedWorkspaceId: change.focusedWorkspaceId ?? previous?.focusedWorkspaceId,
        focusedTabId: change.focusedTabId ?? previous?.focusedTabId,
        tabs: change.tabs ?? previous?.tabs ?? [],
        layouts: change.layouts ?? previous?.layouts ?? [],
        panes: (change.order || [...byId.keys()])
            .map((id) => byId.get(id))
            .filter((pane) => Boolean(pane)),
    };
}

  if (typeof module === 'object' && module.exports) module.exports = exports;
  else root.StudioSessionSync = exports;
})(typeof globalThis === 'undefined' ? this : globalThis);
