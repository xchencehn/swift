/* Appearance is loaded from the active root configuration. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.StudioDeviceTheme = api;
    api.start(root);
  }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const base = {
    bg: '#17171a',
    panel: '#1d1d21',
    'panel-2': '#24242a',
    control: '#2c2c33',
    text: '#c4c5cb',
    muted: '#a3a3ad',
    faint: '#82828d',
    'chat-secondary': '#9b9ba7',
    line: 'rgba(255,255,255,.09)',
    'surface-rgb': '255,255,255',
    accent: '#b8bac2',
    'accent-ink': '#1b1b1f',
    observe: '#9ecbff',
    'folder-icon': '#9ecbff',
    blocked: '#ffd68a',
    danger: '#ff9a8d',
    'sidebar-bg': '#1b1b1f',
    selection: '#303038',
    bubble: '#29292f',
    'code-bg': '#13181c',
    'code-border': '#333b42',
    'code-text': '#cbd3db',
    'code-comment': '#879aaa',
    'code-keyword': '#ffad32',
    'code-string': '#a9d59a',
    'code-number': '#bba6f7',
    'code-function': '#ffd16d',
    'code-type': '#67cfe8',
    'code-variable': '#c5b3ff',
    'code-meta': '#ffad32',
    'tool-surface': '#1e1e23',
    'popover-surface': '#2d2d33',
    scrollbar: '#414149',
    'tool-summary': '#898994',
    'button-hover': '#34343a',
    'new-hover': '#33333b',
    'auth-bg': '#111111',
    'auth-input': '#080808',
    'auth-label': '#d4d4d8',
    'primary-hover': '#c8cad1',
    'activity-blue': '#8fc7ff',
    'activity-green': '#b8bac2',
    'activity-yellow': '#e8c47a',
    'activity-red': '#ee929b',
    'goal-color': '#c5a0ed',
    'goal-prefix': '#b8bac2',
    'question-color': '#dfa3b3',
    // 🔑 状态点的**含义**与 Herdr 对齐（src/client/shell.rs 的 status_color）：
    // 忙 → 黄，有提问 → 红，结束 → 青，空闲 → 绿，看过了 → 灰。
    // ⚠️ 色值不用 Herdr 的 Catppuccin：那套是柔和的粉彩，五颗小圆点摆在一列里分不开。
    // 改用**终端的标准亮色**（实测自 Claude Code 的状态行），这五个两两之间的色相差最大，
    // 6px 的点也一眼能分。含义没变，只是换了更分得开的那一档。
    'dot-working': '#f5f543',
    'dot-done': '#3b8eea',
    'dot-blocked': '#ff6b80',
    'dot-seen': '#999999',
    // Codex 命令行的语法高亮，实测自它自己的终端。
    'codex-cmd': '#8192ae',
    'codex-ddash': '#829e99',
    'codex-flag': '#ad8e97',
    'codex-str': '#92a48b',
    'codex-ok': '#0dbc79',
    'codex-bad': '#cd3131',
    // 代码配色：One Dark（Atom 的默认深色主题），深色三套共用（public/files/code-view.js）。
    'syn-text': '#abb2bf',
    'syn-comment': '#7f848e',
    'syn-keyword': '#c678dd',
    'syn-string': '#98c379',
    'syn-number': '#d19a66',
    'syn-function': '#61afef',
    'syn-type': '#e5c07b',
    'syn-variable': '#e06c75',
    'syn-meta': '#56b6c2',
    // ANSI 16-color roles follow the shared dark surfaces and syntax palette.
    'terminal-black': '#28282e',
    'terminal-red': '#e06c75',
    'terminal-green': '#98c379',
    'terminal-yellow': '#e5c07b',
    'terminal-blue': '#61afef',
    'terminal-magenta': '#c678dd',
    'terminal-cyan': '#56b6c2',
    'terminal-white': '#c4c5cb',
    // ANSI 8 also fills Codex prompts. Keep it subtle; xterm enforces foreground contrast.
    'terminal-bright-black': '#404047',
    'terminal-bright-red': '#ff9a8d',
    'terminal-bright-green': '#98c379',
    'terminal-bright-yellow': '#ffd68a',
    'terminal-bright-blue': '#9ecbff',
    'terminal-bright-magenta': '#c5a0ed',
    'terminal-bright-cyan': '#9fc9ba',
    'terminal-bright-white': '#dedee3',
  };
  const palettes = [
    { id: 'default', label: '深色', scheme: 'dark', colors: { ...base } },
    {
      id: 'light',
      label: '浅色',
      scheme: 'light',
      colors: {
        ...base,
        bg: '#f2f1ed',
        panel: '#eae9e5',
        'panel-2': '#e2e1dc',
        control: '#e5e4de',
        text: '#353733',
        muted: '#5f645d',
        faint: '#62655e',
        'chat-secondary': '#5f645d',
        line: 'rgba(0,0,0,.12)',
        'surface-rgb': '0,0,0',
        accent: '#496a53',
        'accent-ink': '#ffffff',
        observe: '#41657d',
        'folder-icon': '#66788a',
        blocked: '#805d28',
        danger: '#a8484e',
        'sidebar-bg': '#eae9e5',
        selection: '#dcdfd7',
        bubble: '#e5e7df',
        'code-bg': '#f8f8f5',
        'code-border': '#d2d6d2',
        'code-text': '#303842',
        'code-comment': '#5c6f7d',
        'code-keyword': '#985000',
        'code-string': '#376d30',
        'code-number': '#6d46b4',
        'code-function': '#825b00',
        'code-type': '#096b81',
        'code-variable': '#70509c',
        'code-meta': '#985000',
        'tool-surface': '#edece7',
        'popover-surface': '#f5f4ef',
        scrollbar: '#aeb2a8',
        'tool-summary': '#686c65',
        'button-hover': '#dcded6',
        'new-hover': '#e0e2da',
        'auth-bg': '#eae9e5',
        'auth-input': '#f2f1ed',
        'auth-label': '#353733',
        'primary-hover': '#3d5a46',
        'activity-blue': '#41657d',
        'activity-green': '#496a53',
        'activity-yellow': '#805d28',
        'activity-red': '#a8484e',
        'goal-color': '#795b98',
        'goal-prefix': '#486e60',
        'question-color': '#a04f67',
        // 浅色底上亮色发飘，取同一组的非亮版本。
        'dot-working': '#b07d00',
        'dot-done': '#2472c8',
        'dot-blocked': '#d9455f',
        'dot-seen': '#6b6b6b',
        'codex-cmd': '#4d6484',
        'codex-ddash': '#486e6b',
        'codex-flag': '#865863',
        'codex-str': '#536d48',
        'codex-ok': '#107c41',
        'codex-bad': '#cd3131',
        // 代码配色：GitHub Light。
        'syn-text': '#1f2328',
        'syn-comment': '#59636e',
        'syn-keyword': '#cf222e',
        'syn-string': '#0a3069',
        'syn-number': '#0550ae',
        'syn-function': '#6639ba',
        'syn-type': '#953800',
        'syn-variable': '#953800',
        'syn-meta': '#0550ae',
        'terminal-black': '#353733',
        'terminal-red': '#cf222e',
        'terminal-green': '#1a7f37',
        'terminal-yellow': '#805d28',
        'terminal-blue': '#0969da',
        'terminal-magenta': '#8250df',
        'terminal-cyan': '#1b7c83',
        'terminal-white': '#5f645d',
        'terminal-bright-black': '#e2e1dc',
        'terminal-bright-red': '#a8484e',
        'terminal-bright-green': '#496a53',
        'terminal-bright-yellow': '#805d28',
        'terminal-bright-blue': '#41657d',
        'terminal-bright-magenta': '#795b98',
        'terminal-bright-cyan': '#486e60',
        'terminal-bright-white': '#353733',
      },
    },
  ];
  function get(id) {
    return palettes.find((palette) => palette.id === id) || palettes[0];
  }
  function rgb(color) {
    const hex = /^#([\da-f]{6})$/i.exec(color);
    if (hex) return [0, 2, 4].map((index) => parseInt(hex[1].slice(index, index + 2), 16));
    const match = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(color);
    return match ? match.slice(1).map(Number) : null;
  }
  function luminance(channels) {
    return channels.reduce((sum, value, i) => {
      const c = value / 255;
      return (
        sum +
        (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
      );
    }, 0);
  }
  function readableColor(color, palette) {
    const channels = rgb(color);
    if (!channels || palette.scheme !== 'light') return color;
    const background = luminance(rgb(palette.colors.bg));
    let result = channels;
    for (
      let step = 0;
      step < 30 && (background + 0.05) / (luminance(result) + 0.05) < 4.5;
      step++
    ) {
      result = result.map((value) => Math.floor(value * 0.9));
    }
    return `rgb(${result.join(',')})`;
  }
  let host,
    current = palettes[0];
  const terminalColors = new Map();
  function terminalColor(color) {
    if (!host || !rgb(color)) return color;
    const key = `--terminal-${rgb(color).join('-')}`;
    terminalColors.set(key, color);
    host.document.documentElement.style.setProperty(key, readableColor(color, current));
    return `var(${key})`;
  }
  function apply(id, persist = true) {
    current = get(id);
    if (!host) return current;
    const doc = host.document;
    const root = doc.documentElement;
    root.dataset.deviceTheme = current.id;
    root.style.colorScheme = current.scheme;
    for (const [key, value] of Object.entries(current.colors))
      root.style.setProperty(`--${key}`, value);
    for (const [key, color] of terminalColors)
      root.style.setProperty(key, readableColor(color, current));
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', current.colors.bg);
    doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', current.scheme);
    // Older APKs simply use the shared web palette without the native-bar bridge.
    try {
      host.StudioApp?.setTheme?.(current.colors.bg, current.scheme === 'light');
    } catch {}
    host.dispatchEvent(new host.CustomEvent('herdr:themechange', { detail: current.id }));
    return current;
  }
  function start(window) {
    host = window;
    let saved;
    try {
      saved = JSON.parse(
        host.document.querySelector('meta[name="agent-studio-root-settings"]')?.content || '{}',
      ).theme;
    } catch {}
    apply(saved, false);
  }
  return { palettes, get, apply, start, terminalColor, readableColor, current: () => current };
});
