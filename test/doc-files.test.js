'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  markdownHead,
  plainInline,
  fuzzyScore,
  safeFile,
  Summaries,
  listable,
  uniqueReal,
} = require('../lib/doc-files');
const { collectFiles } = require('../lib/session-files');
const { SessionFiles } = require('../lib/session-files');

function tree(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('标题读第一行 # 而不是文件名，摘要是正文头一句且剥掉 Markdown', () => {
  const head = markdownHead(
    [
      '---',
      'title: 忽略 front matter',
      '---',
      '',
      '<!-- 注释不算 -->',
      '# 性能空间初评',
      '',
      '## 背景',
      '',
      '```',
      'code 不算',
      '```',
      '| 表 | 格 |',
      '|---|---|',
      '> 依据见[开发计划](../plan.md)与 **实测数据**。后面这句不要。',
    ].join('\n'),
  );
  assert.equal(head.title, '性能空间初评');
  assert.equal(head.summary, '依据见开发计划与 实测数据。');
  assert.equal(plainInline('`msopprof` 与 ![图](a.png)*强调*'), 'msopprof 与 强调');
  assert.deepEqual(markdownHead('没有标题的一段话。第二句。'), {
    title: null,
    summary: '没有标题的一段话。',
  });
});

test('模糊匹配：分段按序出现即命中，命中在文件名里的排前面', () => {
  const report = 'tasks/40-SpGEMMBackward/reports/20260923-performance-assessment.md';
  assert(fuzzyScore('perf report', report) > 0);
  assert.equal(fuzzyScore('zzz', report), 0);
  assert(
    fuzzyScore('assess', report) > fuzzyScore('assess', 'docs/assessment-notes/readme.md'),
    '文件名里的命中更靠前',
  );
});

test('只读工作根目录之内的可阅读文件，符号链接与越界都拒绝', (t) => {
  const root = tree(t, { 'a/doc.md': '# 文档', 'a/code.js': 'x' });
  const outside = tree(t, { 'secret.md': '# 不该读到' });
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'a/link.md'));
  assert.equal(safeFile(root, path.join(root, 'a/doc.md')).kind, 'markdown');
  assert.equal(safeFile(root, path.join(root, 'a/code.js')), null, '列表里不收代码');
  assert.equal(
    safeFile(root, path.join(root, 'a/code.js'), { anyText: true }).kind,
    'code',
    '文档里点进来的代码可以读',
  );
  assert.equal(
    safeFile(root, path.join(outside, 'secret.md'), { anyText: true }),
    null,
    '放开类型也不能越界',
  );
  assert.equal(safeFile(root, path.join(root, 'a/link.md')), null, '符号链接不跟');
  assert.equal(safeFile(root, path.join(outside, 'secret.md')), null, '根目录之外');
  assert.equal(safeFile(root, 'a/doc.md'), null, '必须是绝对路径');
});

test('列表收录文档、图片和音视频，代码仍从文档链接打开；摘要保留标题与正文', (t) => {
  const root = tree(t, { 'r.md': '# 报告\n\n正文。', 'p.png': 'x', 's.py': 'x' });
  assert.deepEqual(
    ['r.md', 'p.png', 's.py', 'a.mp4', 'b.MP3', 'c.pptx', 'd.doc', 'e.xlsx'].filter(listable),
    ['r.md', 'p.png', 'a.mp4', 'b.MP3', 'c.pptx', 'd.doc', 'e.xlsx'],
  );
  const summaries = new Summaries();
  assert.deepEqual(
    (({ title, summary, kind }) => ({ title, summary, kind }))(
      summaries.describe(path.join(root, 'r.md')),
    ),
    { title: '报告', summary: '正文。', kind: 'markdown' },
  );
  assert.equal(summaries.describe(path.join(root, 'p.png'), root).summary, '图片 · .');
});

test('会话里读过的、回复里引用的文件都算出现过', async (t) => {
  const root = tree(t, { 'reports/perf.md': '# 性能', 'notes/read.md': '# 读过' });
  const lines = [
    {
      type: 'assistant',
      cwd: root,
      timestamp: '2026-09-23T08:00:00Z',
      message: {
        content: [
          {
            type: 'text',
            text: '已写入[性能空间初评](reports/perf.md)，外链 [x](https://a.b/c.md) 不算。',
          },
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: { file_path: path.join(root, 'notes/read.md') },
          },
        ],
      },
    },
  ].map((line) => JSON.stringify(line));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const { mentioned } = await new SessionFiles().appearances(file, 'claude', root);
  assert.deepEqual(mentioned.map((item) => path.relative(root, item.path)).sort(), [
    'notes/read.md',
    'reports/perf.md',
  ]);
  assert.deepEqual(
    collectFiles(lines, 'claude', root),
    [],
    '读与引用不算写入，不开放写入记录那条预览',
  );
});

test('软链与它指向的文件只列一次（CLAUDE.md → AGENTS.md 曾经各列一次）', (t) => {
  const root = tree(t, { 'AGENTS.md': '# 工程约定', 'other.md': '# 另一份' });
  fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
  const real = (file) => fs.realpathSync(path.join(root, file));
  assert.deepEqual(
    uniqueReal(['AGENTS.md', 'CLAUDE.md', 'other.md'].map((file) => path.join(root, file))),
    [real('AGENTS.md'), real('other.md')],
  );
  assert.deepEqual(uniqueReal(['/不存在/x.md']), ['/不存在/x.md'], '读不到的原样保留');
});

test('HTML 和 HTM 报告可搜索并完整读取，拒绝超限与符号链接', async (t) => {
  const source =
    '<!doctype html><meta charset="utf-8"><h1>报告</h1>' +
    '报告'.repeat(180000) +
    '<script>window.complete=true</script>';
  const root = tree(t, {
    'report.HTML': source,
    'next.htm': '<h1>下一页</h1>',
    'large.html': ' '.repeat(8 * 1024 * 1024 + 1),
  });
  fs.symlinkSync(path.join(root, 'next.htm'), path.join(root, 'link.html'));
  assert.equal(listable('report.HTML'), true);
  assert.equal(listable('next.htm'), true);
  const { FileLists } = require('../lib/doc-files');
  assert((await new FileLists().list(root)).includes(path.join(root, 'report.HTML')));
  const routes = {};
  require('../lib/http/routes/doc-files').register(
    {
      get: (name, handler) => {
        routes[name] = handler;
      },
    },
    {
      currentRoot: () => ({ data: { directory: root } }),
      exactPane: async () => ({ workspaceId: 'w', cwd: root }),
      herdr: { dashboard: async () => ({ workspaces: [{ workspaceId: 'w', cwd: root }] }) },
      json: (res, status, body) => Object.assign(res, { status, body }),
      securityHeaders: (headers) => headers,
      apiError: (status, code, message) => Object.assign(new Error(message), { status, code }),
    },
  );
  const read = async (name, route = '/api/doc-files/content') => {
    const res = {};
    await routes[route](
      null,
      res,
      new URL(
        'http://test' +
          route +
          '?' +
          new URLSearchParams({ pane: 'pane', path: path.join(root, name) }),
      ),
    );
    return res;
  };
  const result = await read('report.HTML');
  assert.equal(result.body.kind, 'html');
  assert.equal(result.body.text, source);
  assert.equal(result.body.truncated, false);
  await assert.rejects(read('large.html'), { code: 'TOO_LARGE' });
  await assert.rejects(read('link.html'), { code: 'NOT_FOUND' });
  await assert.rejects(read('next.htm', '/api/doc-files/raw'), { code: 'NOT_FOUND' });
});

test('归档会话按 archived=<provider>:<会话 ID> 列出它涉及的文件，没有 pane 也能看', async (t) => {
  const root = tree(t, { 'mxops/reports/perf.md': '# 性能', 'mxops/notes/a.md': '# 笔记' });
  const cwd = path.join(root, 'mxops');
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      cwd,
      timestamp: '2026-09-23T08:00:00Z',
      message: { content: [{ type: 'text', text: '见[性能](reports/perf.md)。' }] },
    }) + '\n',
  );
  const routes = {};
  const router = {
    get: (route, handler) => {
      routes[route] = handler;
    },
  };
  let found;
  require('../lib/http/routes/doc-files').register(router, {
    currentRoot: () => ({
      data: { directory: root },
      sessionFiles: new SessionFiles(),
      history: {
        find: async (provider, sessionId) => {
          found = [provider, sessionId];
          return { provider, sessionId, cwd, file };
        },
      },
    }),
    exactPane: async () => {
      throw new Error('归档会话不该去找 pane');
    },
    paneTranscriptFile: () => {
      throw new Error('不该读 pane 的存档');
    },
    herdr: { dashboard: async () => ({ workspaces: [{ workspaceId: 'w1', cwd }] }) },
    json: (res, status, body) => Object.assign(res, { status, body }),
    apiError: (status, code, message) => Object.assign(new Error(message), { status, code }),
    securityHeaders: (headers) => headers,
  });
  const res = {};
  await routes['/api/doc-files'](
    null,
    res,
    new URL('http://x/api/doc-files?archived=claude:abc-1&tab=session'),
  );
  assert.deepEqual(found, ['claude', 'abc-1']);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.files.map((item) => path.relative(root, item.path)),
    ['mxops/reports/perf.md'],
  );
});
