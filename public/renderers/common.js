'use strict';

/**
 * 各家渲染器共用的基础件。
 *
 * 这里只放两家都一样的东西：文本、Markdown、代码复制、图片、工具行。
 * 凡是某一家特有的（Claude 的 recap、接口错误标记）都留在它自己的
 * 渲染器里，不要为了"少写几行"把它们挪进来 —— 那样公共件里就会长出一串
 * 按来源判断的分支，这正是拆分要消掉的东西。
 *
 * 块的渲染依赖宿主注入的能力（Markdown、图片、复制、工具行）：渲染器不直接
 * 取全局状态，也不发请求，只把宿主给的东西拼成节点。
 */
(function (root) {
  /**
   * 渲染一条消息的全部块。
   * @param {object} message 统一消息
   * @param {object} host 宿主能力：renderMarkdown / renderImage / renderTool / plainText / onCopyCode
   */
  function renderBlocks(message, host) {
    const nodes = [];
    for (const block of message.blocks || []) {
      const wrap = document.createElement('div');
      wrap.className = 'chat-block';
      if (block.kind === 'image') {
        wrap.append(host.renderImage(block, message));
      } else if (block.kind === 'tools') {
        wrap.className = 'chat-tools';
        const items = block.items?.length ? block.items : [{ name: block.summary }];
        items.forEach((item, index) => wrap.append(host.renderTool(item, message, block, index)));
      } else if (block.kind === 'text' && host.renderText) {
        wrap.append(host.renderText(block, message));
      } else if (message.role === 'assistant' && host.renderMarkdown) {
        // Agent 的正文本来就是按 Markdown 写的；自己发的保持纯文本 ——
        // 输入框里打的字就是字面意思，不该被当成标记语言重新解释。
        wrap.classList.add('chat-md');
        wrap.append(host.renderMarkdown(block.text));
        if (host.onCopyCode) for (const pre of wrap.querySelectorAll('pre')) host.onCopyCode(pre);
      } else {
        host.plainText(wrap, block.text);
      }
      nodes.push(wrap);
    }
    return nodes;
  }

  /**
   * 提问的通用骨架：表头、问题、选项、自填、提交。
   *
   * 两家的提问机制不同（见 docs/PRODUCT_SPEC.md 2.6），但**摆放方式**是一样的：
   * 贴在背景上、等宽字、一行一个选项、点选而不是弹窗。所以骨架放在这里，
   * 各家只提供自己的表头文字和选项形状。
   *
   * @param {object} prompt 统一后的提问
   * @param {object} host   宿主能力：onToggle / onText / onSubmit / state
   */
  function renderQuestion(
    prompt,
    host,
    { heading, describeOption, textPlaceholder = '或者直接写一个答案' },
  ) {
    const root = document.createElement('div');

    const head = document.createElement('div');
    head.className = 'chat-inline-question-head';
    head.textContent = heading;
    root.append(head);

    const title = document.createElement('div');
    title.className = 'chat-inline-question-title';
    title.textContent = prompt.question || '';
    root.append(title);

    if (prompt.stage === 'review' && prompt.review) {
      const note = document.createElement('div');
      note.className = 'chat-inline-question-note';
      note.textContent = prompt.review;
      root.append(note);
    }

    const buttons = [];
    (prompt.options || []).forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-inline-option';
      button.setAttribute('aria-pressed', String(host.state.choices.includes(index)));
      const mark = document.createElement('span');
      mark.className = 'chat-inline-option-mark';
      mark.textContent = host.state.choices.includes(index) ? (prompt.multiSelect ? '✓' : '❯') : '';
      const label = document.createElement('span');
      label.className = 'chat-inline-option-label';
      label.textContent = describeOption(option, index);
      button.append(mark, label);
      if (option.description) {
        const hint = document.createElement('span');
        hint.className = 'chat-inline-option-hint';
        hint.textContent = option.description;
        button.append(hint);
      }
      button.addEventListener('click', () => host.onToggle(index));
      buttons.push(button);
      root.append(button);
    });

    let input = null;
    if (prompt.allowText !== false && prompt.stage !== 'review') {
      input = document.createElement(prompt.isSecret ? 'input' : 'textarea');
      if (prompt.isSecret) {
        input.type = 'password';
        input.autocomplete = 'off';
      } else input.rows = 2;
      input.className = 'chat-inline-question-text';
      input.placeholder = textPlaceholder;
      input.setAttribute('aria-label', '自己写一个答案');
      input.value = host.state.text || '';
      input.addEventListener('input', () => {
        host.onText(input.value);
        // 自填与选项互斥。这里就地抹掉选中标记，不整块重绘 —— 重绘会重建输入框，
        // 打字打到一半就失去焦点了。
        if (input.value)
          for (const button of buttons) {
            button.setAttribute('aria-pressed', 'false');
            button.querySelector('.chat-inline-option-mark').textContent = '';
          }
      });
      root.append(input);
    }

    const actions = document.createElement('div');
    actions.className = 'chat-inline-question-actions';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent =
      prompt.stage === 'review'
        ? '确认提交'
        : prompt.total > 1
          ? `提交并继续（${(prompt.index ?? 0) + 1}/${prompt.total}）`
          : '提交';
    submit.addEventListener('click', () => host.onSubmit());
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    if (host.state.status) status.textContent = host.state.status;
    if (host.state.error) {
      status.className = 'chat-inline-question-error';
      status.textContent = host.state.error;
    }
    actions.append(submit, status);
    root.append(actions);

    if (host.state.locked) {
      submit.disabled = true;
      for (const button of buttons) button.disabled = true;
      if (input) input.disabled = true;
    }
    return root;
  }

  /** 一个小标签，用来把非对话内容从回答里分出来。 */
  function mark(className, text) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
  }

  /**
   * 兜底渲染器：只渲染块，不加任何来源特有的标记。
   * 来源未知时用它，宁可朴素也不要空白。
   */
  const base = {
    harnessId: 'unknown',
    label: '未知来源',
    schemaVersion: 1,
    renderMessage(message, bubble, host) {
      bubble.append(...renderBlocks(message, host));
    },
  };

  root.StudioRendererCommon = { renderBlocks, mark, base, renderQuestion };
  root.StudioRenderers?.setFallback(base);
})(typeof window === 'undefined' ? globalThis : window);
