'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const captures = require('./fixtures/codex-proactive-prompts.json');
const { codexInteraction } = require('../lib/codex-footer');
const { AgentQuestions } = require('../lib/agent-questions');
const pane = {
  paneId: 'prompts',
  terminalId: 'terminal',
  runtimeId: 'process:1',
  agent: { name: 'codex', label: 'codex', session: { value: 'session' } },
};
const composer = '› \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol high · /fixture';
for (const capture of captures)
  test(`native source snapshot: ${capture.source}`, async () => {
    // Ratatui snapshots omit styles. The generic app name is a bold native heading.
    let raw = capture.text.replace(/^Google Calendar/, '\x1b[1mGoogle Calendar\x1b[0m');
    const keys = [];
    const manager = new AgentQuestions({
      herdr: { readPane: async () => raw },
      exactPane: async () => pane,
      readLines: async () => {
        throw Error('archive unavailable');
      },
      keys: async (_id, input) => {
        keys.push(...input);
        raw = composer;
      },
    });
    const q = await manager.read(pane);
    assert(q?.nativeModal, 'Native prompt must expose an action');
    assert(q.options.length);
    assert.equal(q.blocking, true);
    assert.equal(keys.length, 0, 'Observation never acts');
    const original = raw;
    const body = { ...q, choices: [q.selected], requestId: 'snapshot-action' };
    assert.equal((await manager.answer(body)).delivery, 'sent');
    assert.deepEqual(keys, [q.nativeModal.actions?.[q.selected]?.key || q.confirmKey]);
    assert((await manager.answer(body)).repeated);
    assert.equal(keys.length, 1);
    assert(
      !codexInteraction(original + '\n\n' + composer).modal,
      'Historical prompts do not block the composer',
    );
  });
test('visible partial menu supports explicit scrolling without confirming a choice', async () => {
  let raw = captures.find((c) => c.source.includes('update_picker_selected_28x12')).text;
  const keys = [],
    manager = new AgentQuestions({
      herdr: { readPane: async () => raw },
      exactPane: async () => pane,
      readLines: async () => [],
      keys: async (_id, value) => {
        keys.push(...value);
        raw = raw.replace('3. Skip until next version', '2. Skip');
      },
    });
  const q = await manager.read(pane);
  assert(q.nativeModal.scrollable);
  assert.equal(
    (await manager.answer({ ...q, action: 'native-up', requestId: 'scroll' })).delivery,
    'navigated',
  );
  assert.deepEqual(keys, ['up']);
  assert.equal((await manager.read(pane)).options[0].label, 'Skip');
});
test('MCP text uses the displayed submit chord after verifying the pasted value', async () => {
  let raw = captures.find((c) => c.source.includes('text_configured_key_chords')).text;
  const keys = [],
    manager = new AgentQuestions({
      herdr: { readPane: async () => raw },
      exactPane: async () => pane,
      readLines: async () => [],
      paste: async (_id, text) => {
        raw = raw.replace('Type your answer', text);
      },
      keys: async (_id, value) => {
        keys.push(...value);
        raw = composer;
      },
    });
  const q = await manager.read(pane);
  assert(q.allowText);
  assert.equal(
    (await manager.answer({ ...q, choices: [], text: '测试回答', requestId: 'form' })).delivery,
    'sent',
  );
  assert.deepEqual(keys, ['ctrl+x', 'enter']);
});
test('Hooks review executes only the chosen displayed action, with no numbered-menu navigation', async () => {
  const capture = captures.find((c) =>
    c.source.endsWith('__hooks_browser_events_with_review_column.snap'),
  );
  for (const [choice, key] of ['enter', 't', 'esc'].entries()) {
    let raw = capture.text;
    const keys = [];
    const manager = new AgentQuestions({
      herdr: { readPane: async () => raw },
      exactPane: async () => pane,
      readLines: async () => [],
      keys: async (_id, value) => {
        keys.push(...value);
        raw = composer;
      },
    });
    const q = await manager.read(pane);
    assert.equal(
      (await manager.answer({ ...q, choices: [choice], requestId: 'hook-action' })).delivery,
      'sent',
    );
    assert.deepEqual(keys, [key]);
  }
});
