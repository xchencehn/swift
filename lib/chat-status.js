'use strict';
const { parseLine } = require('./json-lines');
const { resetCountdown } = require('../public/ui-model');
const { toRows } = require('../public/status-facts');
const { archivedSettings } = require('./agent-settings');

// 读原生存档里的结构化字段，而不是 TUI 已经省略过的那行文字。
function archivedStatus(provider, lines) {
  const settings = archivedSettings(provider, lines);
  let usage = null,
    cwd = '',
    rateLimits = null;
  for (const raw of lines) {
    let entry;
    try {
      entry = parseLine(raw);
    } catch {
      continue;
    }
    if (provider === 'codex' && entry.type === 'turn_context') cwd = entry.payload?.cwd || cwd;
    if (
      provider === 'codex' &&
      entry.type === 'event_msg' &&
      entry.payload?.type === 'token_count'
    ) {
      if (entry.payload.rate_limits) rateLimits = entry.payload.rate_limits;
      const info = entry.payload.info;
      if (info?.last_token_usage && info.model_context_window > 0) {
        usage = {
          tokens: info.last_token_usage.total_tokens,
          capacity: info.model_context_window,
          recordedAt: entry.timestamp,
        };
      }
    }
  }
  return { ...settings, cwd, usage, rateLimits };
}
// Cut a span run by character offsets so each piece keeps the colour the
// terminal drew it with.
function spanSlice(spans, start, end) {
  const out = [];
  let at = 0;
  for (const span of spans) {
    const text = span.text || '';
    const from = Math.max(start, at),
      to = Math.min(end, at + text.length);
    if (to > from) out.push({ ...span, text: text.slice(from - at, to - at) });
    at += text.length;
  }
  // ⚠️ **不削两端空白。** 切点落在事实边界上,分隔符和它后面那个空格是故意留给
  // 前一条事实的(见 docs/STATUS_WRAPPING.md):削掉之后拼回去就成了 `a ·b ·c`。
  // 旧的手工切点需要削边,是因为那些切点本来就落在半途。
  return out.filter((span) => span.text);
}

// The terminal pads a status line with runs of spaces to push its tail to the
// right edge. A phone has no such edge, so collapse those runs the same way
// the plain-text status does — otherwise the padding alone fills the line and
// pushes the facts out of sight.
function tidySpans(spans) {
  const out = [];
  let trailing = 0;
  for (const span of spans) {
    let text = (span.text || '').replace(/\s{2,}/g, '  ');
    if (!text) continue;
    if (trailing) {
      const lead = /^ */.exec(text)[0].length;
      if (lead) text = text.slice(Math.min(lead, Math.max(0, trailing + lead - 2)));
    }
    if (!out.length) text = text.replace(/^\s+/, '');
    if (!text) continue;
    trailing = / *$/.exec(text)[0].length;
    out.push({ ...span, text });
  }
  if (out.length)
    out[out.length - 1] = {
      ...out[out.length - 1],
      text: out[out.length - 1].text.replace(/\s+$/, ''),
    };
  return out.filter((span) => span.text);
}

/**
 * 按事实排版一行:切成事实、按语义分组成行,并在每条事实的第一个片段上打标记,
 * 让前端知道在哪儿可以换行。策略见 docs/STATUS_WRAPPING.md。
 *
 * 🔑 这里**不按宽度决定换行** —— 服务端不知道客户端多宽,网页、平板、手机、会话
 * APP 共用同一份数据。服务端只管「不管多宽都该分开」的那一刀,行内排到哪儿换由
 * 前端按真实宽度决定。
 *
 * 此前这里是给 Claude 的某一行写死的几个切点(模型/额度/主机/目录),换个模型名
 * 或多一个字段就落在错的位置,而 Codex 则完全没人管 —— 它那行一百多字符,在手机
 * 上被省略号吃掉后半截。
 */
function layoutRows(spans) {
  const line = spans.map((span) => span.text || '').join('');
  const rows = toRows(line);
  if (!rows.length) return [];
  return rows
    .map((row) => {
      const pieces = [];
      for (const fact of row.facts) {
        const cut = spanSlice(spans, fact.start, fact.end);
        if (!cut.length) continue;
        // 事实之间才可以换行,所以只标第一片。
        pieces.push({ ...cut[0], startsFact: true }, ...cut.slice(1));
      }
      return pieces;
    })
    .filter((row) => row.length);
}

function chatStatus(terminal, pane, archived, messages = [], confirmed = null) {
  if (/claude/i.test(pane.agent?.label || '')) {
    // Presentation only: the native permission mode and input handling stay intact.
    //
    // 权限模式那一行（`⏵⏵ bypass permissions on`）要保留并单独成行：它说明
    // 当前这个会话敢不敢直接动机器，是用户在终端上一眼就能看到的信息，网页上
    // 漏掉它等于少了一项安全提示。只剥掉后面那截按键提示（`shift+tab to cycle`）——
    // 网页上按不了 shift+tab，留着是假承诺。
    const isMode = (line) => /bypass permissions|accept edits|plan mode|^\s*[⏵▶►]/i.test(line);
    const isHint = (line) => /(?:shift|ctrl|tab).*\bcycle\b/i.test(line) && !isMode(line);
    const rows = (terminal.statusline || [])
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !isHint(line));
    const statusline = [],
      statusSpans = [],
      modeRows = [];
    for (const { line, index } of rows) {
      const spans = tidySpans(terminal.statusSpans?.[index] || [{ text: line }]);
      const target = isMode(line) ? modeRows : null;
      if (target) {
        // 去掉按键提示那一截，保留原有的颜色分段，让它和终端里长得一样。
        const trimmed = spans
          .map((span) => ({
            ...span,
            text: String(span.text).replace(/\s*\((?:shift|ctrl|tab)[^)]*\)/i, ''),
          }))
          .filter((span) => span.text);
        for (const row of layoutRows(trimmed)) target.push(row);
        continue;
      }
      for (const row of layoutRows(spans)) {
        statusSpans.push(row);
        statusline.push(row.map((span) => span.text).join(''));
      }
    }
    // 权限行排在最后，紧跟在当前目录那一行之后。
    for (const row of modeRows) {
      statusSpans.push(row);
      statusline.push(row.map((span) => span.text).join(''));
    }
    return { ...terminal, statusline, statusSpans };
  }
  if (String(pane.agent?.label).toLowerCase() !== 'codex' || !archived?.model) return terminal;
  // 🔑 状态行以终端画面为准，一比一复刻。
  //
  // 这里原本按存档字段重新拼一行，代价是**终端里有而我们没建的字段全部消失** ——
  // 实测丢掉了工作区名、分支名和 `Context n% used`。重拼的初衷是终端那行可能被
  // 窄屏截断，但那是回退场景，不该变成常态。
  //
  // 所以：终端给出完整的一行就直接用它（连颜色分段一起），只有在它被截断
  // （出现省略号）或根本没有时，才退回按存档重拼。
  const footer = (terminal.statusline || [])
    .map((line, index) => ({ line, index }))
    .find(
      ({ line }) =>
        /·/.test(line) &&
        new RegExp(archived.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(line),
    );
  if (footer && !/[…]|\.{3}/.test(footer.line)) {
    // Codex 那行一百多字符,塞着模型、强度、目录、仓库、分支、状态、上下文、额度
    // 七八条事实。照同一套策略切成事实,行内换行交给前端按真实宽度做。
    const spans = layoutRows(
      tidySpans(terminal.statusSpans?.[footer.index] || [{ text: footer.line }]),
    );
    const rest = (terminal.statusline || [])
      .map((line, index) => ({ line, index }))
      .filter(({ index }) => index !== footer.index)
      .flatMap(({ line, index }) =>
        layoutRows(tidySpans(terminal.statusSpans?.[index] || [{ text: line }])),
      );
    const statusSpans = [...spans, ...rest];
    return {
      ...terminal,
      statusline: statusSpans.map((row) => row.map((part) => part.text).join('')),
      statusSpans,
      statusSource: 'terminal',
    };
  }
  const settings =
    confirmed && Date.parse(confirmed.recordedAt) >= Date.parse(archived.recordedAt || 0)
      ? { ...archived, ...confirmed }
      : archived;
  const colors = {
    model: '#8fc7ff',
    effort: '#e8c47a',
    working: '#9bce78',
    idle: '#91bce5',
    blocked: '#e8c47a',
    done: '#c5a0ed',
    path: '#9fc9ba',
    muted: '#b0b0bb',
    quota: '#9bce78',
    warning: '#e8c47a',
    danger: '#ee929b',
  };
  const statusSpans = [];
  const span = (text, color) => ({ text, color });
  const model = [span(settings.model, colors.model)];
  if (settings.effort) model.push(span(' · ', colors.muted), span(settings.effort, colors.effort));
  const status = pane.agent?.status || pane.status;
  if (status) model.push(span(' · ', colors.muted), span(status, colors[status] || colors.muted));
  statusSpans.push(model);
  const cwd = pane.cwd || archived.cwd || pane.baseCwd;
  if (cwd) statusSpans.push([span(cwd, colors.path)]);
  const windows = [archived.rateLimits?.primary, archived.rateLimits?.secondary].filter(
    (window) => window && Number.isFinite(window.used_percent),
  );
  for (const window of windows) {
    const minutes = window.window_minutes;
    const label =
      minutes === 10080
        ? 'weekly'
        : minutes === 300
          ? '5h'
          : Number.isFinite(minutes) && minutes > 0
            ? `${minutes}min`
            : 'quota';
    // Codex RateLimitWindow exposes usage, not remaining quota. Convert only
    // here, where both the web UI and chat app receive their formatted status.
    const remainingPercent = Math.round(Math.max(0, Math.min(100, 100 - window.used_percent)));
    const color =
      window.used_percent >= 90
        ? colors.danger
        : window.used_percent >= 70
          ? colors.warning
          : colors.quota;
    const row = [
      span(`${label} `, colors.muted),
      span(`${remainingPercent}%`, color),
      span(' left', colors.muted),
    ];
    if (Number.isFinite(window.resets_at))
      row.push(span(' · resets ', colors.muted), {
        ...span(resetCountdown(window.resets_at), colors.effort),
        resetsAt: window.resets_at,
      });
    statusSpans.push(row);
  }
  // Tool history describes calls and background handles, not the agent's
  // current activity. Multiple records can refer to the same running process;
  // do not turn that history into a synthetic waiting count or status line.
  // Retain any additional terminal facts that are complete (e.g. permissions),
  // but replace the model/context footer that may already have been truncated.
  for (const line of terminal.statusline || []) {
    if (!/gpt-|Context|tokens?\b/i.test(line) && !/[…]|\.{3}/.test(line))
      statusSpans.push([span(line, colors.muted)]);
  }
  return {
    ...terminal,
    statusline: statusSpans.map((row) => row.map((part) => part.text).join('')),
    statusSpans,
    statusSource: 'session',
    statusRecordedAt: archived.recordedAt,
    usageRecordedAt: archived.usage?.recordedAt || null,
  };
}
module.exports = { archivedStatus, chatStatus, layoutRows, tidySpans };
