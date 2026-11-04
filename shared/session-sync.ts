export const LIMIT = 200;
export interface HistoryMessage {
  id: string;
  [field: string]: unknown;
}
export interface LocalHistory {
  revision: string;
  messages: HistoryMessage[];
}
export interface HistoryDelta {
  replace?: boolean;
  base?: string;
  after?: string | null;
  messages: HistoryMessage[];
}
export interface Pane {
  paneId: string;
  [field: string]: unknown;
}
export interface Topology {
  runtimeId?: string;
  version?: string;
  protocol?: number;
  focusedWorkspaceId?: string;
  focusedTabId?: string;
  tabs?: unknown[];
  layouts?: unknown[];
}
export interface Snapshot extends Topology {
  hash: string;
  rootDirectory: string;
  focusedPaneId: string;
  workspaces: unknown[];
  panes: Pane[];
}
export interface SnapshotChange extends Topology {
  hash: string;
  full?: boolean;
  rootDirectory?: string;
  focusedPaneId?: string;
  workspaces?: unknown[];
  panes?: Pane[];
  removed?: string[];
  order?: string[];
}

/**
 * 把一次变化应用到本地的消息上。
 * @returns {object[]|null} 新的消息列表；接不上（锚点不在本地、版本对不上）返回 null。
 */
export function applyDelta(
  local: LocalHistory | null,
  event: HistoryDelta,
): HistoryMessage[] | null {
  if (event.replace) return event.messages.slice(-LIMIT);
  if (!local || (event.base && local.revision !== event.base)) return null;
  const index = local.messages.findIndex((message) => message.id === event.after);
  if (index < 0) return null;
  return local.messages
    .slice(0, index + 1)
    .concat(event.messages)
    .slice(-LIMIT);
}

/** 快照的变化：只带变了的 pane、消失的 pane 与顺序（lib/sync/hub.js 的 snapshotChange）。 */
export function applySnapshot(previous: Snapshot | null, change: SnapshotChange): Snapshot {
  if (change.full) previous = null;
  const byId = new Map(
    (change.full ? [] : previous?.panes || []).map((pane) => [pane.paneId, pane]),
  );
  for (const id of change.removed || []) byId.delete(id);
  for (const pane of change.panes || []) byId.set(pane.paneId, pane);
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
      .filter((pane): pane is Pane => Boolean(pane)),
  };
}
