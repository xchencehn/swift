'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { codexModels } = require('../lib/agent-catalog');

test('Codex 目录读本机 debug models：逐模型档位与速度档位，内部型号不列出', () => {
  const output = JSON.stringify({
    models: [
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6-Astra',
        visibility: 'list',
        is_default: true,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium', description: '默认' }],
        service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }],
      },
      // ⚠️ 隐藏的字段是 visibility，不是 hidden：按 hidden 过滤会让内部型号漏进选择器。
      {
        slug: 'codex-auto-review',
        display_name: 'codex-auto-review',
        visibility: 'hide',
        supported_reasoning_levels: [],
      },
      { slug: 'gpt-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
    ],
  });
  const models = codexModels(output);
  assert.deepEqual(
    models.map((m) => m.id),
    ['gpt-6-astra', 'gpt-5.5'],
  );
  assert.equal(models[0].label, 'GPT-6-Astra');
  assert.equal(models[1].label, 'gpt-5.5', '没有显示名时退到 slug');
  assert.deepEqual(
    models[0].efforts.map((e) => [e.id, e.isDefault]),
    [
      ['low', false],
      ['medium', true],
    ],
  );
  assert.deepEqual(models[0].serviceTiers, [
    { id: 'priority', name: 'Fast', description: '2x speed' },
  ]);
  assert.deepEqual(models[1].serviceTiers, []);
});
