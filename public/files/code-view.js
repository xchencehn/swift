/**
 * 会话文件面板里的代码查看：直接铺在页面上（不套框），按语言着色，带行号。
 *
 * 配色跟着主题走：深色三套用 One Dark（Atom），浅色用 GitHub Light，
 * 颜色写在 public/device-theme.js 的 syn-* 里，换主题时由 CSS 变量直接生效，不必重画。
 *
 * 着色库（public/vendor/highlight/）不进首屏，第一次打开代码时才加载。先按纯文本画出来，
 * 加载完再原地换成着色的版本：字与字号不变，只变颜色，页面不跳。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioCodeView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const host = typeof window !== 'undefined' ? window : globalThis;

  // 扩展名 → highlight.js 的语言名。没列出的按纯文本显示，不做自动识别（大文件上又慢又常认错）。
  const LANGUAGES = {
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    hxx: 'cpp',
    cu: 'cpp',
    cuh: 'cpp',
    inl: 'cpp',
    ipp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    gradle: 'kotlin',
    scala: 'java',
    groovy: 'java',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    m: 'objectivec',
    mm: 'objectivec',
    py: 'python',
    pyi: 'python',
    pyw: 'python',
    rb: 'ruby',
    php: 'php',
    pl: 'perl',
    pm: 'perl',
    lua: 'lua',
    r: 'r',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    jsonl: 'json',
    json5: 'json',
    ipynb: 'json',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ksh: 'bash',
    bashrc: 'bash',
    profile: 'bash',
    bat: 'dos',
    cmd: 'dos',
    ps1: 'powershell',
    psm1: 'powershell',
    psd1: 'powershell',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    xaml: 'xml',
    plist: 'xml',
    css: 'css',
    scss: 'scss',
    less: 'less',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    properties: 'ini',
    env: 'bash',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    proto: 'protobuf',
    diff: 'diff',
    patch: 'diff',
    mk: 'makefile',
    cmake: 'cmake',
    vb: 'vbnet',
    wasm: 'wasm',
    wat: 'wasm',
  };
  const FILENAMES = {
    makefile: 'makefile',
    gnumakefile: 'makefile',
    dockerfile: 'dockerfile',
    'cmakelists.txt': 'cmake',
    '.bashrc': 'bash',
    '.zshrc': 'bash',
    '.profile': 'bash',
    '.gitconfig': 'ini',
    '.editorconfig': 'ini',
  };
  // 超过这个大小只显示纯文本：手机上给几十万字着色要好几百毫秒。
  const HIGHLIGHT_LIMIT = 256 * 1024;
  // 行按组放，组上开 content-visibility，几千行的文件也只排版看得见的那几组。
  const CHUNK = 200;

  function languageFor(file) {
    const name = String(file || '')
      .split('/')
      .pop()
      .toLowerCase();
    if (FILENAMES[name]) return FILENAMES[name];
    if (/^dockerfile\b/.test(name)) return 'dockerfile';
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return LANGUAGES[ext] || null;
  }

  let loading = null;
  function load() {
    if (host.hljs) return Promise.resolve(host.hljs);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'vendor/highlight/highlight.min.js?v=11.11.1';
        script.onload = () =>
          host.hljs ? resolve(host.hljs) : reject(new Error('highlight.js 没有加载'));
        script.onerror = () => {
          loading = null;
          script.remove();
          reject(new Error('highlight.js 加载失败'));
        };
        document.head.append(script);
      });
    }
    return loading;
  }

  const escape = (value) =>
    value.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));

  /**
   * 把着色后的 HTML 按行切开。highlight.js 的输出只有 <span class>、</span> 和转义过的文字，
   * 多行注释、字符串的 span 会跨行，所以每行开头重新打开上一行没关的 span、行尾补上关闭。
   */
  function splitLines(html) {
    const lines = [];
    const open = [];
    let current = '';
    const pattern = /<span class="[^"]*">|<\/span>|\n|[^<\n]+/g;
    let match;
    while ((match = pattern.exec(html))) {
      const token = match[0];
      if (token === '\n') {
        lines.push(current + '</span>'.repeat(open.length));
        current = open.join('');
      } else if (token === '</span>') {
        open.pop();
        current += token;
      } else if (token.startsWith('<span')) {
        open.push(token);
        current += token;
      } else current += token;
    }
    lines.push(current + '</span>'.repeat(open.length));
    return lines;
  }

  function paintLines(view, lines) {
    const digits = String(lines.length).length;
    view.style.setProperty('--code-gutter', `${Math.max(2, digits)}ch`);
    const chunks = [];
    for (let start = 0; start < lines.length; start += CHUNK) {
      const chunk = document.createElement('div');
      chunk.className = 'code-chunk';
      const part = lines.slice(start, start + CHUNK);
      chunk.style.setProperty('--code-rows', part.length);
      // content-visibility 自带样式隔离，计数器出不了组，所以每组从自己的起始行号重新计。
      chunk.style.counterReset = `code-line ${start}`;
      chunk.innerHTML = part
        .map((line) => `<div class="code-line"><span>${line || ' '}</span></div>`)
        .join('');
      chunks.push(chunk);
    }
    view.replaceChildren(...chunks);
  }

  /**
   * 在 container 里画一份代码。先画纯文本，再异步换成着色版本。
   * @returns {HTMLElement} 代码视图的根节点
   */
  let runHighlight;
  const highlights = new Map(),
    pendingHighlights = new Map();
  const HIGHLIGHT_CACHE_BYTES = 8 * 1024 * 1024;
  let highlightBytes = 0;
  function highlightSource(source, language) {
    const key = `${language}\0${source}`;
    const cached = highlights.get(key);
    if (cached) {
      highlights.delete(key);
      highlights.set(key, cached);
      return Promise.resolve(cached.html);
    }
    if (pendingHighlights.has(key)) return pendingHighlights.get(key);
    runHighlight ||= host.StudioOffThread.createOffThreadQueue(
      () =>
        new Worker(
          `${document.querySelector('meta[name="agent-studio-base-path"]')?.content || ''}/files/highlight-worker.js?v=2`,
        ),
      1000,
      { waitForReady: true },
    );
    const promise = runHighlight({ source, language }).promise.then((html) => {
      pendingHighlights.delete(key);
      // Failed, timed-out or dropped jobs remain retryable. Count both the UTF-16
      // key and markup so large code blocks cannot grow retained memory forever.
      if (typeof html === 'string') {
        const bytes = 2 * (key.length + html.length);
        if (bytes <= HIGHLIGHT_CACHE_BYTES) {
          while (highlights.size >= 64 || highlightBytes + bytes > HIGHLIGHT_CACHE_BYTES) {
            const oldest = highlights.keys().next().value;
            highlightBytes -= highlights.get(oldest).bytes;
            highlights.delete(oldest);
          }
          highlights.set(key, { html, bytes });
          highlightBytes += bytes;
        }
      }
      return html;
    });
    pendingHighlights.set(key, promise);
    return promise;
  }

  /** Fenced code shares the file viewer's bounded worker; plain text is visible first. */
  function highlightElement(code, language) {
    const aliases = { shell: 'bash', shellscript: 'bash', 'c++': 'cpp', 'c#': 'csharp' };
    const name = String(language || '').toLowerCase();
    if (!name || ['text', 'txt', 'plaintext', 'mermaid', 'ansi', 'console'].includes(name)) return;
    const source = code.textContent;
    if (source.length > HIGHLIGHT_LIMIT || !host.Worker || !host.StudioOffThread) return;
    highlightSource(source, aliases[name] || LANGUAGES[name] || name).then((html) => {
      if (!code.isConnected || !html || code.textContent !== source) return;
      // Only the vendored highlight.js worker produces this escaped span markup.
      code.innerHTML = html;
      code.classList.add('hljs');
    });
  }

  function render(container, text, file) {
    const view = document.createElement('div');
    view.className = 'code-view';
    view.tabIndex = 0;
    const source = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n$/, '');
    const language = languageFor(file);
    if (language) view.dataset.language = language;
    const lines = source.split('\n');
    if (lines.length > 20000) {
      view.textContent = source;
      view.style.whiteSpace = 'pre';
    } else paintLines(view, lines.map(escape));
    container.append(view);
    if (
      language &&
      source.length <= HIGHLIGHT_LIMIT &&
      lines.length <= 20000 &&
      host.Worker &&
      host.StudioOffThread
    ) {
      highlightSource(source, language).then((html) => {
        if (!view.isConnected || !html) return;
        paintLines(view, splitLines(html));
        view.classList.add('hljs');
      });
    }
    return view;
  }

  return { render, languageFor, splitLines, load, highlightElement };
});
