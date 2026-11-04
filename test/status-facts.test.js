'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { splitFacts, toRows, groupOf } = require('../public/status-facts');

const texts = (line) => toRows(line).map((row) => row.facts.map((fact) => fact.text));

test('按分隔符切成事实，分隔符跟在前一条后面，拼回去和原文一字不差', () => {
  const line =
    'gpt-6-astra high · ~/workdir/mxops · mxops · proveforkernel · Working · Context 51% used · weekly 59% left';
  const facts = splitFacts(line);
  assert.deepEqual(
    facts.map((fact) => fact.text),
    [
      'gpt-6-astra high · ',
      '~/workdir/mxops · ',
      'mxops · ',
      'proveforkernel · ',
      'Working · ',
      'Context 51% used · ',
      'weekly 59% left',
    ],
  );
  // 换行不能改内容：拼回去必须还是原来那一行。
  assert.equal(facts.map((fact) => fact.text).join(''), line);
});

test('括号里的分隔符不算：一句话不能被劈成两半', () => {
  for (const line of [
    '✻ Sizzling… (26m 15s · ↓ 36 tokens · esc to interrupt)',
    '• Working (53m 11s • esc to interrupt)',
    '[Opus 5 (1M context)] eff:high',
  ])
    assert.deepEqual(
      splitFacts(line).map((fact) => fact.text),
      [line],
      line,
    );
  // 两侧没有空格的 `·` 也不算 —— `weekly 60%·2d5h` 是一条事实。
  assert.deepEqual(
    splitFacts('weekly 60%·2d5h').map((fact) => fact.text),
    ['weekly 60%·2d5h'],
  );
});

test('Claude 用连续空格顶开两段，主机与目录按冒号分开', () => {
  const line =
    '[Opus 5 (1M context)] eff:xhigh 20%  chenchen2@DESKTOP-LIIC751:/home/developer/workdir/ir';
  assert.deepEqual(
    splitFacts(line).map((fact) => fact.text),
    [
      '[Opus 5 (1M context)] eff:xhigh 20%  ',
      'chenchen2@DESKTOP-LIIC751:',
      '/home/developer/workdir/ir',
    ],
  );
  // `eff:xhigh` 里那个冒号不是主机与目录的分界，后面不是路径。
  assert.equal(splitFacts('eff:xhigh 20%').length, 1);
});

test('认组：权限模式、后台进程，其余都是 main', () => {
  for (const line of ['⏵⏵ bypass permissions on', '▶ accept edits on', 'plan mode on'])
    assert.equal(groupOf(line), 'mode', line);
  for (const line of [
    '11 shells, 2 monitors still running',
    '1 background terminal running',
    '2 background agents',
  ])
    assert.equal(groupOf(line), 'background', line);
  // `← 7 agents` 是工作区里有几个 agent，不是后台进程。
  for (const line of ['← 7 agents', 'Context 51% used', '~/workdir/mxops'])
    assert.equal(groupOf(line), 'main', line);
});

test('一行最多切一刀，切在第一条后台事实前面，断口不留分隔符', () => {
  assert.deepEqual(texts('⏵⏵ bypass permissions on · 11 shells, 2 monitors · ← 7 agents'), [
    ['⏵⏵ bypass permissions on'],
    ['11 shells, 2 monitors · ', '← 7 agents'],
  ]);
  assert.deepEqual(
    texts('✻ Cogitated for 2m 27s · done 1:13 PM · 11 shells, 2 monitors still running'),
    [['✻ Cogitated for 2m 27s · ', 'done 1:13 PM'], ['11 shells, 2 monitors still running']],
  );
  // 后台那一段后面还有别的，一起归第二行 —— 不切第二刀。
  assert.equal(texts('a · 1 background terminal running · b · c').length, 2);
});

test('没有后台那一段就不换行，长行留给前端按宽度排', () => {
  for (const line of [
    '⏵⏵ bypass permissions on · ← 7 agents',
    '• Working (53m 11s • esc to interrupt)',
    'gpt-6-astra high · ~/workdir/mxops · Working · Context 51% used',
  ])
    assert.equal(toRows(line).length, 1, line);
});

test('空行与纯空白不产出事实', () => {
  for (const line of ['', '   ', null, undefined]) assert.deepEqual(toRows(line), []);
});
