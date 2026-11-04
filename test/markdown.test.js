'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// 渲染器全程用 DOM API,单测里给一个够用的最小 document 替身:
// 它只实现 createElement / createDocumentFragment / append 和 textContent,
// 并能把结果序列化成便于断言的形状。
function installDom() {
  const makeNode = (tag) => ({
    tag,
    children: [],
    dataset: {},
    attrs: {},
    set textContent(value) {
      this.children = [String(value)];
    },
    get textContent() {
      return this.children
        .map((child) => (typeof child === 'string' ? child : child.textContent))
        .join('');
    },
    set href(value) {
      this.attrs.href = value;
    },
    get href() {
      return this.attrs.href;
    },
    set target(value) {
      this.attrs.target = value;
    },
    set rel(value) {
      this.attrs.rel = value;
    },
    append(...items) {
      this.children.push(...items);
    },
  });
  global.document = {
    createElement: makeNode,
    createDocumentFragment: () => makeNode('#fragment'),
  };
}
installDom();
const { renderMarkdown, safeHref } = require('../public/markdown');

test('公式先于 Markdown 行内格式解析，代码和普通金额保持原样', (t) => {
  const calls = [];
  global.katex = {
    render(tex, node, options) {
      calls.push({ tex, options });
      node.textContent = tex;
    },
  };
  t.after(() => {
    delete global.katex;
  });
  const formula = String.raw`\operatorname{PReLU}(x,\alpha)=
\begin{cases}
x,&x\geq 0\\
\alpha x,&x<0
\end{cases}`;
  const source =
    '\\[\n' +
    formula +
    '\n\\]\n\n行内 \\(x_1 + x_2\\) 和 $y^2$。\n\n```tex\n\\[x\\]\n```\n\n金额 $5 到 $10';
  const result = renderMarkdown(source);
  assert.deepEqual(
    calls.map((c) => c.tex),
    [formula, 'x_1 + x_2', 'y^2'],
  );
  assert.equal(calls[0].options.displayMode, true);
  assert.equal(calls[1].options.displayMode, false);
  assert(calls.every((c) => c.options.trust === false && c.options.maxExpand === 1000));
  assert(result.textContent.includes('金额 $5 到 $10'));
  assert(shape(result).includes('pre(code(\\[x\\]))'));
  assert.equal(shape(renderMarkdown('$$x^2$$')), 'div(x^2)');
});

test('公式解析失败或渲染器不可用时保留源码', (t) => {
  global.katex = {
    render() {
      throw new Error('incomplete formula');
    },
  };
  t.after(() => {
    delete global.katex;
  });
  assert.equal(renderMarkdown('\\[\\notACommand{x}\\]').textContent, '\\[\\notACommand{x}\\]');
  delete global.katex;
  assert.equal(renderMarkdown('公式 \\(x_1\\)').textContent, '公式 \\(x_1\\)');
  assert.equal(shape(renderMarkdown('\\[\nx_1 + x_2')), 'div(\\[\nx_1 + x_2)');
});

/** 把渲染结果压成 "tag(子)" 形式,断言时一眼能看懂 */
function shape(node) {
  if (typeof node === 'string') return node;
  const inner = node.children.map(shape).join('');
  return node.tag === '#fragment' ? inner : `${node.tag}(${inner})`;
}

test('标题、段落与水平线', () => {
  assert.equal(shape(renderMarkdown('## 标题')), 'h2(标题)');
  assert.equal(shape(renderMarkdown('普通一段')), 'p(普通一段)');
  assert.equal(shape(renderMarkdown('---')), 'hr()');
  assert.equal(shape(renderMarkdown('####### 七个井号不是标题')), 'p(####### 七个井号不是标题)');
});

test('行内:代码、粗体、斜体', () => {
  assert.equal(shape(renderMarkdown('用 `ls -l` 看看')), 'p(用 code(ls -l) 看看)');
  assert.equal(shape(renderMarkdown('**很重要**')), 'p(strong(很重要))');
  assert.equal(shape(renderMarkdown('*轻一点*')), 'p(em(轻一点))');
  // 代码先切出来,里面的星号不该被当成格式
  assert.equal(shape(renderMarkdown('`a * b`')), 'p(code(a * b))');
});

test('列表分有序无序,类型变了就另起一个', () => {
  assert.equal(shape(renderMarkdown('- 甲\n- 乙')), 'ul(li(甲)li(乙))');
  assert.equal(shape(renderMarkdown('1. 甲\n2. 乙')), 'ol(li(甲)li(乙))');
  assert.equal(shape(renderMarkdown('- 甲\n1. 乙')), 'ul(li(甲))ol(li(乙))');
});

test('列表项之间有空行也还是同一个列表', () => {
  // agent 的输出里项间空行很普遍。断开的话每项各成一个 <ol>,
  // 1. 2. 3. 会全部渲染成 1. —— 截图里就是这么露馅的。
  assert.equal(shape(renderMarkdown('1. 甲\n\n2. 乙\n\n3. 丙')), 'ol(li(甲)li(乙)li(丙))');
  assert.equal(shape(renderMarkdown('- 甲\n\n- 乙')), 'ul(li(甲)li(乙))');
  // 空行之后不再是列表项,就该收尾并把那段当正文
  assert.equal(shape(renderMarkdown('- 甲\n\n后面一段')), 'ul(li(甲))p(后面一段)');
});

test('项与项之间隔着正文时，每个有序列表从自己的编号开始', () => {
  const nodes = renderMarkdown(
    '1. **甲？**\n\n说明一\n\n2. **乙？**\n\n说明二\n\n3. **丙？**',
  ).children;
  const lists = nodes.filter((node) => node.tag === 'ol');
  assert.deepEqual(
    lists.map((list) => list.start),
    [undefined, 2, 3],
  );
  assert.equal(renderMarkdown('1. 甲\n2. 乙').children[0].start, undefined, '从 1 开始不写 start');
});

test('围栏代码块原样保留,内部不做行内解析', () => {
  const out = shape(renderMarkdown('```js\nconst a = `x`; // **不是粗体**\n```'));
  assert.equal(out, 'pre(code(const a = `x`; // **不是粗体**))');
});

test('没有收尾围栏也不能崩,把剩下的都当代码', () => {
  assert.equal(shape(renderMarkdown('```\n没关上')), 'pre(code(没关上))');
});

test('只将完整 Mermaid 围栏交给图表渲染，流式未完成时保留源码', () => {
  const source = 'flowchart TD\nA[开始] --> B[结束]';
  const complete = renderMarkdown('```mermaid\n' + source + '\n```').children[0];
  assert.equal(complete.dataset.diagram, 'mermaid');
  assert.equal(complete.textContent, source);
  assert.equal(
    renderMarkdown('```MERMAID\n' + source + '\n```').children[0].dataset.diagram,
    'mermaid',
  );
  assert.equal(renderMarkdown('```mermaid\n' + source).children[0].dataset.diagram, undefined);
  assert.equal(renderMarkdown('```js\n' + source + '\n```').children[0].dataset.diagram, undefined);
});

test('表格要有分隔行才算表格', () => {
  const table = shape(renderMarkdown('| 甲 | 乙 |\n|---|---|\n| 1 | 2 |'));
  assert.equal(table, 'table(thead(tr(th(甲)th(乙)))tbody(tr(td(1)td(2))))');
  // 只有竖线没有分隔行的普通文本不该被吞成表格
  assert.equal(shape(renderMarkdown('a | b')), 'p(a | b)');
});

test('引用', () => {
  assert.equal(shape(renderMarkdown('> 一句话\n> 接着说')), 'blockquote(一句话\n接着说)');
});

test('链接只放行 http/https', () => {
  const ok = renderMarkdown('[文档](https://example.com/a)');
  assert.equal(shape(ok), 'p(a(文档))');
  assert.equal(ok.children[0].children[0].attrs.href, 'https://example.com/a');
  assert.equal(ok.children[0].children[0].attrs.rel, 'noopener noreferrer');
});

test('截图中的加粗列表项继续解析内部链接，完整保留评论参数', () => {
  const url =
    'https://gitcode.com/cann/asc-devkit/discussions/26?comment_id=ed621d789588451db240d1460b07fdaa';
  const result = renderMarkdown(
    `- **剩余三类精度问题已发到[讨论帖 26](${url})**：溢出 Inf、Cast 异常转换、Div 的 0 ULP／FTZ 偏差。`,
  );
  assert.equal(
    shape(result),
    'ul(li(strong(剩余三类精度问题已发到a(讨论帖 26))：溢出 Inf、Cast 异常转换、Div 的 0 ULP／FTZ 偏差。))',
  );
  const link = result.children[0].children[0].children[0].children[1];
  assert.deepEqual(link.attrs, { href: url, target: '_blank', rel: 'noopener noreferrer' });
});

test('链接标签里的加粗、斜体和代码以及斜体中的链接都能渲染', () => {
  assert.equal(
    shape(renderMarkdown('[**文档** 与 *说明* `api`](https://example.com)')),
    'p(a(strong(文档) 与 em(说明) code(api)))',
  );
  assert.equal(shape(renderMarkdown('*参阅[说明](https://example.com)*')), 'p(em(参阅a(说明)))');
  assert.equal(shape(renderMarkdown('**执行 `x < y`**')), 'p(strong(执行 code(x < y)))');
});

test('加粗中的危险链接仍为纯文本，代码中的 Markdown 不产生链接', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
  ]) {
    assert.equal(shape(renderMarkdown(`**[点我](${url})**`)), `p(strong([点我](${url})))`);
  }
  assert.equal(
    shape(renderMarkdown('`**[示例](https://example.com)**`')),
    'p(code(**[示例](https://example.com)**))',
  );
  assert.equal(
    shape(renderMarkdown('**`[示例](https://example.com)`**')),
    'p(strong(code([示例](https://example.com))))',
  );
  assert.equal(
    shape(renderMarkdown('[**<img src=x onerror=alert(1)>**](https://example.com)')),
    'p(a(strong(<img src=x onerror=alert(1)>)))',
  );
});

test('URL 里的成对括号不会把多余的 ) 留在正文', () => {
  const out = renderMarkdown('[条目](https://zh.wikipedia.org/wiki/Foo_(bar)) 后面');
  assert.equal(shape(out), 'p(a(条目) 后面)');
  assert.equal(out.children[0].children[0].attrs.href, 'https://zh.wikipedia.org/wiki/Foo_(bar)');
});

test('危险协议退回纯文本,不给可点的入口', () => {
  // 这些如果被当成链接渲染出来,点一下就执行脚本了
  for (const evil of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
  ]) {
    assert.equal(safeHref(evil), null, evil);
    const out = shape(renderMarkdown(`[点我](${evil})`));
    assert.ok(out.startsWith('p('), out);
    assert.ok(!out.includes('a('), `不该渲染成链接: ${out}`);
  }
});

test('标签与事件属性只会变成字面文本', () => {
  // 全程 createElement + textContent,所以尖括号进不了 DOM 结构
  const out = renderMarkdown('<img src=x onerror=alert(1)> 和 <script>alert(2)</script>');
  assert.equal(shape(out), 'p(<img src=x onerror=alert(1)> 和 <script>alert(2)</script>)');
  assert.equal(out.children[0].tag, 'p');
  assert.equal(out.children[0].children.length, 1);
  assert.equal(typeof out.children[0].children[0], 'string');
});

test('空输入与空白输入返回空片段', () => {
  assert.equal(shape(renderMarkdown('')), '');
  assert.equal(shape(renderMarkdown('   \n\n  ')), '');
  assert.equal(shape(renderMarkdown(null)), '');
});
