'use strict';

// A tool invocation may return while its process or orchestration cell is still
// alive. Track those handles before preview clipping removes the status fields.
function outcomes(value, found = [], depth = 0) {
  if (depth > 12 || value == null) return found;
  if (typeof value === 'string') {
    try {
      return outcomes(JSON.parse(value), found, depth + 1);
    } catch {}
    const cell = value.match(/^Script running with cell ID (\S+)/m);
    const process = value.match(/^Process running with session ID (\S+)/m);
    if (cell) found.push({ key: `cell:${cell[1]}`, running: true });
    if (process) found.push({ key: `process:${process[1]}`, running: true });
    if (/^Script (?:completed|terminated)\b/m.test(value)) found.push({ cellCompleted: true });
    const exited = value.match(/^Process exited with code (-?\d+)/m);
    if (exited) found.push({ running: false, failed: Number(exited[1]) !== 0 });
    // tools.exec_command responses are sometimes separate JSON lines in an
    // orchestration tool's text blocks, rather than one JSON document.
    for (const line of value.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        outcomes(JSON.parse(line), found, depth + 1);
      } catch {}
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) outcomes(item, found, depth + 1);
    return found;
  }
  if (typeof value !== 'object') return found;
  if ('exit_code' in value || ('session_id' in value && 'output' in value)) {
    const done = value.exit_code != null;
    if (done || value.session_id != null)
      found.push({
        key: value.session_id == null ? null : `process:${value.session_id}`,
        running: !done,
        failed: done && value.exit_code !== 0,
      });
    return found; // stdout is arbitrary user data, never a control record.
  }
  for (const key of ['text', 'content', 'value'])
    if (key in value) outcomes(value[key], found, depth + 1);
  return found;
}

class ToolLifecycle {
  constructor(state) {
    this.pending = state?.pending || new Map();
    this.references = new WeakMap(state?.references || []);
    this.calls = state?.calls || new Set();
  }
  checkpoint(tools) {
    return {
      pending: this.pending,
      calls: this.calls,
      references: [...tools]
        .filter((tool) => this.references.has(tool))
        .map((tool) => [tool, this.references.get(tool)]),
    };
  }
  start(tool, rawInput) {
    const input = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput || {});
    const refs = new Set();
    // Direct write_stdin/wait and the same calls inside functions.exec.
    if (/write_stdin|wait|exec/.test(tool.name)) {
      for (const match of input.matchAll(/\b(session_id|cell_id)["']?\s*:\s*["']?([\w-]+)/g)) {
        refs.add(`${match[1] === 'cell_id' ? 'cell' : 'process'}:${match[2]}`);
      }
    }
    this.references.set(tool, refs);
    this.calls.add(tool);
    for (const key of refs)
      for (const previous of this.pending.get(key) || []) {
        previous.running = true;
        previous.statusUnknown = false;
        this.calls.add(previous);
      }
  }
  finishTurn() {
    for (const tool of this.calls) {
      if (tool.running || tool.result == null) {
        tool.running = false;
        tool.statusUnknown = true;
      }
    }
    this.calls.clear();
  }
  result(tool, output) {
    tool.statusUnknown = false;
    const events = outcomes(output);
    const refs = this.references.get(tool) || new Set();
    tool.pendingHandles = new Set();
    const complete = (key, failed) => {
      for (const previous of this.pending.get(key) || []) {
        previous.pendingHandles.delete(key);
        previous.running = previous.pendingHandles.size > 0;
        previous.statusUnknown = false;
        previous.failed ||= Boolean(failed);
      }
      this.pending.delete(key);
    };
    for (const event of events) {
      if (event.cellCompleted) continue;
      if (!event.running) {
        const key = event.key || (refs.size === 1 ? [...refs][0] : null);
        if (key) complete(key, event.failed);
        tool.failed ||= Boolean(event.failed);
      } else {
        const watchers = this.pending.get(event.key) || new Set();
        watchers.add(tool);
        this.pending.set(event.key, watchers);
        tool.pendingHandles.add(event.key);
      }
    }
    // A yielded orchestration cell ends when wait returns without that handle.
    for (const key of refs) {
      if (
        key.startsWith('cell:') &&
        events.some((e) => e.cellCompleted) &&
        !events.some((e) => e.key === key && e.running)
      ) {
        const previous = [...(this.pending.get(key) || [])];
        // Processes started inside the cell can outlive the cell itself.
        for (const event of events.filter((e) => e.running))
          for (const prior of previous) {
            prior.pendingHandles.add(event.key);
            this.pending.get(event.key)?.add(prior);
          }
        complete(key, tool.failed);
      }
      // A timeout or an unrecognized waiting response is not proof of exit.
      if (this.pending.has(key)) {
        this.pending.get(key).add(tool);
        tool.pendingHandles.add(key);
      }
    }
    tool.running = tool.pendingHandles.size > 0;
  }
}
module.exports = { ToolLifecycle, outcomes };
