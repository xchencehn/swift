(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioTerminalKeyboard = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  const named = new Set([
    'Backspace',
    'Enter',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Tab',
    'Delete',
    'Insert',
    'Escape',
  ]);
  function validKey(key) {
    return (
      typeof key === 'string' &&
      (named.has(key) ||
        /^F(?:[1-9]|1\d|2[0-4])$/.test(key) ||
        ([...key].length === 1 && !/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(key)))
    );
  }
  function create() {
    const pressed = new Map();
    return {
      event(event) {
        if (event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph'))
          return null;
        const identity = event.code || event.key;
        if (event.type === 'keyup') {
          const previous = pressed.get(identity);
          pressed.delete(identity);
          return previous ? { ...previous, kind: 'release', text: null } : null;
        }
        if (event.type !== 'keydown' || !validKey(event.key)) return null;
        const character = [...event.key].length === 1;
        const key = /^[A-Z]$/.test(event.key) ? event.key.toLowerCase() : event.key;
        const command = {
          type: 'terminal.key',
          key,
          modifiers:
            Number(event.shiftKey) |
            (Number(event.ctrlKey) << 1) |
            (Number(event.altKey) << 2) |
            (Number(event.metaKey) << 3),
          kind: event.repeat ? 'repeat' : 'press',
          shiftedCodepoint: key !== event.key ? event.key.codePointAt(0) : null,
          text: character && !event.ctrlKey && !event.altKey && !event.metaKey ? event.key : null,
        };
        pressed.set(identity, command);
        return command;
      },
      clear() {
        pressed.clear();
      },
    };
  }
  return { create, validKey };
});
