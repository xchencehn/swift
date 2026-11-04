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
