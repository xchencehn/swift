'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseTranscript,
  parseClaudeTranscript,
  parseCodexTranscript,
  locateTranscript,
  textOnly,
  stripSystemMarkup,
  stripMemoryCitations,
  summarizeTools,
  toolCategory,
} = require('../lib/agent-transcript');

// fixture 由真实存档脱敏而来:内容换成占位符,**字段名与块类型原样保留**。
// 手写假数据会让这些用例全绿而线上永远解析不出东西 —— Codex 的文本块叫
// input_text / output_text 而不是 text,正是这种差别。
function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', `${name}-transcript.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);
}

test('Codex 原生 item_completed 回执关联存档消息，不把事件 ID 当成消息 ID', () => {
  const lines = fs
    .readFileSync(path.join(__dirname, 'fixtures/codex-native-steer-receipt.jsonl'), 'utf8')
    .trim()
    .split('\n');
  const messages = parseCodexTranscript(lines);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'archive-message');
  assert.equal(messages[0].operationId, 'send-operation');
  const [user, receipt] = lines.map(JSON.parse);
  const parse = (entries) => parseCodexTranscript(entries.map(JSON.stringify));
  const other = structuredClone(receipt);
  other.payload.item.content[0].text = 'OTHER_PROMPT';
  assert.equal(parse([user, other])[0].operationId, undefined, '内容不同不能分配回执');
  const metadata = structuredClone(user);
  metadata.payload.internal_chat_message_metadata_passthrough = {
    content_item_kinds: ['environment_context'],
  };
  assert.equal(
    parse([user, metadata, receipt])[0].operationId,
    undefined,
    '跳过的上下文也必须隔断关联',
  );
  const start = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } };
  assert.equal(parse([user, start, receipt])[0].operationId, undefined, '不能跨轮次关联');
  const second = structuredClone(user);
  second.payload.id = 'second-message';
  const secondReceipt = structuredClone(receipt);
  secondReceipt.payload.item.client_id = 'second-operation';
  assert.deepEqual(
    parse([user, receipt, second, secondReceipt]).map((m) => m.operationId),
    ['send-operation', 'second-operation'],
  );
  assert.deepEqual(
    parse([
      user,
      receipt,
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    ]),
    [],
  );
});

test('Claude 运行中接收的 queued_command 按存档位置进入聊天流，队列事件不是消费凭据', () => {
  const lines = fixture('claude-midturn');
  const messages = textOnly(parseClaudeTranscript(lines));
  assert.deepEqual(
    messages.map((m) => m.id),
    ['request', 'tool-call', 'queued-attachment', 'final', 'recap'],
  );
  const received = messages[2];
  assert.equal(received.role, 'user');
  assert.equal(received.ts, '2026-09-19T20:33:45.270Z');
  assert.deepEqual(received.blocks, [{ kind: 'text', text: '请把审查表写入隔离目录。' }]);
  assert.equal(messages[1].blocks[0].items[0].result.text, '/fixture/project');
  const entries = lines.map((line) => JSON.parse(line));
  const attachment = entries.find((e) => e.type === 'attachment');
  const excluded = entries.filter((e) => e !== attachment);
  for (const patch of [
    null,
    { origin: { kind: 'agent' } },
    { type: 'goal_status' },
    { prompt: '' },
  ]) {
    const sample = patch
      ? [...excluded, { ...attachment, attachment: { ...attachment.attachment, ...patch } }]
      : excluded;
    assert.deepEqual(
      parseClaudeTranscript(sample.map((e) => JSON.stringify(e)))
        .filter((m) => m.role === 'user')
        .map((m) => m.id),
      ['request'],
    );
  }
});

test('Claude 存档解析出对话，且工具结果不冒充用户发言', () => {
  const messages = parseClaudeTranscript(fixture('claude'));
  assert.ok(messages.length > 0, '应当解析出消息');
  assert.ok(messages.every((m) => m.role === 'user' || m.role === 'assistant'));

  // tool_result 躺在后续的 user 行里,直接按 role 渲染就会多出一堆假的"用户消息"
  const fakeUser = messages.filter(
    (m) => m.role === 'user' && m.blocks.every((b) => b.kind === 'tool'),
  );
  assert.equal(fakeUser.length, 0, '只含工具结果的 user 行不应成为一条用户消息');

  const tools = messages.flatMap((m) => m.blocks).filter((b) => b.kind === 'tool');
  assert.ok(tools.length > 0, '应当解析出工具调用');
  assert.ok(
    tools.some((b) => b.result),
    '工具结果应当回填到对应的调用上',
  );
  assert.ok(
    tools.every((b) => b.name),
    '每个工具块都要有名字供折叠时显示',
  );
});

test('思考内容两边都不落盘，解析器不生成空块', () => {
  // 实测:Claude 的 thinking 块只有 signature、thinking 字段是空串;
  // Codex 的 reasoning 只有加密的 encrypted_content、summary 也是空
  // (1065 个块无一例外)。所以聊天视图看不到思考过程,解析器要做的是
  // **不要为此生成一堆空块**,而不是假装能解析出内容。
  for (const name of ['claude', 'codex']) {
    const blocks = parseTranscript(name, fixture(name)).flatMap((m) => m.blocks);
    assert.ok(
      blocks.every((b) => b.kind !== 'thinking' || (b.text && b.text.length > 0)),
      `${name}: 不应出现内容为空的 thinking 块`,
    );
  }
  const kinds = new Set(
    parseClaudeTranscript(fixture('claude'))
      .flatMap((m) => m.blocks)
      .map((b) => b.kind),
  );
  assert.ok(kinds.has('text'), '应当识别 text 块');
});

test('思考内容一旦落盘也能解析出来（为将来的格式变化留的路径）', () => {
  const claude = parseClaudeTranscript([
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '推理过程', signature: 'sig' }] },
    }),
  ]);
  assert.equal(claude[0].blocks[0].kind, 'thinking');
  assert.equal(claude[0].blocks[0].text, '推理过程');

  const codex = parseCodexTranscript([
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '推理摘要' }] },
    }),
  ]);
  assert.equal(codex[0].blocks[0].kind, 'thinking');
  assert.equal(codex[0].blocks[0].text, '推理摘要');
});

test('Codex 存档:识别 input_text / output_text，跳过 developer 注入', () => {
  const messages = parseCodexTranscript(fixture('codex'));
  assert.ok(messages.length > 0, '应当解析出消息');
  assert.ok(
    messages.every((m) => m.role === 'user' || m.role === 'assistant'),
    'developer 角色是注入的系统提示，不该出现在对话里',
  );
  const texts = messages.flatMap((m) => m.blocks).filter((b) => b.kind === 'text');
  assert.ok(texts.length > 0, 'input_text / output_text 都要能取出正文');
  assert.ok(texts.every((b) => typeof b.text === 'string' && b.text.length > 0));
});

test('Codex 注入的系统消息不冒充用户发言', () => {
  // Codex 把 AGENTS.md、环境上下文、记忆、技能说明都当 role:user 注入。
  // 第一版漏了这一层,聊天视图第一条就是一大段 <environment_context> XML,
  // 还顶着用户气泡的绿底色。
  const messages = parseCodexTranscript(fixture('codex'));
  const userTexts = messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.blocks)
    .map((b) => b.text || '');
  assert.ok(
    userTexts.every((t) => !t.includes('environment_context')),
    '环境上下文不该显示成用户消息',
  );
  assert.ok(
    userTexts.every((t) => !t.includes('AGENTS.md instructions')),
    'AGENTS.md 注入不该显示成用户消息',
  );

  // 白名单:标了 user.text 的留下，其余一律挡掉，将来新增的注入类型也一样
  const mk = (kinds) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '内容' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
      },
    });
  assert.equal(parseCodexTranscript([mk(['user.text'])]).length, 1, 'user.text 应当保留');
  assert.equal(parseCodexTranscript([mk(['environments.environment_context'])]).length, 0);
  assert.equal(
    parseCodexTranscript([mk(['将来才有的注入类型'])]).length,
    0,
    '未知注入类型也要挡住',
  );
  // 老版本没有这个字段时不能误杀
  assert.equal(
    parseCodexTranscript([
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '内容' }],
        },
      }),
    ]).length,
    1,
  );
});

test('Codex 的工具调用与输出按 call_id 配对', () => {
  const messages = parseCodexTranscript(fixture('codex'));
  const tools = messages.flatMap((m) => m.blocks).filter((b) => b.kind === 'tool');
  assert.ok(tools.length > 0, '应当解析出工具调用');
  assert.ok(
    tools.some((b) => b.result),
    'custom_tool_call_output 应当配到对应调用上',
  );
});

test('两种存档都不会因为未知块类型而整条崩掉', () => {
  const alien = [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: '未来才有的块' }, { type: 'text', text: '正文' }] },
    }),
    JSON.stringify({ type: 'response_item', payload: { type: '未来才有的块' } }),
    '这行根本不是 JSON',
    '',
  ];
  const claude = parseClaudeTranscript(alien);
  assert.equal(claude.length, 1, '未知块跳过，正文仍要留下');
  assert.equal(claude[0].blocks[0].text, '正文');
  assert.doesNotThrow(() => parseCodexTranscript(alien));
});

test('超长的工具内容会截断并标记，对话正文不截断', () => {
  const huge = 'x'.repeat(50000);
  const messages = parseClaudeTranscript([
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: huge },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: huge } },
        ],
      },
    }),
  ]);
  const [textBlock, toolBlock] = messages[0].blocks;
  assert.equal(textBlock.text.length, 50000, '对话正文不该被截断');
  assert.ok(toolBlock.input.truncated, '工具入参应当截断');
  assert.ok(toolBlock.input.fullLength > toolBlock.input.text.length);
});

test('parseTranscript 按 agent 类型分发，未知类型返回空', () => {
  assert.ok(parseTranscript('claude', fixture('claude')).length > 0);
  assert.ok(parseTranscript('codex', fixture('codex')).length > 0);
  assert.deepEqual(parseTranscript('某种未知 agent', fixture('claude')), []);
});

test('textOnly 留下正文与工具摘要，不留空气泡', () => {
  for (const name of ['claude', 'codex']) {
    const all = parseTranscript(name, fixture(name));
    const conversation = textOnly(all);
    const kinds = new Set(conversation.flatMap((m) => m.blocks).map((b) => b.kind));
    for (const kind of kinds)
      assert.ok(['text', 'tools'].includes(kind), `${name}: 意外的块 ${kind}`);
    assert.ok(
      conversation.every((m) => m.blocks.length > 0),
      '空消息要丢掉，不留空气泡',
    );
    assert.ok(conversation.length > 0, `${name}: 不该把对话也滤没了`);
    // 工具调用不能再带着入参和输出外发 —— 那是传输量的大头
    for (const block of conversation.flatMap((m) => m.blocks)) {
      if (block.kind !== 'tools') continue;
      assert.equal(block.input, undefined);
      assert.equal(block.result, undefined);
      assert.ok(block.summary.length > 0);
    }
  }
});

test('工具摘要按语义归类并计数，像终端那样压成一行', () => {
  assert.equal(summarizeTools([{ name: 'Bash' }, { name: 'Bash' }]), '运行 2 条命令');
  assert.equal(
    summarizeTools([{ name: 'Read' }, { name: 'Bash' }, { name: 'Bash' }]),
    '读取 1 个文件 · 运行 2 条命令',
  );
  // 两家 agent 的工具名不同，要归到同一组
  assert.equal(toolCategory('Bash'), toolCategory('shell'));
  assert.equal(toolCategory('Edit'), toolCategory('apply_patch'));
  assert.equal(toolCategory('Grep'), 'search');
  assert.equal(toolCategory('说不上来的工具'), 'other');
  assert.equal(summarizeTools([{ name: '说不上来的工具' }]), '调用 1 次工具');
});

test('连续的工具调用合并成一条摘要，正文把它们分段', () => {
  const messages = [
    {
      id: 'a',
      role: 'assistant',
      blocks: [
        { kind: 'text', text: '先看一下' },
        { kind: 'tool', name: 'Bash' },
        { kind: 'tool', name: 'Bash' },
        { kind: 'text', text: '结论是这样' },
        { kind: 'tool', name: 'Read' },
      ],
    },
  ];
  const blocks = textOnly(messages)[0].blocks;
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['text', 'tools', 'text', 'tools'],
  );
  assert.equal(blocks[1].summary, '运行 2 条命令');
  assert.equal(blocks[1].count, 2);
  assert.equal(blocks[3].summary, '读取 1 个文件');
});

test('剥掉工具块之后，工具结果依然没有冒充用户发言', () => {
  // 认出"哪些 user 行其实是工具回传"要靠解析工具块，所以解析层不能省，
  // 只是不往外发。这条用例守住这个顺序不被后人调换。
  const conversation = textOnly(parseClaudeTranscript(fixture('claude')));
  const users = conversation.filter((m) => m.role === 'user');
  assert.ok(users.every((m) => m.blocks.every((b) => b.kind === 'text' && b.text.length > 0)));
});

test('记忆引用标记被滤掉,正常的尖括号内容不受牵连', () => {
  const noisy =
    '结论在这里。\n\n<oai-mem-citation> <citation_entries> MEMORY.md:47-66|note=[x] </citation_entries> ' +
    '<rollout_ids> 01a0a9ea </rollout_ids> </oai-mem-citation>\n\n后面还有一段。';
  const clean = stripMemoryCitations(noisy);
  assert.ok(!clean.includes('oai-mem-citation'), clean);
  assert.ok(!clean.includes('citation_entries'), clean);
  assert.ok(!clean.includes('MEMORY.md:47-66'), '块里的内容也要一起删掉');
  assert.ok(clean.includes('结论在这里。') && clean.includes('后面还有一段。'), '正文不能被牵连');

  // 只认这三个标签名:对话里正常讨论 HTML/XML 时不能被误伤
  const code = '用 <div>x</div> 包一层,再看 <span>y</span>。';
  assert.equal(stripMemoryCitations(code), code);
  assert.equal(stripMemoryCitations('没有尖括号的一句话'), '没有尖括号的一句话');
  assert.equal(stripMemoryCitations(''), '');
});

test('只剩记忆引用的消息整条丢掉,不留空气泡', () => {
  const messages = [
    {
      id: 'a',
      role: 'assistant',
      blocks: [
        {
          kind: 'text',
          text: '<oai-mem-citation> <citation_entries> x </citation_entries> </oai-mem-citation>',
        },
      ],
    },
  ];
  assert.equal(textOnly(messages).length, 0);
});

test('相邻的纯工具消息合并成一条摘要', () => {
  // agent 每调一次工具就是一条 assistant 消息,中间夹着已被滤掉的工具回传。
  // 不跨消息合并的话,会连着出现三行「运行 1 条命令」。
  const messages = [
    { id: 'a', role: 'assistant', blocks: [{ kind: 'tool', name: 'Bash' }] },
    { id: 'b', role: 'assistant', blocks: [{ kind: 'tool', name: 'Bash' }] },
    { id: 'c', role: 'assistant', blocks: [{ kind: 'tool', name: 'Read' }] },
    { id: 'd', role: 'assistant', blocks: [{ kind: 'text', text: '说点什么' }] },
    { id: 'e', role: 'assistant', blocks: [{ kind: 'tool', name: 'Bash' }] },
  ];
  const out = textOnly(messages);
  assert.equal(out.length, 3, '三条工具消息并成一条,正文独立,之后的工具再起一条');
  assert.equal(out[0].blocks[0].summary, '运行 2 条命令 · 读取 1 个文件');
  assert.equal(out[0].blocks[0].count, 3);
  assert.equal(out[1].blocks[0].text, '说点什么');
  assert.equal(out[2].blocks[0].summary, '运行 1 条命令');
  // 正文把工具分段,不能把正文前后的工具也并到一起
  assert.notEqual(out[0].blocks[0].count, 4);
});

test('剥掉工具块之后，工具结果依然没有冒充用户发言(摘要不算发言)', () => {
  const conversation = textOnly(parseClaudeTranscript(fixture('claude')));
  const users = conversation.filter((m) => m.role === 'user');
  assert.ok(
    users.every((m) => m.blocks.some((b) => b.kind === 'text')),
    '用户消息必须有真正的正文',
  );
});

test('locateTranscript 能在真实的目录形状里找到存档', () => {
  // 之前只测了返回 null 的分支,结果把 Codex 的目录层数写少了一层
  // (sessions/年/月/日/文件 是四层),端点上线才发现一直找不到文件。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-transcript-'));
  const sid = '01a0ade5-9aad-7b62-8973-c7660bfc908a';
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '09', '17');
  fs.mkdirSync(codexDir, { recursive: true });
  const codexFile = path.join(codexDir, `rollout-2026-09-17T13-45-00-${sid}.jsonl`);
  fs.writeFileSync(codexFile, '');
  assert.equal(locateTranscript('codex', sid, '', home), codexFile);

  const cwd = '/home/someone/workdir/proj';
  const claudeDir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeFile = path.join(claudeDir, 'abc-123.jsonl');
  fs.writeFileSync(claudeFile, '');
  assert.equal(locateTranscript('claude', 'abc-123', cwd, home), claudeFile);

  assert.equal(locateTranscript('codex', '不存在的会话', '', home), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('locateTranscript 缺少会话 id 时返回 null 而不是猜一个路径', () => {
  assert.equal(locateTranscript('claude', '', '/tmp'), null);
  assert.equal(locateTranscript('claude', 'abc', ''), null);
  assert.equal(locateTranscript('某种未知 agent', 'abc', '/tmp'), null);
});

// 下面这组样本全部取自真实归档(已脱敏),标签名与嵌套结构保持原样。
test('系统注入块整块删掉,只留用户真正打的字', () => {
  const noisy = [
    '<task-notification>',
    '<task-id>bj8wd7428</task-id>',
    '<summary>Monitor event: "只看新建的 m.txt 等采集完成"</summary>',
    '<event>采集完成</event>',
    '</task-notification>  把这些没用标签都去掉 只显示我的内容',
  ].join('\n');
  assert.equal(stripSystemMarkup(noisy), '把这些没用标签都去掉 只显示我的内容');
});

test('后台命令完成通知也整块删掉', () => {
  const noisy =
    '<task-notification>\n<tool-use-id>toolu_019Zy</tool-use-id>\n' +
    '<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n</task-notification>继续';
  assert.equal(stripSystemMarkup(noisy), '继续');
});

test('本地命令回显与 caveat 删掉,skill 正文也删掉', () => {
  assert.equal(
    stripSystemMarkup('<local-command-stdout>Goal set: 性能调优</local-command-stdout>'),
    '',
  );
  assert.equal(
    stripSystemMarkup('<local-command-caveat>Caveat: ...</local-command-caveat>好'),
    '好',
  );
  assert.equal(stripSystemMarkup('<skill>\n<name>claude:transfer</name>\n正文若干\n</skill>'), '');
});

test('slash command 是用户自己打的,还原成一行而不是删掉', () => {
  const raw =
    '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n' +
    '<command-args>打开思路，全局思考 性能调优</command-args>';
  assert.equal(stripSystemMarkup(raw), '/goal 打开思路，全局思考 性能调优');
  assert.equal(stripSystemMarkup('<command-name>/clear</command-name>'), '/clear');
});

test('正文里的尖括号一个都不能动', () => {
  // 归档里出现频次最高的尖括号全是这些,泛化删除会毁掉代码块。
  const keep = [
    'std::vector<int64_t> v; llvm::SmallVector<uint32_t> w;',
    '%x0: !tt.ptr<f32>, %P: !tt.ptr<i64>',
    '我多留了两个 `</div>`，提前闭合了容器',
    '最近的 `c2c:<openid>` peer',
    'A["TTIR<br/>tt：函数、指针和访存"]',
    '<td>单元格</td><li>列表项</li>',
    '`~/.claude/projects/<cwd>/<id>.jsonl`',
  ];
  for (const text of keep) assert.equal(stripSystemMarkup(text), text);
});

test('旧的 stripMemoryCitations 仍是同一个函数', () => {
  assert.equal(stripMemoryCitations, stripSystemMarkup);
});

test('工具调用逐条列出,正在执行的那条能认出来', () => {
  // 存档里 tool_use 与 tool_result 成对出现,缺结果的那条就是此刻正在跑的。
  const lines = [
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status\n--short' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/tmp/a.txt' } },
          { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
        ],
      },
    }),
  ];
  const messages = textOnly(parseTranscript('claude', lines));
  const tools = messages.flatMap((m) => m.blocks).find((b) => b.kind === 'tools');
  assert.equal(tools.items.length, 3);
  // 明细取入参里最能说明「在做什么」的那段,且只取第一行
  assert.equal(tools.items[0].detail, 'git status');
  assert.equal(tools.items[1].detail, '/tmp/a.txt');
  assert.equal(tools.items[0].category, 'shell');
  assert.equal(tools.items[1].category, 'read');
  // 前两条有结果=已完成;第三条没有结果=正在执行
  assert.equal(tools.items[0].running, false);
  assert.equal(tools.items[1].running, false);
  assert.equal(tools.items[2].running, true);
  // 聚合那句话仍然在,逐条明细是额外的
  assert.ok(tools.summary.includes('运行'));
});

test('工具出错的那条要标出来', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
      },
    }),
  ];
  const tools = textOnly(parseTranscript('claude', lines))
    .flatMap((m) => m.blocks)
    .find((b) => b.kind === 'tools');
  assert.equal(tools.items[0].failed, true);
  assert.equal(tools.items[0].running, false);
});

test('一轮耗时不进聊天流：终端正文里本来就没有这么一条', () => {
  const at = new Date('2026-09-17T14:05:00Z');
  const lines = [
    JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      uuid: 't1',
      durationMs: 48043,
      timestamp: at.toISOString(),
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'away_summary',
      uuid: 'r1',
      timestamp: at.toISOString(),
      content: '这一轮做完了 A。',
    }),
  ];
  const messages = textOnly(parseTranscript('claude', lines));
  // 终端上「用了多久、什么时候完的」只是完成那一瞬的状态行，随下一轮消失；
  // 按它合成一条常驻消息，等于在对话里凭空多出终端没有的东西。
  assert.deepEqual(
    messages.map((message) => message.kind),
    ['recap'],
  );
  assert(!messages.some((message) => /done \d\d:\d\d/.test(message.blocks[0].text)));
});

test('收尾总结被认出来,且剥掉开关提示', () => {
  const lines = [
    JSON.stringify({
      type: 'system',
      subtype: 'away_summary',
      uuid: 'r1',
      timestamp: '2026-09-17T00:00:00Z',
      content: '这一轮把 A 做完了，下一步是 B。 (disable recaps in /config)',
    }),
  ];
  const messages = textOnly(parseTranscript('claude', lines));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'recap');
  assert.equal(messages[0].blocks[0].text, '这一轮把 A 做完了，下一步是 B。');
});

test('工具摘要包含 id、截断内容和标记，按需解析恢复完整详情', () => {
  const { describeTool } = require('../lib/agent-transcript');
  const huge = 'x'.repeat(5000);
  for (const agent of ['codex', 'claude']) {
    const lines =
      agent === 'codex'
        ? [
            JSON.stringify({
              type: 'response_item',
              payload: {
                type: 'function_call',
                call_id: 'tool-full',
                name: 'exec',
                arguments: huge,
              },
            }),
            JSON.stringify({
              type: 'response_item',
              payload: { type: 'function_call_output', call_id: 'tool-full', output: huge },
            }),
          ]
        : [
            JSON.stringify({
              type: 'assistant',
              message: {
                content: [{ type: 'tool_use', id: 'tool-full', name: 'Bash', input: huge }],
              },
            }),
            JSON.stringify({
              type: 'user',
              message: {
                content: [
                  { type: 'tool_result', tool_use_id: 'tool-full', content: huge, is_error: true },
                ],
              },
            }),
          ];
    const short = textOnly(parseTranscript(agent, lines))[0].blocks[0].items[0];
    assert.equal(short.id, 'tool-full');
    assert.equal(short.truncated, true);
    assert.equal(short.input.text.length, 2000);
    assert.equal(short.result.text.length, 2000);
    const full = describeTool(
      parseTranscript(agent, lines, { toolTextLimit: Infinity })[0].blocks[0],
    );
    assert.equal(full.input.text, huge);
    assert.equal(full.result.text, huge);
    assert.equal(full.truncated, false);
    assert.equal(full.failed, agent === 'claude');
  }
});

test('原生模型和 effort 控制记录不生成聊天气泡，普通斜杠正文保留', () => {
  const { parseTranscript } = require('../lib/agent-transcript');
  const entries = [
    '<command-name>/model</command-name><command-message>model</command-message><command-args></command-args>',
    '<local-command-stdout>Set model to `Sonnet 5` for this session only</local-command-stdout>',
    '请说明 /model 的用法',
  ];
  const messages = textOnly(
    parseTranscript(
      'claude',
      entries.map((content) => JSON.stringify({ type: 'user', message: { content } })),
    ),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].blocks[0].text, '请说明 /model 的用法');
});

test('恢复注入的合成记录不显示为用户消息，其回复按父子链一并隐藏', () => {
  // 形状取自 Claude Code 2.1.258 恢复一个被打断会话后的真实存档。
  // 真实存档里每条记录都带 parentUuid，首条为 null；缺了它分支筛选会另作判断。
  const lines = [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      message: { role: 'user', content: [{ type: 'text', text: '真实提问' }] },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: '真实回答' }] },
    },
    {
      type: 'user',
      uuid: 'm1',
      parentUuid: 'a1',
      isMeta: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Continue from where you left off.' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'm1',
      isApiErrorMessage: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a2',
      message: { role: 'user', content: [{ type: 'text', text: '恢复之后的提问' }] },
    },
  ].map((value) => JSON.stringify(value));

  const messages = parseTranscript('claude', lines);
  assert.deepEqual(
    messages.map((m) => m.blocks.map((b) => b.text).join('')),
    ['真实提问', '真实回答', '恢复之后的提问'],
    '用户没有说过那句 Continue，也就不该看到它和它的回复',
  );
});

test('Codex 的 JS 包装里抽出真正做的那件事，包装原文照旧保留', () => {
  const { codexAction } = require('../lib/agent-transcript');
  // 终端里显示的是 `• Ran server194 exec …`，不是这层 `text(await tools.…)` 包装。
  assert.deepEqual(
    codexAction(
      'text(await tools.exec_command({cmd:"server194 exec --script /tmp/x.sh",yield_time_ms:1000}));',
    ),
    { verb: 'Ran', command: 'server194 exec --script /tmp/x.sh' },
  );
  // ⚠️ 命令里带转义引号和换行是常态（sed 的范围、heredoc），不能用正则去抓引号内容。
  assert.equal(
    codexAction(`text(await tools.exec_command({cmd:"sed -n '25,83p' a.md"}));`).command,
    "sed -n '25,83p' a.md",
  );
  // heredoc 用拼接写，免得测试文件自己的引号先被吃掉。
  const heredoc =
    'text(await tools.exec_command({cmd:"python3 - <<' + "'PY'" + '\\nprint(1)\\nPY"}));';
  assert.equal(codexAction(heredoc).command, "python3 - <<'PY'\nprint(1)\nPY");
  assert.deepEqual(codexAction('text(await tools.write_stdin({session_id:56774,chars:""}));'), {
    verb: 'Waited for background terminal',
    command: 'session 56774',
  });
  assert.deepEqual(
    codexAction(
      'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: ops/a.py\\n*** Add File: b.py\\n*** End Patch"));',
    ),
    { verb: 'Edited', command: 'ops/a.py、b.py' },
  );
  // 不是代码模式的调用不该被硬塞一个动作。
  assert.equal(codexAction('{"duration_ms":30000}'), null);
  assert.equal(codexAction(''), null);
});

test('Codex 的输出外壳里取出退出码与真实正文，解不开就承认解不开', () => {
  const { codexOutcome } = require('../lib/agent-transcript');
  const wrap = (chunks) =>
    JSON.stringify(
      [
        { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
        { type: 'input_text', text: chunks.map((chunk) => JSON.stringify(chunk)).join('\n') },
      ],
      null,
      1,
    );
  // 终端显示的是里面那个 output，行首的点按 exit_code 画绿或红。
  assert.deepEqual(codexOutcome(wrap([{ exit_code: 0, output: 'hello\nworld\n' }])), {
    exitCode: 0,
    output: 'hello\nworld',
  });
  assert.deepEqual(codexOutcome(wrap([{ value: { exit_code: 1, output: '命令失败' } }])), {
    exitCode: 1,
    output: '命令失败',
  });
  // 一次调用分几段回来时，正文要接起来。
  assert.equal(
    codexOutcome(
      wrap([
        { exit_code: 0, output: 'a\n' },
        { exit_code: 0, output: 'b' },
      ]),
    ).output,
    'a\nb',
  );
  // ⚠️ 不是这套外壳就返回 null，不硬拆 —— 猜错了会把别的文字当成命令输出显示出来。
  assert.equal(codexOutcome('Wall time: 45s\nSleep completed.'), null);
  assert.equal(codexOutcome('[不是 JSON'), null);
  assert.equal(codexOutcome(''), null);
});

test('一轮被中断要在正文里标出来，否则看着像跑着跑着没了', () => {
  const lines = [
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-09-22T06:00:00Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '正在编译' }],
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-09-22T06:01:00Z',
      payload: { type: 'turn_aborted' },
    }),
  ];
  const messages = textOnly(parseTranscript('codex', lines));
  // 被中断的那一轮没有收尾的话，正文停在最后几条命令上；终端会写明一行，这里也要有。
  assert.equal(messages.at(-1).kind, 'aborted');
  assert.equal(messages.at(-1).blocks[0].text, '这一轮被中断了');
  // 正常结束不该凭空多一条。
  const done = textOnly(
    parseTranscript('codex', [
      lines[0],
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ]),
  );
  assert.equal(
    done.some((message) => message.kind === 'aborted'),
    false,
  );
});

test('Claude 把长粘贴包成 <pasted_content>：拆掉包装，附件原文另存给发送确认用', () => {
  // 2026-09-23 Claude Code 2.1.280 的实际写法：会话页经粘贴送进去的多行消息被整段包起来。
  const sent =
    '选中文字后 拖动怎么禁用 \n\n附件：image.png\n文件路径："/tmp/agent-studio/attachments/a/image.png"';
  const content = `\n\n<pasted_content id="45e5">\n${sent}\n</pasted_content id="45e5">\n`;
  const line = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-09-23T07:45:56.000Z',
    message: { role: 'user', content },
  });
  const [message] = textOnly(parseClaudeTranscript([line]));
  assert.deepEqual(
    message.blocks.map((block) => block.kind),
    ['text', 'image'],
  );
  assert.equal(message.blocks[0].text.includes('pasted_content'), false, '页面上不露出标签');
  assert.equal(message.sourceText, sent.trim(), '队列拿这份原文与送出的正文比对');
  // assistant 在正文里提到这个标签时原样保留。
  const reply = JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-23T07:46:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '<pasted_content id="1">\nx\n</pasted_content id="1">' }],
    },
  });
  assert.match(textOnly(parseClaudeTranscript([reply]))[0].blocks[0].text, /pasted_content/);
});

test('Codex 代码模式的 wait 轮询不进聊天流，结果并回它等的那条命令', () => {
  const item = (payload) =>
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-23T08:00:00.000Z', payload });
  const envelope = (text) => JSON.stringify([{ type: 'input_text', text }]);
  const lines = [
    item({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'c1',
      input: 'text(await tools.exec_command({cmd:"python3 watch.py"}))',
    }),
    item({
      type: 'custom_tool_call_output',
      call_id: 'c1',
      output: envelope('Script running with cell ID 44\nWall time 60.0 seconds\nOutput:\n'),
    }),
    // 终端对下面这几次轮询一条都不显示。
    item({
      type: 'function_call',
      name: 'wait',
      call_id: 'w1',
      arguments: '{"cell_id":"44","yield_time_ms":60000}',
    }),
    item({
      type: 'function_call_output',
      call_id: 'w1',
      output: envelope('Script running with cell ID 44\nWall time 60.0 seconds\nOutput:\n'),
    }),
    item({
      type: 'function_call',
      name: 'wait',
      call_id: 'w2',
      arguments: '{"cell_id":"44","yield_time_ms":60000}',
    }),
    item({
      type: 'function_call_output',
      call_id: 'w2',
      output: envelope(
        'Script completed\nWall time 3.0 seconds\nOutput:\npipeline 42585 success\n',
      ),
    }),
  ];
  const tools = parseCodexTranscript(lines)
    .flatMap((message) => message.blocks)
    .filter((block) => block.kind === 'tool');
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['exec'],
    '只剩那条命令，wait 不单独成行',
  );
  assert.match(tools[0].result.text, /pipeline 42585 success/, '最后一次轮询带回的输出并到命令上');
  assert.equal(tools[0].running, false, '等到完成就不再是运行中');
});
