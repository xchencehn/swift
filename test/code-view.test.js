'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { languageFor, splitLines } = require('../public/files/code-view');

test('按扩展名与文件名认语言，认不出的按纯文本', () => {
  const cases = {
    'a/b.cpp': 'cpp',
    'x.h': 'c',
    'k.cu': 'cpp',
    'Main.java': 'java',
    'p.json': 'json',
    's.py': 'python',
    'a.js': 'javascript',
    'a.tsx': 'typescript',
    'run.sh': 'bash',
    'build.bat': 'dos',
    'x.CMD': 'dos',
    'i.ps1': 'powershell',
    'c.yaml': 'yaml',
    Makefile: 'makefile',
    Dockerfile: 'dockerfile',
    'CMakeLists.txt': 'cmake',
    'x.go': 'go',
    'x.rs': 'rust',
    'a.toml': 'ini',
    'notes.txt': null,
    README: null,
  };
  for (const [file, language] of Object.entries(cases))
    assert.equal(languageFor(file), language, file);
});

test('着色后的 HTML 按行切开，跨行的 span 在每行重新打开并补上关闭', () => {
  const lines = splitLines(
    'a <span class="hljs-comment">/* x\ny */</span> b\n<span class="hljs-string">"s"</span>',
  );
  assert.deepEqual(lines, [
    'a <span class="hljs-comment">/* x</span>',
    '<span class="hljs-comment">y */</span> b',
    '<span class="hljs-string">"s"</span>',
  ]);
});

test('打包的着色库带齐常用语言，每一种映射到的语言都注册了', () => {
  const context = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../public/vendor/highlight/highlight.min.js'), 'utf8'),
    context,
  );
  const source = fs.readFileSync(path.join(__dirname, '../public/files/code-view.js'), 'utf8');
  const used = new Set([...source.matchAll(/:\s*'([a-z]+)'/g)].map((match) => match[1]));
  for (const language of used) assert.ok(context.hljs.getLanguage(language), language);
});

function highlighter() {
  const jobs = [];
  const context = {
    Worker() {},
    document: { querySelector: () => null },
    StudioOffThread: {
      createOffThreadQueue: () => (request) => {
        let finish;
        const promise = new Promise((resolve) => (finish = resolve));
        jobs.push({ request, finish });
        return { promise };
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../public/files/code-view.js'), 'utf8'),
    context,
  );
  return {
    jobs,
    code(source, language = 'javascript') {
      const code = {
        textContent: source,
        innerHTML: '',
        isConnected: true,
        classList: { add() {} },
      };
      context.StudioCodeView.highlightElement(code, language);
      return code;
    },
  };
}
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('identical code shares in-flight highlighting and bounded cached markup by language', async () => {
  const h = highlighter();
  const first = h.code('const value = 42;'),
    second = h.code('const value = 42;', 'js');
  assert.equal(h.jobs.length, 1);
  const html = '<span class="hljs-keyword">const</span> value = 42;';
  h.jobs[0].finish(html);
  await settled();
  assert.equal(first.innerHTML, html);
  assert.equal(second.innerHTML, html);
  const cached = h.code('const value = 42;');
  await settled();
  assert.equal(cached.innerHTML, html);
  assert.equal(h.jobs.length, 1);
  h.code('const value = 42;', 'python');
  assert.equal(h.jobs.length, 2);
  h.jobs[1].finish(null);
});

test('failed highlighting retries and stale elements never receive cached or late markup', async () => {
  const h = highlighter();
  h.code('value');
  h.jobs[0].finish(null);
  await settled();
  const stale = h.code('value'),
    removed = h.code('value');
  assert.equal(h.jobs.length, 2);
  stale.textContent = 'changed';
  removed.isConnected = false;
  h.jobs[1].finish('<span>value</span>');
  await settled();
  assert.equal(stale.innerHTML, '');
  assert.equal(removed.innerHTML, '');
});

test('highlight cache evicts by entry count and retained UTF-16 byte budget', async () => {
  const h = highlighter();
  for (let n = 0; n < 65; n++) {
    h.code(`value-${n}`);
    h.jobs.at(-1).finish(`value-${n}`);
    await settled();
  }
  h.code('value-64');
  assert.equal(h.jobs.length, 65);
  h.code('value-0');
  assert.equal(h.jobs.length, 66);
  h.jobs.at(-1).finish(null);
  await settled();
  const large = '<span>' + 'x'.repeat(3 * 1024 * 1024) + '</span>';
  for (const source of ['large-a', 'large-b']) {
    h.code(source);
    h.jobs.at(-1).finish(large);
    await settled();
  }
  const count = h.jobs.length;
  h.code('large-b');
  assert.equal(h.jobs.length, count);
  h.code('large-a');
  assert.equal(h.jobs.length, count + 1);
  h.jobs.at(-1).finish(null);
});
