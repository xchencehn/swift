(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./ansi') : root.StudioAnsi,
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioNativeStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ansi) {
  'use strict';
  const { matchActivityLine } = ansi;
  const textOf = (row) => row.map((span) => span.text).join('');
  const promptPattern = /^\s*[›❯»](?:\s|$)/;
  const promptHint =
    /^\s*[›❯»]\s*(?:Ask Codex(?: to do anything)?|Ask a follow-up question|Write a message)?\s*$/i;
  const browsingHint = /^(?:New activity\s*[·•]\s*)?↓\s+Back to bottom(?:\s*[·•]\s*esc)?$/i;

  function columnWidth(text) {
    return Array.from(text).reduce(
      (total, c) =>
        total +
        (/\p{Mark}/u.test(c)
          ? 0
          : /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(
                c,
              )
            ? 2
            : 1),
      0,
    );
  }
  function columnSlice(text, left, right) {
    let column = 0,
      result = '';
    for (const c of text) {
      const width = columnWidth(c);
      if (column >= left && column + width <= right) result += c;
      column += width;
      if (column >= right) break;
    }
    return result;
  }
  function panelKind(title) {
    if (title === 'Approaching rate limits') return 'rate-limit';
    if (title === 'Resume paused goal?') return 'goal-resume';
    if (title === 'Replace goal?') return 'goal-replace';
    if (/permission|allow|approval|run this command|apply.*change/i.test(title)) return 'approval';
    if (/model|reasoning|effort/i.test(title)) return 'model-settings';
    if (/sign in|log in|authentication|verif(?:y|ication)/i.test(title)) return 'authentication';
    if (/^Field \d+\/\d+|request.*input|provide.*information/i.test(title)) return 'form';
    if (/Tell us more|Custom prompt|Prompt arguments/i.test(title)) return 'form';
    if (/Folder access|Trust this folder/i.test(title)) return 'directory-trust';
    if (
      /skills|experimental|status line|terminal title|settings|configuration|memories/i.test(title)
    )
      return 'configuration';
    if (/shortcuts|keyboard|help/i.test(title)) return 'help';
    if (/^Warnings\b/i.test(title)) return 'warnings';
    return 'selection';
  }
  const panelFooter = (line) =>
    /\benter (?:to )?(?:select|confirm|apply|submit|default|continue)\b/i.test(line) &&
    /\besc (?:to )?(?:back|cancel|close|go back|quit|skip)\b/i.test(line);
  const auxiliaryFooter = (line) =>
    /\b(?:space(?:\/enter)? toggle|enter save)\b.*\besc (?:save\/close|close|cancel)\b/i.test(
      line,
    ) ||
    /\bk keep\s*&\s*next\b.*\besc dismiss\s*&\s*close\b/i.test(line) ||
    /^\s*(?:Press )?esc to cancel this request\s*$/i.test(line);
  const panelKey = (lines) =>
    JSON.stringify(
      lines.map((line) =>
        line
          .replace(/^\s*[›❯»>](?=\s*\d+\.)/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    );
  function rateLimitPanel(rows) {
    const text = rows.map(textOf),
      end = text.findLastIndex((line) => line.trim());
    if (end < 0 || !/^\s*enter select\s*·\s*esc back\s*$/i.test(text[end])) return null;
    const start = text.findLastIndex(
      (line, i) => i < end && i >= end - 32 && line.trim() === 'Approaching rate limits',
    );
    if (start < 0) return null;
    const lines = text.slice(start, end + 1).map((line) => line.trimEnd());
    const options = lines
      .map((line) => /^\s*([›❯»>]?)\s*(\d+)\.\s+(.+?)\s*$/.exec(line))
      .filter(Boolean);
    const labels = options.map((option) => option[3].split(/\s{2,}/)[0]);
    const model = /^Switch to ([\w.-]+)$/.exec(labels[0] || '')?.[1];
    const first = lines.findIndex((line) => /^\s*[›❯»>]?\s*1\./.test(line));
    const subtitle = lines.slice(1, first).join(' ').replace(/\s+/g, ' ').trim();
    // Recognize this complete native prompt even when ANSI title styling is
    // absent. A title in history or an incomplete/changed menu is insufficient.
    if (
      !model ||
      options.length !== 3 ||
      options.some((option, i) => Number(option[2]) !== i + 1) ||
      options.filter((option) => option[1]).length !== 1 ||
      labels[1] !== 'Keep current model' ||
      labels[2] !== 'Keep current model (never show again)' ||
      subtitle !== `Switch to ${model} for lower credit usage?`
    )
      return null;
    return {
      kind: 'rate-limit',
      title: 'Approaching rate limits',
      lines,
      key: panelKey(lines),
      numbered: true,
      rect: { left: 0, right: Math.max(...lines.map(columnWidth)), top: start, bottom: end },
    };
  }
  const proactiveTitles =
    /^(?:This conversation is(?: archived)?$|Enable subagents\?|Enable memories\?|Turn on Daybreak for your next request\?|Implement this plan\?|Choose what to import|Choose an import source|Hooks need review|Codex just got an upgrade\.|Update available|Giving this request a little extra thought|Stop this attempt and retry\?|Chat (?:paused|stopped) as a precaution|You've reached your workspace credit limit|Usage limit reached|Enable full access\?|Set up the Codex agent sandbox|Your organization requires the default Codex agent sandbox|Couldn't set up your sandbox|Folder access|Import setup|Action required|Finish in Browser|Waiting for verification|Field \d+\/\d+)/;
  function proactivePanel(rows) {
    const text = rows.map(textOf),
      end = text.findLastIndex((line) => line.trim());
    const start = text.findLastIndex(
      (line, i) =>
        i <= end && i >= end - 100 && proactiveTitles.test(line.trim().replace(/^>\s+/, '')),
    );
    if (start < 0) return null;
    const lines = text.slice(start, end + 1).map((line) => line.trimEnd()),
      title = lines[0].trim().replace(/^>\s+/, '');
    const tail = lines.slice(-3).join(' ').replace(/\s+/g, ' ').trim();
    const customize =
      title === 'Choose what to import' &&
      /(?:space to toggle|enter to continue).*b to go back/i.test(tail);
    const footer =
      customize ||
      auxiliaryFooter(lines.at(-1)) ||
      auxiliaryFooter(tail) ||
      panelFooter(tail) ||
      /enter\/esc (?:confirm|continue).*quit/i.test(tail) ||
      /Use.*enter to select, c to customize/.test(tail) ||
      /enter continue.*esc skip/i.test(tail);
    const choices = lines.filter((line) => /^\s*[›❯»>]?\s*\d+\.\s+\S/.test(line));
    const safety =
      /^(?:Giving this request a little extra thought|Stop this attempt and retry\?)/.test(title);
    const safetyEnd =
      /No action is required\. Codex will keep waiting, and this menu will close when the response is ready\.$/.test(
        tail,
      ) || /^(?:.*\s)?(?:[›❯»>]\s*)?\d+\. (?:Learn more|Stop and retry)\s*$/.test(lines.at(-1));
    if (!footer && !(safety && safetyEnd)) return null;
    if (lines.some((line) => /(?:GPT-|gpt-)\S+.*[·•].*(?:Context|~?\/)/.test(line))) return null;
    if (
      !customize &&
      choices.length &&
      choices.filter((line) => /^\s*[›❯»>]\s*\d+\./.test(line)).length !== 1
    )
      return null;
    const continuation =
      !choices.length &&
      /^Codex just got an upgrade\./.test(title) &&
      /enter\/esc continue/.test(tail);
    const form =
      !choices.length &&
      /^Field \d+\/\d+/.test(title) &&
      lines.some((line) => /^\s*[›❯»>]\s+/.test(line));
    const waiting =
      !choices.length && /^Waiting for verification/.test(title) && /esc.*cancel/.test(tail);
    if (!choices.length && !continuation && !form && !waiting && !customize) return null;
    const inputRow = form ? lines.findIndex((line) => /^\s*[›❯»>]\s+/.test(line)) : -1;
    const input = form
      ? lines[inputRow]
          .replace(/^\s*[›❯»>]\s?/, '')
          .replace(/^Type your answer(?: \(optional\))?$/, '')
      : '';
    const submitHint = form
      ? lines
          .map((line) => line.trim().match(/^(?:Press )?((?:⌃[a-z] )?enter) to submit/i)?.[1])
          .find(Boolean)
      : '';
    const submitKeys = submitHint
      ? submitHint.split(' ').map((key) => key.replace(/^⌃/, 'ctrl+'))
      : undefined;
    const keyLines = form ? lines.map((line, i) => (i === inputRow ? '›' : line)) : lines;
    const kind = waiting
      ? 'authentication'
      : /^Field /.test(title)
        ? 'form'
        : /Hooks need review|Folder access|Enable full access|sandbox/.test(title)
          ? 'approval'
          : /limit|credits/.test(title)
            ? 'rate-limit'
            : 'selection';
    return {
      kind,
      title,
      lines,
      key: panelKey(keyLines),
      numbered: Boolean(choices.length),
      ...(form ? { input, submitKeys } : {}),
      ...(customize
        ? { action: 'customize', toggle: /space to toggle/i.test(tail) }
        : continuation
          ? { action: 'continue' }
          : form
            ? { action: 'form' }
            : waiting
              ? { action: 'cancel' }
              : {}),
      scrollable:
        customize ||
        (choices.length > 0 &&
          (Number(choices[0].match(/\d+/)[0]) > 1 ||
            lines.some((line) => /^\s*[↑↓]\s*$/.test(line)))),
      rect: { left: 0, right: Math.max(...lines.map(columnWidth)), top: start, bottom: end },
    };
  }
  function hooksPanel(rows) {
    const text = rows.map(textOf),
      end = text.findLastIndex((line) => line.trim());
    if (end < 0) return null;
    const footer = text[end].trim();
    if (
      !/\besc (?:close|back)$/.test(footer) ||
      !/(?:enter (?:details|review)|toggle|trust|Managed \(always on\))/.test(footer)
    )
      return null;
    const start = text.findLastIndex(
      (line, i) => i < end && /^(?:Hooks|[A-Za-z]+ hooks)$/.test(line.trim()),
    );
    if (start < 0 || end - start > 100) return null;
    const lines = text.slice(start, end + 1).map((line) => line.trimEnd());
    if (!lines.some((line) => /^\s*[›❯»>]\s+/.test(line))) return null;
    const actions = [];
    if (/enter (?:details|review)/.test(footer))
      actions.push({ label: '查看当前 Hook', key: 'enter' });
    if (/space\/enter toggle/.test(footer))
      actions.push({ label: '切换当前 Hook 的启用状态', key: 'space' });
    const trust = footer.match(/\bt (trust(?: all)?)/);
    if (trust)
      actions.push({
        label: trust[1] === 'trust all' ? '信任全部 Hooks' : '信任当前 Hook',
        key: 't',
      });
    actions.push({
      label: /esc back$/.test(footer) ? '返回 Hooks 列表' : '关闭 Hooks 审查',
      key: 'esc',
    });
    return {
      kind: 'configuration',
      title: text[start].trim(),
      lines,
      key: panelKey(lines),
      action: 'hooks',
      actions,
      scrollable: true,
      numbered: false,
      rect: { left: 0, right: Math.max(...lines.map(columnWidth)), top: start, bottom: end },
    };
  }
  function inlinePanel(rows) {
    const text = rows.map(textOf),
      end = text.findLastIndex((line) => line.trim());
    if (end < 0 || !(panelFooter(text[end]) || auxiliaryFooter(text[end]))) return null;
    const first = text.findIndex(
      (line, i) => i >= Math.max(0, end - 32) && i < end && /^\s*[›❯»>]?\s*\d+\.\s+\S/.test(line),
    );
    const boundary = first < 0 ? end : first;
    const candidates = rows
      .map((row, i) =>
        i < boundary &&
        i >= Math.max(0, boundary - 32) &&
        row.some((span) => span.bold && !span.dim && span.text.trim()) &&
        !/^\s*[›❯»>]/.test(text[i])
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    if (!candidates.length) return null;
    const known = candidates.find((i) =>
      /^\s*(?:Would you like|Allow|Approve|Folder access|Trust|Select|Choose|Resume paused goal\?|Replace goal\?|Configure|Enable\/Disable|Experimental features|Memories|Waiting for verification|Tell us more|Field \d+\/\d+)/i.test(
        text[i],
      ),
    );
    const start = known ?? candidates.at(-1),
      lines = text.slice(start, end + 1).map((line) => line.trimEnd());
    const choices = lines.filter((line) => /^\s*[›❯»>]?\s*\d+\.\s+\S/.test(line));
    const title = text[start].trim();
    const kind = panelKind(title);
    if (kind === 'rate-limit') return null; // Only the complete current prompt above is actionable.
    if (
      choices.length
        ? choices.filter((line) => /^\s*[›❯»>]\s*\d+\./.test(line)).length !== 1
        : !['form', 'configuration', 'authentication', 'help', 'warnings'].includes(kind)
    )
      return null;
    return {
      kind,
      title,
      lines,
      key: panelKey(lines),
      numbered: Boolean(choices.length),
      scrollable: Boolean(
        choices.length &&
        (Number(choices[0].match(/\d+/)[0]) > 1 || lines.some((line) => /^\s*[↑↓]\s*$/.test(line))),
      ),
      rect: { left: 0, right: Math.max(...lines.map(columnWidth)), top: start, bottom: end },
    };
  }
  // Centered Codex views retain and dim the parent. The composer visible
  // behind such a view is not the input recipient. Use foreground styles,
  // aligned title/choices/hints and a bounded rectangle, not history keywords.
  function nativePanel(rows) {
    if (!Array.isArray(rows) || rows.length > 240) return null;
    const rateLimit = rateLimitPanel(rows);
    if (rateLimit) return rateLimit;
    const hooks = hooksPanel(rows);
    if (hooks) return hooks;
    const proactive = proactivePanel(rows);
    if (proactive) return proactive;
    const text = rows.map(textOf),
      candidates = new Map();
    function candidate(left, right, y) {
      if (left < 0 || right - left < 16 || right > 2000) return;
      const key = left + ':' + right;
      if (!candidates.has(key)) candidates.set(key, { left, right, ys: [] });
      candidates.get(key).ys.push(y);
    }
    rows.forEach((row, y) => {
      let column = 0,
        selectedLeft = -1,
        selectedRight = -1;
      row.forEach((span, index) => {
        const left = column,
          width = columnWidth(span.text);
        column += width;
        if (
          !span.dim &&
          width >= 16 &&
          !span.text.trim() &&
          (row[index - 1]?.dim || row[index + 1]?.dim)
        )
          candidate(left, column, y);
        if (span.bold && !span.dim) {
          if (/^[›❯»>]\s*\d+\./.test(span.text)) selectedLeft = left;
          if (selectedLeft >= 0) selectedRight = column;
        }
      });
      if (selectedLeft >= 0) {
        candidate(selectedLeft, selectedRight, Math.max(0, y - 7));
        candidate(selectedLeft, selectedRight, y);
      }
    });
    for (const rect of candidates.values()) {
      if (rect.ys.length < 2) continue;
      const crop = text.map((line) => columnSlice(line, rect.left, rect.right).trimEnd());
      const first = Math.min(...rect.ys),
        last = Math.min(text.length - 1, Math.max(...rect.ys) + 8);
      const end = crop.findIndex(
        (line, y) => y > first && y <= last && (panelFooter(line) || auxiliaryFooter(line)),
      );
      if (end < 0) continue;
      const start = crop.findIndex((line, y) => {
        if (
          y < Math.max(0, first - 8) ||
          y >= end ||
          !line.trim() ||
          /^\s*[›❯»>]?\s*\d+\./.test(line)
        )
          return false;
        let column = 0;
        return rows[y].some((span) => {
          const left = column;
          column += columnWidth(span.text);
          return (
            span.bold && !span.dim && span.text.trim() && left >= rect.left && left < rect.right
          );
        });
      });
      if (start < 0) continue;
      const choices = crop
        .slice(start + 1, end)
        .filter((line) => /^\s*[›❯»>]?\s*\d+\.\s+\S/.test(line));
      const title = crop[start].trim(),
        lines = crop.slice(start, end + 1);
      const kind = panelKind(title);
      if (kind === 'rate-limit') continue;
      if (
        choices.length
          ? choices.filter((line) => /^\s*[›❯»>]\s*\d+\./.test(line)).length !== 1
          : !['form', 'configuration', 'authentication', 'help', 'warnings'].includes(kind)
      )
        continue;
      const key = panelKey(lines);
      return {
        kind,
        title,
        lines,
        key,
        numbered: Boolean(choices.length),
        rect: { left: rect.left, right: rect.right, top: start, bottom: end },
      };
    }
    return inlinePanel(rows);
  }
  function styledComposerHint(rows, prompt) {
    const row = rows?.[prompt];
    if (!row) return '';
    const text = textOf(row)
      .replace(/[\u2800-\u28ff]/g, '')
      .trim();
    const main = /^[›❯»]\s+(?:Ask Codex(?: to do anything)?|Write a message)$/.test(text);
    const side = /^[›❯»]\s+Ask a follow-up question$/.test(text);
    if (!main && !side) return '';
    let skip = textOf(row).search(/[›❯»]/) + 1,
      dim = true;
    for (const span of row) {
      const value = span.text.slice(Math.min(skip, span.text.length));
      skip = Math.max(0, skip - span.text.length);
      if (value.replace(/[\s\u2800-\u28ff]/g, '') && !span.dim) dim = false;
    }
    return dim ? (side ? 'side' : 'main') : '';
  }
  function hasCodexModel(fields) {
    return fields.some(
      (field) =>
        codexModelField(field) ||
        /^(?:gpt-[\w.-]+|codex(?:-[\w.-]+)?|o\d(?:-[\w.-]+)?)(?:…|\s|$)/i.test(field),
    );
  }

  // Field order and the left/right alignment are configurable in Codex. Keep
  // the original rows intact; field boundaries are only recognition evidence.
  function parseCodexFooter(inputLines, { nativeComposer = false } = {}) {
    const lines = inputLines.slice();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const prompt = lines.findLastIndex((line) => promptPattern.test(line));
    const separator = lines.findLastIndex((line, i) => i > prompt && !line.trim());
    // A complete native frame may put its footer immediately after an empty
    // composer. Never use this path for a multiline user draft: text resembling
    // a footer inside that draft is not authority to write to a thread.
    const compactFooter = prompt >= 0 && separator < prompt && promptHint.test(lines[prompt]);
    const start =
      prompt < 0 ? -1 : separator > prompt ? separator + 1 : compactFooter ? prompt + 1 : -1;
    const remaining = start >= 0 ? lines.slice(start) : [];
    let rows = remaining.length <= 8 ? remaining : [];
    let fields = rows
      .flatMap((line) => line.trim().split(/\s*·\s*|\s{2,}/))
      .map((field) => field.replace(/…$/, '').trim())
      .filter(Boolean);
    if (
      compactFooter &&
      !hasCodexModelAndDirectory(fields) &&
      !(nativeComposer && hasCodexModel(fields))
    ) {
      rows = [];
      fields = [];
    }
    return {
      lines,
      prompt,
      rows,
      text: rows.join('\n'),
      fields,
      footerIndex: rows.length ? start : -1,
    };
  }

  function codexModelField(field) {
    return String(field).match(
      /^(.+?)\s+(default|none|minimal|low|medium|high|xhigh|max|ultra)(\s+fast)?$/i,
    );
  }

  function hasCodexModelAndDirectory(fields) {
    const model = fields.some((field) => {
      if (codexModelField(field)) return true;
      // Native footer regions can touch with only one space. A known model
      // identifier still proves its presence when truncated, or when followed
      // by a complete reasoning effort and another independently rendered item.
      // This does not recover the truncated model or authorize a settings value.
      const identifier = /^(gpt-[\w.-]+|codex(?:-[\w.-]+)?|o\d(?:-[\w.-]+)?)(…?)(?=\s|$)/i.exec(
        field,
      );
      if (!identifier) return false;
      if (identifier[2] || identifier[0].length === field.length) return true;
      const effort = /^\s+(\S+)/.exec(field.slice(identifier[0].length))?.[1];
      return Boolean(effort && codexModelField(`${identifier[1]} ${effort}`));
    });
    const cwd = fields.some((field) => /^(?:~(?=[\s\\/]|$)|\/|[A-Za-z]:[\\/])/.test(field));
    return model && cwd;
  }

  function hasNarrowGoalFooter(fields) {
    // A narrow native footer can spend all remaining space on its Goal state
    // and omit the model. This is display evidence only, never input authority.
    const goal =
      /(?:^|\s)(?:Goal paused \(\/goal resume\)|Pursuing goal \(\d+(?:\.\d+)?(?:ms|s|m|h|d)(?:\s+\d+(?:\.\d+)?(?:ms|s|m|h|d))*\))$/;
    const directories = [];
    let foundGoal = false;
    for (const field of fields) {
      const match = goal.exec(field);
      if (match) {
        foundGoal = true;
        directories.push(field.slice(0, match.index).trim());
      } else directories.push(field);
    }
    return (
      foundGoal &&
      directories.some((field) => /^(?:~(?:[\\/].*)?|\/.*|[A-Za-z]:[\\/].*)(?:…)?$/.test(field))
    );
  }

  /** Independent facts from one native frame; display evidence never grants input authority. */
  function inspectCodexScreen(inputLines, styledRows = null) {
    let footer = parseCodexFooter(inputLines);
    const hint = styledComposerHint(styledRows, footer.prompt);
    if (hint && !footer.rows.length)
      footer = parseCodexFooter(inputLines, { nativeComposer: true });
    const { lines, prompt, rows, fields, text } = footer;
    const modal = nativePanel(styledRows || []);
    const last = lines.findLastIndex((line) => line.trim());
    const gap =
      prompt >= 0
        ? lines
            .slice(Math.max(0, prompt - 4), prompt)
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
    const browsing = Boolean(gap.length && browsingHint.test(gap.at(-1)));
    const obscured = rows.some((row) =>
      /again to (?:quit|edit previous message)|reverse-i-search:|esc esc to edit previous message/i.test(
        row,
      ),
    );
    const side = /Side from ([^\n·]+)\s*(?:·|$)/.exec(text);
    const parkedSide = /\^\/ for side\b/.test(text);
    const thread =
      side || hint === 'side'
        ? 'side'
        : !obscured &&
            (parkedSide ||
              hasCodexModelAndDirectory(fields) ||
              (hint === 'main' && hasCodexModel(fields)))
          ? 'main'
          : 'unknown';
    const questionStart = lines.findLastIndex((line) =>
      /^\s*[•·]\s*Queued follow-up inputs\s*$/.test(line),
    );
    const questionFooter =
      last >= 0 &&
      /\benter submit\b/.test(lines[last]) &&
      /(?:alt\+(?:↓|down)|shift\+(?:→|right)) (?:main prompt|prev question)/.test(lines[last]);
    const queuedQuestion = questionStart >= 0 && questionFooter && questionStart < last;
    const menuFooter =
      last >= 0 &&
      /(?:enter (?:select|confirm|apply)|Press enter to confirm)/i.test(lines[last]) &&
      /esc (?:back|cancel|to go back)/i.test(lines[last]);
    const selection =
      menuFooter &&
      lines
        .slice(Math.max(0, last - 32), last)
        .some((line) => /^\s*[›❯»>]\s*\d+\.\s+\S/.test(line));
    const inputTarget = modal
      ? modal.kind === 'authentication'
        ? 'authentication'
        : !modal.numbered
          ? 'form'
          : 'menu'
      : queuedQuestion
        ? 'question'
        : selection
          ? 'menu'
          : obscured
            ? 'confirmation'
            : prompt >= 0 && thread !== 'unknown'
              ? 'composer'
              : 'unknown';
    let activity = null;
    for (let i = (prompt >= 0 ? prompt : last + 1) - 1; i >= 0; i--) {
      if (promptPattern.test(lines[i])) break;
      const value = matchActivityLine(lines[i]);
      if (value || /^\s*Worked for /.test(lines[i])) {
        activity = value || { running: false };
        break;
      }
    }
    return {
      thread,
      inputTarget,
      reading: browsing ? 'history' : thread !== 'unknown' ? 'latest' : 'unknown',
      composerOccupied:
        inputTarget === 'composer' &&
        Boolean(lines[prompt]?.replace(promptPattern, '').trim()) &&
        !promptHint.test(lines[prompt]),
      execution: activity ? (activity.running ? 'running' : 'idle') : 'unknown',
      hasSide: Boolean(side || parkedSide),
      origin: side?.[1].trim() || '',
      capabilities: {
        compose: inputTarget === 'composer' && thread === 'main',
        answer: inputTarget === 'question',
        select: inputTarget === 'menu' && modal?.numbered !== false,
        latest: browsing,
      },
      reason: modal
        ? 'native-modal'
        : inputTarget === 'unknown'
          ? prompt < 0
            ? 'composer-not-visible'
            : !rows.length
              ? 'footer-not-visible'
              : !hasCodexModel(fields)
                ? 'model-not-visible'
                : 'input-context-unconfirmed'
          : obscured
            ? 'confirmation'
            : '',
      ...(inputTarget === 'unknown'
        ? {
            evidence: {
              composerVisible: prompt >= 0,
              styled: Array.isArray(styledRows),
              placeholder: hint || 'none',
              modelVisible: hasCodexModel(fields),
              footerRows: rows.length,
              sampleRows: lines.length,
            },
          }
        : {}),
      ...(modal ? { modal } : {}),
      footer,
    };
  }

  // PendingInputPreview in Codex wraps headers and limits each preview to three
  // lines. Read only that current bottom-pane region; never infer acceptance
  // from the transport receipt or turn these previews into transcript messages.
  function pendingInputs(lines, start, end) {
    const sections = [],
      consumed = new Set();
    for (let i = start; i < end; i++) {
      if (!/^\s*[•·]\s*(?:Messages to be submitted|Queued follow-up inputs)/.test(lines[i]))
        continue;
      let at = i + 1,
        header = lines[i].trim().replace(/^[•·]\s*/, '');
      while (at < end && /^  \S/.test(lines[at]) && !/^\s*↳/.test(lines[at]))
        header += ' ' + lines[at++].trim();
      const match =
        /^(Messages to be submitted after next tool call|Messages to be submitted at end of turn|Queued follow-up inputs)(?:\s+\((press .+ to interrupt and send immediately)\))?$/.exec(
          header,
        );
      if (!match) continue;
      const messages = [];
      while (at < end) {
        const first = /^\s{2}↳\s?(.*)$/.exec(lines[at]);
        if (!first) break;
        let message = first[1];
        at++;
        while (
          at < end &&
          /^ {4}\S/.test(lines[at]) &&
          !/ edit last queued message\s*$/.test(lines[at])
        )
          message += '\n' + lines[at++].slice(4);
        messages.push(message);
      }
      if (!messages.length) continue; // Queued questions have their own UI.
      sections.push({ title: match[1], hint: match[2] || '', messages });
      if (at < end && /^\s+.+ edit last queued message\s*$/.test(lines[at])) at++;
      for (let row = i; row < at; row++) consumed.add(row);
      i = at - 1;
    }
    return { sections, consumed };
  }

  // Recognize the footer independently: an idle or newly started Codex does
  // not necessarily have an activity/completion line above its composer.
  function projectTerminalScreen(rows) {
    const interaction = inspectCodexScreen(rows.map(textOf), rows),
      parsed = interaction.footer;
    const { lines, prompt, fields } = parsed;
    const lastText = lines.findLastIndex((line) => line.trim());
    let footer =
      hasCodexModelAndDirectory(fields) ||
      hasNarrowGoalFooter(fields) ||
      (hasCodexModel(fields) && styledComposerHint(rows, prompt))
        ? parsed.footerIndex
        : -1;
    // Older native frames and menus can omit the directory, composer gap or
    // composer itself. Preserve their explicit status vocabulary without
    // searching above a newer composer for an older footer.
    if (footer < 0)
      footer = lines.findLastIndex(
        (line, i) =>
          i > prompt &&
          i >= lastText - 7 &&
          / · /.test(line) &&
          /Context|Ready|Working|\d+%|eff:/.test(line),
      );
    let start = -1;
    for (let i = prompt - 1; i >= 0; i--) {
      if (promptPattern.test(lines[i])) break;
      if (
        /^\s*(?:[─━•●✻✽*]\s*)?(?:Worked|[A-Za-z]+) for \d/.test(lines[i]) ||
        matchActivityLine(lines[i])
      ) {
        start = i;
        break;
      }
    }
    // The default Codex footer can contain only model, directory and spinner.
    // A current compaction header plus its composer anchors this known layout.
    // An older compaction above a newer activity/completion is not current.
    if (
      footer < 0 &&
      start >= 0 &&
      /^Compacting context\s*\(/.test(matchActivityLine(lines[start])?.body || '') &&
      prompt >= lastText - 7
    ) {
      footer = lines.findIndex((line, i) => i > prompt && / · /.test(line));
    }
    const facts = { ...interaction };
    delete facts.footer;
    if (interaction.modal) {
      const panel = interaction.modal;
      return {
        recognized: true,
        rows: panel.lines.map((text) => [{ text }]),
        statusRows: [],
        interaction: facts,
      };
    }
    if (footer < 0) return { recognized: false, rows, statusRows: [], interaction: facts };
    if (prompt < 0)
      return { recognized: true, rows: [], statusRows: rows.slice(footer), interaction: facts };
    const previousPrompt = lines.findLastIndex((line, i) => i < prompt && promptPattern.test(line));
    const pending = pendingInputs(lines, start >= 0 ? start : previousPrompt + 1, prompt);
    // Unknown text between the last activity/completion and the prompt is
    // retained verbatim: Recap, errors, reconnect banners, and future additions.
    return {
      recognized: true,
      rows:
        start < 0
          ? []
          : rows
              .slice(start, prompt)
              .filter((row, i) => !pending.consumed.has(start + i) && textOf(row).trim()),
      pendingInputs: pending.sections,
      statusRows: rows.slice(footer),
      interaction: facts,
    };
  }

  return {
    projectTerminalScreen,
    textOf,
    parseCodexFooter,
    codexModelField,
    hasCodexModelAndDirectory,
    inspectCodexScreen,
    promptPattern,
    nativePanel,
    styledComposerHint,
    pendingInputs,
  };
});
