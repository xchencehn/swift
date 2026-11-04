'use strict';

const { stripAnsi } = require('../public/ansi');
const { codexInteraction } = require('./codex-footer');
const { promptPattern } = require('../public/native-status');
const failure = (code, message) => Object.assign(new Error(message), { code, status: 409 });

// This is recognition of Codex's native navigation state, not a display filter.
// The affordance occupies the composer gap immediately above the prompt.
function codexBrowsing(raw) {
  return codexInteraction(raw).reading === 'history';
}

async function viewPane(herdr, target, expected) {
  async function verify() {
    const view = await herdr.dashboard();
    if (!expected || !expected.runtimeId || expected.runtimeId !== view.runtimeId)
      throw failure('RUNTIME_CHANGED', 'Herdr 运行实例已经改变，请重新选择会话。');
    const pane = view.panes.find((item) => item.paneId === target);
    if (
      !pane ||
      !expected.terminalId ||
      pane.terminalId !== expected.terminalId ||
      typeof expected.sessionId !== 'string' ||
      (pane.agent?.session?.value || '') !== expected.sessionId
    )
      throw failure('TARGET_CHANGED', '终端或 Agent 会话已经改变，请重新选择会话。');
    return pane;
  }
  let pane = await verify();
  await herdr.request('pane.focus', { pane_id: pane.paneId });
  pane = await verify();
  await herdr.request('pane.scroll', { pane_id: pane.paneId, offset_from_bottom: 0 });
  let agentScrolled = false;
  // Herdr scrollback and a fullscreen Agent's transcript are separate viewports.
  // Alt+> is Codex's JumpTarget::Latest (the Ctrl+End alternative supported
  // by Herdr 0.9.3 key parsing). Escape is also interrupt and must
  // never be used here. Ordinary shells and other providers receive no keys.
  if (pane.agent?.label?.toLowerCase() === 'codex') {
    const raw = await herdr.readPane(target, { source: 'recent', lines: 120, ansi: true });
    if (codexBrowsing(raw)) {
      await verify();
      await herdr.request('pane.send_keys', { pane_id: target, keys: ['alt+>'] });
      // A receipt means input acceptance, not a completed redraw. Wait for the
      // source view before Swift subscribes; do not flash the old navigation UI.
      let confirmed = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const latest = await herdr.readPane(target, { source: 'recent', lines: 120, ansi: true });
        if (
          !codexBrowsing(latest) &&
          stripAnsi(latest)
            .split(/\r?\n/)
            .some((line) => promptPattern.test(line))
        ) {
          confirmed = true;
          break;
        }
      }
      await verify();
      if (!confirmed)
        throw failure('NATIVE_VIEW_PENDING', '原生聊天视图尚未回到底部，请稍后重新选择会话。');
      agentScrolled = true;
    }
  }
  return { paneId: target, terminalId: pane.terminalId, agentScrolled };
}

module.exports = { viewPane, codexBrowsing };
