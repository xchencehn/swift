(function (root) {
  'use strict';
  const Model = root.StudioToolPresentation;
  const node = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const output = (text, cls = '') => root.StudioAnsi.renderAnsi(node('pre', cls), text);
  const button = (label, action, cls = '') => {
    const el = node('button', cls, label);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
  };
  function chevron() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('tool-chevron');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'm6 4 4 4-4 4');
    svg.append(path);
    return svg;
  }
  let diffLoading;
  function loadDiff() {
    if (root.Diff) return Promise.resolve(root.Diff);
    if (!diffLoading)
      diffLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src =
          (document.querySelector('meta[name="agent-studio-base-path"]')?.content || '') +
          '/vendor/diff/diff.min.js?v=8.0.3';
        script.onload = () =>
          root.Diff ? resolve(root.Diff) : reject(new Error('差异组件未就绪'));
        script.onerror = () => {
          diffLoading = null;
          script.remove();
          reject(new Error('差异组件加载失败'));
        };
        document.head.append(script);
      });
    return diffLoading;
  }
  function summary(row, item) {
    const model = Model.describe(item);
    row.dataset.status = model.status;
    row.classList.toggle('failed', model.failed);
    const head = row.querySelector('summary');
    if (!head.querySelector('.tool-chevron')) head.append(chevron());
    const mark = head.querySelector('.chat-tools-mark');
    mark.textContent =
      model.status === 'running'
        ? '…'
        : model.status === 'failed'
          ? '!'
          : model.status === 'unknown'
            ? '·'
            : '✓';
    mark.setAttribute(
      'aria-label',
      { running: '正在执行', failed: '执行失败', unknown: '状态未确认', completed: '已完成' }[
        model.status
      ],
    );
    if (!model.kind) return model;
    row.dataset.presentation = model.kind;
    const name = head.querySelector('.chat-tool-name');
    name.textContent = model.label;
    const detail = head.querySelector('.chat-tool-detail');
    detail.textContent = model.target;
    detail.title = model.target;
    head.querySelector('.tool-summary-note')?.remove();
    if (model.note) {
      const note = node('span', 'tool-summary-note', model.note);
      head.insertBefore(note, head.querySelector('.tool-chevron'));
    }
    return model;
  }
  function render(body, item, host) {
    const model = Model.describe(item);
    if (!model.kind) return false;
    const section = node('div', 'tool-presentation');
    const head = (label, copy) => {
      const el = node('div', 'tool-section-head');
      el.append(node('span', '', label));
      if (copy !== undefined)
        el.append(
          button('复制', (event) => host.copyText(copy, event.currentTarget), 'copy-action'),
        );
      return el;
    };
    const file = (path) => {
      if (!path) return;
      const el = host.openFile
        ? button(path, () => host.openFile(path), 'tool-file-link')
        : node('span', 'tool-file-link', path);
      el.title = path;
      return el;
    };
    const raw = node('details', 'tool-original');
    raw.append(node('summary', '', '原始记录'), node('div', 'tool-original-content'));
    raw.open = host.rawOpen === true;
    let rawBuilt = false;
    raw.addEventListener('toggle', () => {
      host.saveRawOpen?.(raw.open);
      if (!raw.open || rawBuilt) return;
      rawBuilt = true;
      const content = raw.lastElementChild;
      for (const [label, value] of [
        ['输入', item.input],
        ['输出', item.result],
      ])
        if (value) {
          content.append(head(label, value.text || ''), output(value.text || '（无文本输出）'));
        }
    });
    function previewRows(container, rows, css) {
      let shown = 0;
      const more = button('显示更多', append, 'tool-show-more');
      function append() {
        const next = rows.slice(shown, shown + 160);
        shown += next.length;
        for (const row of next) {
          const el = node(
            'div',
            css +
              ' ' +
              row.kind +
              (css === 'tool-diff-line' && row.oldLine == null && row.newLine == null
                ? ' excerpt'
                : ''),
          );
          if (css === 'tool-diff-line') {
            el.append(
              node('span', 'tool-line-number', row.oldLine ?? ''),
              node('span', 'tool-line-number', row.newLine ?? ''),
              node(
                'span',
                'tool-diff-sign',
                row.kind === 'added'
                  ? '+'
                  : row.kind === 'removed'
                    ? '-'
                    : row.kind === 'hunk'
                      ? '⋯'
                      : ' ',
              ),
            );
          } else el.append(node('span', 'tool-line-number', row.line));
          el.append(root.StudioAnsi.renderAnsi(node('code'), row.text || ' '));
          if (row.gap) el.classList.add('gap-before');
          container.append(el);
        }
        more.remove();
        if (shown < rows.length) {
          more.textContent = `显示更多（剩余 ${rows.length - shown} 行）`;
          container.append(more);
        }
      }
      append();
    }
    function diff(path, rows, label) {
      const box = node('section', 'tool-diff-file'),
        title = head(label);
      if (path) {
        const link = file(path);
        if (link) title.prepend(link);
      }
      const additions = rows.filter((r) => r.kind === 'added').length,
        deletions = rows.filter((r) => r.kind === 'removed').length;
      const stats = node('span', 'tool-diff-stats');
      stats.setAttribute('aria-label', `显示的差异增加 ${additions} 行，删除 ${deletions} 行`);
      stats.append(
        node('span', 'tool-added', `+${additions}`),
        node('span', 'tool-removed', `−${deletions}`),
      );
      if (rows.length) title.append(stats);
      box.append(title);
      const lines = node('div', 'tool-diff-lines');
      lines.tabIndex = 0;
      lines.setAttribute('aria-label', '本次工具调用的文件差异');
      previewRows(lines, rows, 'tool-diff-line');
      box.append(lines);
      if (!rows.length)
        box.append(node('p', 'tool-result-note', '原生记录未包含差异正文，不能计算增删行数。'));
      section.append(box);
    }
    if (model.failed)
      section.append(node('p', 'tool-result-note failed', '执行失败；以下保留本次调用的结果。'));
    if (['search', 'locations'].includes(model.kind) && model.blocks.length) {
      for (const block of model.blocks) {
        if (block.kind === 'text') {
          if (block.text.trim()) section.append(output(block.text, 'tool-search-notice'));
          continue;
        }
        const box = node('section', 'tool-search-file');
        box.append(file(block.path));
        const lines = node('div', 'tool-search-lines');
        lines.tabIndex = 0;
        lines.setAttribute('aria-label', block.path + ' 搜索结果');
        previewRows(lines, block.lines, 'tool-search-line');
        box.append(lines);
        section.append(box);
      }
      section.prepend(
        head(model.kind === 'search' ? '搜索结果' : '输出中的文件位置', model.output),
      );
    } else if (model.kind === 'edit' && !model.failed && !item.input?.truncated) {
      const pending = node('p', 'tool-result-note', '正在生成差异…');
      section.append(pending);
      loadDiff()
        .then((api) => {
          if (!section.isConnected || !host.isCurrent()) return;
          pending.remove();
          const rows = Model.editDiff(model.input, api.diffLines);
          if (rows)
            diff(model.path, rows, model.status === 'completed' ? '替换片段' : '请求的替换片段');
          else
            section.append(node('p', 'tool-result-note', '此调用无法生成行差异，请查看原始记录。'));
        })
        .catch(() => {
          if (section.isConnected && host.isCurrent()) {
            pending.textContent = '差异组件加载失败，原始记录仍可查看。';
            pending.append(
              button('重试', () => {
                body.replaceChildren();
                render(body, item, host);
              }),
            );
          }
        });
    } else if (model.kind === 'patch' && !model.failed) {
      for (const entry of model.files)
        diff(
          entry.path,
          entry.rows,
          entry.operation === 'Delete'
            ? model.status === 'completed'
              ? '删除文件'
              : '请求删除文件'
            : model.status === 'completed'
              ? '本次修改'
              : '请求的修改',
        );
    } else {
      if (model.path && model.kind !== 'search') section.append(file(model.path));
      const label = model.kind === 'write' ? '写入内容（不代表 Git 新增）' : '输出';
      const content =
        model.kind === 'write' && !model.failed && !item.input?.truncated
          ? (model.input.content ?? model.input.contents)
          : model.output;
      if (typeof content === 'string' && content) {
        const pre = output(content.slice(0, 48000), 'tool-preview-text');
        if (
          model.kind === 'write' &&
          !model.failed &&
          !item.input?.truncated &&
          !content.includes('\x1b')
        ) {
          const code = node('code', '', pre.textContent);
          pre.replaceChildren(code);
          pre.classList.add('tool-code');
          root.StudioCodeView?.highlightElement(code, root.StudioCodeView.languageFor(model.path));
        }
        section.append(head(label, content), pre);
        if (content.length > 48000)
          section.append(
            node('p', 'tool-result-note', '此处显示前 48,000 字符，完整内容见原始记录。'),
          );
      } else
        section.append(
          node('p', 'tool-result-note', item.running ? '等待结果…' : '此记录未提供文本结果。'),
        );
    }
    if (model.truncated)
      section.append(node('p', 'tool-result-note', '当前为预览；加载完整详情后显示完整结果。'));
    body.append(section, raw);
    return true;
  }
  root.StudioToolView = { summary, render };
})(globalThis);
