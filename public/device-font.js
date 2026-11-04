/* Apply the active root's reading size before the page is painted. */
(() => {
  'use strict';
  const defaultSize = 14;
  let current = defaultSize;
  function apply(value, persist = true) {
    const size = Number(value);
    current = Number.isFinite(size) && size >= 12 && size <= 20 ? Math.round(size) : defaultSize;
    document.documentElement.style.setProperty(
      '--device-font-scale',
      String(current / defaultSize),
    );
    window.dispatchEvent(new CustomEvent('herdr:fontchange', { detail: current }));
    return current;
  }
  let terminalSize = 0;
  function applyTerminal(value) {
    const size = Number(value);
    terminalSize = Number.isFinite(size) && size >= 7 && size <= 24 ? Math.round(size * 2) / 2 : 0;
    document.documentElement.style.setProperty('--terminal-font-size', String(terminalSize));
    window.dispatchEvent(new CustomEvent('herdr:terminalfontchange'));
    return terminalSize;
  }
  let saved;
  try {
    saved = JSON.parse(
      document.querySelector('meta[name="agent-studio-root-settings"]')?.content || '{}',
    ).fontSize;
  } catch {}
  apply(saved, false);
  try {
    applyTerminal(
      JSON.parse(document.querySelector('meta[name="agent-studio-root-settings"]')?.content || '{}')
        .terminalFontSize,
    );
  } catch {
    applyTerminal(0);
  }
  window.StudioTerminalFont = {
    apply: applyTerminal,
    current: () => terminalSize,
    defaultSize: () =>
      matchMedia('(pointer: coarse)').matches &&
      Math.min(screen.width || innerWidth, screen.height || innerHeight) < 600
        ? 11.5
        : 14,
  };
  window.StudioDeviceFont = { apply, current: () => current, defaultSize };
})();
