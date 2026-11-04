/** Isolated HTML reports. App authentication stays in the parent document. */
(function (root) {
  'use strict';
  function render(container, doc, { onOpen, renderSource }) {
    container.replaceChildren();
    container.classList.add('html-document');
    const toolbar = document.createElement('div');
    toolbar.className = 'html-document-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'HTML 显示方式');
    const previewButton = document.createElement('button'),
      sourceButton = document.createElement('button');
    previewButton.textContent = '预览';
    sourceButton.textContent = '源码';
    for (const button of [previewButton, sourceButton]) {
      button.type = 'button';
      toolbar.append(button);
    }
    const status = document.createElement('div');
    status.className = 'html-document-status';
    status.setAttribute('role', 'status');
    const frame = document.createElement('iframe');
    frame.className = 'html-document-frame';
    frame.title = doc.title || 'HTML 预览';
    frame.referrerPolicy = 'no-referrer';
    const source = document.createElement('div');
    source.className = 'html-document-source';
    source.hidden = true;
    container.append(toolbar, status, frame, source);
    let channel = null,
      timer = null,
      disposed = false,
      sourceRendered = false,
      initialized = false;
    // Android's legacy Java bridge is injected into every frame, even opaque
    // sandbox origins. Never execute report scripts in that WebView.
    const staticOnly = typeof window.StudioApp?.closeChat === 'function';
    frame.setAttribute('sandbox', staticOnly ? '' : 'allow-scripts');
    function showSource(on) {
      previewButton.setAttribute('aria-pressed', String(!on));
      sourceButton.setAttribute('aria-pressed', String(on));
      frame.hidden = on;
      source.hidden = !on;
      status.hidden = on || !status.childNodes.length;
      if (on && !sourceRendered) {
        renderSource(source);
        sourceRendered = true;
      }
    }
    previewButton.addEventListener('click', () => showSource(false));
    sourceButton.addEventListener('click', () => showSource(true));
    function loaded() {
      clearTimeout(timer);
      if (staticOnly) status.textContent = '当前手机客户端显示静态预览，页面交互请在电脑上使用。';
      else status.replaceChildren();
      showSource(!source.hidden);
    }
    function start() {
      channel?.port1.close();
      clearTimeout(timer);
      initialized = false;
      status.textContent = '正在加载预览…';
      status.hidden = false;
      timer = setTimeout(() => {
        if (disposed) return;
        status.textContent = '预览未能加载。';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'chat-btn';
        retry.textContent = '重试';
        retry.addEventListener('click', start);
        status.append(retry);
      }, 12000);
      if (staticOnly) {
        // A scriptless srcdoc needs no relaxed parent policy or native API.
        // Prefix the policy before the parser sees any report resource URL.
        frame.srcdoc =
          '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data: blob:; font-src data:; form-action &#39;none&#39;; base-uri &#39;none&#39;">' +
          doc.text;
      } else {
        frame.src = new URL('files/html-preview.html', document.baseURI).href;
      }
    }
    frame.addEventListener('load', () => {
      if (disposed || initialized) return;
      initialized = true;
      if (staticOnly) {
        loaded();
        return;
      }
      channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        if (disposed || !container.isConnected) return;
        if (event.data?.type === 'rendered') {
          loaded();
          return;
        }
        if (event.data?.type !== 'link' || typeof event.data.href !== 'string') return;
        const href = event.data.href.trim(),
          local = StudioDocView.localHref(href);
        if (local) {
          try {
            onOpen(StudioDocView.resolvePath(doc.path, decodeURIComponent(local)));
          } catch {
            /* malformed link */
          }
        } else if (/^https?:\/\//i.test(href)) {
          try {
            const url = new URL(href);
            if (!url.username && !url.password)
              window.open(url.href, '_blank', 'noopener,noreferrer');
          } catch {
            /* malformed link */
          }
        }
      };
      // The target has an opaque origin; a private transferred port provides
      // the reply channel. No global message handler accepts report commands.
      frame.contentWindow.postMessage({ type: 'swift.html.document', text: doc.text }, '*', [
        channel.port2,
      ]);
    });
    showSource(false);
    start();
    return () => {
      disposed = true;
      clearTimeout(timer);
      channel?.port1.close();
      frame.remove();
      container.classList.remove('html-document');
    };
  }
  root.StudioHtmlView = { render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
