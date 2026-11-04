'use strict';
const { readStatusArea, isRule } = require('./agent-composer');
const { stripAnsi } = require('../public/ansi');
const { codexInteraction, codexModelField } = require('./codex-footer');
const { herdrRequest } = require('./herdr-input');
const { binding } = require('./conversation-state');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code, message) =>
  Object.assign(new Error(message), { status: 409, code, deliveryUncertain: false });

function composerState(raw, provider) {
  const area = readStatusArea(raw);
  if (provider === 'codex') {
    const native = codexInteraction(raw),
      { lines, prompt, footerIndex, fields } = native.footer;
    // A filled narrow composer may omit the directory and placeholder. Its
    // current model footer still identifies the editor; modal/side/history
    // surfaces never authorize clearing. The caller rechecks main afterward.
    const editor =
      !native.modal &&
      native.thread !== 'side' &&
      native.reading !== 'history' &&
      (native.inputTarget === 'composer' ||
        (native.inputTarget === 'unknown' &&
          native.reason === 'input-context-unconfirmed' &&
          fields.some(codexModelField)));
    const input =
      prompt >= 0 && footerIndex > prompt
        ? [lines[prompt].replace(/^\s*[›»]\s?/, ''), ...lines.slice(prompt + 1, footerIndex)]
            .join('\n')
            .trimEnd()
        : area.composer;
    return {
      recognized: editor,
      input: area.composerHint ? '' : input,
      refusal:
        native.thread === 'side'
          ? 'SIDE_ACTIVE'
          : native.modal
            ? 'QUESTION_PENDING'
            : 'NATIVE_INPUT_UNAVAILABLE',
    };
  }
  if (provider === 'claude') {
    const lines = stripAnsi(raw).split('\n'),
      bottom = lines.findLastIndex(isRule);
    const top = lines.findLastIndex((line, i) => i < bottom && isRule(line));
    return {
      recognized:
        top >= 0 &&
        bottom > top &&
        lines.slice(top + 1, bottom).some((line) => /^\s*❯(?:\s|$)/.test(line)),
      input: area.composerHint
        ? ''
        : top >= 0
          ? lines
              .slice(top + 1, bottom)
              .map((line, i) => (i ? line.replace(/^ {1,2}/, '') : line.replace(/^\s*❯\s?/, '')))
              .join('\n')
              .trimEnd()
          : area.composer,
    };
  }
  return { recognized: false, input: '' };
}

// Called only for an explicit operation, while its per-pane operation lock is
// held. Clearing never submits, interrupts, or changes the browser's draft.
async function clearNativeComposer({
  pane,
  herdr,
  exactPane,
  screen,
  press,
  timeoutMs = 8000,
  stepMs = 40,
}) {
  const provider = pane.agent?.label?.toLowerCase();
  if (!['codex', 'claude'].includes(provider)) return false;
  const expected = binding(pane);
  const verify = async () => {
    if (binding(await exactPane(pane.paneId)) !== expected)
      throw fail('SESSION_CHANGED', '目标会话已改变，未继续清空或发送。');
  };
  const read =
    screen || (() => herdr.readPane(pane.paneId, { lines: 160, ansi: true, exact: true }));
  const keys =
    press ||
    ((value) =>
      herdrRequest(
        'agent.send_keys',
        { target: pane.paneId, keys: value },
        { socketFile: herdr.socketPath },
      ));
  let state = composerState(await read(), provider);
  if (!state.input) return false;
  const until = Date.now() + timeoutMs;
  while (state.input) {
    if (!state.recognized)
      throw fail(
        state.refusal || 'NATIVE_INPUT_UNAVAILABLE',
        '未确认当前主会话输入框，未清空或发送。',
      );
    await verify();
    const current = composerState(await read(), provider);
    if (!current.recognized || current.input !== state.input)
      throw fail('NATIVE_INPUT_CHANGED', '原生输入已在检查期间改变，未继续清空或发送。');
    // Ctrl+E moves to the logical line end; Ctrl+U/K remove both sides and
    // adjacent newlines. Unlike Escape/Ctrl+C these do not stop an active turn.
    await keys(['ctrl+e', 'ctrl+u', 'ctrl+k']);
    await delay(stepMs);
    await verify();
    state = composerState(await read(), provider);
    if (!state.recognized)
      throw fail('NATIVE_INPUT_UNAVAILABLE', '清空期间原生界面已改变，未继续发送。');
    // Removing an empty logical line can leave the same visible text. Continue
    // bounded editing under the same identity instead of mistaking that for a
    // failed clear; no subsequent command is pasted before an empty readback.
    if (Date.now() >= until && state.input)
      throw fail('NATIVE_INPUT_CLEAR_UNCONFIRMED', '尚未确认原生输入框已清空，本次内容未发送。');
  }
  await verify();
  return true;
}
module.exports = { clearNativeComposer, composerState };
