(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('../ansi') : root.StudioAnsi,
    typeof module === 'object' && module.exports
      ? require('../native-status')
      : root.StudioNativeStatus,
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioSessionStatusModel = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function (ansi, nativeStatus) {
  'use strict';
  const textOf = (row) =>
    typeof row === 'string' ? row : (row || []).map((span) => span.text || '').join('');
  const effortPattern = /^(?:default|none|minimal|low|medium|high|xhigh|max|ultra)$/i;
  function seconds(text) {
    let total = 0,
      found = false;
    for (const match of String(text).matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)\b/g)) {
      found = true;
      total += Number(match[1]) * { ms: 0.001, h: 3600, m: 60, s: 1 }[match[2]];
    }
    return found ? total : null;
  }
  function formatDuration(value) {
    const total = Math.max(0, Math.floor(value)),
      h = Math.floor(total / 3600),
      m = Math.floor((total % 3600) / 60),
      s = total % 60;
    return [h ? `${h}h` : '', m || h ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ');
  }
  function parse({ projection, status = {} } = {}) {
    const native = Boolean(projection),
      recognized = native ? projection.recognized === true : true;
    const activityRows = native
      ? recognized && !projection.interaction?.modal
        ? projection.rows || []
        : []
      : [status.activity || '', status.tip || ''];
    const footerRows = native
      ? recognized
        ? projection.statusRows || []
        : []
      : status.statusline || [];
    const activityLines = activityRows.map(textOf);
    // Older execution endpoints still include pending previews in activity rows.
    const pending = nativeStatus.pendingInputs(activityLines, 0, activityLines.length);
    const rows = activityLines
      .filter((_, index) => !pending.consumed.has(index))
      .map((line) => line.trim())
      .filter(Boolean);
    const footer = footerRows
      .map(textOf)
      .map((line) => line.trim())
      .filter(Boolean);
    const all = [...rows, ...footer];
    const value = {
      recognized,
      model: '',
      effort: '',
      context: '',
      quotas: [],
      directory: '',
      metadata: [],
      warnings: null,
      background: null,
      elapsedSeconds: null,
      elapsedText: '',
      completedAt: '',
      running: false,
      completed: false,
      compacting: false,
      activity: '',
      notes: [],
      alert: '',
      modalTitle: projection?.interaction?.modal?.title || '',
      pendingInputs: native
        ? recognized && !projection.interaction?.modal
          ? projection.pendingInputs || pending.sections
          : []
        : status.pendingInputs || [],
    };
    const add = (label, text) => {
      text = String(text || '').trim();
      if (text && !value.metadata.some((item) => item.label === label && item.value === text))
        value.metadata.push({ label, value: text });
    };
    for (const line of all) {
      const warning = /(?:⚠\s*)?(\d+)\s+warnings?\b/i.exec(line);
      if (warning) value.warnings = Math.max(value.warnings || 0, Number(warning[1]));
      const background = /\b(\d+)\s+(?:background\s+terminals?|shells?|monitors?)\b/i.exec(line);
      if (background) value.background = Math.max(value.background || 0, Number(background[1]));
    }
    for (const line of rows) {
      const hit = ansi?.matchActivityLine(line);
      const activity = hit || /^(?:[•●·✻✽*─]\s*)?(?:Work(?:ed|ing)|[A-Za-z]+) for \d/.test(line);
      if (activity && value.elapsedSeconds == null) {
        const time = /(?:\(|\bfor\s+)((?:<\s*)?(?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/.exec(
          line,
        )?.[1];
        value.elapsedSeconds = time ? seconds(time) : null;
        value.running = hit ? hit.running : !/\bWorked for\b/i.test(line);
        value.completed = !value.running;
        if (value.completed) {
          value.elapsedText = time?.trim().startsWith('<') ? time.trim().replace(/\s+/g, '') : '';
          value.completedAt =
            /[•·]\s*(?:done\s+)?(\d{1,2}:\d{2}(?:\s*[AP]M)?)(?![\d:])/i.exec(
              hit?.body || line,
            )?.[1] || '';
        }
        value.compacting = /\bCompacting context\b/i.test(line);
        value.activity = (hit?.body || line)
          .replace(/\([^)]*\)/g, '')
          .replace(/^\s*[•●·✻✽*─]\s*/, '')
          .replace(/\bfor\s+(?:<\s*)?(?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+/, '')
          .replace(/\s*[•·]\s*(?:done\s+)?\d{1,2}:\d{2}(?:\s*[AP]M)?/i, '')
          .replace(/[\s·•]+$/, '')
          .trim();
        continue;
      }
      if (/^(?:New activity\s*[·•]\s*)?↓?\s*Back to bottom/i.test(line)) continue;
      if (/^\s*[•·]?\s*\d+ background terminals? running\b/i.test(line)) continue;
      value.notes.push(line.replace(/^\s*[└│]\s*/, ''));
      if (!value.alert && /^(?:■\s+|error\b|failed to\b|server connection could not\b)/i.test(line))
        value.alert = line.replace(/^■\s+/, '');
    }
    for (let rowIndex = 0; rowIndex < footer.length; rowIndex++) {
      for (const original of footer[rowIndex].split(/\s*[·•]\s*|\s{2,}/)) {
        let field = original.trim();
        if (!field) continue;
        if (
          /^(?:\? for shortcuts|f\d+ to view|esc\b|enter\/esc\b|\^\S+\b|Ready$|Working$|idle$|done$)/i.test(
            field,
          )
        )
          continue;
        if (/^(?:⚠\s*)?\d+ warnings?\b/i.test(field)) continue;
        const model =
          /^((?:gpt-[\w.-]+|codex(?:-[\w.-]+)?|o\d[\w.-]*)(?:…)?)\s*(default|none|minimal|low|medium|high|xhigh|max|ultra)?\b(?:\s+fast\b)?/i.exec(
            field,
          );
        if (model) {
          value.model = model[1];
          if (model[2]) value.effort = model[2];
          field = field.slice(model[0].length).trim();
          if (!field) continue;
        }
        if (effortPattern.test(field)) {
          value.effort ||= field;
          continue;
        }
        if (/^resets?\b/i.test(field) && value.quotas.length) {
          const quota = value.quotas.at(-1);
          if (!quota.resetsAt) quota.value += ' · ' + field;
          continue;
        }
        const quota = /^(weekly|5h|\d+min|quota)\s*(\d+(?:\.\d+)?)%\s*(left|used)?\b/i.exec(field);
        if (quota) {
          const label = quota[1].toLowerCase();
          const percent = Number(quota[2]),
            remaining =
              quota[3]?.toLowerCase() === 'used' ? 100 - percent : quota[3] ? percent : null;
          const rowSpans = status.statusSpans?.[rowIndex] || [];
          value.quotas.push({
            label,
            value: field,
            remaining: remaining == null ? null : Math.max(0, Math.min(100, remaining)),
            resetsAt: rowSpans.find((span) => Number.isFinite(span.resetsAt))?.resetsAt || null,
          });
          continue;
        }
        const context =
          /^(?:Context\s+(\d+(?:\.\d+)?)%\s*(used|left)?|(\d+(?:\.\d+)?)%\s+context\s+(left|used))/i.exec(
            field,
          );
        if (context) {
          const count = Number(context[1] || context[3]),
            mode = context[2] || context[4];
          value.context = `${count}%${mode ? ` ${mode.toLowerCase()}` : ''}`;
          continue;
        }
        const goal = /(?:Pursuing goal\b|Goal paused\b|Goal (?:completed|budget exhausted)\b)/.exec(
          field,
        );
        if (goal) {
          add('Goal', field.slice(goal.index));
          field = field.slice(0, goal.index).trim();
          if (!field) continue;
        }
        if (/^(?:~(?=[/\\]|$)|\/|[A-Za-z]:[/\\])/.test(field)) {
          value.directory = field;
          continue;
        }
        if (/^\d+\s+(?:background\s+terminals?|shells?|monitors?)/i.test(field)) continue;
        if (/^(?:\d+\s*(?:tokens?|tok)\b|[$€¥]\s*\d)/i.test(field)) add('Usage', field);
        else if (
          /permissions?|sandbox|approval|accept edits|plan mode|bypass permissions|^[⏵▶►]/i.test(
            field,
          )
        )
          add('Permissions', field);
        else if (!/^\s*(?:\?\s|f\d\b|ctrl\+|alt\+|shift\+)/i.test(field)) add('Native info', field);
      }
    }
    value.nativeDraft = !native
      ? Boolean(status.composer && !status.composerHint)
      : Boolean(projection?.interaction?.composerOccupied);
    if (!native && status.forceIdle) value.running = false;
    return value;
  }
  return { parse, seconds, formatDuration };
});
