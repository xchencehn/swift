'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parts, plainText } = require('../public/codex-question-reply');
const { pendingQuestion } = require('../lib/questions/codex');
const envelope = (items) =>
  `<send_user_message_question_reply>\n${JSON.stringify(items)}\n</send_user_message_question_reply>`;
const reply = (question = '问题内容', answer = '回答内容', index = 0) => ({
  question,
  answer,
  questionItemId: JSON.stringify(['request_user_input_async', 'call-reply', index]),
});

test('native question reply preserves question, answer and surrounding text while hiding transport metadata', () => {
  const item = reply(
    '请运行 `python3 /fixture/review.py` 后回复。',
    '我无法执行这个操作\n我授权你直接执行这个操作',
  );
  const text = `补充说明\n${envelope([item])}\n\n还有一条建议。`;
  const result = parts(text);
  assert.deepEqual(result, [
    { kind: 'text', text: '补充说明\n' },
    { kind: 'question_reply', ...item },
    { kind: 'text', text: '\n\n还有一条建议。' },
  ]);
  const display = plainText(text);
  assert(display.includes('问题：请运行'));
  assert(display.includes('回答：我无法执行'));
  assert(display.includes('还有一条建议。'));
  for (const field of ['send_user_message_question_reply', 'questionItemId', 'call-reply'])
    assert(!display.includes(field));
});

test('multiple questions and multiple envelopes remain in native order, including an empty answer', () => {
  const text = `${envelope([reply('第一问', '第一答'), reply('第二问', '', 1)])}\n普通文字\n${envelope([reply('第三问', '第三答', 2)])}`;
  assert.deepEqual(
    parts(text)
      .filter((p) => p.kind === 'question_reply')
      .map((p) => [p.question, p.answer]),
    [
      ['第一问', '第一答'],
      ['第二问', ''],
      ['第三问', '第三答'],
    ],
  );
  assert(plainText(text).includes('普通文字'));
});

test('literal protocol tags inside JSON answers are content and do not truncate the reply', () => {
  const item = reply(
    '怎样展示标签？',
    '<send_user_message_question_reply> 是开始，</send_user_message_question_reply> 是结束。',
  );
  assert.equal(parts(envelope([item]))[0].answer, item.answer);
});

test('malformed, unknown and partial payloads remain verbatim; a later valid envelope is still recognized', () => {
  for (const text of [
    '<send_user_message_question_reply>[',
    envelope([]),
    envelope({ question: 'q', answer: 'a' }),
    envelope([{ answer: 'a' }]),
    envelope([{ question: 'q', answer: null }]),
  ]) {
    assert.deepEqual(parts(text), [{ kind: 'text', text }]);
    assert.equal(plainText(text), text);
  }
  const invalid = envelope([{ question: 'missing answer' }]);
  const text = invalid + '\n' + envelope([reply()]);
  assert.equal(parts(text)[0].text, invalid + '\n');
  assert.equal(parts(text)[1].kind, 'question_reply');
});

test('quoted code, inline code and ordinary text never become question replies', () => {
  for (const text of [
    `\`\`\`xml\n${envelope([reply()])}\n\`\`\``,
    `~~~\n${envelope([reply()])}\n~~~`,
    `\`\`\`\n${envelope([reply()])}`,
    `引用：${envelope([reply()])}`,
    `> ${envelope([reply()])}`,
    '普通输入 <answer>保持原样</answer>',
  ])
    assert.equal(plainText(text), text);
});

test('pending-question state uses the same parser for multiple replies and ignores quoted examples', () => {
  const call = {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: 'call-reply',
      arguments: JSON.stringify({ questions: [{ title: '第一问' }, { title: '第二问' }] }),
    },
  };
  const message = (text) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  const parse = (text) => pendingQuestion([call, message(text)].map(JSON.stringify));
  assert.equal(
    parse(`\`\`\`\n${envelope([reply('第一问', '答案')])}\n\`\`\``).questions[0].answered,
    false,
  );
  assert.equal(parse(envelope([reply('第一问', '答案')])).questions[0].answered, true);
  assert.equal(
    parse(`${envelope([reply('第一问', '答案')])}\n${envelope([reply('第二问', '答案', 1)])}`),
    null,
  );
});
