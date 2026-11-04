'use strict';
const crypto = require('node:crypto');
const { stripAnsi } = require('../public/ansi');
const { sendPaneKeys } = require('./herdr-input');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Match the native updater's own screen, never a message mentioning updates.
function updatePrompt(raw, provider) {
  const screen = stripAnsi(raw);
  if (
    provider !== 'codex' ||
    !screen.includes('Update available!') ||
    !screen.includes('https://github.com/openai/codex/releases/latest') ||
    !screen.includes('Skip until next version')
  )
    return null;
  const rows = [
    ...screen.matchAll(
      /^\s*([❯›>]?)\s*(?:\d+\.\s*)?(Update now \(runs `[^`]+`\)|Skip|Skip until next version)\s*$/gm,
    ),
  ];
  const selected = rows.findIndex((row) => row[1]),
    desired = rows.findIndex((row) => row[2].startsWith('Update now'));
  if (selected < 0 || desired < 0 || rows.length < 2) return null;
  return {
    screen,
    fingerprint: crypto.createHash('sha256').update(screen).digest('hex'),
    keys: [
      ...Array(Math.abs(desired - selected)).fill(desired < selected ? 'up' : 'down'),
      'enter',
    ],
  };
}
async function launchWithUpdates(
  herdr,
  args,
  pane,
  provider,
  { keys = sendPaneKeys, pollMs = 250, timeoutMs = 120000 } = {},
) {
  const seen = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    let settled = false,
      outcome;
    const launch = herdr
      .json(args, { timeoutMs })
      .then(
        (value) => {
          outcome = { value };
        },
        (error) => {
          outcome = { error };
        },
      )
      .finally(() => {
        settled = true;
      });
    let updated = false;
    const deadline = Date.now() + timeoutMs;
    while ((!settled || updated) && Date.now() < deadline) {
      await (settled ? pause(pollMs) : Promise.race([launch, pause(pollMs)]));
      if (settled && !updated) break;
      try {
        const current = await herdr.resolveTarget(pane.paneId);
        if (
          current.terminalId !== pane.terminalId ||
          (current.agent?.label && current.agent.label !== provider)
        )
          break;
        if (updated) {
          // Herdr's startup deadline can expire before a slow update finishes.
          // Keep this new pane until the updater exits or the Agent is ready.
          if (!current.agent?.label) break;
          if (['idle', 'done', 'working'].includes(current.agent?.status || current.status)) {
            await launch;
            return outcome.value || { paneId: pane.paneId, status: 'ready' };
          }
          continue;
        }
        const prompt = updatePrompt(await herdr.readPane(pane.paneId, { lines: 60 }), provider);
        if (!prompt || seen.has(prompt.fingerprint)) continue;
        const fresh = await herdr.resolveTarget(pane.paneId);
        if (fresh.terminalId !== pane.terminalId) break;
        const confirmation = updatePrompt(
          await herdr.readPane(pane.paneId, { lines: 60 }),
          provider,
        );
        if (confirmation?.fingerprint !== prompt.fingerprint) continue;
        seen.add(prompt.fingerprint);
        updated = true;
        await keys(pane.paneId, prompt.keys);
      } catch {
        /* no unverified key press; launch errors retain their normal path */
      }
    }
    await launch;
    if (!outcome.error) return outcome.value;
    // The updater may exit the old CLI after replacing its binary. Restart only
    // this newly launched pane, with exactly the same resume identity/arguments.
    if (updated && attempt === 0) {
      const current = await herdr.resolveTarget(pane.paneId);
      if (current.terminalId === pane.terminalId && !current.agent?.label) continue;
    }
    throw outcome.error;
  }
}
module.exports = { updatePrompt, launchWithUpdates };
