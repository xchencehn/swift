(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  if (root) root.StudioSlashCommands = value;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  // These commands need text, a path or a subcommand before submission. Commands
  // that open a useful native selector (model, review, resume…) execute directly.
  const argumentsRequired = new Set(['goal', 'rename', 'cd']);
  function needsInput(command) {
    return (
      command?.requiresInput === true ||
      argumentsRequired.has(command?.name) ||
      Boolean(command?.argumentHint?.trim())
    );
  }
  function query(text, caret = text.length) {
    return caret === text.length && /^\/[\w:.-]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  }
  function filter(commands, search) {
    if (search === null) return [];
    return commands
      .map((command, index) => {
        const name = command.name.toLowerCase();
        let score =
          name === search ? 0 : name.startsWith(search) ? 1 : name.includes(search) ? 2 : 3;
        let offset = 0;
        for (const char of search) {
          offset = name.indexOf(char, offset);
          if (offset < 0) return null;
          offset++;
        }
        return { command, score, index };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((item) => item.command);
  }
  function goalCommand(text) {
    const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return null;
    const value = match[1]?.trim() || '';
    if (!value) return { action: 'show' };
    const control = value.toLowerCase();
    return ['pause', 'resume', 'edit', 'clear'].includes(control)
      ? { action: control }
      : { action: 'set', objective: value };
  }
  return { query, filter, needsInput, goalCommand };
});
