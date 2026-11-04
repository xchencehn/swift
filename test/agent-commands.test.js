'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readAgentCommands, versionCatalog } = require('../lib/agent-commands');
const { query, filter, needsInput } = require('../public/slash-commands');

test('目录严格对应安装版本，不把旧版或其他 agent 命令冒充当前候选', () => {
  const codex = versionCatalog('codex', '0.155.1'),
    claude = versionCatalog('claude', '2.1.258');
  assert(codex.length > 40);
  assert(claude.length > 60);
  assert(codex.some((c) => c.name === 'permissions'));
  assert(claude.some((c) => c.name === 'effort'));
  assert(!codex.some((c) => c.name === 'effort'));
  assert(!claude.some((c) => c.name === 'experimental'));
  assert.deepEqual(versionCatalog('codex', 'unknown'), []);
  assert.deepEqual(versionCatalog('../codex', '../../package'), []);
});

test('Claude 项目命令与内置目录合并、去重，不串用目录', async () => {
  const reads = [];
  const dependencies = {
    version: async () => '2.1.258',
    claude: async (cwd) => {
      reads.push(cwd);
      return [
        { name: 'model', description: 'native model' },
        { name: cwd.slice(1), description: 'project skill' },
      ];
    },
  };
  const a = await readAgentCommands('claude', '/one', dependencies);
  const b = await readAgentCommands('claude', '/two', dependencies);
  assert.equal(a.commands.filter((c) => c.name === 'model').length, 1);
  assert(a.commands.some((c) => c.name === 'one'));
  assert(!b.commands.some((c) => c.name === 'one'));
  assert.deepEqual(reads, ['/one', '/two']);
});

test('补全仅在首行斜杠词尾生效，前缀 model 优先于模糊匹配，空格和正文不误触发', () => {
  const commands = [{ name: 'permissions' }, { name: 'model' }, { name: 'compact' }];
  assert.equal(query('/'), '');
  assert.equal(query('/mo'), 'mo');
  for (const text of ['mo', '正文 /mo', '/model ', '/mo\n', '/model arg'])
    assert.equal(query(text), null);
  assert.equal(query('/model', 2), null);
  assert.equal(filter(commands, query('/mo'))[0].name, 'model');
  assert.deepEqual(filter(commands, query('/unknown')), []);
});

test('CLI 升级后没有固定目录仍提供已接通的网页操作', async () => {
  for (const provider of ['claude', 'codex']) {
    const result = await readAgentCommands(provider, '/unused', {
      version: async () => '999.0.0',
      claude: async () => [],
    });
    assert(result.commands.some((command) => command.name === 'model'));
    assert(result.commands.some((command) => command.name === 'effort'));
    assert(!result.commands.some((command) => command.name === 'permissions'));
  }
});

test('需要正文、路径或子命令的候选只补全，可直接打开的选择器保持执行', () => {
  for (const name of ['goal', 'rename', 'cd']) assert.equal(needsInput({ name }), true, name);
  for (const name of [
    'model',
    'effort',
    'fast',
    'status',
    'compact',
    'review',
    'resume',
    'mcp',
    'daemon',
    'mention',
  ])
    assert.equal(needsInput({ name }), false, name);
  assert.equal(needsInput({ name: 'project-command', argumentHint: '<instructions>' }), true);
  assert.equal(needsInput({ name: 'future-command', requiresInput: true }), true);
});

test('current supported Codex versions expose every collected native command including Goal', async () => {
  for (const version of ['0.164.0', '0.165.0', '0.166.0']) {
    const native = versionCatalog('codex', version);
    assert.equal(native.length, 54);
    const result = await readAgentCommands('codex', '/fixture', { version: async () => version });
    for (const command of native)
      assert(
        result.commands.some((item) => item.name === command.name),
        command.name,
      );
    for (const name of [
      'goal',
      'presets',
      'hfork',
      'permissions',
      'status',
      'warnings',
      'daemon',
      'effort',
    ])
      assert(
        result.commands.some((command) => command.name === name),
        name,
      );
    assert.equal(result.reason, undefined);
  }
});
test('Goal command intents preserve objective text and distinguish native controls', () => {
  const { goalCommand } = require('../public/slash-commands');
  assert.deepEqual(goalCommand('/goal'), { action: 'show' });
  assert.deepEqual(goalCommand('/goal 持续完成全部开发'), {
    action: 'set',
    objective: '持续完成全部开发',
  });
  assert.deepEqual(goalCommand('/goal 第一行\n第二行'), {
    action: 'set',
    objective: '第一行\n第二行',
  });
  for (const action of ['pause', 'resume', 'clear', 'edit'])
    assert.deepEqual(goalCommand('/goal ' + action), { action });
  assert.equal(goalCommand('/goals'), null);
});

test('a current Claude SDK catalog remains available without a pinned builtin snapshot', async () => {
  const result = await readAgentCommands('claude', '/fixture', {
    version: async () => '2.1.280',
    claude: async () => [{ name: 'goal', description: 'native Goal' }, { name: 'project-skill' }],
  });
  assert(result.commands.some((command) => command.name === 'goal'));
  assert(result.commands.some((command) => command.name === 'project-skill'));
  assert.equal(result.reason, undefined);
});
