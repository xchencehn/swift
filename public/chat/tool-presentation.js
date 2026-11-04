/* Search projection adapted from OpenBitFun 675ad70e (MIT); see vendor/openbitfun/LICENSE. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioToolPresentation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const text = (value) => (typeof value === 'string' ? value : '');
  // Decode only transport envelopes. A command's stdout is data, never another
  // execution record, even when it contains fields named output or exit_code.
  function outputRecords(raw) {
    const records = [];
    const payload = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    function visit(value, depth = 0) {
      if (value == null) return;
      if (depth > 8) {
        records.push({ text: payload(value) });
        return;
      }
      if (
        Array.isArray(value) &&
        value.every(
          (part) =>
            part &&
            [
              'text',
              'input_text',
              'output_text',
              'image',
              'input_image',
              'output_image',
              'image_url',
            ].includes(part.type),
        )
      ) {
        for (const part of value) {
          if (part.type.includes('image')) records.push({ text: '（工具图片不在聊天流中显示。）' });
          else visit(part.text, depth + 1);
        }
      } else if (value && typeof value === 'object') {
        if (
          typeof value.output === 'string' &&
          ['exit_code', 'session_id', 'chunk_id'].some((key) => Object.hasOwn(value, key))
        ) {
          records.push({
            text: value.output,
            exitCode: Number.isInteger(value.exit_code) ? value.exit_code : null,
            running: value.exit_code == null && value.session_id != null,
          });
        } else if (
          value.value &&
          typeof value.value === 'object' &&
          Object.hasOwn(value.value, 'output')
        )
          visit(value.value, depth + 1);
        else if (
          Array.isArray(value.content) &&
          value.content.every((part) => part?.type === 'text')
        )
          visit(value.content, depth + 1);
        else records.push({ text: payload(value) });
      } else if (typeof value === 'string') {
        const source = value.trim();
        if (!source) return;
        try {
          const parsed = JSON.parse(source);
          if (parsed && typeof parsed === 'object') {
            visit(parsed, depth + 1);
            return;
          }
        } catch {}
        const script =
          /^Script (?:completed|running[^\n]*|terminated)\nWall time[^\n]*\nOutput:\n?/.exec(
            source,
          );
        if (script) {
          visit(source.slice(script[0].length), depth + 1);
          return;
        }
        const terminal =
          /^(?:Chunk ID:[^\n]*\n)?Wall time:[^\n]*\nProcess (exited with code (-?\d+)|running with session ID [^\n]+)\n(?:Final output|Output):\n?/.exec(
            source,
          );
        if (terminal) {
          records.push({
            text: source.slice(terminal[0].length),
            exitCode: terminal[2] == null ? null : Number(terminal[2]),
            running: terminal[2] == null,
          });
          return;
        }
        const lines = source.split('\n');
        if (
          lines.length > 1 &&
          lines.every((line) => !line.trim() || /^\s*\{.*\}\s*$/.test(line))
        ) {
          try {
            const values = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
            for (const part of values) visit(part, depth + 1);
            return;
          } catch {}
        }
        records.push({ text: source });
      } else records.push({ text: String(value) });
    }
    visit(raw);
    return records;
  }
  function excerpt(value, maxLines = 16, maxChars = 2400) {
    const source = text(value).trim(),
      lines = source.split(/\r?\n/);
    if (lines.length <= maxLines && source.length <= maxChars) return source;
    const selected = new Set();
    const head = Math.min(4, Math.ceil(maxLines / 2)),
      tail = Math.min(4, Math.floor(maxLines / 2));
    for (let i = 0; i < Math.min(head, lines.length); i++) selected.add(i);
    const important =
      /\b(?:error|failed|failure|exception|traceback|fatal|denied|warning)\b|错误|失败|异常/i;
    for (let i = 0; i < lines.length && selected.size < maxLines - tail; i++)
      if (important.test(lines[i])) selected.add(i);
    for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) selected.add(i);
    for (let i = 0; i < lines.length && selected.size < maxLines; i++) selected.add(i);
    const indices = [...selected].sort((a, b) => a - b),
      result = [];
    let previous = -1;
    const lineLimit = Math.max(16, Math.floor((maxChars - 160) / indices.length));
    for (const i of indices) {
      if (i > previous + 1) result.push(`…（省略 ${i - previous - 1} 行）`);
      result.push(lines[i].length > lineLimit ? lines[i].slice(0, lineLimit) + '…' : lines[i]);
      previous = i;
    }
    if (previous < lines.length - 1) result.push(`…（省略 ${lines.length - previous - 1} 行）`);
    return result.join('\n') + '\n（内容已节选，完整内容见完整详情。）';
  }
  function readablePayload(source) {
    try {
      const value = JSON.parse(source);
      if (value && typeof value === 'object') source = JSON.stringify(value, null, 2);
    } catch {}
    const lines = source.split(/\r?\n/),
      result = [];
    for (let i = 0; i < lines.length; i++) {
      let end = i + 1;
      while (end < lines.length && lines[end] === lines[i]) end++;
      result.push(lines[i]);
      if (end - i > 2) result.push(`…（该行连续出现 ${end - i} 次）`);
      else if (end - i === 2) result.push(lines[i]);
      i = end - 1;
    }
    return result.join('\n');
  }
  function outputPreview(raw) {
    const records = outputRecords(raw);
    const content = records
      .map((record, index) => {
        const state = record.running
          ? '仍在运行'
          : Number.isInteger(record.exitCode)
            ? `退出码：${record.exitCode}`
            : '';
        const title =
          records.length > 1 ? `结果 ${index + 1}${state ? '（' + state + '）' : ''}` : state;
        return [title, readablePayload(record.text)].filter(Boolean).join('\n');
      })
      .join('\n\n');
    return excerpt(content, 12);
  }
  function detailSections(item, full = false) {
    if (full)
      return [
        ['调用原文', text(item.input?.text)],
        ['返回原文', text(item.result?.text)],
      ].filter(([, value]) => value);
    const input = inputOf(item),
      sections = [];
    let output = item.result?.preview;
    if (typeof output !== 'string') {
      if (item.result?.truncated && /^\s*\[\s*\{\s*"type"\s*:/.test(item.result.text || '')) {
        output = item.outcome
          ? outputPreview({ exit_code: item.outcome.exitCode, output: text(item.outcome.output) })
          : '结果预览不完整，请加载完整详情。';
      } else output = outputPreview(item.result?.text || '');
    }
    if (!output && item.outcome)
      output = outputPreview({
        exit_code: item.outcome.exitCode,
        output: text(item.outcome.output),
      });
    sections.push([
      '执行结果',
      output ||
        (item.running
          ? '仍在执行，尚无文本输出。'
          : item.result
            ? '此记录未提供文本结果。'
            : '尚无执行结果。'),
    ]);
    const command = text(item.action?.command || input.cmd || input.command);
    if (command) {
      const lines = command.trim().split(/\r?\n/),
        first = lines[0];
      sections.push([
        '命令',
        first.slice(0, 220) +
          (first.length > 220 ? '…' : '') +
          (lines.length > 1
            ? `\n（另有 ${lines.length - 1} 行，完整命令见完整详情。）`
            : first.length > 220
              ? '\n（完整命令见完整详情。）'
              : ''),
      ]);
    } else if (item.input?.text) {
      const source = item.input.text;
      sections.push([
        '输入',
        /\b(?:tools\.|await\s)/.test(source)
          ? `${item.name || '工具'} 调用；代码见完整详情。`
          : excerpt(readablePayload(source), 6, 600),
      ]);
    }
    return sections;
  }
  function inputOf(item) {
    if (item.input?.truncated) return {};
    try {
      const value = JSON.parse(text(item.input?.text));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  function outputOf(item) {
    if (item.outcome?.output) return item.outcome.output;
    const raw = text(item.result?.text);
    try {
      const value = JSON.parse(raw);
      if (typeof value?.output === 'string') return value.output;
      if (typeof value?.content === 'string') return value.content;
    } catch {
      /* Plain output stays plain. */
    }
    return raw;
  }
  function numberedLine(value) {
    const match = /^("(?:[^"\\]|\\.)*"|(?:[A-Za-z]:[\\/])?[^:\r\n]+):(\d+):(.*)$/.exec(value);
    const context = /^("(?:[^"\\]|\\.)*"|(?:[A-Za-z]:[\\/])?[^:\r\n]+)-(\d+)(?::|-)(.*)$/.exec(
      value,
    );
    if ((!match && !context) || (match && context)) return null;
    const parts = match || context,
      line = Number(parts[2]);
    if (!Number.isSafeInteger(line) || line < 1) return null;
    let path = parts[1];
    if (path.startsWith('"')) {
      try {
        path = JSON.parse(path);
      } catch {
        return null;
      }
    }
    return { path, line, text: parts[3], kind: match ? 'match' : 'context' };
  }
  function searchBlocks(value, options = {}) {
    if (
      options.multiline ||
      options['-n'] === false ||
      options.show_line_numbers === false ||
      (options.output_mode && options.output_mode !== 'content')
    )
      return [];
    const blocks = [];
    let current = null,
      gap = false;
    const lines = value.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw === '--' && current && numberedLine(lines[i + 1] || '')?.path === current.path) {
        gap = true;
        continue;
      }
      const parsed = numberedLine(raw);
      if (parsed) {
        if (current?.path !== parsed.path) {
          current = { kind: 'file', path: parsed.path, lines: [] };
          blocks.push(current);
        }
        current.lines.push({ ...parsed, gap });
      } else {
        current = null;
        if (blocks.at(-1)?.kind === 'text') blocks.at(-1).text += '\n' + raw;
        else blocks.push({ kind: 'text', text: raw });
      }
      gap = false;
    }
    return blocks.some((block) => block.kind === 'file') ? blocks : [];
  }
  function patchText(item, input) {
    if (item.input?.truncated) return '';
    const source = text(input.patch || input.input || item.input?.text);
    if (
      source.startsWith('*** Begin Patch') ||
      source.startsWith('diff --git ') ||
      source.startsWith('--- ')
    )
      return source;
    // Only one literal apply_patch call is projected. Never evaluate code or templates.
    const call =
      /^(?:text\(\s*)?(?:await\s+)?tools\.apply_patch\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*\)?;?\s*$/.exec(
        source.trim(),
      );
    if (call) {
      try {
        return JSON.parse(call[1]);
      } catch {
        /* Unknown wrappers retain raw detail. */
      }
    }
    return '';
  }
  function patchFiles(source) {
    const files = [];
    let file = null,
      hunk = false,
      oldLine = null,
      newLine = null,
      oldRemaining = null,
      newRemaining = null;
    for (const line of source.split(/\r?\n/)) {
      const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
      if (header) {
        file = { path: header[2], operation: header[1], rows: [] };
        files.push(file);
        hunk = header[1] === 'Add';
        oldLine = newLine = oldRemaining = newRemaining = null;
        continue;
      }
      if (!hunk && line.startsWith('--- ')) {
        file = { path: line.slice(4).replace(/^a\//, ''), operation: 'Update', rows: [] };
        files.push(file);
        hunk = false;
        continue;
      }
      if (!hunk && line.startsWith('+++ ') && file) {
        if (line.slice(4) !== '/dev/null') file.path = line.slice(4).replace(/^b\//, '');
        continue;
      }
      if (!file) continue;
      if (line.startsWith('*** Move to: ')) {
        file.path = line.slice(13);
        continue;
      }
      if (line.startsWith('@@')) {
        const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        oldLine = range ? Number(range[1]) : null;
        newLine = range ? Number(range[3]) : null;
        oldRemaining = range ? Number(range[2] ?? 1) : null;
        newRemaining = range ? Number(range[4] ?? 1) : null;
        file.rows.push({ kind: 'hunk', text: line });
        hunk = true;
        continue;
      }
      if (line.startsWith('*** ') || line.startsWith('diff --git ')) {
        hunk = false;
        continue;
      }
      if (!hunk || !['+', '-', ' '].includes(line[0])) continue;
      const kind = line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context';
      file.rows.push({
        kind,
        text: line.slice(1),
        oldLine: kind === 'added' ? null : oldLine,
        newLine: kind === 'removed' ? null : newLine,
      });
      if (kind !== 'added' && oldLine !== null) oldLine++;
      if (kind !== 'removed' && newLine !== null) newLine++;
      if (oldRemaining !== null && kind !== 'added') oldRemaining--;
      if (newRemaining !== null && kind !== 'removed') newRemaining--;
      if (oldRemaining === 0 && newRemaining === 0) hunk = false;
    }
    return files;
  }
  function describe(item) {
    const input = inputOf(item),
      name = String(item.name || '')
        .split('.')
        .at(-1)
        .toLowerCase();
    const path = text(input.file_path || input.path || input.target_file);
    const failed = Boolean(
      item.failed ||
      item.result?.isError ||
      (Number.isInteger(item.outcome?.exitCode) && item.outcome.exitCode !== 0),
    );
    const status = item.running
      ? 'running'
      : failed
        ? 'failed'
        : item.statusUnknown
          ? 'unknown'
          : 'completed';
    let kind = '',
      label = '',
      target = '',
      note = '';
    if (['read', 'read_file', 'readfile'].includes(name)) {
      kind = 'read';
      label = '读取';
      target = path;
    }
    if (['grep', 'grep_search', 'search_files'].includes(name)) {
      kind = 'search';
      label = '搜索';
      target = text(input.pattern || input.query);
      note = path;
    }
    if (['glob', 'glob_search'].includes(name)) {
      kind = 'glob';
      label = '查找文件';
      target = text(input.pattern || input.glob_pattern);
      note = path;
    }
    if (['edit', 'edit_file', 'str_replace'].includes(name)) {
      kind = 'edit';
      label = '修改';
      target = path;
    }
    if (['write', 'write_file'].includes(name)) {
      kind = 'write';
      label = '写入';
      target = path;
    }
    const patch = patchText(item, input);
    const files = patch ? patchFiles(patch) : [];
    if (files.length) {
      kind = 'patch';
      label = '修改';
      target = files.map((file) => file.path).join('、');
      note = files.length > 1 ? `${files.length} 个文件` : '';
    }
    // A failed operation describes the attempted action; never claim a successful edit.
    const output = outputOf(item);
    let blocks =
      kind === 'search' && !failed && !item.result?.truncated ? searchBlocks(output, input) : [];
    // Format recorded file:line output without inferring what a shell command did.
    if (
      !kind &&
      !failed &&
      !item.result?.truncated &&
      (item.action?.verb === 'Ran' || ['exec_command', 'bash', 'shell_command'].includes(name))
    ) {
      blocks = searchBlocks(output);
      if (blocks.length) {
        kind = 'locations';
        label = item.action?.verb || '运行';
        target = text(item.action?.command || input.cmd || input.command);
      }
    }
    if (blocks.length && kind === 'search')
      note = `${blocks.filter((block) => block.kind === 'file').reduce((n, block) => n + block.lines.filter((line) => line.kind === 'match').length, 0)} 处匹配`;
    if (!target) target = text(item.detail);
    if (kind && !target) target = text(item.name);
    return {
      kind,
      label,
      target,
      note,
      path,
      input,
      output,
      files,
      blocks,
      status,
      failed,
      truncated: Boolean(item.input?.truncated || item.result?.truncated),
    };
  }
  function editDiff(input, diffLines) {
    const before = input.old_string ?? input.old_text,
      after = input.new_string ?? input.new_text;
    if (typeof before !== 'string' || typeof after !== 'string') return null;
    if (before.length + after.length > 256 * 1024) return null;
    const changes = diffLines(before, after, { timeout: 30, maxEditLength: 1500 });
    if (!changes) return null;
    const rows = [];
    for (const part of changes) {
      const lines = part.value.split('\n');
      if (lines.at(-1) === '') lines.pop();
      for (const line of lines)
        rows.push({
          kind: part.added ? 'added' : part.removed ? 'removed' : 'context',
          text: line.replace(/\r$/, ''),
        });
    }
    return rows;
  }
  function resolvePath(path, cwd) {
    if (!path || /[\0\r\n]/.test(path) || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return null;
    if (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) return path;
    if (!cwd || !/^(?:\/|[A-Za-z]:[\\/])/.test(cwd)) return null;
    return cwd.replace(/[/\\]+$/, '') + '/' + path.replace(/^\.\//, '');
  }
  return {
    inputOf,
    outputOf,
    outputPreview,
    detailSections,
    searchBlocks,
    patchFiles,
    describe,
    editDiff,
    resolvePath,
  };
});
