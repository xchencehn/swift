'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { collectFiles, SessionFiles, commandPaths } = require('../lib/session-files');
const { prepareWorkspace } = require('../lib/workspace-root');
const lines = (values) => values.map(JSON.stringify);
const call = (id, input, name = 'apply_patch') => ({
  type: 'response_item',
  timestamp: '2026-09-19T01:00:00Z',
  payload: { type: 'function_call', call_id: id, name, arguments: input },
});
const output = (id, value, timestamp = '2026-09-19T01:01:00Z') => ({
  type: 'response_item',
  timestamp,
  payload: { type: 'function_call_output', call_id: id, output: value },
});
async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('按成功写入记录归属，重复文件按最新写入排序，读取和其他会话不混入', () => {
  const rows = collectFiles(
    lines([
      call('a', '*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch'),
      output('a', 'Success'),
      call('read', JSON.stringify({ file_path: 'secret.txt' }), 'Read'),
      output('read', 'hello'),
      call('b', '*** Update File: b.txt'),
      output('b', 'Success', '2026-09-19T01:02:00Z'),
      call('again', '*** Update File: a.txt'),
      output('again', 'Success', '2026-09-19T01:03:00Z'),
      call('failed', '*** Add File: fail.txt'),
      output('failed', 'Error: failed'),
    ]),
    'codex',
    '/project',
  );
  assert.deepEqual(
    rows.map((r) => r.path),
    ['/project/a.txt', '/project/b.txt'],
  );
  assert.equal(rows[0].updatedAt, Date.parse('2026-09-19T01:03:00Z'));
});
test('Claude Edit 与 Write 仅成功结果入列', () => {
  const rows = collectFiles(
    lines([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'w',
              name: 'Write',
              input: { file_path: '/project/new.md', content: 'hi' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-09-19T01:00:00Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/project/fail.md' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'e', is_error: true, content: 'failed' }],
        },
      },
    ]),
    'claude',
    '/project',
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['new.md'],
  );
});
test('显式 Python 写入路径与 shell 重定向解析，不把 Read 和 git status 输出当修改', () => {
  assert.deepEqual(
    commandPaths(
      "p='a.py';s=open(p).read();open(p,'w').write(s)\np='b.py';open(p,'w').write('ok')",
    ).map((r) => r.path),
    ['a.py', 'b.py'],
  );
  assert.deepEqual(
    commandPaths("cat > 'doc.txt' <<'EOF'\nhi\nEOF").map((r) => r.path),
    ['doc.txt'],
  );
  assert.deepEqual(commandPaths("open('read.txt').read()\nM unrelated.txt"), []);
});
test('编排调用采用命令自身 workdir，等待进程退出后记录写入时间', () => {
  const source =
    'text(await tools.exec_command({cmd:"cat > result.txt <<EOF\\nhi\\nEOF",workdir:"/actual"}));';
  const archive = [
    call('exec', source, 'exec'),
    output('exec', JSON.stringify({ session_id: 8, output: '' })),
  ];
  assert.equal(collectFiles(lines(archive), 'codex', '/wrong').length, 0);
  archive.push(
    call('wait', '{"session_id":8}', 'write_stdin'),
    output('wait', '{"session_id":8,"exit_code":0,"output":""}', '2026-09-19T01:05:00Z'),
  );
  const rows = collectFiles(lines(archive), 'codex', '/wrong');
  assert.equal(rows[0].path, '/actual/result.txt');
  assert.equal(rows[0].updatedAt, Date.parse('2026-09-19T01:05:00Z'));
});
test('预览只读并限制到当前会话文件，UTF8 分页、图片、删除和符号链接有明确处理', async (t) => {
  const dir = await folder(t),
    file = path.join(dir, '中文.txt'),
    archive = path.join(dir, 'archive.jsonl');
  const content = '中'.repeat(100000);
  await fs.writeFile(file, content);
  await fs.writeFile(
    archive,
    lines([call('a', `*** Add File: ${file}`), output('a', 'Success')]).join('\n'),
  );
  const reader = new SessionFiles(),
    rows = await reader.list(archive, 'codex', dir);
  await assert.rejects(reader.preview(rows, 'unlisted'), { code: 'FILE_NOT_IN_SESSION' });
  const first = await reader.preview(rows, rows[0].id),
    rest = await reader.preview(rows, rows[0].id, first.nextOffset);
  assert.equal(first.content + rest.content, content);
  assert.equal(rest.nextOffset, null);
  assert.equal(await fs.readFile(file, 'utf8'), content);
  await fs.unlink(file);
  await assert.rejects(reader.preview(rows, rows[0].id), { code: 'FILE_MISSING' });
  await fs.symlink(archive, file);
  await assert.rejects(reader.preview(rows, rows[0].id), { code: 'UNSUPPORTED_FILE' });
});
test('工作区名称不创建目录，启动目录必须存在且仍受根目录限制', async (t) => {
  const root = await folder(t);
  const result = await prepareWorkspace(root, '产品 / 讨论');
  assert.deepEqual(result, { cwd: root, created: false });
  assert.deepEqual(await fs.readdir(root), []);
  const child = path.join(root, 'child');
  await fs.mkdir(child);
  assert.equal((await prepareWorkspace(root, '任意名称', child)).cwd, child);
  await fs.symlink(path.dirname(root), path.join(root, 'linked'));
  await assert.rejects(prepareWorkspace(root, '任意名称', path.join(root, 'linked')), {
    code: 'INVALID_WORKSPACE_DIRECTORY',
  });
  await assert.rejects(prepareWorkspace(root, '任意名称', 'relative'), {
    code: 'INVALID_WORKSPACE_DIRECTORY',
  });
});
test('真实 Codex 编排 apply_patch 的输出可以为空，仍从字符串参数提取已落盘路径', () => {
  const input =
    'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: /tmp/probe.md\\n+ok\\n*** End Patch"));';
  const rows = collectFiles(
    lines([
      call('exec', input, 'exec'),
      output('exec', [
        { type: 'input_text', text: 'Script completed\nOutput:\n' },
        { type: 'input_text', text: '{}' },
      ]),
    ]),
    'codex',
    '/cwd',
  );
  assert.deepEqual(
    rows.map((r) => r.path),
    ['/tmp/probe.md'],
  );
});
test('文件缓存按有效历史重建，支持覆盖、截断及未完成行', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-file-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'session.jsonl'),
    store = new SessionFiles();
  const records = (id, file) =>
    [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file } }] },
      },
      {
        type: 'user',
        timestamp: '2026-09-19T00:00:00Z',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n';
  await fs.writeFile(archive, records('a', 'a.txt'));
  const first = await store.list(archive, 'claude', directory);
  assert.equal(first.length, 1);
  assert.strictEqual(await store.list(archive, 'claude', directory), first);
  const collector = [...store.cache.values()][0].collector;
  await fs.appendFile(archive, records('b', 'b.txt'));
  const [second, concurrent] = await Promise.all([
    store.list(archive, 'claude', directory),
    store.list(archive, 'claude', directory),
  ]);
  assert.strictEqual(second, concurrent);
  assert.equal(second.length, 2);
  assert.notStrictEqual([...store.cache.values()][0].collector, collector);
  await fs.writeFile(archive, records('c', 'c.txt'));
  assert.deepEqual(
    (await store.list(archive, 'claude', directory)).map((x) => x.name),
    ['c.txt'],
  );
  await fs.appendFile(archive, '{"type":');
  await store.list(archive, 'claude', directory);
  await fs.appendFile(archive, '"system"}\n' + records('d', 'd.txt'));
  assert.equal((await store.list(archive, 'claude', directory)).length, 2);
});
