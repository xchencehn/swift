/**
 * 会话文件面板里的文档正文：Markdown 按聊天流那一套排版，代码按语言着色（files/code-view.js），
 * 纯文本原样显示。正文里的相对链接变成面板内的一跳（docs/PRODUCT_SPEC.md 2.4）。全程只读。
 *
 * 会话面板继续列会话文档与搜索结果；独立目录树由 workspace.js 管理，本模块复用正文渲染。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioDocView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const text = (node, value) => {
    node.textContent = value == null ? '' : String(value);
    return node;
  };
  const codeView = typeof window !== 'undefined' ? window.StudioCodeView : null;
  const make = (tag, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  /** 仅缩短展示路径；原始绝对路径继续用于读取和相对链接解析。 */
  function displayPath(file, rootDirectory) {
    const value = String(file || ''),
      directory = String(rootDirectory || '').replace(/\/+$/, '');
    if (!directory) return rootDirectory === '/' ? value.replace(/^\//, '') || '.' : value;
    if (value === directory) return '.';
    return value.startsWith(`${directory}/`) ? value.slice(directory.length + 1) : value;
  }

  /** 相对于某份文档解析一条相对链接（越界交给服务端再挡一次）。 */
  function resolvePath(from, href) {
    const base = String(href || '').startsWith('/')
      ? ['']
      : String(from || '')
          .split('/')
          .slice(0, -1);
    const parts = String(href || '').split('/');
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') base.pop();
      else base.push(part);
    }
    return base.join('/');
  }

  /** 把锚点、查询和外链剥掉；剩下的才是一条本地相对路径。 */
  function localHref(href) {
    const value = String(href || '').trim();
    if (!value || /^[a-z][\w+.-]*:/i.test(value) || value.startsWith('#') || value.startsWith('//'))
      return null;
    return value.split('#')[0].split('?')[0] || null;
  }

  const ago = (at, now = Date.now()) => {
    const minutes = Math.max(0, Math.round((now - Number(at || 0)) / 60000));
    if (!Number.isFinite(minutes) || !at) return '';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.round(hours / 24);
    return days < 30 ? `${days} 天前` : `${Math.round(days / 30)} 个月前`;
  };

  /**
   * @param {object} deps
   *   `markdown(source, resolve, image)` 渲染 Markdown；与聊天流共用同一套，所以主题、
   *                      字号、代码块和公式都一致。
   */
  function createDocView({ markdown }) {
    /**
     * 一份文档的正文。
     *
     * Markdown 用聊天流那一套渲染，所以主题、字号、代码块和公式都一致；正文里的
     * 相对链接（文档之间全靠它互相引用）变成面板内的一跳。
     * 不是 Markdown 的就按原样显示，不猜它的语言。
     */
    function renderDoc(container, doc, { onOpen, image = null, rootDirectory = '' }) {
      container.replaceChildren();
      const head = make('div', 'project-doc-head');
      const title = text(make('strong'), doc.title);
      head.append(title);
      head.append(text(make('span'), displayPath(doc.path, rootDirectory)));
      container.append(head);
      // 借聊天流那一套排版：标题层级、列表、引用，以及关键的两条 ——
      // pre 与 table 各自 overflow-x: auto。没有它们，一段长代码就会把面板撑破。
      const body = make('div', 'project-doc-body chat-md');
      if (/\.(md|markdown)$/i.test(doc.path) && markdown) {
        body.append(
          markdown(
            doc.text,
            (href) => {
              const local = localHref(href);
              if (!local) return null;
              const target = resolvePath(doc.path, local);
              if (!target) return null;
              const go = () => onOpen(target);
              go.path = target;
              return go;
            },
            image
              ? (raw, alt) => {
                  // 内嵌图片只认本地相对路径；外链图片受页面的 img-src 限制加载不了，退回成链接。
                  const local = localHref(raw);
                  const target = local && resolvePath(doc.path, local);
                  return target ? image(target, alt) : null;
                }
              : null,
          ),
        );
      } else if (codeView && codeView.languageFor(doc.path)) {
        // 代码直接铺在页面上，不套 .chat-md pre 那个框（2026-09-24 用户要求）。
        body.classList.remove('chat-md');
        codeView.render(body, doc.text, doc.path);
      } else {
        text(body, doc.text);
        body.classList.replace('chat-md', 'project-doc-plain');
      }
      container.append(body);
      // 标题本来就是正文的第一个标题（`# ` 那一行），头部再写一遍就重复了，只留路径。
      const heading = body.querySelector('h1, h2');
      if (
        heading &&
        heading === body.firstElementChild &&
        heading.textContent.trim() === String(doc.title || '').trim()
      )
        title.remove();
      if (doc.truncated) {
        container.append(
          text(
            make('p', 'project-empty'),
            `只显示了前 ${Math.round(doc.text.length / 1024)} KB，这份材料还有更多内容。`,
          ),
        );
      }
    }

    return { renderDoc };
  }

  return { createDocView, resolvePath, localHref, ago, displayPath };
});
