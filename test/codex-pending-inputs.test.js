'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { projectTerminalScreen } = require('../public/native-status');
const { readStatusArea } = require('../lib/agent-composer');
const Model = require('../public/chat/status-model');
const title = 'Messages to be submitted after next tool call';
const hint = '(press esc to interrupt and send immediately)';
const project = (body) =>
  projectTerminalScreen(
    [...body, '', '› Ask Codex to do anything', '', 'GPT-6-Astra xhigh · ~/workdir/compete'].map(
      (text) => [{ text }],
    ),
  );
test('pending steers stay separate from activity, notes, warnings and transcript delivery', () => {
  const body = [
    '• Compacting context (2m 51s • esc to interrupt)',
    '  └ Making room to continue.',
    '',
    `• ${title} ${hint}`,
    '  ↳ 999 warnings · 4 background terminals',
    '    继续核对任务书。',
  ];
  const projection = project(body),
    value = Model.parse({ projection });
  assert.equal(value.activity, 'Compacting context');
  assert.equal(value.elapsedSeconds, 171);
  assert.deepEqual(value.notes, ['Making room to continue.']);
  assert.equal(value.warnings, null);
  assert.equal(value.background, null);
  assert.deepEqual(value.pendingInputs, [
    {
      title,
      hint: hint.slice(1, -1),
      messages: ['999 warnings · 4 background terminals\n继续核对任务书。'],
    },
  ]);
  assert.equal(projection.interaction.capabilities.compose, true);
  const raw = [
    ...body,
    '',
    '› Ask Codex to do anything',
    '',
    'GPT-6-Astra xhigh · ~/workdir/compete',
  ].join('\n');
  assert.deepEqual(readStatusArea(raw).pendingInputs, value.pendingInputs);
  const old = { ...projection, pendingInputs: undefined, rows: body.map((text) => [{ text }]) };
  assert.deepEqual(Model.parse({ projection: old }).pendingInputs, value.pendingInputs);
  assert.equal(Model.parse({ projection: old }).warnings, null);
});
test('wrapped native headers, multiple messages and end-of-turn queue retain exact meanings', () => {
  const value = Model.parse({
    projection: project([
      '• Working (1s • esc to interrupt)',
      '',
      '• Messages to be submitted after next',
      '  tool call (press esc to interrupt',
      '  and send immediately)',
      '  ↳ 第一条',
      '  ↳ 第二条',
      '',
      '• Messages to be submitted at end of turn',
      '  ↳ 下一轮',
      '',
      '• Queued follow-up inputs',
      '  ↳ 普通队列',
      '    shift+left edit last queued message',
    ]),
  });
  assert.equal(value.pendingInputs.length, 3);
  assert.equal(value.pendingInputs[0].title, title);
  assert.equal(value.pendingInputs[0].hint, hint.slice(1, -1));
  assert.deepEqual(value.pendingInputs[0].messages, ['第一条', '第二条']);
  assert.deepEqual(value.pendingInputs[2].messages, ['普通队列']);
  assert.deepEqual(value.notes, []);
});
test('queued questions, history, unknown foreground and cleared queues cannot become pending user messages', () => {
  assert.deepEqual(
    Model.parse({
      projection: project(['• Queued follow-up inputs', '  ? 1 question', '    alt+↑ to answer']),
    }).pendingInputs,
    [],
  );
  const history = [
    `• ${title} ${hint}`,
    '  ↳ OLD',
    '› previous input',
    '• Working (1s • esc to interrupt)',
  ];
  assert.deepEqual(Model.parse({ projection: project(history) }).pendingInputs, []);
  const populated = project([`• ${title} ${hint}`, '  ↳ queued']);
  assert.equal(populated.pendingInputs.length, 1);
  assert.deepEqual(
    Model.parse({ projection: { ...populated, recognized: false } }).pendingInputs,
    [],
  );
  assert.deepEqual(
    Model.parse({ projection: { ...populated, interaction: { modal: { title: 'Select model' } } } })
      .pendingInputs,
    [],
  );
  assert.deepEqual(Model.parse({ projection: project(['Worked for 3s']) }).pendingInputs, []);
});
