/* 图片、音视频与分页文档共用只读预览和原件下载入口。 */
(function (root) {
  'use strict';
  const make = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  function download(file, url) {
    const button = make('button', 'chat-btn', '下载原文件');
    button.type = 'button';
    button.dataset.saveFile = '';
    button.dataset.downloadUrl = url;
    button.dataset.downloadName = file;
    return button;
  }
  function render(container, doc, { fetchPage, fetchText, downloadUrl, retry, rootDirectory }) {
    let disposed = false,
      pageUrl = null,
      pageToken = 0,
      pageAbort = null;
    const urls = [],
      name = doc.title || doc.file.split('/').pop();
    const head = make('div', 'project-doc-head');
    head.append(
      make('strong', '', name),
      make('span', '', StudioDocView.displayPath(doc.file, rootDirectory)),
    );
    const controls = make('div', 'file-preview-controls');
    const save = download(doc.file, downloadUrl);
    const status = make('p', 'file-preview-status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const saveStatus = make('p', 'file-preview-status');
    saveStatus.dataset.fileSaveStatus = '';
    saveStatus.setAttribute('role', 'status');
    saveStatus.hidden = true;
    const body = make('div', 'file-preview-body');
    const wrap = make('section', 'file-preview');
    wrap.setAttribute('aria-label', name);
    wrap.append(head, controls, status, saveStatus, body);
    container.replaceChildren(wrap);
    let media;
    const feedback = (message, action) => {
      status.replaceChildren(make('span', '', message));
      status.hidden = false;
      if (action) {
        const button = make('button', 'chat-btn', '重试');
        button.type = 'button';
        button.addEventListener('click', action);
        status.append(button);
      }
    };
    if (StudioFileTypes.paginated(doc.kind)) {
      const previous = make('button', 'chat-btn', '上一页'),
        next = make('button', 'chat-btn', '下一页');
      previous.type = next.type = 'button';
      const input = make('input', 'file-preview-page');
      input.type = 'number';
      input.inputMode = 'numeric';
      input.min = '1';
      input.max = String(doc.pages);
      input.setAttribute('aria-label', '页码');
      const label = make('label', 'file-preview-pagination');
      label.append(input, make('span', '', `/ ${doc.pages} 页`));
      const pageView = make('button', 'chat-btn', '页面'),
        textView = make('button', 'chat-btn', '文字'),
        zoom = make('button', 'chat-btn', '放大');
      for (const button of [pageView, textView, zoom]) button.type = 'button';
      pageView.setAttribute('aria-pressed', 'true');
      textView.setAttribute('aria-pressed', 'false');
      zoom.setAttribute('aria-pressed', 'false');
      controls.append(previous, label, next, pageView, textView, zoom, save);
      media = make('img', 'doc-page');
      media.decoding = 'async';
      const plain = make('pre', 'file-preview-text');
      plain.hidden = true;
      body.append(media, plain);
      let current = 1,
        mode = 'page',
        zoomed = false;
      zoom.addEventListener('click', () => {
        zoomed = !zoomed;
        body.classList.toggle('file-preview-zoom', zoomed);
        zoom.textContent = zoomed ? '适应宽度' : '放大';
        zoom.setAttribute('aria-pressed', String(zoomed));
      });
      for (const event of ['touchstart', 'touchmove', 'touchend', 'wheel'])
        body.addEventListener(
          event,
          (event) => {
            if (zoomed) event.stopPropagation();
          },
          { passive: true },
        );
      const select = (value) => {
        if (mode === value) return;
        mode = value;
        pageView.setAttribute('aria-pressed', String(mode === 'page'));
        textView.setAttribute('aria-pressed', String(mode === 'text'));
        zoom.hidden = mode === 'text';
        void show(current);
      };
      pageView.addEventListener('click', () => select('page'));
      textView.addEventListener('click', () => select('text'));
      async function show(page) {
        if (disposed) return;
        if (!Number.isSafeInteger(page) || page < 1 || page > doc.pages) {
          input.value = String(current);
          return;
        }
        current = page;
        const mine = ++pageToken;
        pageAbort?.abort();
        pageAbort = new AbortController();
        previous.disabled = page === 1;
        next.disabled = page === doc.pages;
        input.value = String(page);
        feedback(`正在读取第 ${page} 页…`);
        media.hidden = plain.hidden = true;
        body.setAttribute('aria-busy', 'true');
        try {
          if (mode === 'text') {
            const result = await fetchText(page, doc.version, { signal: pageAbort.signal });
            if (disposed || mine !== pageToken) return;
            plain.textContent = result.text?.trim() ? result.text : '这一页没有可提取的文字。';
            plain.hidden = false;
            status.hidden = true;
            return;
          }
          const blob = await fetchPage(page, doc.version, { signal: pageAbort.signal });
          if (disposed || mine !== pageToken) return;
          const url = URL.createObjectURL(blob);
          if (pageUrl) URL.revokeObjectURL(pageUrl);
          pageUrl = url;
          media.alt = `${name}，第 ${page} 页，共 ${doc.pages} 页`;
          media.src = url;
          await media.decode();
          if (disposed || mine !== pageToken) return;
          media.hidden = false;
          status.hidden = true;
          container.scrollTop = 0;
        } catch (error) {
          if (disposed || mine !== pageToken) return;
          feedback(error.message || '这一页读取失败，请重试或下载原文件。', () =>
            error.message?.includes('改变') ? retry() : void show(page),
          );
        } finally {
          if (!disposed && mine === pageToken) body.removeAttribute('aria-busy');
        }
      }
      previous.addEventListener('click', () => void show(current - 1));
      next.addEventListener('click', () => void show(current + 1));
      input.addEventListener('change', () => void show(Number(input.value)));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void show(Number(input.value));
        }
      });
      void show(1);
    } else {
      controls.append(save);
      const url = URL.createObjectURL(doc.blob);
      urls.push(url);
      const tag = doc.kind === 'image' ? 'img' : doc.kind;
      media = make(tag, `doc-${doc.kind}`);
      media.dataset.path = doc.file;
      if (tag === 'img') {
        media.alt = name;
        media.decoding = 'async';
      } else {
        media.controls = true;
        media.preload = 'metadata';
        media.setAttribute('aria-label', name);
        if (tag === 'video') media.playsInline = true;
      }
      media.addEventListener('error', () =>
        feedback(
          tag === 'img'
            ? '图片无法显示，请重试或下载原文件。'
            : '当前设备无法播放此文件，请下载后使用支持该编码的播放器打开。',
          tag === 'img' ? retry : null,
        ),
      );
      media.src = url;
      body.append(media);
    }
    return () => {
      disposed = true;
      pageToken++;
      pageAbort?.abort();
      if (media?.tagName === 'VIDEO' || media?.tagName === 'AUDIO') {
        media.pause();
        media.removeAttribute('src');
        media.load();
      }
      if (pageUrl) URL.revokeObjectURL(pageUrl);
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }
  root.StudioMediaView = { render, download };
})(typeof globalThis !== 'undefined' ? globalThis : this);
