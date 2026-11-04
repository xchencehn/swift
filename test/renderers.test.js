'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 渲染器是浏览器脚本，挂在 window 上。放进沙箱里测，不需要真实页面。
function load() {
  const elements = [];
  const makeElement = (tag) => {
    const element = {
      tagName: tag,
      className: '',
      textContent: '',
      dataset: {},
      children: [],
      style: {},
      ownerDocument: { createElement: makeElement },
      replaceChildren(...nodes) {
        element.children = nodes;
        element.textContent = '';
      },
      classList: {
        add(name) {
          element.className = `${element.className} ${name}`.trim();
        },
      },
      append(...nodes) {
        element.children.push(...nodes);
      },
      prepend(node) {
        element.children.unshift(node);
      },
      querySelectorAll: () => [],
      // 只按类名找，够渲染器用；深度优先，和浏览器一致。
      querySelector(selector) {
        const name = selector.replace('.', '');
        for (const child of element.children) {
          if (typeof child !== 'object') continue;
          if (
            String(child.className || '')
              .split(/\s+/)
              .includes(name)
          )
            return child;
          const deeper = child.querySelector?.(selector);
          if (deeper) return deeper;
        }
        return null;
      },
      addEventListener() {},
    };
    elements.push(element);
    return element;
  };
  const makeText = (text) => ({ textContent: String(text), children: [] });
  const context = {
    window: {},
    console,
    document: {
      createElement: makeElement,
      createTextNode: makeText,
      createDocumentFragment: () => makeElement('#fragment'),
    },
  };
  context.window.StudioCodexQuestionReply = require('../public/codex-question-reply');
  context.window.StudioAnsi = require('../public/ansi');
  context.globalThis = context;
  vm.createContext(context);
  for (const name of ['registry', 'common', 'codex', 'claude']) {
    const file = path.join(__dirname, '..', 'public', 'renderers', `${name}.js`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return { window: context.window, makeElement };
}

// 只收集节点里的文字，用来断言渲染出了什么。
function textOf(node) {
  if (!node || typeof node !== 'object') return String(node ?? '');
  return [node.textContent || '', ...(node.children || []).map(textOf)].join('');
}
function host() {
  return {
    renderMarkdown: (text) => ({ textContent: `[md]${text}`, children: [] }),
    plainText: (element, text) => {
      element.textContent = text;
    },
    renderImage: () => ({ textContent: '[image]', children: [] }),
    renderTool: (item) => {
      // 真实的工具行是 <details>，摘要里有 .chat-tool-name 与 .chat-tool-detail。
      const mark = { className: 'chat-tools-mark', textContent: '✓', children: [] };
      const name = { className: 'chat-tool-name', textContent: item.name || '', children: [] };
      const detail = {
        className: 'chat-tool-detail',
        textContent: item.detail || '',
        children: [],
        append(...nodes) {
          detail.children.push(...nodes);
        },
      };
      // 真实的 <details> 里还有一块 .tool-body，展开才看得到 —— 少了它，
      // 「点了才展开」那一半就测不到。
      const body = {
        className: 'tool-body',
        textContent: '',
        children: [],
        append(...nodes) {
          body.children.push(...nodes);
        },
        prepend(node) {
          body.children.unshift(node);
        },
        querySelector(selector) {
          const key = selector.replace('.', '');
          return (
            body.children.find((node) =>
              String(node.className || '')
                .split(/\s+/)
                .includes(key),
            ) || null
          );
        },
        querySelectorAll: () => [],
      };
      const row = {
        className: 'chat-tool-row',
        open: true,
        addEventListener() {},
        textContent: '',
        children: [mark, name, detail, body],
        classList: {
          add(value) {
            row.className = `${row.className} ${value}`.trim();
          },
        },
        querySelector(selector) {
          const key = selector.replace('.', '');
          return (
            [mark, name, detail, body].find((node) =>
              String(node.className).split(/\s+/).includes(key),
            ) || null
          );
        },
      };
      return row;
    },
    onCopyCode: () => {},
  };
}

test('注册表按来源选渲染器，未知来源回退但标记为降级', () => {
  const { window } = load();
  // 沙箱里的数组与本 realm 的不是同一个原型，比字符串而不是比结构。
  assert.equal(window.StudioRenderers.listed().join(','), 'claude,codex');

  assert.equal(window.StudioRenderers.for('claude').renderer.harnessId, 'claude');
  assert.equal(window.StudioRenderers.for('codex').renderer.harnessId, 'codex');
  assert.equal(
    window.StudioRenderers.for('CLAUDE').renderer.harnessId,
    'claude',
    '大小写不该影响选择',
  );
  assert.equal(window.StudioRenderers.for('claude').degraded, false);

  // 未知来源要有东西显示，但必须让调用方知道这不是完整适配。
  const unknown = window.StudioRenderers.for('kimi-k3');
  assert.equal(unknown.renderer.harnessId, 'unknown');
  assert.equal(unknown.degraded, true);
  assert.equal(unknown.reason, 'no-renderer', '降级原因要能区分，否则提示会说错话');

  // 没有来源时用兜底，且不算降级：这是历史消息的正常情形。
  assert.equal(window.StudioRenderers.for('').degraded, false);
});

test('数据版本高于渲染器支持的版本时标记降级，而不是留白', () => {
  const { window } = load();
  assert.equal(window.StudioRenderers.for('claude', 1).degraded, false);
  assert.equal(
    window.StudioRenderers.for('claude', 9).degraded,
    true,
    '未知版本不能冒充已完整适配',
  );
  assert.equal(window.StudioRenderers.for('claude', 9).reason, 'schema-newer');
  assert.equal(window.StudioRenderers.for('claude', 1).reason, null);
  // 仍然返回渲染器：宁可显示得朴素，也不要整段空白。
  assert.equal(window.StudioRenderers.for('claude', 9).renderer.harnessId, 'claude');
});

test('注册渲染器必须声明来源标识', () => {
  const { window } = load();
  assert.throws(() => window.StudioRenderers.register({ label: '没有标识' }), /harnessId/);
});

test('Claude 渲染器保留它特有的三种记录标记', () => {
  const { window, makeElement } = load();
  const { renderer } = window.StudioRenderers.for('claude');

  const error = makeElement('div');
  renderer.renderMessage(
    {
      id: 'e',
      role: 'assistant',
      kind: 'error',
      status: 529,
      blocks: [{ kind: 'text', text: 'API Error: 529 Overloaded.' }],
    },
    error,
    host(),
  );
  assert.match(textOf(error), /接口错误 529/);
  assert.match(textOf(error), /Overloaded/);

  const withoutStatus = makeElement('div');
  renderer.renderMessage(
    { id: 'e2', role: 'assistant', kind: 'error', blocks: [{ kind: 'text', text: '失败' }] },
    withoutStatus,
    host(),
  );
  assert.match(textOf(withoutStatus), /接口错误(?! \d)/, '没有状态码时不编造一个');

  const recap = makeElement('div');
  renderer.renderMessage(
    { id: 'r', role: 'assistant', kind: 'recap', blocks: [{ kind: 'text', text: '这次做了什么' }] },
    recap,
    host(),
  );
  assert.match(textOf(recap), /recap/, '标签照搬终端写法，不翻译');
});

test('Codex 渲染器不摆 Claude 特有的标记，因为它不产出那些记录', () => {
  const { window, makeElement } = load();
  const { renderer } = window.StudioRenderers.for('codex');

  const bubble = makeElement('div');
  renderer.renderMessage(
    { id: 'm', role: 'assistant', kind: 'recap', blocks: [{ kind: 'text', text: '正文' }] },
    bubble,
    host(),
  );
  assert.equal(
    textOf(bubble).includes('recap'),
    false,
    '摆一个永不出现的标签和压成通用卡片是同一种错',
  );
  assert.match(textOf(bubble), /\[md\]正文/);
});

test('公共件渲染四种块，用户消息保持纯文本', () => {
  const { window, makeElement } = load();
  const { renderer } = window.StudioRenderers.for('codex');

  const assistant = makeElement('div');
  renderer.renderMessage(
    {
      id: 'a',
      role: 'assistant',
      blocks: [
        { kind: 'text', text: '**粗体**' },
        { kind: 'image' },
        { kind: 'tools', items: [{ name: 'Read' }, { name: 'Edit' }] },
      ],
    },
    assistant,
    host(),
  );
  const rendered = textOf(assistant);
  assert.match(rendered, /\[md\]\*\*粗体\*\*/);
  assert.match(rendered, /\[image\]/);
  assert.match(rendered, /Read/);
  assert.match(rendered, /Edit/);

  // 自己发的字就是字面意思，不该被当成标记语言重新解释。
  const user = makeElement('div');
  renderer.renderMessage(
    { id: 'u', role: 'user', blocks: [{ kind: 'text', text: '**不要加粗**' }] },
    user,
    host(),
  );
  assert.equal(textOf(user), '**不要加粗**');
});

test('工具块没有明细时退回摘要，不渲染成空白', () => {
  const { window, makeElement } = load();
  const { renderer } = window.StudioRenderers.for('codex');
  const bubble = makeElement('div');
  renderer.renderMessage(
    { id: 'm', role: 'assistant', blocks: [{ kind: 'tools', items: [], summary: '3 个工具调用' }] },
    bubble,
    host(),
  );
  assert.match(textOf(bubble), /3 个工具调用/);
});

test('宿主没有 Markdown 能力时退回纯文本，不抛错', () => {
  const { window, makeElement } = load();
  const { renderer } = window.StudioRenderers.for('claude');
  const bubble = makeElement('div');
  const bare = { ...host(), renderMarkdown: null };
  renderer.renderMessage(
    { id: 'm', role: 'assistant', blocks: [{ kind: 'text', text: '正文' }] },
    bubble,
    bare,
  );
  assert.equal(textOf(bubble), '正文');
});

test('Codex 的命令行照搬它终端的样子：显示真正跑的命令，不是那层 JS 包装', () => {
  const { window, makeElement } = load();
  const { renderer } = window.StudioRenderers.for('codex');
  const bubble = makeElement('div');
  renderer.renderMessage(
    {
      id: 'm',
      role: 'assistant',
      blocks: [
        {
          kind: 'tools',
          items: [
            {
              name: 'exec',
              detail: 'text(await tools.exec_command({cmd:"server194 exec --script /tmp/x.sh"',
              action: { verb: 'Ran', command: "server194 exec --script '/tmp/x.sh'" },
            },
          ],
        },
      ],
    },
    bubble,
    host(),
  );
  const text = textOf(bubble);
  // ⚠️ 照着显示 detail 没人看得懂：Codex 走代码模式，入参是一层 JS 包装。
  assert.equal(text.includes('tools.exec_command'), false, '不该把 JS 包装显示出来');
  assert.match(text, /Ran/);
  assert.match(text, /server194 exec --script '\/tmp\/x\.sh'/);

  // 命令做语法高亮：命令名、`--` 标志、引号串各自一个类，配色在 style.css 里。
  const classes = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.className) classes.push(node.className);
    for (const child of node.children || []) walk(child);
  };
  walk(bubble);
  for (const name of ['codex-verb', 'codex-cmd', 'codex-ddash', 'codex-str']) {
    assert(classes.includes(name), `缺少 ${name}：${classes.join(' | ')}`);
  }
});

test('没有 action 的工具行原样交给公共件，不硬塞一个动词', () => {
  const { window, makeElement } = load();
  const { renderer } = window.StudioRenderers.for('codex');
  const bubble = makeElement('div');
  renderer.renderMessage(
    {
      id: 'm',
      role: 'assistant',
      blocks: [{ kind: 'tools', items: [{ name: 'sleep', detail: '30s' }] }],
    },
    bubble,
    host(),
  );
  assert.match(textOf(bubble), /30s/);
});

test('Codex 的点按退出码上色，收起只有一行，输出在展开里', () => {
  const { window, makeElement } = load();
  const { renderer } = window.StudioRenderers.for('codex');
  const render = (item) => {
    const bubble = makeElement('div');
    renderer.renderMessage(
      { id: 'm', role: 'assistant', blocks: [{ kind: 'tools', items: [item] }] },
      bubble,
      host(),
    );
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      found.push(node);
      for (const child of node.children || []) walk(child);
    };
    walk(bubble);
    return found;
  };

  const ok = render({
    name: 'exec',
    action: { verb: 'Ran', command: 'git status' },
    outcome: { exitCode: 0, output: '第一行\n第二行\n第三行' },
  });
  const bullet = ok.find((node) => String(node.className).includes('codex-bullet'));
  assert(bullet, '成功要有一颗点');
  assert.equal(bullet.textContent, '•');
  assert(String(bullet.className).includes('ok'));
  // 🔑 收起的那一行里只有动词和命令 —— 输出一个字都不许露出来,否则一条命令
  // 就占四五行,列表没法扫。
  const summary = ok.find((node) => String(node.className).includes('chat-tool-detail'));
  const summaryText = textOf(summary);
  assert.match(summaryText, /Ran git status/);
  assert.equal(summaryText.includes('第一行'), false, '输出不该出现在收起的那一行里');
  assert.equal(summaryText.includes('lines'), false, '计数也不该出现在收起的那一行里');
  // 展开里放的是能看懂的东西：真正的命令、真正的输出、退出码。
  const opened = textOf(ok.find((node) => String(node.className).includes('codex-real')));
  assert.match(opened, /命令/);
  assert.match(opened, /git status/);
  assert.match(opened, /第一行[\s\S]*第二行[\s\S]*第三行/);
  assert.match(opened, /退出码/);

  const bad = render({
    name: 'exec',
    action: { verb: 'Ran', command: 'false' },
    outcome: { exitCode: 1, output: '' },
  });
  assert(
    String(bad.find((node) => String(node.className).includes('codex-bullet')).className).includes(
      'bad',
    ),
  );

  // 多行命令压成一行再进收起行：nowrap 下断行看不见，但复制出去会带着它。
  const multi = render({
    name: 'exec',
    action: { verb: 'Ran', command: "python3 - <<'PY'\nprint(1)\nPY" },
    outcome: { exitCode: 0, output: '1' },
  });
  const oneLine = textOf(multi.find((node) => String(node.className).includes('chat-tool-detail')));
  assert.equal(oneLine.includes('\n'), false, '收起的那一行里不该有换行');
  assert.match(oneLine, /python3 - <<'PY' print\(1\) PY/);
  // 展开里仍然是原样的多行命令,不能把换行也一起吃掉。
  assert.match(
    textOf(multi.find((node) => String(node.className).includes('codex-real'))),
    /<<'PY'\nprint\(1\)\nPY/,
  );

  // ⚠️ 拿不到退出码就不上色 —— 猜一个绿点出来，等于谎称这条命令成功了。
  const unknown = render({ name: 'exec', action: { verb: 'Ran', command: 'git status' } });
  assert.equal(
    unknown.some((node) => String(node.className).includes('codex-bullet')),
    false,
  );
});
