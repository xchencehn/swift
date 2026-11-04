/* Mermaid is loaded locally, only when a complete diagram enters the chat. */
(function () {
  'use strict';
  const scriptURL = new URL(document.currentScript.src);
  // The startup bundle lives under assets/, while local vendors belong to the
  // application's namespace, including desktop and remote execution paths.
  const basePath = document.querySelector('meta[name="agent-studio-base-path"]')?.content || '';
  const engineURL = new URL(
    `${basePath.replace(/\/$/, '')}/vendor/mermaid/mermaid.min.js`,
    location.origin,
  );
  engineURL.search = scriptURL.search;
  let enginePromise,
    sequence = 0,
    generation = 0,
    queue = Promise.resolve();
  const pending = new WeakMap();
  const scrollOwners = new WeakMap();

  function themeVariables() {
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue(`--${name}`).trim();
    return {
      darkMode: style.colorScheme !== 'light',
      background: color('bg'),
      primaryColor: color('panel-2'),
      primaryTextColor: color('text'),
      primaryBorderColor: color('muted'),
      secondaryColor: color('control'),
      secondaryTextColor: color('text'),
      secondaryBorderColor: color('muted'),
      tertiaryColor: color('panel'),
      tertiaryTextColor: color('text'),
      tertiaryBorderColor: color('muted'),
      lineColor: color('muted'),
      textColor: color('text'),
      mainBkg: color('panel-2'),
      nodeBorder: color('muted'),
      clusterBkg: color('panel'),
      clusterBorder: color('muted'),
      titleColor: color('text'),
      edgeLabelBackground: color('bg'),
      actorBkg: color('panel-2'),
      actorTextColor: color('text'),
      actorBorder: color('muted'),
      actorLineColor: color('muted'),
      signalColor: color('text'),
      signalTextColor: color('text'),
      noteBkgColor: color('control'),
      noteTextColor: color('text'),
      noteBorderColor: color('muted'),
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
    };
  }

  function loadEngine() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (!enginePromise)
      enginePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = engineURL.href;
        const timer = setTimeout(() => fail(), 15000);
        script.onload = () => {
          clearTimeout(timer);
          window.mermaid ? resolve(window.mermaid) : fail();
        };
        const fail = () => {
          clearTimeout(timer);
          script.remove();
          enginePromise = null;
          reject(new Error('Diagram renderer unavailable'));
        };
        script.onerror = fail;
        document.head.append(script);
      });
    return enginePromise;
  }

  async function draw(pre, log, requestedGeneration) {
    const current = () => pre.isConnected && requestedGeneration === generation;
    if (!current()) return;
    const source = pre.querySelector('code').textContent;
    let host;
    try {
      const mermaid = await loadEngine();
      if (!current()) return;
      const colors = themeVariables();
      // Never accept diagram directives that change the application's policy.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: colors,
        suppressErrorRendering: true,
        maxTextSize: 50000,
        maxEdges: 500,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        secure: [
          'secure',
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'maxEdges',
          'suppressErrorRendering',
          'htmlLabels',
          'flowchart',
          'themeCSS',
          'theme',
          'themeVariables',
        ],
      });
      host = document.createElement('div');
      host.className = 'diagram-measure';
      document.body.append(host);
      const { svg } = await mermaid.render(`chat-diagram-${++sequence}`, source, host);
      if (!current()) return;
      // Display as an image: generated SVG never becomes active chat DOM.
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      parsed.style.backgroundColor = colors.background;
      for (const filter of parsed.querySelectorAll('filter')) filter.remove();
      for (const node of parsed.querySelectorAll('*')) {
        node.removeAttribute('filter');
        node.style?.setProperty('filter', 'none', 'important');
        node.style?.setProperty('box-shadow', 'none', 'important');
        node.style?.setProperty('text-shadow', 'none', 'important');
      }
      for (const shape of parsed.querySelectorAll(
        '.node rect, .node circle, .node ellipse, .node polygon, .node path, .cluster rect, .labelBkg, .edgeLabel rect, rect.actor, rect.note',
      )) {
        shape.style.setProperty('fill', 'none', 'important');
        shape.style.setProperty('stroke', colors.lineColor, 'important');
      }
      const dimensions = (parsed.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number);
      const image = document.createElement('img');
      image.alt = '会话图表';
      if (dimensions.length === 4 && dimensions[2] > 0 && dimensions[3] > 0) {
        image.width = Math.ceil(dimensions[2]);
        image.height = Math.ceil(dimensions[3]);
        parsed.setAttribute('width', image.width);
        parsed.setAttribute('height', image.height);
        if (image.width <= 600) image.className = 'diagram-fit';
      }
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(parsed))}`;
      await image.decode();
      if (!current()) return;
      const scroll = scrollOwners.get(log),
        before = scroll?.capture();
      pre.querySelectorAll(':scope > .diagram-error').forEach((note) => note.remove());
      let figure = pre.closest('.chat-diagram');
      if (figure) figure.querySelector('.diagram-viewport').replaceChildren(image);
      else {
        figure = document.createElement('figure');
        figure.className = 'chat-diagram';
        const viewport = document.createElement('div');
        viewport.className = 'diagram-viewport';
        viewport.tabIndex = 0;
        viewport.setAttribute('aria-label', '图表，可横向滚动');
        viewport.append(image);
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '查看图表源码';
        details.append(summary);
        pre.before(figure);
        details.append(pre);
        figure.append(viewport, details);
      }
      figure.dataset.theme = document.documentElement.dataset.deviceTheme;
      if (before) scroll.restore(before);
    } catch {
      if (!current()) return;
      pre.querySelectorAll(':scope > .diagram-error').forEach((note) => note.remove());
      const note = document.createElement('div');
      note.className = 'diagram-error';
      note.append('图表暂时无法显示，已保留源码。');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', () => {
        note.remove();
        pending.delete(pre);
        render(log);
      });
      note.append(retry);
      pre.prepend(note);
    } finally {
      host?.remove();
    }
  }

  function render(log, scroll) {
    if (scroll) scrollOwners.set(log, scroll);
    for (const pre of log.querySelectorAll('pre[data-diagram="mermaid"]')) {
      if (pending.get(pre) === generation) continue;
      const requestedGeneration = generation;
      pending.set(pre, requestedGeneration);
      // Mermaid uses shared parser/configuration state; serialize diagrams.
      queue = queue.then(() => draw(pre, log, requestedGeneration)).catch(() => {});
    }
    return queue;
  }
  window.StudioDiagrams = { render };
  let themeSignature = JSON.stringify(themeVariables());
  window.addEventListener('herdr:themechange', () => {
    const signature = JSON.stringify(themeVariables());
    if (signature === themeSignature) {
      for (const figure of document.querySelectorAll('#chatLog .chat-diagram'))
        figure.dataset.theme = document.documentElement.dataset.deviceTheme;
      return;
    }
    themeSignature = signature;
    generation += 1;
    const log = document.querySelector('#chatLog');
    if (log) render(log);
  });
})();
