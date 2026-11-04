'use strict';
const crypto = require('node:crypto');
const { stripAnsi } = require('../public/ansi');
const { sendPaneKeys } = require('./herdr-input');

// Only translate the known Claude directory trust prompt. Never send approval
// keys for an unrecognized screen or an occupant that changed since inspection.
async function readStartup(herdr, pane) {
  if (
    !/claude/i.test(pane.agent?.label || '') ||
    pane.agent?.session?.value ||
    (pane.agent?.status || pane.status) !== 'blocked'
  )
    return null;
  const screen = stripAnsi(await herdr.readPane(pane.paneId, { lines: 60 })).trim();
  if (
    !screen.includes('Accessing workspace:') ||
    !screen.includes('Yes, I trust this folder') ||
    !screen.includes('No, exit')
  )
    return null;
  const selected = screen
    .split('\n')
    .find((line) => /^\s*[❯>]\s*(No, exit|Yes, I trust this folder)/u.test(line));
  if (!selected || !pane.terminalId) return null;
  const cwd = screen.split('Accessing workspace:')[1].trim().split('\n')[0].trim();
  if (!cwd.startsWith('/')) return null;
  return {
    kind: 'directory-trust',
    paneId: pane.paneId,
    cwd,
    selected: selected.includes('No, exit') ? 'reject' : 'trust',
    challenge: crypto
      .createHash('sha256')
      .update(
        JSON.stringify([pane.paneId, pane.terminalId, pane.agent.name, pane.agent.label, screen]),
      )
      .digest('hex'),
  };
}

async function answerStartup(herdr, pane, { challenge, choice }) {
  if (!['trust', 'reject'].includes(choice))
    throw Object.assign(new Error('请选择信任目录或退出。'), { status: 400 });
  const prompt = await readStartup(herdr, pane);
  if (!prompt || prompt.challenge !== challenge)
    throw Object.assign(new Error('启动画面已变化，请刷新后重新确认。'), { status: 409 });
  const keys =
    prompt.selected === choice ? ['enter'] : [choice === 'trust' ? 'down' : 'up', 'enter'];
  await sendPaneKeys(pane.paneId, keys);
  return { paneId: pane.paneId, choice };
}
module.exports = { readStartup, answerStartup };
