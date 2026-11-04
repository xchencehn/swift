'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { AgentQuestions } = require('../lib/agent-questions'),
  codex = require('../lib/questions/codex');
const questions = [
  { title: 'Which build target?', options: ['Desktop', 'Mobile'] },
  { title: 'What is the project name?' },
  { title: 'Skip this optional question?', options: ['Yes', 'No'] },
];
const call = (id, qs) =>
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: id,
      name: 'request_user_input_async',
      arguments: JSON.stringify({ questions: qs }),
    },
  });
function setup(options = {}) {
  const pane = {
    paneId: 'p1',
    terminalId: 't1',
    runtimeId: 'process:1',
    agent: { label: 'codex', name: 'test', session: { value: 's1' } },
  };
  const lines = [call('first-call', questions)],
    writes = [],
    live = [0, 1, 2];
  let collapsed = true,
    position = 0,
    selected = 0,
    text = '';
  const screen = () => {
    if (!live.length) return '› Ask Codex to do anything';
    if (collapsed)
      return `• Queued follow-up inputs\n? ${live.length} questions · 16s\nshift+← to answer\n› Ask Codex to do anything`;
    const q = questions[live[position]],
      rows = q.options
        ? [...q.options, text || 'Other']
            .map((label, i) => `${selected === i ? '›' : ' '} ${i + 1}. ${label}`)
            .join('\n')
        : text || 'Type your answer';
    return `• Queued follow-up inputs\n${position + 1} of ${live.length}\n${q.title}\n${rows}\nenter submit   ^] skip   shift+→ ${position ? 'prev question' : 'main prompt'}${position < live.length - 1 ? '   shift+← next question' : ''}`;
  };
  const keys = async (_id, keys) => {
    writes.push(keys);
    for (const key of keys) {
      if (key === 'shift+left') {
        if (collapsed) collapsed = false;
        else position = Math.min(position + 1, live.length - 1);
      }
      if (key === 'shift+right') {
        if (!position) collapsed = true;
        else position--;
      }
      if (key === 'down') selected++;
      if (key === 'up') selected--;
      if (key === 'enter' || key === 'ctrl+]') {
        const index = live[position];
        if (key === 'enter')
          lines.push(
            JSON.stringify({
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: `<send_user_message_question_reply>${JSON.stringify([{ answer: text || questions[index].options[selected], question: questions[index].title, questionItemId: JSON.stringify(['request_user_input_async', 'first-call', index]) }])}</send_user_message_question_reply>`,
                  },
                ],
              },
            }),
          );
        live.splice(position, 1);
        position = Math.max(0, Math.min(position, live.length - 1));
        selected = 0;
        text = '';
      }
    }
  };
  const config = {
    herdr: { readPane: async () => screen() },
    exactPane: async () => structuredClone(pane),
    readLines: async () => lines,
    keys,
    paste: async (_id, value) => {
      writes.push(value);
      text = value;
    },
    restoreMain: true,
    ...options,
  };
  const instance = new AgentQuestions(config);
  return { pane, lines, writes, live, instance, config, screen };
}
for (const name of ['collapsed', 'options', 'text'])
  test(`recognizes recorded Codex 0.162.1 ${name} menu`, () => {
    const prompt = codex.inspect({
      pane: { paneId: 'p', terminalId: 't', agent: { session: { value: 's' } } },
      lines: [call('q', questions)],
      screen: fs.readFileSync(
        path.join(__dirname, `fixtures/codex-questions/v0.162.1-${name}.txt`),
        'utf8',
      ),
      state: { goalPrompts: new Map() },
    });
    assert(prompt?.queued);
    assert.equal(prompt.navigation.open, 'shift+left');
    assert.equal(prompt.remaining, 3);
  });
test('all native calls remain available; an older call can own the visible menu', () => {
  const lines = [
    call('older', questions),
    call('newer', [{ title: 'A different question?', options: ['A', 'B'] }]),
  ];
  const pending = codex.pendingQuestion(lines);
  assert.equal(pending.calls.length, 2);
  const q = codex.inspect({
    pane: { paneId: 'p', agent: { session: { value: 's' } } },
    lines,
    screen: fs.readFileSync(
      path.join(__dirname, 'fixtures/codex-questions/v0.162.1-options.txt'),
      'utf8',
    ),
    state: { goalPrompts: new Map() },
  });
  assert.equal(q.toolId, 'older');
});
test('open, previous, next, skip and returning to the main prompt preserve original question identity', async () => {
  const f = setup();
  let q = await f.instance.read(f.pane);
  const act = async (action) => {
    const result = await f.instance.answer({
      ...q,
      action,
      requestId: 'request-' + f.writes.length,
    });
    q = await f.instance.read(f.pane);
    return result;
  };
  await act('open');
  assert(q.expanded);
  assert.equal(q.index, 0);
  await act('next');
  assert.equal(q.index, 1);
  assert.equal(q.position, 2);
  await act('previous');
  assert.equal(q.index, 0);
  await act('skip');
  assert.equal(q.index, 1);
  assert.equal(q.position, 1);
  assert.equal(q.remaining, 2);
  await act('previous');
  assert(q.collapsed);
  await act('open');
  assert.equal(q.index, 1);
  await f.instance.answer({
    ...q,
    action: 'answer',
    requestId: 'text-answer',
    choices: [],
    text: 'SwiftFixture',
  });
  q = await f.instance.read(f.pane);
  assert(q.collapsed);
  assert.equal(
    q.index,
    0,
    'collapsed summary is not proof that skipped archive entries remain active',
  );
  await f.instance.answer({ ...q, action: 'open', requestId: 'open-final' });
  q = await f.instance.read(f.pane);
  assert.equal(q.index, 2);
  assert.equal(f.writes.filter((keys) => Array.isArray(keys) && keys.includes('enter')).length, 1);
  const snapshot = codex.questionState(f.lines);
  assert(codex.hasReceipt(snapshot, { toolId: 'first-call', index: 1 }));
  assert(!codex.hasReceipt(snapshot, { toolId: 'first-call', index: 0 }));
});
test('native receipt confirms an answer; a changed menu alone does not', async () => {
  const q = { toolId: 'q', index: 0, expanded: true, options: [{ label: 'A' }], selected: 0 };
  const io = {
    keys: async () => {},
    reread: async () => q,
    until: async () => true,
    confirm: async () => false,
  };
  assert.equal(await codex.answer({ prompt: q, payload: { choices: [0] }, io }), 'uncertain');
});
test('archived candidates support local browsing; submitting another candidate locates that exact live question', async () => {
  const f = setup(),
    q = await f.instance.read(f.pane);
  assert.equal(q.items.length, 3);
  assert.deepEqual(f.writes, []);
  const target = q.items[1];
  await f.instance.answer({
    ...target,
    action: 'answer',
    requestId: 'local-second',
    text: 'LocalPreview',
    choices: [],
  });
  assert(codex.hasReceipt(codex.questionState(f.lines), { toolId: 'first-call', index: 1 }));
  assert(!codex.hasReceipt(codex.questionState(f.lines), { toolId: 'first-call', index: 0 }));
  assert.equal(f.writes.filter((keys) => Array.isArray(keys) && keys.includes('enter')).length, 1);
});
test('a candidate absent from the native menu never receives a guessed answer', async () => {
  const f = setup(),
    q = await f.instance.read(f.pane);
  f.live.splice(1, 1);
  await assert.rejects(
    f.instance.answer({
      ...q.items[1],
      action: 'answer',
      requestId: 'removed-candidate',
      text: 'must not appear',
      choices: [],
    }),
    /找不到|切不到/,
  );
  assert(!f.writes.some((keys) => typeof keys === 'string' || keys.includes('enter')));
});
test('a question removed during main-thread verification is rejected before the write callback', async () => {
  const f = setup(),
    q = await f.instance.read(f.pane);
  f.instance.ensureMain = async () => {
    f.live.splice(0);
  };
  f.instance.beforeAnswer = async () => {
    throw Error('must not invoke a missing question');
  };
  await assert.rejects(
    f.instance.answer({
      ...q.items[1],
      action: 'answer',
      requestId: 'disappeared',
      text: 'unused',
      choices: [],
    }),
    /问题已变化/,
  );
  assert.deepEqual(f.writes, []);
});
test('thread verification restores the original queued question and rejects side before an answer', async () => {
  const f = setup();
  let q = await f.instance.read(f.pane);
  await f.instance.answer({ ...q, action: 'open' });
  q = await f.instance.read(f.pane);
  await f.instance.answer({ ...q, action: 'next' });
  q = await f.instance.read(f.pane);
  let checks = 0;
  await f.instance.verifyQuestionThread(f.pane, q, async () => {
    checks++;
    assert((await f.instance.read(f.pane)).collapsed);
  });
  assert.equal(checks, 1);
  assert.equal((await f.instance.read(f.pane)).challenge, q.challenge);
  f.instance.beforeAnswer = (pane, prompt) =>
    f.instance.verifyQuestionThread(pane, prompt, async () => {
      throw Error('SIDE_ACTIVE');
    });
  const before = f.writes.length;
  await assert.rejects(
    f.instance.answer({ ...q, action: 'answer', text: 'must not be sent' }),
    /SIDE_ACTIVE/,
  );
  assert(
    f.writes
      .slice(before)
      .every((keys) => Array.isArray(keys) && keys.every((key) => key === 'shift+right')),
  );
  assert((await f.instance.read(f.pane)).collapsed);
});
test('an explicit request is not re-dispatched after restart, including a different request ID for the same uncertain question', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-question-receipts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptFile = path.join(dir, 'receipts.json'),
    f = setup({ receiptFile });
  const q = await f.instance.read(f.pane),
    body = { ...q, action: 'open', requestId: 'open-once' };
  await Promise.all([f.instance.answer(body), f.instance.answer(body)]);
  assert.equal(f.writes.length, 1);
  const revived = new AgentQuestions(f.config);
  await revived.answer(body);
  assert.equal(f.writes.length, 1);
  const current = await revived.read(f.pane);
  revived.keys = async () => {
    throw Error('socket ended after write');
  };
  const answer = { ...current, action: 'answer', requestId: 'answer-once', choices: [0] };
  await assert.rejects(revived.answer(answer), /socket ended/);
  const after = new AgentQuestions(f.config);
  assert.equal((await after.answer(answer)).delivery, 'uncertain');
  await assert.rejects(after.answer({ ...answer, requestId: 'different' }), /已有操作记录/);
  await assert.rejects(after.answer({ ...answer, choices: [1] }), /不同操作/);
  const contents = fs.readFileSync(receiptFile, 'utf8');
  assert(!contents.includes('Which build target?'));
  assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o600);
});
test('a corrupt receipt ledger blocks question writes without breaking construction', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-question-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptFile = path.join(dir, 'receipts.json');
  fs.writeFileSync(receiptFile, 'broken');
  const f = setup({ receiptFile });
  await assert.rejects(f.instance.answer({ paneId: 'p1', requestId: 'x' }), /回执/);
  assert.deepEqual(f.writes, []);
});
