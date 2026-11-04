'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const captures = require('./fixtures/codex-native-panels-0164.json').captures;
const { codexInteraction } = require('../lib/codex-footer');
const { parseAnsiLine, stripAnsi } = require('../public/ansi');
const { projectTerminalScreen } = require('../public/native-status');
const { AgentQuestions } = require('../lib/agent-questions');
const { CodexSide } = require('../lib/codex-side');
const codex = require('../lib/questions/codex');
const pane = {
  paneId: 'p1',
  terminalId: 't1',
  runtimeId: '123:456',
  agent: { name: 'codex', label: 'codex', session: { value: 's1' } },
};

for (const capture of captures)
  test(`actual Codex 0.164 foreground and composer: ${capture.name}`, async () => {
    const state = codexInteraction(capture.ansi);
    const modal = ['02-replace', '03-resume-goal'].includes(capture.state);
    assert.equal(state.inputTarget, modal ? 'menu' : 'composer');
    assert.equal(state.capabilities.compose, !modal);
    const projected = projectTerminalScreen(capture.ansi.split('\n').map(parseAnsiLine));
    assert.equal(projected.recognized, true);
    const side = new CodexSide({
      herdr: { readPane: async () => capture.ansi },
      exactPane: async () => pane,
    });
    if (modal) {
      await assert.rejects(side.assertMain(pane), { code: 'QUESTION_PENDING' });
      const view = await side.read(pane);
      for (const action of ['open', 'main', 'side', 'close'])
        await assert.rejects(
          side.handle({
            paneId: pane.paneId,
            action,
            requestId: 'modal-' + action,
            binding: view.binding,
            revision: view.revision,
          }),
          { code: 'QUESTION_PENDING' },
        );
      const manager = new AgentQuestions({
        herdr: {
          readPane: async (_id, options) => {
            assert.equal(options.source, 'recent');
            assert(options.ansi);
            return capture.ansi;
          },
        },
        exactPane: async () => pane,
        requireProcess: true,
        readLines: async () => [],
      });
      const q = await manager.read(pane);
      assert.equal(q?.toolId, 'goal-confirmation');
      assert.equal(q.options.length, 2);
      await manager.verifyQuestionThread(pane, q, () => {
        throw Error('A foreground dialog must not require its parent composer');
      });
      assert(!projected.rows.flat().some((span) => /Ask Codex/.test(span.text)));
    } else await side.assertMain(pane);
  });

test('a real dim native placeholder accepts model-only footers; quoted plain text does not', () => {
  for (const prompt of ['›', '❯', '»'])
    for (const gap of ['\n', '\n\n']) {
      const raw = `${prompt} \x1b[2mAsk Codex to do anything\x1b[0m${gap}GPT-6.1-Sol max · weekly 95% left\n? for shortcuts`;
      assert.equal(codexInteraction(raw).capabilities.compose, true);
      assert.equal(codexInteraction(stripAnsi(raw)).thread, 'unknown');
      const side = raw.replace('Ask Codex to do anything', 'Ask a follow-up question');
      assert.equal(codexInteraction(side).thread, 'side');
      assert.equal(codexInteraction(side).capabilities.compose, false);
    }
});

test('unknown native frames explain missing evidence without exposing content or granting input authority', () => {
  const raw = '› \x1b[2mAsk Codex to do anything\x1b[0m\n\n/private/project';
  const state = codexInteraction(raw);
  assert.equal(state.inputTarget, 'unknown');
  assert.equal(state.capabilities.compose, false);
  assert.equal(state.evidence.composerVisible, true);
  assert.equal(state.evidence.placeholder, 'main');
  assert.equal(state.evidence.modelVisible, false);
  assert(state.evidence.footerRows > 0);
  assert(!JSON.stringify(state.evidence).includes('/private'));
  const empty = codexInteraction('');
  assert.equal(empty.evidence.composerVisible, false);
  assert.equal(empty.capabilities.compose, false);
  const projected = projectTerminalScreen(raw.split('\n').map(parseAnsiLine));
  assert.deepEqual(projected.interaction.evidence, state.evidence);
});

test('native forms and configuration lists are recognized without pretending their keys are numbered answers', () => {
  const cases = [
    [
      'Configure Status Line',
      '› [x] model',
      'space toggle · ←/→ reorder · enter save · esc cancel',
      'configuration',
    ],
    [
      'Enable/Disable Skills',
      '› [x] Repo Scout',
      'space/enter toggle · esc close',
      'configuration',
    ],
    [
      'Experimental features',
      'No experimental features available for now',
      'space toggle · enter save · esc save/close',
      'configuration',
    ],
    [
      'Waiting for verification…',
      'Server: fixture-server',
      'Press esc to cancel this request',
      'authentication',
    ],
    [
      'Tell us more (bug)',
      '(optional) Write a short description',
      'Press enter to submit or esc to cancel',
      'form',
    ],
  ];
  for (const [title, body, hint, kind] of cases) {
    const raw = `\x1b[1m${title}\x1b[0m\n\n${body}\n\n${hint}`;
    const state = codexInteraction(raw);
    assert.equal(state.modal?.kind, kind, title);
    assert.equal(state.capabilities.compose, false);
    assert.equal(state.capabilities.select, false);
    assert.equal(state.inputTarget, kind === 'authentication' ? 'authentication' : 'form');
    assert(projectTerminalScreen(raw.split('\n').map(parseAnsiLine)).recognized);
  }
});

test('native approvals retain the command context and model settings use the session key', async () => {
  const inspect = (rawScreen) =>
    codex.inspect({
      pane,
      rawScreen,
      screen: stripAnsi(rawScreen),
      lines: [],
      state: { goalPrompts: new Map() },
    });
  const approval =
    '\x1b[1mWould you like to run the following command?\x1b[0m\n\n$ echo fixture-only\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel';
  const q = inspect(approval);
  assert.equal(q.toolId, 'native-selection');
  assert(q.question.includes('$ echo fixture-only'));
  const model =
    '\x1b[1mSelect Reasoning Effort\x1b[0m\n\n› 1. High\n  2. Max\n\nenter default · s session · esc back';
  const setting = inspect(model);
  assert.equal(setting.confirmKey, 's');
  const writes = [];
  await codex.answer({
    prompt: setting,
    payload: { choices: [0] },
    io: {
      reread: async (accept) => (accept(setting) ? setting : null),
      keys: async (keys) => writes.push(keys),
      until: async () => true,
    },
  });
  assert.deepEqual(writes, [['s']]);
  assert.equal(
    inspect(model.replace(' · s session', '')),
    null,
    'A default-setting menu must not become a session setting',
  );
});

test('changing a modal highlight preserves identity; closing and reopening invalidates it', async () => {
  const raw = captures.find((c) => c.state === '03-resume-goal').ansi;
  let screen = raw;
  const manager = new AgentQuestions({
    herdr: { readPane: async () => screen },
    exactPane: async () => pane,
    readLines: async () => [],
  });
  const first = await manager.read(pane);
  screen = raw
    .replace('› 1. Resume goal', '  1. Resume goal')
    .replace('  2. Leave paused', '› 2. Leave paused');
  assert.equal((await manager.read(pane)).challenge, first.challenge);
  screen = captures.find((c) => c.state === '01-main').ansi;
  await manager.read(pane);
  screen = raw;
  assert.notEqual((await manager.read(pane)).challenge, first.challenge);
});

test('a changed foreground or runtime is rejected before any confirmation key', async () => {
  const raw = captures.find((c) => c.state === '03-resume-goal').ansi;
  let current = pane,
    screen = raw;
  const writes = [];
  const manager = new AgentQuestions({
    herdr: { readPane: async () => screen },
    exactPane: async () => current,
    readLines: async () => [],
    keys: async (_id, keys) => writes.push(keys),
    requireProcess: true,
  });
  const q = await manager.read(pane);
  current = { ...pane, runtimeId: '123:replacement' };
  await assert.rejects(
    manager.answer({ ...q, choices: [1], requestId: 'replaced' }),
    /问题已变化|会话已改变/,
  );
  current = pane;
  screen = raw.replace('Verify fixture popup lifecycle', 'Changed native objective');
  await assert.rejects(manager.answer({ ...q, choices: [1], requestId: 'changed' }), /问题已变化/);
  assert.deepEqual(writes, []);
});

test('foreground answers verify each navigation and submit once, preserving uncertain receipts', async () => {
  const prompt = {
    toolId: 'native-selection',
    selected: 0,
    options: [{ label: 'A' }, { label: 'B' }],
    allowText: false,
    nativeModal: { key: 'same' },
  };
  const writes = [];
  let selected = 0;
  const io = {
    keys: async (keys) => {
      writes.push(keys);
      if (keys[0] === 'down') selected++;
    },
    reread: async (accept) => {
      const q = { ...prompt, selected };
      return accept(q) ? q : null;
    },
    until: async () => true,
  };
  assert.equal(await codex.answer({ prompt, payload: { choices: [1] }, io }), 'sent');
  assert.deepEqual(writes, [['down'], ['enter']]);
  writes.length = 0;
  selected = 0;
  await assert.rejects(
    codex.answer({ prompt, payload: { choices: [1] }, io: { ...io, reread: async () => null } }),
    /界面已变化/,
  );
  assert.deepEqual(writes, [['down']]);
  assert.equal(
    await codex.answer({
      prompt,
      payload: { choices: [0] },
      io: { ...io, reread: async () => prompt, until: async () => false },
    }),
    'uncertain',
  );
});

function startupFixture() {
  let current = { ...pane, agent: { ...pane.agent, session: null } };
  let screen =
    '\x1b[1mSelect startup option\x1b[0m\n\n› 1. Continue\n  2. Leave paused\n  3. Go back\n\nenter select · esc back';
  const writes = [],
    archived = [];
  const manager = new AgentQuestions({
    herdr: { readPane: async () => screen },
    exactPane: async () => current,
    requireProcess: true,
    readLines: async () => {
      archived.push(current.agent.session?.value || '');
      return [];
    },
    keys: async (_id, keys) => {
      writes.push(keys);
      if (keys[0] === 'down') screen = screen.replace('› 1.', '  1.').replace('  2.', '› 2.');
      if (keys[0] === 'enter') {
        current = {
          ...current,
          agent: { ...current.agent, session: { value: 'created-session' } },
        };
        screen = captures.find((c) => c.state === '01-main').ansi;
      }
    },
  });
  manager.beforeAnswer = (target, prompt) =>
    manager.verifyQuestionThread(target, prompt, () => {
      throw Error('No main composer required for a startup menu');
    });
  return {
    manager,
    writes,
    archived,
    pane: () => current,
    setPane: (value) => {
      current = value;
    },
    setScreen: (value) => {
      screen = value;
    },
  };
}
test('a native startup menu operates before session identity exists and session creation only confirms the result', async () => {
  const f = startupFixture(),
    q = await f.manager.read(f.pane());
  assert(q.preSession);
  assert.equal(q.sessionId, '');
  assert.equal(q.canWrite, true);
  assert.deepEqual(f.archived, []);
  const body = { ...q, requestId: 'startup-once', choices: [1] };
  assert.equal((await f.manager.answer(body)).delivery, 'sent');
  assert.equal((await f.manager.answer(body)).repeated, true);
  assert.deepEqual(f.writes, [['down'], ['enter']]);
  assert(
    f.archived.every((value) => value === 'created-session'),
    'No archive is read before native session creation',
  );
});
test('startup controls require a complete current modal, process and terminal; plain composers grant no startup answer', async () => {
  for (const change of [{ runtimeId: '' }, { terminalId: '' }]) {
    const f = startupFixture();
    f.setPane({ ...f.pane(), ...change });
    assert.equal(await f.manager.read(f.pane()), null);
  }
  const f = startupFixture();
  f.setScreen(captures.find((c) => c.state === '01-main').ansi);
  assert.equal(await f.manager.read(f.pane()), null);
  assert.deepEqual(f.writes, []);
});
test('a changed startup process, session or foreground cannot be bypassed with a supplied preSession flag', async () => {
  for (const field of ['runtime', 'session', 'foreground']) {
    const f = startupFixture(),
      q = await f.manager.read(f.pane());
    if (field === 'runtime') f.setPane({ ...f.pane(), runtimeId: 'replacement:789' });
    if (field === 'session')
      f.setPane({
        ...f.pane(),
        agent: { ...f.pane().agent, session: { value: 'different-session' } },
      });
    if (field === 'foreground') f.setScreen(captures.find((c) => c.state === '01-main').ansi);
    await assert.rejects(
      f.manager.answer({ ...q, preSession: true, choices: [0], requestId: 'changed-' + field }),
      /会话已改变|问题已变化/,
    );
    assert.deepEqual(f.writes, []);
  }
});
