'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { userInputDisplay, sanitizeUserText, rustTrim } = require('../lib/codex-user-display');
const text = (value, elements = []) => ({ type: 'text', text: value, text_elements: elements });
const bytes = (value) => Buffer.byteLength(value, 'utf8');

test('native text items concatenate without inserting a separator', () => {
  const result = userInputDisplay([text('第一'), text('second')]);
  assert.equal(result.message, '第一second');
  assert.equal(result.visible, true);
  assert.equal(result.complete, true);
});

test('Rust control sanitization consumes CSI and preserves OSC payload text', () => {
  assert.equal(sanitizeUserText('\x1b[31m\x00\x7f\x85\t\n\x1b[0m'), '\t\n');
  assert.equal(sanitizeUserText('a\x1b[123'), 'a');
  assert.equal(sanitizeUserText('\x1b]title\x07'), ']title');
  assert.equal(userInputDisplay([text('\x1b[31m\x00\x85\t\n')]).visible, false);
});

test('visibility uses Rust White_Space rather than JavaScript trim', () => {
  assert.equal(rustTrim('\u0085\u2007text\u202f'), 'text');
  assert.equal(userInputDisplay([text('\ufeff')]).visible, true);
  assert.equal(userInputDisplay([text('\u0085\u2007\u202f')]).visible, false);
});

test('inline and local images remain visible without text', () => {
  for (const input of [
    { type: 'image', url: 'https://example.invalid/a.png' },
    { type: 'image', image_url: 'data:image/png;base64,AA==' },
    { type: 'localImage', path: '/tmp/a.png' },
    { type: 'local_image', path: '/tmp/a.png' },
  ]) {
    const result = userInputDisplay([input]);
    assert.equal(result.visible, true);
    assert.equal(result.complete, true);
  }
});

test('TUI omits file-backed images, audio, skills and mentions', () => {
  const result = userInputDisplay([
    { type: 'image', fileId: 'file-1' },
    { type: 'image', file_id: 'file-2' },
    { type: 'audio', url: 'data:audio/wav;base64,AA==' },
    { type: 'localAudio', path: '/tmp/a.wav' },
    { type: 'local_audio', path: '/tmp/b.wav' },
    { type: 'skill', name: 's', path: '/tmp/SKILL.md' },
    { type: 'mention', name: 'm', path: 'thread://abc' },
  ]);
  assert.equal(result.message, '');
  assert.equal(result.visible, false);
  assert.equal(result.complete, true);
});

test('last request heading strips context without requiring an IDE prefix', () => {
  const result = userInputDisplay([
    text(
      'user literal\n## My request for Codex:\nold\n## My request for Codex:\n\u0085  final \u2007',
    ),
  ]);
  assert.equal(result.message, 'final');
  assert.equal(result.complete, true);
  assert.equal(
    userInputDisplay([text('# Context from my IDE setup:\ncontext\n## My request for Codex:\n\t')])
      .visible,
    false,
  );
  assert.equal(
    userInputDisplay([text('# Context from my IDE setup:\ncontext')]).message,
    '# Context from my IDE setup:\ncontext',
  );
});

test('context stripping filters and rebases text element byte ranges', () => {
  const prefix = '上下文\n## My request for Codex:\n  ';
  const result = userInputDisplay([
    text(prefix + '中x ', [
      { byte_range: { start: 0, end: 3 }, placeholder: '上' },
      { byte_range: { start: bytes(prefix), end: bytes(prefix) + 3 }, placeholder: '中' },
    ]),
  ]);
  assert.equal(result.message, '中x');
  assert.deepEqual(result.textElements, [{ byteRange: { start: 0, end: 3 }, placeholder: '中' }]);
});

test('an empty text element counts as native visible content', () => {
  const result = userInputDisplay([
    text('', [{ byteRange: { start: 0, end: 0 }, placeholder: '' }]),
  ]);
  assert.equal(result.visible, true);
  assert.equal(result.complete, true);
});

test('complete async reply envelopes display question and answer before request stripping', () => {
  const envelope =
    '<send_user_message_question_reply>' +
    JSON.stringify([
      {
        questionItemId: 'q1',
        question: 'Where?',
        answer: 'Line one\n## My request for Codex:\nLiteral answer',
      },
      { questionItemId: 'q2', question: 'Why?', answer: 'Because.' },
    ]) +
    '</send_user_message_question_reply>';
  const expected =
    '> Where?\n\nLine one\n## My request for Codex:\nLiteral answer\n\n> Why?\n\nBecause.';
  for (const prompt of [
    envelope,
    '# Context from my IDE setup:\ncontext\n## My request for Codex:\n' + envelope,
  ]) {
    const result = userInputDisplay([
      text(prompt, [{ byteRange: { start: 0, end: 0 }, placeholder: 'x' }]),
    ]);
    assert.equal(result.message, expected);
    assert.deepEqual(result.textElements, []);
    assert.equal(result.complete, true);
  }
});

test('invalid or partial async envelopes retain their literal display', () => {
  for (const prompt of [
    '<send_user_message_question_reply>[]</send_user_message_question_reply>',
    '<send_user_message_question_reply>{"question":"q","answer":"a"}</send_user_message_question_reply>',
    'prefix <send_user_message_question_reply>{"questionItemId":"q","question":"q","answer":"a"}</send_user_message_question_reply>',
  ]) {
    const result = userInputDisplay([text(prompt)]);
    assert.equal(result.message, prompt);
    assert.equal(result.complete, true);
  }
});

test('duplicate JSON keys in an exact async envelope fail completeness conservatively', () => {
  const result = userInputDisplay([
    text(
      '<send_user_message_question_reply>{"questionItemId":"q","question":"q","answer":"a","answer":"b"}</send_user_message_question_reply>',
    ),
  ]);
  assert.equal(result.complete, false);
  assert.match(result.issues[0].detail, /duplicate JSON keys/);
});

test('task links decode only a matching element and retain UTF-8 ranges', () => {
  const prefix = '中';
  const link = '[@标\\]题](thread://abc-12)';
  const result = userInputDisplay([
    text(prefix),
    text(link + '尾', [{ byteRange: { start: 0, end: bytes(link) }, placeholder: '@标]题' }]),
  ]);
  assert.equal(result.message, '中@标]题尾');
  assert.deepEqual(result.textElements, [
    { byteRange: { start: 3, end: bytes('中@标]题') }, placeholder: '@标]题' },
  ]);
  assert.equal(result.complete, true);
  assert.equal(userInputDisplay([text(link)]).message, link);
  assert.equal(
    userInputDisplay([
      text(link, [{ byte_range: { start: 0, end: bytes(link) }, placeholder: '@other' }]),
    ]).message,
    link,
  );
});

test('task link syntax enforces native thread ID and title bounds', () => {
  for (const [title, id, expectedDecode] of [
    ['a'.repeat(160), 'abc', true],
    ['a'.repeat(161), 'abc', false],
    ['a', 'a'.repeat(64), true],
    ['a', 'a'.repeat(65), false],
    ['a', 'with/slash', false],
  ]) {
    const link = `[@${title}](thread://${id})`;
    const result = userInputDisplay([
      text(link, [{ byteRange: { start: 0, end: bytes(link) }, placeholder: '@' + title }]),
    ]);
    assert.equal(result.message, expectedDecode ? '@' + title : link);
    assert.equal(result.complete, true);
  }
});

test('unsupported content fails completeness without hiding unrelated normal text', () => {
  const result = userInputDisplay([text('normal'), { type: 'futureInput' }]);
  assert.equal(result.message, 'normal');
  assert.equal(result.visible, true);
  assert.equal(result.complete, false);
  assert.equal(
    userInputDisplay([{ type: 'text', text: 'normal', text_elements: null }]).complete,
    false,
  );
});
