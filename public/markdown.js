(function initStudioMarkdown(root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.StudioMarkdown = model;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  /**
   * agent 输出的 markdown 子集渲染。
   *
   * 🔑 全程用 DOM API 构造,**不碰 innerHTML** —— 内容来自 agent,里面完全可能
   * 出现 `<script>` 或 `onerror=`,拼字符串再塞进 innerHTML 就是一个现成的 XSS。
   * 用 createElement/textContent 的话,任何尖括号都只会变成字面文本。
   *
   * 只认这些:标题、段落、有序/无序列表、围栏代码块、引用、水平线、表格,
   * 行内认 `code`、**粗**、*斜*、[文字](链接)。公式单独交给本地 KaTeX，
   * 禁用可信 HTML/URL 命令；不支持或未完成的公式保留源码。
   * 完整的 Mermaid 围栏由 diagrams.js 挂载后异步渲染，源码始终保留。
   */

  /** 只放行 http/https:javascript: 和 data: 都能在 <a> 上执行脚本。 */
  function safeHref(url) {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) return null;
    return value;
  }

  // 相对链接默认不成为链接：聊天流里的正文来自 Agent，指向本机路径的链接点了也
  // 没有意义。文件面板是例外 —— 任务材料之间互相引用走的全是相对路径
  // （`[当前结果](results.md)`），所以它传一个解析器进来，把相对路径变成面板内
  // 的一跳。解析器返回 null 时仍然退回纯文本。
  let resolveRelative = null;
  // 内嵌图片同理：聊天流里 Agent 回复的图片由服务端拆成图片块，不经过这里；文件面板
  // 读的是原始 Markdown，所以它再传一个图片解析器进来。`resolveImage(raw, alt)` 返回
  // 一个节点，或者 null 表示退回成链接或纯文本。
  let resolveImage = null;

  function renderMath(tex, target, displayMode, original) {
    const node = document.createElement(displayMode ? 'div' : 'span');
    node.className = displayMode ? 'chat-math display' : 'chat-math';
    try {
      globalThis.katex.render(tex, node, {
        displayMode,
        output: 'htmlAndMathml',
        trust: false,
        strict: 'ignore',
        throwOnError: true,
        maxExpand: 1000,
        maxSize: 20,
      });
    } catch {
      node.textContent = original;
      node.className += ' math-source';
    }
    target.append(node);
  }

  /** 行内:代码 → 链接 → 粗 → 斜,先切出代码以免它内部的星号被当格式。 */
  function renderInline(text, target, allowLinks = true) {
    // URL 里可以有成对括号(javascript:alert(1)、wiki 的 foo_(bar));只认第一个 ')'
    // 会把多出来的括号留在正文里。
    const pattern =
      /(`[^`]+`)|(\\\([\s\S]*?\\\))|(\$[^$\s\n](?:[^$\n]*?[^$\s\n])?\$(?!\d))|(!?\[[^\]]*\]\((?:<[^>\n]+>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
    let index = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > index) target.append(text.slice(index, match.index));
      const token = match[0];
      if (token.startsWith('`')) {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        target.append(code);
      } else if (token.startsWith('\\(') || token.startsWith('$')) {
        const size = token.startsWith('$') ? 1 : 2;
        renderMath(token.slice(size, -size), target, false, token);
      } else if (token.startsWith('![')) {
        const split = token.indexOf('](');
        const alt = token.slice(2, split);
        const raw = token.slice(split + 2, -1).replace(/^<(.+)>$/, '$1');
        const image = allowLinks && resolveImage ? resolveImage(raw, alt) : null;
        if (image) target.append(image);
        else {
          // 没有图片解析器（聊天流）保持原来的样子：感叹号照留，后面按普通链接处理。
          // 有解析器但显示不了（外链图片）就只留成链接，感叹号没有意义。
          if (!resolveImage) target.append('!');
          renderInline(token.slice(1), target, allowLinks);
        }
      } else if (token.startsWith('[')) {
        const split = token.indexOf('](');
        const label = token.slice(1, split);
        const raw = token.slice(split + 2, -1).replace(/^<(.+)>$/, '$1');
        const href = label && allowLinks && safeHref(raw);
        const relative =
          !href && label && allowLinks && resolveRelative ? resolveRelative(raw) : null;
        if (href || relative) {
          const link = document.createElement('a');
          renderInline(label, link, false);
          if (href) {
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
          } else {
            // 面板内的一跳：不给 href，免得中键、右键「在新标签页打开」得到一个
            // 打不开的地址；它是这一页里的导航，不是一个可分享的位置。
            link.className = 'md-local-link';
            if (relative.path) link.dataset.filePath = relative.path;
            if (relative.downloadUrl) {
              link.dataset.downloadUrl = relative.downloadUrl;
              link.dataset.downloadName = relative.path;
            }
            link.setAttribute('role', 'link');
            link.tabIndex = 0;
            const go = (event) => {
              event.preventDefault();
              relative();
            };
            link.addEventListener('click', go);
            link.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') go(event);
            });
          }
          target.append(link);
        } else {
          // 协议不安全就退回纯文本,既不丢信息也不给可点的入口
          target.append(token);
        }
      } else if (token.startsWith('**')) {
        const strong = document.createElement('strong');
        // Formatting containers may contain links and code. Parsing their
        // children retains semantics without interpreting arbitrary HTML.
        renderInline(token.slice(2, -2), strong, allowLinks);
        target.append(strong);
      } else {
        const em = document.createElement('em');
        renderInline(token.slice(1, -1), em, allowLinks);
        target.append(em);
      }
      index = match.index + token.length;
    }
    if (index < text.length) target.append(text.slice(index));
    return target;
  }

  function isTableDivider(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  }

  function splitRow(line) {
    return line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function renderMarkdown(source) {
    const fragment = document.createDocumentFragment();
    const lines = String(source || '').split('\n');
    let cursor = 0;

    const flushParagraph = (buffer) => {
      if (!buffer.length) return;
      const p = document.createElement('p');
      renderInline(buffer.join('\n'), p);
      fragment.append(p);
      buffer.length = 0;
    };
    const paragraph = [];

    while (cursor < lines.length) {
      const line = lines[cursor];

      // 围栏代码块:内部原样保留,不做任何行内解析
      const fence = line.match(/^\s*```(\S*)\s*$/);
      if (fence) {
        flushParagraph(paragraph);
        const body = [];
        cursor += 1;
        while (cursor < lines.length && !/^\s*```\s*$/.test(lines[cursor])) {
          body.push(lines[cursor]);
          cursor += 1;
        }
        const complete = cursor < lines.length;
        cursor += 1; // 吃掉收尾围栏;没有收尾也不要紧,循环已经到头
        const pre = document.createElement('pre');
        if (complete && fence[1].toLowerCase() === 'mermaid') pre.dataset.diagram = 'mermaid';
        const code = document.createElement('code');
        if (fence[1]) code.dataset.lang = fence[1];
        code.textContent = body.join('\n');
        if (code.textContent.includes('\x1b') && globalThis.StudioAnsi)
          globalThis.StudioAnsi.renderAnsi(code, code.textContent);
        else globalThis.StudioCodeView?.highlightElement(code, fence[1]);
        pre.append(code);
        fragment.append(pre);
        continue;
      }

      const mathStart = line.match(/^\s*(\\\[|\$\$)/);
      if (mathStart) {
        const closing = mathStart[1] === '\\[' ? '\\]' : '$$';
        const body = [line.slice(mathStart[0].length)];
        let end = cursor;
        while (!body.at(-1).includes(closing) && end + 1 < lines.length) body.push(lines[++end]);
        const close = body.at(-1).indexOf(closing);
        if (close >= 0) {
          flushParagraph(paragraph);
          const tail = body.at(-1).slice(close + closing.length);
          body[body.length - 1] = body.at(-1).slice(0, close);
          renderMath(
            body.join('\n').trim(),
            fragment,
            true,
            lines.slice(cursor, end + 1).join('\n'),
          );
          if (tail.trim()) paragraph.push(tail);
          cursor = end + 1;
          continue;
        }
        // Streaming may stop before the closing delimiter arrives. Keep the
        // unfinished formula intact instead of parsing its underscores as Markdown.
        flushParagraph(paragraph);
        const pending = document.createElement('div');
        pending.className = 'chat-math display math-source';
        pending.textContent = lines.slice(cursor, end + 1).join('\n');
        fragment.append(pending);
        cursor = end + 1;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph(paragraph);
        fragment.append(document.createElement('hr'));
        cursor += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph(paragraph);
        const node = document.createElement(`h${Math.min(6, heading[1].length)}`);
        renderInline(heading[2], node);
        fragment.append(node);
        cursor += 1;
        continue;
      }

      // 表格:标题行 + 分隔行 才算,否则一行普通的竖线文本会被误判
      if (line.includes('|') && cursor + 1 < lines.length && isTableDivider(lines[cursor + 1])) {
        flushParagraph(paragraph);
        const table = document.createElement('table');
        const head = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const cell of splitRow(line)) {
          const th = document.createElement('th');
          renderInline(cell, th);
          headRow.append(th);
        }
        head.append(headRow);
        table.append(head);
        const body = document.createElement('tbody');
        cursor += 2;
        while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
          const row = document.createElement('tr');
          for (const cell of splitRow(lines[cursor])) {
            const td = document.createElement('td');
            renderInline(cell, td);
            row.append(td);
          }
          body.append(row);
          cursor += 1;
        }
        table.append(body);
        fragment.append(table);
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushParagraph(paragraph);
        const block = document.createElement('blockquote');
        const body = [quote[1]];
        cursor += 1;
        while (cursor < lines.length && /^\s*>\s?/.test(lines[cursor])) {
          body.push(lines[cursor].replace(/^\s*>\s?/, ''));
          cursor += 1;
        }
        renderInline(body.join('\n'), block);
        fragment.append(block);
        continue;
      }

      const bullet = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (bullet) {
        flushParagraph(paragraph);
        const ordered = /\d/.test(bullet[1]);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        // 有序列表从第一项自己的编号开始（CommonMark 的规定）。项与项之间隔着一段正文时，
        // 每一项各成一个列表，不带 start 就全显示成 1.（2026-09-24 用户指出）。
        const first = ordered ? Number.parseInt(bullet[1], 10) : 1;
        if (first !== 1) list.start = first;
        while (cursor < lines.length) {
          // 列表项之间常有空行(agent 输出里很普遍)。空行就断开的话,每一项都会
          // 变成独立的 <ol>,于是 1. 2. 3. 全渲染成 1. —— 所以先越过空行,
          // 确认后面还是同类项再继续,不是就把 cursor 留在空行处交给外层。
          let probe = cursor;
          while (probe < lines.length && !lines[probe].trim()) probe += 1;
          const item =
            probe < lines.length ? lines[probe].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/) : null;
          if (!item || /\d/.test(item[1]) !== ordered) break;
          cursor = probe;
          const li = document.createElement('li');
          renderInline(item[2], li);
          list.append(li);
          cursor += 1;
        }
        fragment.append(list);
        continue;
      }

      if (!line.trim()) {
        flushParagraph(paragraph);
        cursor += 1;
        continue;
      }

      paragraph.push(line);
      cursor += 1;
    }
    flushParagraph(paragraph);
    return fragment;
  }

  /**
   * 在一次渲染期间启用相对链接。`resolve(raw)` 返回一个点击时执行的函数，
   * 或者 null 表示这条链接仍然退回纯文本。渲染结束后自动关掉，不影响聊天流。
   */
  function renderMarkdownWithLinks(source, resolve, { image = null } = {}) {
    resolveRelative = typeof resolve === 'function' ? resolve : null;
    resolveImage = typeof image === 'function' ? image : null;
    try {
      return renderMarkdown(source);
    } finally {
      resolveRelative = null;
      resolveImage = null;
    }
  }

  return { renderMarkdown, renderMarkdownWithLinks, safeHref };
});
