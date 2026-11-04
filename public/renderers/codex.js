'use strict';

/**
 * Codex 的聊天流渲染器。
 *
 * 正文和工具沿用公共块；中断及上下文压缩完成记录保留 Codex 自己的语义，
 * 不使用 Claude 的 recap 或接口错误标记。
 */
(function (root) {
  const { renderBlocks, renderQuestion, mark } = root.StudioRendererCommon;
  const QuestionReply = root.StudioCodexQuestionReply;

  function renderUserText(block, host) {
    const content = document.createDocumentFragment();
    const parts = QuestionReply.parts(block.text);
    const structured = parts.some((part) => part.kind === 'question_reply');
    if (!structured) {
      host.plainText(content, block.text);
      return content;
    }
    for (const part of parts) {
      if (part.kind === 'text') {
        if (!part.text.trim()) continue;
        const text = document.createElement('div');
        text.className = 'codex-reply-text';
        host.plainText(text, structured ? part.text.trim() : part.text);
        content.append(text);
        continue;
      }
      const reply = document.createElement('dl');
      reply.className = 'codex-question-reply';
      const questionLabel = document.createElement('dt'),
        question = document.createElement('dd');
      questionLabel.textContent = '问题';
      question.className = 'codex-reply-question';
      if (host.renderMarkdown) {
        question.classList.add('chat-md');
        question.append(host.renderMarkdown(part.question));
        if (host.onCopyCode)
          for (const pre of question.querySelectorAll('pre')) host.onCopyCode(pre);
      } else host.plainText(question, part.question);
      const answerLabel = document.createElement('dt'),
        answer = document.createElement('dd');
      answerLabel.textContent = '回答';
      answer.className = 'codex-reply-answer';
      host.plainText(answer, part.answer);
      reply.append(questionLabel, question, answerLabel, answer);
      content.append(reply);
    }
    return content;
  }

  /**
   * Codex 给命令做语法高亮，配色取自它自己的终端（实测 2026-09-22）：
   * 命令名蓝、`--` 青、单个短横灰、紧跟短横的标志词粉、引号串绿、其余按正文色。
   * 照搬它这一套，才是「Codex 的样子」而不是我们另配一套。
   */
  const SHELL = [
    [/^'[^']*'|^"[^"]*"/, 'codex-str'],
    [/^--[A-Za-z][\w-]*/, 'codex-ddash'],
    [/^-[A-Za-z]\w*/, 'codex-flag'],
    [/^\s+/, null],
  ];

  function highlightCommand(command) {
    const out = document.createDocumentFragment();
    let rest = String(command || ''),
      first = true;
    const push = (text, cls) => {
      if (!text) return;
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = text;
      out.append(span);
    };
    while (rest) {
      let matched = false;
      for (const [pattern, cls] of SHELL) {
        const hit = pattern.exec(rest);
        if (!hit) continue;
        push(hit[0], cls);
        rest = rest.slice(hit[0].length);
        matched = true;
        break;
      }
      if (matched) continue;
      const word = /^\S+/.exec(rest)[0];
      // 头一个词是命令名，单独一个颜色 —— 终端里一眼能找到「跑的是什么」。
      push(word, first ? 'codex-cmd' : null);
      first = false;
      rest = rest.slice(word.length);
    }
    return out;
  }

  /**
   * 把公共的工具行改成 Codex 终端里的样子：`• Ran <命令>`。
   *
   * ⚠️ 不要直接显示 `item.detail`：Codex 走的是「代码模式」，工具入参是一层 JS 包装
   * （`text(await tools.exec_command({cmd:"…"}))`），照着显示出来没人看得懂。真正做的
   * 那件事由服务端抽出来放在 `item.action`（lib/agent-transcript.js 的 codexAction），
   * 包装原文仍在展开里。
   */
  function decorate(row, item, host) {
    const action = item.action;
    if (
      !action ||
      !row?.querySelector ||
      (row.dataset?.presentation && row.dataset?.presentation !== 'locations')
    )
      return row;
    const detail = row.querySelector('.chat-tool-detail');
    if (!detail) return row;
    row.classList.add('codex-tool');
    // 行首那颗点按退出码上色：绿是成功、红是失败。这是终端上最先被看到的那一眼，
    // 比读完整行命令快得多。拿不到退出码就不上色，不猜。
    const exitCode = item.outcome?.exitCode;
    const mark = row.querySelector('.chat-tools-mark');
    if (mark && !item.running && Number.isInteger(exitCode)) {
      mark.textContent = '•';
      mark.className = `chat-tools-mark codex-bullet ${exitCode === 0 ? 'ok' : 'bad'}`;
    }
    // 收起时**只有一行**:动词 + 命令,长了用省略号截住。命令常常是几百字符的
    // `python3 -c '…'`,照原样铺开一条要占四五行,一屏就只剩得下两三条。
    // ⚠️ 这里要把换行压成空格:多行命令即便在 nowrap 下也别留着原样进 DOM,
    // 复制出去会带上看不见的断行。
    detail.textContent = '';
    const verb = document.createElement('span');
    verb.className = 'codex-verb';
    verb.textContent = action.verb;
    detail.append(verb);
    if (action.command) {
      const oneLine = action.command.replace(/\s+/g, ' ').trim().slice(0, 240);
      detail.append(document.createTextNode(' '));
      detail.append(
        action.verb === 'Ran' ? highlightCommand(oneLine) : document.createTextNode(oneLine),
      );
    }
    if (row.open) expand(row, item, action, host);
    row.addEventListener('toggle', () => {
      if (row.open) expand(row, item, action, host);
    });
    return row;
  }

  /**
   * 展开里放**能看懂的**东西:真正跑的那条命令、真正的输出、退出码。
   *
   * ⚠️ 公共件建的那两段是原文 —— 入参是代码模式的 JS 包装、结果是一层 JSON 信封
   * (`[{"type":"input_text","text":"{\"exit_code\":0,…}"}]`)。留着有用,但它们不能是
   * 点开之后看到的第一样东西,否则「点了才展开」等于什么也没给。
   */
  function expand(row, item, action, host) {
    const body = row.querySelector('.tool-body');
    if (
      !body ||
      body.dataset?.contentPreview === 'true' ||
      row.dataset?.presentation ||
      body.querySelector('.codex-real')
    )
      return;
    const box = document.createElement('div');
    box.className = 'codex-real';
    const exitCode = item.outcome?.exitCode;
    const output = String(item.outcome?.output || '');
    const parts = [
      ['命令', action.command || ''],
      ['输出', output],
    ];
    if (Number.isInteger(exitCode)) parts.push(['退出码', String(exitCode)]);
    let added = false;
    for (const [label, text] of parts) {
      if (!text.trim()) continue;
      added = true;
      const head = document.createElement('div');
      head.className = 'tool-section-head';
      const name = document.createElement('span');
      name.textContent = label;
      head.append(name);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制';
      copy.classList.add('copy-action');
      if (host?.copyText) copy.addEventListener('click', () => host.copyText(text, copy));
      else copy.hidden = true;
      head.append(copy);
      const pre = document.createElement('pre');
      root.StudioAnsi.renderAnsi(pre, text);
      if (label === '命令') pre.classList.add('tool-command');
      box.append(head, pre);
    }
    if (!added) return;
    body.prepend(box);
    // 原文那两段改个名,免得和上面新加的「输出」撞在一起分不清谁是谁。
    for (const head of body.querySelectorAll('.codex-real ~ .tool-section-head > span')) {
      if (head.textContent === '输入') head.textContent = '调用原文';
      else if (head.textContent === '输出') head.textContent = '返回原文';
    }
  }

  root.StudioRenderers.register({
    harnessId: 'codex',
    label: 'Codex',
    welcomeBrand: { label: 'Codex', icon: 'codex' },
    schemaVersion: 1,
    messageText(message) {
      return (message.blocks || [])
        .filter((block) => typeof block.text === 'string' && block.text)
        .map((block) =>
          message.role === 'user' ? QuestionReply.plainText(block.text) : block.text,
        )
        .join('\n\n');
    },
    renderMessage(message, bubble, host) {
      // 一轮被中断时没有收尾的那段话，正文停在最后几条命令上。终端会写明一行，
      // 这里也要标出来 —— 否则看着就是「跑着跑着没了」。
      if (message.kind === 'aborted') bubble.append(mark('chat-aborted-mark', '中断'));
      // 工具行套一层自己的装饰；其余交给公共件，滚动、分页、节点身份都不碰。
      bubble.append(
        ...renderBlocks(message, {
          ...host,
          ...(message.role === 'user'
            ? { renderText: (block) => renderUserText(block, host) }
            : {}),
          renderTool: (item, owner, block, index) =>
            decorate(host.renderTool(item, owner, block, index), item, host),
        }),
      );
    },

    /**
     * Codex 的提问：`request_user_input(_async)`（v0.156.1 实测，解析与作答在 lib/questions/codex.js）。
     *
     * 与 Claude 不同：它**一问一问单独提交**，没有汇总确认页；异步提问问完 Agent 继续干活，面板收在终端里，
     * 服务端作答时会先替你展开。有的问题**只能填文字**（不给选项），带选项的最后一项「Other」可以自填。
     */
    renderQuestion(prompt, host) {
      const textOnly = !(prompt.options || []).length;
      return renderQuestion(prompt, host, {
        heading:
          prompt.total > 1
            ? `Codex 的问题 ${(prompt.index ?? 0) + 1}/${prompt.total}`
            : 'Codex 想确认一件事',
        describeOption: (option) => option.label,
        textPlaceholder: textOnly ? '写下你的回答' : '或者自己写一个答案（Other）',
      });
    },
  });
})(typeof window === 'undefined' ? globalThis : window);
