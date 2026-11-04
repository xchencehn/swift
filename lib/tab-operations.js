'use strict';

const fail = (message) =>
  Object.assign(new Error(message), { code: 'TARGET_CHANGED', status: 409 });
const identity = (pane) => [pane.paneId, pane.terminalId, pane.agent?.session?.value || ''];
const membersOf = (view, id) => view.panes.filter((p) => p.tabId === id);
const locks = new WeakSet();

async function exclusive(herdr, run) {
  if (locks.has(herdr)) throw fail('Tab 正在整理，请刷新后重试。');
  locks.add(herdr);
  try {
    return await run();
  } finally {
    locks.delete(herdr);
  }
}
function checkRuntime(view, expected) {
  if (view.runtimeId && view.runtimeId !== expected?.runtimeId)
    throw fail('Herdr 运行实例已经改变，请刷新。');
}
async function separate(herdr, view, tabId, expected) {
  return exclusive(herdr, async () => {
    const members = membersOf(view, tabId);
    if (JSON.stringify(members.map(identity)) !== JSON.stringify(expected?.members))
      throw fail('Tab 中的会话已经改变，请刷新后重试。');
    const original = view.tabs.find((t) => t.tab_id === tabId);
    const moved = [];
    // Keep the first terminal in its native Tab. Moving the others preserves
    // terminal IDs, processes and agent sessions; native pane IDs can change.
    for (const member of members.slice(1)) {
      const current = await herdr.dashboard();
      checkRuntime(current, expected);
      const occupants = membersOf(current, tabId);
      if (
        JSON.stringify(occupants.map(identity)) !==
        JSON.stringify(
          members.filter((p) => !moved.some((m) => m.terminalId === p.terminalId)).map(identity),
        )
      )
        throw fail('Tab 中的会话已经改变，请刷新后重试。');
      const label = member.label || member.agent?.name || original.label;
      await herdr.request('pane.move', {
        pane_id: member.paneId,
        destination: { type: 'new_tab', workspace_id: original.workspace_id, label },
        focus: false,
      });
      const next = await herdr.dashboard();
      checkRuntime(next, expected);
      const pane = next.panes.find((p) => p.terminalId === member.terminalId);
      if (
        !pane ||
        pane.tabId === tabId ||
        pane.agent?.session?.value !== member.agent?.session?.value
      )
        throw fail('会话移动结果未确认，请刷新后核对。');
      const siblings = next.tabs.filter((t) => t.workspace_id === original.workspace_id);
      await herdr.request('tab.move', {
        tab_id: pane.tabId,
        insert_index: siblings.findIndex((t) => t.tab_id === tabId) + moved.length + 1,
      });
      moved.push(pane);
    }
    const selected = moved.find((p) => p.terminalId === expected?.terminalId);
    return {
      separated: moved.map((p) => ({
        pane_id: p.paneId,
        terminal_id: p.terminalId,
        tab_id: p.tabId,
      })),
      selected_pane_id: selected?.paneId,
    };
  });
}
async function move(herdr, view, params, expected) {
  return exclusive(herdr, async () => {
    const current = await herdr.dashboard();
    checkRuntime(current, expected);
    const members = membersOf(current, params.tab_id),
      pane = members[0];
    if (
      members.length !== 1 ||
      !expected?.terminalId ||
      pane.terminalId !== expected.terminalId ||
      (expected.sessionId && pane.agent?.session?.value !== expected.sessionId)
    )
      throw fail('Tab 中的会话已经改变，请重新选择。');
    if (pane.workspaceId === params.workspace_id) return {};
    if (!current.workspaces.some((w) => w.workspaceId === params.workspace_id))
      throw fail('目标 Space 已经离开，请重新选择。');
    return herdr.request('pane.move', {
      pane_id: pane.paneId,
      destination: {
        type: 'new_tab',
        workspace_id: params.workspace_id,
        label: view.tabs.find((t) => t.tab_id === params.tab_id).label,
      },
      focus: false,
    });
  });
}
module.exports = { separate, move };
