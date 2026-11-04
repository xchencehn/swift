'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const model = require('../public/chat/tool-presentation');
const { diffLines } = require('../public/vendor/diff/diff.min.js');
const tool = (name, input, result = '', extra = {}) => ({
  name,
  input: { text: typeof input === 'string' ? input : JSON.stringify(input) },
  result: { text: result },
  ...extra,
});
test('search projection preserves Windows paths, source order, context, gaps and unknown lines', () => {
  const result = model.searchBlocks(
    'C:\\src\\a.ts:12:const value = "a:b";\nC:\\src\\a.ts-13-context\n--\nC:\\src\\a.ts:30:next();\nnotice: unavailable\n"src/a b.ts":5:found',
  );
  assert.equal(result[0].path, 'C:\\src\\a.ts');
  assert.equal(result[0].lines[1].kind, 'context');
  assert.equal(result[0].lines[2].gap, true);
  assert.equal(result[1].text, 'notice: unavailable');
  assert.equal(result[2].path, 'src/a b.ts');
  assert.deepEqual(model.searchBlocks('x.ts:1:hit', { output_mode: 'count' }), []);
  assert.deepEqual(model.searchBlocks('x.ts:1:hit', { multiline: true }), []);
});
test('semantic summaries retain failures, unknown formats and truncated input without guessing', () => {
  assert.equal(model.describe(tool('Read', { file_path: 'src/a.ts' })).target, 'src/a.ts');
  const failed = model.describe(
    tool('Grep', { pattern: 'foo' }, 'Permission denied', { failed: true }),
  );
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.blocks, []);
  assert.equal(
    model.describe(tool('exec_command', { cmd: 'rg foo src; rm cache' }, 'src/a.ts:1:foo')).kind,
    'locations',
  );
  assert.equal(
    model.describe(tool('exec_command', { cmd: 'rg foo src; rm cache' }, 'src/a.ts:1:foo')).label,
    '运行',
  );
  assert.equal(model.describe(tool('arbitrary', { file_path: 'src/a.ts' })).kind, '');
  assert.deepEqual(model.inputOf({ input: { text: '{"path":"a"}', truncated: true } }), {});
  assert.equal(
    model.describe(tool('Bash', { command: 'false' }, '', { outcome: { exitCode: 1 } })).failed,
    true,
  );
});
test('native patches keep multiple files, operation, context and line numbers', () => {
  const patch =
    '*** Begin Patch\n*** Update File: a.ts\n@@\n old\n-removed\n+added\n*** Add File: b.ts\n+new\n*** Delete File: c.ts\n*** End Patch';
  const value = model.describe(tool('apply_patch', patch));
  assert.equal(value.kind, 'patch');
  assert.equal(value.files.length, 3);
  assert.equal(value.files[0].rows[2].kind, 'removed');
  assert.equal(value.files[2].operation, 'Delete');
  assert.equal(value.files[2].rows.length, 0);
  const wrapped = model.describe(
    tool('exec', 'text(await tools.apply_patch(' + JSON.stringify(patch) + '));'),
  );
  assert.equal(wrapped.files.length, 3);
  assert.equal(
    model.describe(
      tool(
        'exec',
        'text(await tools.apply_patch(' +
          JSON.stringify(patch) +
          ')); await tools.exec_command({cmd:"test"});',
      ),
    ).kind,
    '',
  );
  const unified = model.patchFiles('--- a/file\n+++ b/file\n@@ -12,2 +12,2 @@\n same\n-old\n+new');
  assert.equal(unified[0].rows[2].oldLine, 13);
  assert.equal(unified[0].rows[3].newLine, 13);
  const multiple = model.patchFiles(
    '--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+++ literal\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-before\n+after',
  );
  assert.equal(multiple.length, 2);
  assert.equal(multiple[0].rows[2].text, '++ literal');
  assert.equal(multiple[1].path, 'b');
});
test('edit diff uses actual line changes and retains literal content', () => {
  const rows = model.editDiff(
    { old_string: 'a\nb\nc\n', new_string: 'a\n<script>\nx\nc\n' },
    diffLines,
  );
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['context', 'removed', 'added', 'added', 'context'],
  );
  assert.equal(rows[2].text, '<script>');
  assert.equal(
    model.editDiff({ old_string: 'x'.repeat(300000), new_string: 'y' }, diffLines),
    null,
  );
  assert.equal(model.editDiff({ new_string: 'x' }, diffLines), null);
});
test('file references resolve on the owning host without accepting external URLs', () => {
  assert.equal(model.resolvePath('src/a.ts', '/work/project'), '/work/project/src/a.ts');
  assert.equal(model.resolvePath('C:\\src\\a.ts', '/work'), 'C:\\src\\a.ts');
  assert.equal(model.resolvePath('https://example.com/file', '/work'), null);
  assert.equal(model.resolvePath('a\nother', '/work'), null);
  assert.equal(model.resolvePath('a', null), null);
});

test('execution previews decode envelopes, preserve each exit state and never interpret stdout as control', () => {
  const wrap = (rows) =>
    JSON.stringify([
      { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
      ...rows.map((row) => ({ type: 'input_text', text: JSON.stringify(row) })),
    ]);
  const raw = wrap([
    { session_id: 71, output: '' },
    { exit_code: 2, output: 'Permission denied' },
    { exit_code: 0, output: 'Checked 12 files' },
  ]);
  const preview = model.outputPreview(raw);
  assert.match(preview, /仍在运行/);
  assert.match(preview, /退出码：2/);
  assert.match(preview, /Permission denied/);
  assert.match(preview, /Checked 12 files/);
  assert.doesNotMatch(preview, /input_text|session_id|Wall time/);
  const data = model.outputPreview(
    wrap([{ exit_code: 0, output: '{"exit_code":9,"output":"ordinary data"}' }]),
  );
  assert.match(data, /退出码：0/);
  assert.match(data, /"exit_code": 9/);
  assert.doesNotMatch(data, /退出码：9/);
  assert.match(
    model.outputPreview(
      'Chunk ID: x\nWall time: 1 seconds\nProcess exited with code 7\nFinal output:\nfailed to read',
    ),
    /退出码：7\nfailed to read/,
  );
  const image = model.outputPreview([
    { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE_IMAGE' },
    { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'Done' }) },
  ]);
  assert.match(image, /Done/);
  assert.doesNotMatch(image, /PRIVATE_IMAGE|input_text|base64/);
});
test('default details show bounded results and command excerpts; full details retain exact source', () => {
  const lines = Array.from({ length: 200 }, (_, i) => 'normal line ' + i);
  lines[150] = 'ERROR: database unavailable';
  lines[199] = 'Totals: 3 failed';
  const raw = JSON.stringify([
    { type: 'input_text', text: JSON.stringify({ exit_code: 1, output: lines.join('\n') }) },
  ]);
  const item = tool('exec', 'text(await tools.exec_command({cmd:"python3 script.py"}));', raw, {
    action: {
      verb: 'Ran',
      command: "python3 - <<'PY'\n" + 'hidden implementation\n'.repeat(50) + 'PY',
    },
  });
  const sections = model.detailSections(item);
  assert.equal(sections[0][0], '执行结果');
  assert.match(sections[0][1], /ERROR: database unavailable/);
  assert.match(sections[0][1], /Totals: 3 failed/);
  assert(sections[0][1].length < 3000);
  assert(sections[1][1].length < 400);
  assert.doesNotMatch(sections.map((row) => row[1]).join('\n'), /input_text|tools.exec_command/);
  assert.deepEqual(model.detailSections(item, true), [
    ['调用原文', item.input.text],
    ['返回原文', raw],
  ]);
  const plain = tool('custom_tool', {}, '<img src=x onerror=alert(1)>');
  assert.match(model.detailSections(plain)[0][1], /<img/);
  assert.match(
    model.detailSections({
      ...item,
      result: { text: '[{"type":"input_text","text":"incomplete', truncated: true },
    })[0][1],
    /预览不完整/,
  );
});
