'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentQuestions,
  pendingQuestion,
  claudeDialog,
  codexDialog,
} = require('../lib/agent-questions');
const questions = [
  {
    question: 'Choose a color?',
    header: 'Color',
    multiSelect: false,
    options: [
      { label: 'Red', description: 'Red color' },
      { label: 'Blue', description: 'Blue color' },
    ],
  },
  {
    question: 'Choose features?',
    header: 'Features',
    multiSelect: true,
    options: [
      { label: 'Search', description: '' },
      { label: 'Export', description: '' },
    ],
  },
];
const pending = { id: 'tool-question', questions };
const single =
  '\n←  ☐ Color  ☐ Features  ✔ Submit  →\n\nChoose a color?\n\n❯ 1. Red\n     Red color\n  2. Blue\n     Blue color\n  3. Type something.\n  4. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
const multi =
  '\n←  ☒ Color  ☐ Features  ✔ Submit  →\nChoose features?\n❯ 1. [ ] Search\n  2. [✔] Export\n  3. [ ] Type something\n     Submit\n  4. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
const review =
  '\n←  ☒ Color  ☒ Features  ✔ Submit  →\nReview your answers\n ● Choose a color?\n   → Blue\n ● Choose features?\n   → Search, Export\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel';
const codex =
  '\n  Question 1/1 (1 unanswered)\n  Choose a color?\n  › 1. Red    Red color\n    2. Blue   Blue color\n    3. None of the above  Optionally, add details in notes (tab).\n  tab to add notes | enter to submit answer | esc to interrupt';
function setup(screen = single) {
  const pane = {
    paneId: 'p1',
    terminalId: 't1',
    agent: { name: 'claude-1', label: 'claude', session: { value: 's1' } },
  };
  const lines = [
    JSON.stringify({
      message: {
        content: [
          { type: 'tool_use', id: pending.id, name: 'AskUserQuestion', input: { questions } },
        ],
      },
    }),
  ];
  const inputs = [];
  const instance = new AgentQuestions({
    herdr: { readPane: async () => screen },
    exactPane: async () => pane,
    readLines: async () => lines,
    keys: async (id, keys) => inputs.push({ id, keys }),
    text: async (id, text) => inputs.push({ id, text }),
  });
  return {
    instance,
    pane,
    inputs,
    lines,
    screen: (value) => {
      screen = value;
    },
  };
}
test('只识别未完成的结构化提问与匹配的原生对话框，不把权限提示当问题', () => {
  const { lines } = setup();
  assert.deepEqual(pendingQuestion('claude', lines), pending);
  assert.equal(
    pendingQuestion('claude', [
      ...lines,
      JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: pending.id }] } }),
    ]),
    null,
  );
  assert.equal(claudeDialog('Allow Bash?\n❯ 1. Yes\n2. No', pending), null);
  assert.equal(claudeDialog(single.replace('Red\n', 'Unknown\n'), pending), null);
  assert.equal(claudeDialog(single, pending).index, 0);
  assert.deepEqual(claudeDialog(multi, pending).checked, [false, true]);
  assert.equal(claudeDialog(review, pending).stage, 'review');
  assert.equal(codexDialog(codex, { ...pending, questions: [questions[0]] }).selected, 0);
});
test('单选写入明确 pane，重复提交和旧会话不得再次输入', async () => {
  const { instance, pane, inputs } = setup();
  const prompt = await instance.read(pane);
  const body = { ...prompt, choices: [1] };
  await instance.answer(body);
  assert.deepEqual(inputs, [{ id: 'p1', keys: ['down', 'enter'] }]);
  await assert.rejects(instance.answer(body), /已提交/);
  pane.agent.session.value = 's2';
  await assert.rejects(instance.answer(body), /会话已改变/);
  assert.equal(inputs.length, 1);
});
test('多选按现有勾选状态增减，前进到原生 Submit；汇总需要明确确认', async () => {
  const f = setup(multi);
  const prompt = await f.instance.read(f.pane);
  await f.instance.answer({ ...prompt, choices: [0] });
  assert.deepEqual(f.inputs[0].keys, ['space', 'down', 'space', 'down', 'down', 'enter']);
  f.screen(review);
  const confirm = await f.instance.read(f.pane);
  await assert.rejects(f.instance.answer({ ...confirm }), /请确认/);
  await f.instance.answer({ ...confirm, confirm: true });
  assert.deepEqual(f.inputs[1].keys, ['enter']);
});
test('发送前问题变化、无效选择、并发提交、输入结果不确定时都不会盲目重发', async () => {
  const f = setup();
  const prompt = await f.instance.read(f.pane);
  await assert.rejects(f.instance.answer({ ...prompt, choices: [99] }), /格式/);
  f.screen(multi);
  await assert.rejects(f.instance.answer({ ...prompt, choices: [0] }), /问题已变化/);
  assert.equal(f.inputs.length, 0);
  f.screen(single);
  let release;
  f.instance.keys = async () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const request = f.instance.answer({ ...prompt, choices: [0] });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.instance.answer({ ...prompt, choices: [0] }), /正在提交/);
  release();
  await request;
  const g = setup();
  const q = await g.instance.read(g.pane);
  g.instance.keys = async () => {
    throw new Error('connection closed');
  };
  await assert.rejects(g.instance.answer({ ...q, choices: [0] }));
  assert.equal((await g.instance.read(g.pane)).delivery, 'uncertain');
  await assert.rejects(g.instance.answer({ ...q, choices: [0] }), /已提交/);
});
test('自由输入必须先进入同一提问的原生编辑状态，再原子粘贴并提交', async () => {
  const f = setup();
  const q = await f.instance.read(f.pane);
  f.instance.keys = async (id, keys) => {
    f.inputs.push({ id, keys });
    f.screen(
      single
        .replace('❯ 1.', '  1.')
        .replace('  3.', '❯ 3.')
        .replace('Tab/Arrow keys to navigate', '↑/↓ to navigate · ctrl+g to edit in Vim'),
    );
  };
  await f.instance.answer({ ...q, choices: [], text: '绿色\n自定义答案' });
  assert.deepEqual(f.inputs, [
    { id: 'p1', keys: ['down', 'down', 'enter'] },
    { id: 'p1', text: '绿色\n自定义答案' },
  ]);
});
test('Claude 尚未刷入 tool_use 时识别当前提问，不从历史权限或普通编号文本推断', async () => {
  const f = setup(multi);
  f.lines.splice(
    0,
    1,
    JSON.stringify({ type: 'user', uuid: 'last-user', message: { content: 'Ask questions' } }),
  );
  assert.equal(await f.instance.read(f.pane), null, '非 blocked 不能从画面猜问答');
  f.pane.agent.status = 'blocked';
  const q = await f.instance.read(f.pane);
  assert.equal(q.question, 'Choose features?');
  assert.equal(q.multiSelect, true);
  assert.deepEqual(
    q.options.map((x) => x.label),
    ['Search', 'Export'],
  );
  await f.instance.answer({ ...q, choices: [1] });
  assert.deepEqual(f.inputs[0].keys, ['down', 'down', 'down', 'enter']);
  f.screen('Bash needs permission\n❯ 1. Yes\n2. No\nEnter to select · Esc to cancel');
  assert.equal(await f.instance.read(f.pane), null);
});
test('Codex 结构化问题、提交结果和原生菜单匹配', async () => {
  const f = setup(codex);
  f.pane.agent.label = 'codex';
  f.lines.splice(
    0,
    1,
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'codex-q',
        arguments: JSON.stringify({ questions: [questions[0]] }),
      },
    }),
  );
  const q = await f.instance.read(f.pane);
  assert.equal(q.provider, 'codex');
  await f.instance.answer({ ...q, choices: [1] });
  assert.deepEqual(f.inputs[0].keys, ['down', 'enter']);
  f.lines.push(
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'codex-q', output: '{}' },
    }),
  );
  assert.equal(await f.instance.read(f.pane), null);
});
// Codex v0.156.1 的异步提问，画面照探针会话里逐帧记录的原样（2026-09-25）。
const asyncCall = {
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'request_user_input_async',
    call_id: 'codex-async',
    arguments: JSON.stringify({
      questions: [
        { title: '用哪种语言', options: ['Python', 'Rust', 'Go'] },
        { title: '项目叫什么名字' },
      ],
    }),
  },
};
const accepted = {
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: 'codex-async', output: '{"accepted":true}' },
};
const reply = (index, answer, question) => ({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: `<send_user_message_question_reply>\n${JSON.stringify([{ answer, question, questionItemId: JSON.stringify(['request_user_input_async', 'codex-async', index]) }])}\n</send_user_message_question_reply>`,
      },
    ],
  },
});
const collapsedScreen = (count, timer = '') =>
  `• Working (20s • esc to interrupt)\n\n• Queued follow-up inputs\n  ? ${count} question${count > 1 ? 's' : ''}${timer}\n    alt+↑ to answer\n\n› Ask Codex to do anything\n\n  GPT-6-Astra high · Working`;
const optionsScreen = (selected) =>
  `• Queued follow-up inputs\n\n  1 of 2\n  用哪种语言\n\n${['Python', 'Rust', 'Go', 'Other'].map((label, i) => `  ${i === selected ? '› ' : '  '}${i + 1}. ${label}`).join('\n')}\n\n  enter submit   ctrl+] skip   alt+↓ main prompt   alt+↑ next question`;
const textScreen = (typed) =>
  `• Queued follow-up inputs\n\n  项目叫什么名字\n\n  ${typed || 'Type your answer'}\n\n  enter submit   ctrl+] skip   alt+↓ main prompt`;

test('Codex 异步提问：收起时带不带计时都认得，收起与展开是同一张卡，已答的一问按存档记录去掉', async () => {
  const f = setup(collapsedScreen(2));
  f.pane.agent.label = 'codex';
  f.lines.splice(0, 1, JSON.stringify(asyncCall), JSON.stringify(accepted));
  // 没有收起标记也没有展开的面板：进程重启后旧提问已经不在了，不能凭存档一直挂着。
  f.screen('› Ask Codex to do anything');
  assert.equal(await f.instance.read(f.pane), null);
  f.screen(collapsedScreen(2));
  const collapsed = await f.instance.read(f.pane);
  assert.deepEqual(
    [collapsed.collapsed, collapsed.blocking, collapsed.index, collapsed.question],
    [true, false, 0, '用哪种语言'],
  );
  assert.deepEqual(
    collapsed.options.map((o) => o.label),
    ['Python', 'Rust', 'Go'],
  );
  // 计时一出现原来就认不出，卡片时有时无，输入框被反复重建（2026-09-25 用户指出）。
  f.screen(collapsedScreen(2, ' · 15s'));
  assert.equal(
    (await f.instance.read(f.pane)).challenge,
    collapsed.challenge,
    '带计时仍是同一张卡',
  );
  f.screen(optionsScreen(0));
  const expanded = await f.instance.read(f.pane);
  assert.equal(expanded.expanded, true);
  assert.equal(expanded.selected, 0);
  assert.equal(expanded.challenge, collapsed.challenge, '展开前后是同一张卡');
  // 第一问答过了（存档里有它的回答记录）：卡片换成第二问，只能填文字。
  f.lines.push(JSON.stringify(reply(0, 'Rust', '用哪种语言')));
  f.screen(collapsedScreen(1));
  const second = await f.instance.read(f.pane);
  assert.deepEqual(
    [second.index, second.question, second.options.length],
    [1, '项目叫什么名字', 0],
  );
  f.lines.push(JSON.stringify(reply(1, '探针项目', '项目叫什么名字')));
  assert.equal(await f.instance.read(f.pane), null, '两问都答了就没有卡片了');
});

test('Codex 异步提问作答：先展开，选项用方向键加回车，文字只粘贴、核对进了答题位再回车，以存档记录为准', async () => {
  const f = setup(collapsedScreen(2));
  f.pane.agent.label = 'codex';
  f.lines.splice(0, 1, JSON.stringify(asyncCall), JSON.stringify(accepted));
  // 假终端：按键和粘贴改变画面；回车提交当前这一问，写进存档，切到下一问。
  let selected = 0,
    typed = '',
    view = 'collapsed';
  const paint = () =>
    f.screen(
      view === 'collapsed'
        ? collapsedScreen(2)
        : view === 'options'
          ? optionsScreen(selected)
          : view === 'text'
            ? textScreen(typed)
            : '› Ask Codex to do anything',
    );
  const inputs = [];
  f.instance.keys = async (id, keys) => {
    inputs.push(keys);
    for (const key of keys) {
      if (key === 'alt+up' && view === 'collapsed') view = 'options';
      else if (key === 'down') selected += 1;
      else if (key === 'up') selected -= 1;
      else if (key === 'enter' && view === 'options') {
        f.lines.push(JSON.stringify(reply(0, ['Python', 'Rust', 'Go'][selected], '用哪种语言')));
        view = 'text';
      } else if (key === 'enter' && view === 'text') {
        f.lines.push(JSON.stringify(reply(1, typed, '项目叫什么名字')));
        view = 'done';
      }
    }
    paint();
  };
  f.instance.paste = async (id, text) => {
    inputs.push({ paste: text });
    typed = text;
    paint();
  };
  f.instance.text = async () => {
    throw new Error('提问里不能用主输入框那套「补按回车」的发送');
  };

  const first = await f.instance.read(f.pane);
  const one = await f.instance.answer({ ...first, choices: [1] });
  assert.equal(one.delivery, 'sent');
  assert.deepEqual(inputs, [['alt+up'], ['down'], ['enter']]);

  const second = await f.instance.read(f.pane);
  assert.deepEqual([second.index, second.expanded, second.textOnly], [1, true, true]);
  inputs.length = 0;
  const two = await f.instance.answer({ ...second, choices: [], text: '探针项目' });
  assert.equal(two.delivery, 'sent');
  assert.deepEqual(
    inputs,
    [{ paste: '探针项目' }, ['enter']],
    '只按一次回车：补按会把下一问的默认选项也提交掉',
  );
  assert.equal(await f.instance.read(f.pane), null);
});

test('窄终端折行的提问仍能识别', () => {
  assert.equal(
    claudeDialog(single.replace('Esc to cancel', 'Esc\nto cancel'), pending).question,
    'Choose a color?',
  );
});
test('Claude 多选自由输入需要勾选自定义选项并前进到汇总，不把粘贴当成完成', async () => {
  const f = setup(multi);
  const q = await f.instance.read(f.pane);
  let screen = multi
    .replace('❯ 1.', '  1.')
    .replace('  3.', '❯ 3.')
    .replace('Tab/Arrow keys to navigate', '↑/↓ to navigate · ctrl+g to edit in Vim');
  f.instance.keys = async (id, keys) => {
    f.inputs.push({ id, keys });
    if (keys.length === 1 && keys[0] === 'enter')
      screen = screen.replace('[ ] Custom feature', '[✔] Custom feature');
    f.screen(screen);
  };
  f.instance.text = async (id, text) => {
    f.inputs.push({ id, text });
    screen = screen.replace('Type something', text);
    f.screen(screen);
  };
  await f.instance.answer({ ...q, choices: [], text: 'Custom feature' });
  assert.deepEqual(
    f.inputs.map((x) => x.keys || x.text),
    [['down', 'space', 'down', 'enter'], 'Custom feature', ['enter'], ['down', 'enter']],
  );
});

test('遗留的 Claude 模型缓存确认可显式选择 1 或 2，不接受自由输入或其他权限框', async () => {
  const screen =
    'Switch model?\nYour next response will be slower and use more tokens\nThis conversation is cached for the current model.\n❯ 1. Yes, switch to Sonnet 5 (1M context)\n2. No, go back';
  const f = setup(screen);
  f.lines.length = 0;
  f.pane.agent.status = 'blocked';
  const q = await f.instance.read(f.pane);
  assert.equal(q.allowText, false);
  f.pane.agent.status = 'working';
  assert.equal(
    (await f.instance.read(f.pane)).challenge,
    q.challenge,
    'model confirmation must not depend on Herdr recognizing blocked',
  );
  assert.equal(q.options.length, 2);
  assert(q.question.includes('Sonnet 5'));
  await assert.rejects(f.instance.answer({ ...q, choices: [], text: 'yes' }), /选项/);
  await f.instance.answer({ ...q, choices: [1] });
  assert.deepEqual(f.inputs, [{ id: 'p1', keys: ['down', 'enter'] }]);
  f.screen('PreModelSwitch hook requires approval\n❯ 1. Yes\n2. No');
  assert.equal(await f.instance.read(f.pane), null);
});

test('Codex async accepted 回执不是答案，原生可见问题仍可识别', () => {
  const call = {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: 'async-q',
      arguments: JSON.stringify({
        questions: [{ title: 'Choose a color?', options: ['Red', 'Blue'] }],
      }),
    },
  };
  const ack = {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'async-q', output: '{"accepted":true}' },
  };
  const q = pendingQuestion('codex', [JSON.stringify(call), JSON.stringify(ack)]);
  assert.equal(q.questions[0].question, 'Choose a color?');
  assert.equal(q.questions[0].options[0].label, 'Red');
  assert.equal(codexDialog(codex, q).selected, 0);
  ack.payload.output = '{"answers":{"color":{"answers":["Red"]}}}';
  assert.equal(pendingQuestion('codex', [JSON.stringify(call), JSON.stringify(ack)]), null);
});

test('Codex 工作中的目标替换确认不依赖工具存档，两个选项都能答', async () => {
  const screen =
    'Replace goal?\nNew objective: 根据公开信息重新审查精度\n补充验收说明\n› 1. Replace current goal  Set the new objective and start it now\n  2. Cancel                Keep the current goal\nPress enter to confirm or esc to go back';
  for (const choice of [0, 1]) {
    const f = setup(screen);
    f.pane.agent.label = 'codex';
    f.pane.agent.status = 'working';
    f.lines.length = 0;
    const q = await f.instance.read(f.pane);
    assert.equal(q.toolId, 'goal-confirmation');
    assert.equal(q.allowText, false);
    assert.match(q.question, /重新审查精度 补充验收说明/);
    assert.deepEqual(
      q.options.map((x) => x.label),
      ['Replace current goal', 'Cancel'],
    );
    await assert.rejects(f.instance.answer({ ...q, choices: [], text: '替换' }), /选项/);
    await f.instance.answer({ ...q, choices: [choice] });
    assert.deepEqual(f.inputs[0].keys, choice ? ['down', 'enter'] : ['enter']);
    f.screen(screen.replace('重新审查精度', '另一个目标'));
    await assert.rejects(f.instance.answer({ ...q, choices: [0] }), /问题已变化/);
    f.screen('Working (20s)');
    assert.equal(await f.instance.read(f.pane), null);
    f.screen(screen);
    const reopened = await f.instance.read(f.pane);
    assert.notEqual(reopened.challenge, q.challenge);
    assert.equal(reopened.delivery, null);
    for (const invalid of [
      screen.replace('Replace goal?', 'Run command?'),
      screen.replace('Keep the current goal', 'Approve all commands'),
      screen.replace('Press enter to confirm or esc to go back', ''),
    ]) {
      f.screen(invalid);
      assert.equal(await f.instance.read(f.pane), null);
    }
  }
});

test('Codex 恢复暂停目标的原生确认可以选择继续或保持暂停', async () => {
  const f = setup(
    'Resume paused goal?\nGoal: Original goal\n› 1. Resume goal  Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nPress enter to confirm or esc to go back',
  );
  f.pane.agent.label = 'codex';
  f.lines.length = 0;
  const q = await f.instance.read(f.pane);
  assert.equal(q.toolId, 'goal-confirmation');
  await f.instance.answer({ ...q, choices: [1] });
  assert.deepEqual(f.inputs[0].keys, ['down', 'enter']);
});

test('窄终端的 Goal 恢复选项换行后仍要求完整原生文字', async () => {
  const screen =
    'Resume paused goal?\nGoal: Original goal\n› 1. Resume goal  Mark it active\n                  and continue when idle\n  2. Leave paused  Keep it paused;\n                   use /goal resume later\nenter select · esc back';
  const f = setup(screen);
  f.pane.agent.label = 'codex';
  f.lines.length = 0;
  const q = await f.instance.read(f.pane);
  assert.equal(q.toolId, 'goal-confirmation');
  await f.instance.answer({ ...q, choices: [0] });
  assert.deepEqual(f.inputs[0].keys, ['enter']);
  f.screen(screen.replace('and continue when idle', 'and change the objective'));
  assert.equal(await f.instance.read(f.pane), null);
  f.screen(
    'Resume paused goal?\nGoal: Original goal\n› 1. Resume goal\n  2. Leave paused\nenter select · esc back',
  );
  assert.equal((await f.instance.read(f.pane)).toolId, 'goal-confirmation');
  f.screen(
    'Resume paused goal?\nGoal: Original goal\n› 1. Resume goal  Mark it active\n  2. Leave paused\nenter select · esc back',
  );
  assert.equal(await f.instance.read(f.pane), null);
});

test('Claude 的工具审批在页面上可以作答：它不是 AskUserQuestion，形状也不同', async () => {
  const approval = [
    '正文若干',
    '',
    'Bash command',
    '  mkdir -p ~/probe && cd ~/probe && rm -rf *',
    '  在 WSL 家目录建测试目录',
    ' Compound command contains cd with write operation — manual approval required',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, and tell Claude what to do differently',
    '',
    'Esc to cancel · Tab to amend',
  ].join('\n');
  const f = setup(approval);
  // ⚠️ 审批提示挡住一切后续操作，所以不依赖存档里有没有 AskUserQuestion。
  f.lines.length = 0;
  const prompt = await f.instance.read(f.pane);
  assert.equal(prompt.toolId, 'permission');
  assert.equal(prompt.header, 'Bash command', '表头要写它要动的是什么');
  assert.equal(prompt.blocking, true);
  assert.equal(prompt.allowText, false, '审批只能选，不能自己写一句');
  assert.match(prompt.question, /Do you want to proceed\?/);
  assert.match(prompt.question, /mkdir -p ~\/probe/, '被审批的命令要摆出来，那是判断依据');
  assert.deepEqual(
    prompt.options.map((option) => option.label),
    ['Yes', 'No, and tell Claude what to do differently'],
  );
  assert.equal(prompt.selected, 0);

  // 选第二项：光标下移一格再回车，和终端里的动作一样。
  await f.instance.answer({ ...prompt, choices: [1] });
  assert.deepEqual(f.inputs[0].keys, ['down', 'enter']);
});

test('正文里的普通编号列表不会被当成审批选项', async () => {
  const f = setup('说明一下\n1. 第一点\n3. 第三点\nDo you want to proceed?');
  f.lines.length = 0;
  // 编号不连续、也没有 ❯ 标出选中，不能认。宁可不显示，也不能让人对着假选项点。
  assert.equal(await f.instance.read(f.pane), null);
});
