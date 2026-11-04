'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const captures = require('./fixtures/codex-rate-limit.json');
const { codexInteraction } = require('../lib/codex-footer');
const { stripAnsi } = require('../public/ansi');
const { AgentQuestions } = require('../lib/agent-questions');
const pane = {
  paneId: 'quota',
  terminalId: 'terminal',
  runtimeId: 'process:1',
  agent: { name: 'codex', label: 'codex', session: { value: 'session' } },
};
const composer = '› \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol high · /fixture';
for (const capture of captures)
  for (const plain of [false, true])
    test(`native quota menu ${capture.columns} columns, plain=${plain}`, async () => {
      const raw = plain ? stripAnsi(capture.ansi) : capture.ansi;
      const interaction = codexInteraction(raw);
      assert.equal(interaction.modal?.kind, 'rate-limit');
      assert.equal(interaction.inputTarget, 'menu');
      assert(!interaction.capabilities.compose);
      const q = await new AgentQuestions({
        herdr: { readPane: async () => raw },
        exactPane: async () => pane,
        readQuestionState: async () => {
          throw Error('archive unavailable');
        },
      }).read(pane);
      assert.equal(q.nativeModal.kind, 'rate-limit');
      assert.equal(q.blocking, true);
      assert.deepEqual(
        q.options.map((o) => o.label),
        ['Switch to gpt-6-luna', 'Keep current model', 'Keep current model (never show again)'],
      );
      if (capture.columns === 140) assert(q.options[0].description.includes('Fast and affordable'));
      assert(
        !codexInteraction(raw + '\n\n' + composer).modal,
        'a historical quota menu cannot override the current composer',
      );
    });
test('known quota fallback requires the complete current menu, not isolated title or changed options', () => {
  const raw = stripAnsi(captures[0].ansi);
  for (const changed of [
    raw.replace('Keep current model', 'Different action'),
    raw.replace('› 1.', '  1.'),
    raw.replace('3. ', '4. '),
    raw.replace('lower credit usage?', 'another operation?'),
    raw.replace('enter select · esc back', ''),
  ]) {
    assert.equal(codexInteraction(changed).modal, undefined);
  }
});
test('native quota choice, confirmation and duplicate receipt are independent of archive reads', async () => {
  let screen = stripAnsi(captures[0].ansi),
    reads = 0;
  const keys = [];
  const manager = new AgentQuestions({
    herdr: { readPane: async () => screen },
    exactPane: async () => pane,
    readQuestionState: async () => {
      reads++;
      throw Error('archive unavailable');
    },
    keys: async (_id, input) => {
      keys.push(...input);
      if (input.includes('down')) screen = screen.replace('› 1.', '  1.').replace('  2.', '› 2.');
      if (input.includes('enter')) screen = composer;
    },
  });
  const q = await manager.read(pane),
    body = { ...q, choices: [1], requestId: 'quota-answer' };
  assert.equal((await manager.answer(body)).delivery, 'sent');
  assert.deepEqual(keys, ['down', 'enter']);
  assert((await manager.answer(body)).repeated);
  assert.deepEqual(keys, ['down', 'enter']);
  assert.equal(reads, 0);
});
test('a lost native observation cannot silently clear an outstanding quota question', async () => {
  let lost = false;
  const manager = new AgentQuestions({
    herdr: {
      readPane: async () => {
        if (lost) throw Error('native disconnected');
        return captures[0].ansi;
      },
    },
    exactPane: async () => pane,
    readLines: async () => [],
  });
  assert(await manager.read(pane));
  lost = true;
  await assert.rejects(manager.read(pane), /native disconnected/);
});
