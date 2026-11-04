'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionMetadata, displayTitle } = require('../lib/session-metadata');
const {
  recentPanes,
  sessionLabel,
  sessionTooltip,
  messageSegments,
} = require('../public/ui-model');
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-metadata-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'session.jsonl');
  fs.writeFileSync(file, '');
  const reader = new SessionMetadata({ home, locate: () => file });
  const append = (value) => fs.appendFileSync(file, JSON.stringify(value) + '\n');
  return { reader, home, file, append };
}
test('最近只取用户消息时间，标题与工具追加不抬高排序，分段追加不中断解析', async (t) => {
  const { reader, append, file } = setup(t);
  append({
    type: 'user',
    timestamp: '2026-09-19T01:00:00Z',
    message: { role: 'user', content: 'hello' },
  });
  append({ type: 'ai-title', aiTitle: '原生会话标题' });
  let metadata = await reader.scan(file, 'claude');
  const initial = metadata.lastMessageAt;
  append({
    type: 'user',
    timestamp: '2026-09-19T03:00:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
  });
  append({ type: 'custom-title', customTitle: '用户更名' });
  metadata = await reader.scan(file, 'claude');
  assert.equal(metadata.lastMessageAt, initial);
  assert.equal(metadata.customTitle, '用户更名');
  const bytes = JSON.stringify({
    type: 'user',
    timestamp: '2026-09-19T04:00:00Z',
    message: { role: 'user', content: 'next' },
  });
  fs.appendFileSync(file, bytes.slice(0, 40));
  await reader.scan(file, 'claude');
  fs.appendFileSync(file, bytes.slice(40) + '\n');
  assert.equal(
    (await reader.scan(file, 'claude')).lastMessageAt,
    Date.parse('2026-09-19T04:00:00Z'),
  );
});
test('Codex 用户事件更新最近时间，环境提示不算用户消息，生成的内部名字不显示', async (t) => {
  const { reader, append, file } = setup(t);
  append({
    type: 'event_msg',
    timestamp: '2026-09-19T01:00:00Z',
    payload: { type: 'user_message', message: 'hello' },
  });
  append({
    type: 'response_item',
    timestamp: '2026-09-19T05:00:00Z',
    payload: {
      role: 'user',
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['environment'] },
      content: [{ type: 'input_text', text: 'environment' }],
    },
  });
  assert.equal(
    (await reader.scan(file, 'codex')).lastMessageAt,
    Date.parse('2026-09-19T01:00:00Z'),
  );
  assert.equal(displayTitle('codex-mu7sxlt6'), '');
  assert.equal(displayTitle('中文会话名称'), '中文会话名称');
});
test('Claude 更换 cwd 后仍按会话 id 找到原存档，自定义名称优先于自动标题', async (t) => {
  const { home } = setup(t);
  const dir = path.join(home, '.claude', 'projects', '-old-cwd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.jsonl'),
    [
      { type: 'custom-title', customTitle: '自定义标题' },
      { type: 'ai-title', aiTitle: '自动标题' },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  const reader = new SessionMetadata({ home, locate: () => null });
  const pane = {
    paneId: 'p',
    tab: '标签页',
    cwd: '/new-cwd',
    agent: { label: 'claude', session: { value: 'session' } },
  };
  await reader.enrich({ panes: [pane] });
  assert.equal(pane.sessionTitle, '自定义标题');
  assert.equal(sessionLabel(pane), '自定义标题');
});
test('Codex 没有状态数据库时从原生会话索引读取最新名称', (t) => {
  const { reader, home } = setup(t);
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(
    path.join(home, '.codex', 'session_index.jsonl'),
    [
      { id: 'session', thread_name: '旧标题' },
      { id: 'session', thread_name: '新标题' },
    ]
      .map(JSON.stringify)
      .join('\n'),
  );
  assert.equal(reader.codexTitles(['session']).get('session'), '新标题');
});
test('最近平铺会话，排队消息及时更新，失败与取消不影响排序，缺失时间稳定靠后', () => {
  const a = { paneId: 'a', agent: {}, lastMessageAt: 100 },
    b = { paneId: 'b', agent: {}, lastMessageAt: 200 };
  const blank = { paneId: 'empty', agent: {} },
    shell = { paneId: 'shell' };
  assert.deepEqual(
    recentPanes([a, blank, shell, b]).map((p) => p.paneId),
    ['b', 'a', 'empty', 'shell'],
  );
  assert.equal(recentPanes([a, b], { a: [{ status: 'queued', createdAt: 300 }] })[0].paneId, 'a');
  assert.equal(
    recentPanes([a, b], {
      a: [
        { status: 'cancelled', createdAt: 400 },
        { status: 'failed', createdAt: 500 },
      ],
    })[0].paneId,
    'b',
  );
  assert.equal(
    recentPanes([a, b], { a: [{ sessionId: 'old-session', status: 'queued', createdAt: 600 }] })[0]
      .paneId,
    'b',
  );
  assert.equal(sessionLabel({ tabTitle: '我的标签', agent: {}, sessionTitle: '' }), '未命名会话');
});
test('正文与工具交错时分别排列，复制区域不会跨过命令', () => {
  const message = {
    id: 'm',
    role: 'assistant',
    ts: 'time',
    blocks: [
      { kind: 'text', text: 'before' },
      { kind: 'tools', items: [{ id: 't' }] },
      { kind: 'text', text: 'after' },
    ],
  };
  const result = messageSegments(message);
  assert.deepEqual(
    result.map((m) => m.blocks.map((b) => b.kind)),
    [['text'], ['tools'], ['text']],
  );
  assert.equal(result[0].ts, message.ts);
  assert.equal(message.blocks.length, 3);
});
test('新会话收到正文后采用内容标题，原生标题随后替代，不覆盖明确命名', async (t) => {
  const { reader, append } = setup(t);
  reader.codexTitles = () => new Map();
  const pane = {
    paneId: 'p',
    tabTitle: '新会话',
    agentTitle: '新会话 | workdir',
    agent: { label: 'claude', session: { value: 'session' } },
  };
  await reader.enrich({ panes: [pane] });
  assert.equal(sessionLabel(pane), '新会话');
  append({
    type: 'user',
    timestamp: '2026-09-19T01:00:00Z',
    message: { role: 'user', content: '修复附件上传\n具体细节' },
  });
  await reader.enrich({ panes: [pane] });
  assert.equal(sessionLabel(pane), '修复附件上传');
  append({ type: 'ai-title', aiTitle: '附件上传问题修复' });
  await reader.enrich({ panes: [pane] });
  assert.equal(sessionLabel(pane), '附件上传问题修复');
  append({ type: 'custom-title', customTitle: '我的上传任务' });
  await reader.enrich({ panes: [pane] });
  assert.equal(pane.sessionTitle, '我的上传任务');
});
test('会话只有一级名字，长名裁成短语，悬浮才显示原来的长名', async (t) => {
  const { reader, append } = setup(t);
  reader.codexTitles = () => new Map();
  const pane = {
    paneId: 'p',
    tabTitle: '7',
    agentTitle: '新会话 | workdir',
    agent: { label: 'claude', session: { value: 'session' } },
  };
  append({
    type: 'user',
    timestamp: '2026-09-22T01:00:00Z',
    message: { role: 'user', content: '把消息队列迁移到 SQLite，并且保证重复导入是幂等的' },
  });
  await reader.enrich({ panes: [pane] });
  // 标签页编号不再拼进名字，长句在子句边界断开。
  assert.equal(sessionLabel(pane), '把消息队列迁移到 SQLite');
  assert.equal(pane.sessionFullTitle, '把消息队列迁移到 SQLite，并且保证重复导入是幂等的');
  assert.equal(sessionTooltip(pane), pane.sessionFullTitle + ' · 7 · p');
  // 会话自己写下自动命名之后，短语就用它；这时长名与短名一致，不重复悬浮。
  append({ type: 'ai-title', aiTitle: '消息队列迁移' });
  await reader.enrich({ panes: [pane] });
  assert.equal(sessionLabel(pane), '消息队列迁移');
  assert.match(sessionTooltip(pane), /(?:7|3) · p$/);
});
test('没有实质内容时不编短语，沿用回退名称', async (t) => {
  const { reader } = setup(t);
  reader.codexTitles = () => new Map();
  const pane = {
    paneId: 'p',
    tabTitle: '3',
    agentTitle: '新会话 | workdir',
    agent: { label: 'claude', session: { value: 'session' } },
  };
  await reader.enrich({ panes: [pane] });
  assert.equal(sessionLabel(pane), '新会话');
  assert.match(sessionTooltip(pane), /(?:7|3) · p$/);
});
test('原生回滚后最近发言时间按有效历史重建，不保留删除轮次', async (t) => {
  const { reader, append, file } = setup(t);
  append({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'a' } });
  append({
    type: 'response_item',
    timestamp: '2026-09-19T01:00:00Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
  });
  append({ type: 'event_msg', payload: { type: 'task_complete' } });
  append({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'b' } });
  append({
    type: 'response_item',
    timestamp: '2026-09-19T03:00:00Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'removed' }] },
  });
  await reader.scan(file, 'codex');
  append({ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } });
  assert.equal(
    (await reader.scan(file, 'codex')).lastMessageAt,
    Date.parse('2026-09-19T01:00:00Z'),
  );
});

test('慢存档定位不阻塞拓扑，后台并发受限并按终端身份返回缓存标签', async (t) => {
  const { reader } = setup(t);
  reader.codexTitles = () => new Map();
  let release,
    active = 0,
    peak = 0,
    calls = 0,
    changes = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  reader.locate = async (_provider, id) => {
    calls++;
    peak = Math.max(peak, ++active);
    await held;
    active--;
    return id;
  };
  reader.readBackground = async (file) => ({ customTitle: '标题 ' + file, lastMessageAt: 123 });
  reader.onChange = () => changes++;
  const make = () => ({
    runtimeId: 'native-1',
    panes: Array.from({ length: 59 }, (_, i) => ({
      paneId: 'p' + i,
      terminalId: 't' + i,
      cwd: '/fixture',
      agentTitle: '原生名称',
      agent: { label: 'codex', session: { value: 'session-' + i } },
    })),
  });
  const first = make();
  await reader.enrich(first);
  assert.equal(calls, 0, 'Cold discovery and SQLite title lookup start after the snapshot returns');
  assert.equal(first.panes[0].sessionTitle, '原生名称');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 4);
  for (let i = 0; i < 4; i++) await reader.enrich(make());
  assert.equal(calls, 4, 'Concurrent snapshots share the bounded background work');
  release();
  await reader.refreshing;
  assert.equal(calls, 59);
  assert.equal(peak, 4);
  assert.equal(changes, 1);
  assert.equal(
    first.panes[0].sessionTitle,
    '原生名称',
    'A completed response is never mutated later',
  );
  const cached = make();
  await reader.enrich(cached);
  assert.equal(cached.panes[0].sessionTitle, '标题 session-0');
  const replacement = make();
  replacement.panes[0].terminalId = 'replacement';
  await reader.enrich(replacement);
  assert.equal(replacement.panes[0].sessionTitle, '原生名称');
  const restarted = make();
  restarted.runtimeId = 'native-2';
  await reader.enrich(restarted);
  assert.equal(restarted.panes[0].sessionTitle, '原生名称');
  await reader.refreshing;
});
