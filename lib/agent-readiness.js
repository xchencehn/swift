'use strict';

const { readStatusArea } = require('./agent-composer');
const { stripAnsi, matchActivityLine } = require('../public/ansi');

// Herdr 的 unknown 不能直接当作 idle。只接受已绑定原生会话、进程身份明确的
// Codex 当前可见画面：暗色空输入框和它下方的原生 Ready 状态栏必须同时存在。
function applyNativeReadiness(pane, screen) {
  if (
    pane.agent?.label !== 'codex' ||
    (pane.agent.status || pane.status) !== 'unknown' ||
    !pane.runtimeId ||
    !pane.agent.session?.value ||
    pane.agent.interactiveReady === false ||
    pane.agent.launchPending
  )
    return pane;
  const area = readStatusArea(screen);
  if (!area.composerHint || (area.activity && matchActivityLine(area.activity)?.running !== false))
    return pane;
  const lines = stripAnsi(screen).split('\n');
  const prompt = lines.findLastIndex((line) => /^\s*›\s/.test(line));
  if (prompt < 0) return pane;
  const footer = lines.slice(prompt + 1).filter((line) => line.trim());
  const ready = (line) =>
    /^\s*(?:GPT-|gpt-)/i.test(line) &&
    / · Ready(?: · |\s*$)/.test(line) &&
    / · Context\b/.test(line);
  if (
    !footer.some(ready) ||
    footer.some(
      (line) => !ready(line) && !/^\s*(?:← for agents · )?\? for shortcuts\s*$/.test(line),
    )
  )
    return pane;
  if (
    lines.some((line) =>
      /esc to interrupt|Would you like to|Press (?:Enter|Esc)|\[y\/N\]/i.test(line),
    )
  )
    return pane;
  return {
    ...pane,
    status: 'idle',
    agent: { ...pane.agent, status: 'idle', readinessSource: 'codex-native-screen' },
  };
}

module.exports = { applyNativeReadiness };
