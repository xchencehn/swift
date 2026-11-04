'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { CodexSide, sideScreen } = require('../lib/codex-side');
const Conversation = require('../lib/conversation-state');
const main =
  '• Main answer\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  GPT-6.1-Sol high · ~/project';
const side =
  '• Side answer\n\n› \x1b[2mAsk a follow-up question\x1b[0m\n\n  GPT-6.1-Sol high · ~/project · Agent   Side from main thread · ^/ to switch · ^c to close';
const parked = main + ' · Main [high]    ^/ for side';
test('side footer is recognized in idle, parked and occupied native screens', () => {
  assert.equal(sideScreen(main).mode, 'main');
  assert.equal(sideScreen(main).hasSide, false);
  assert.equal(sideScreen(side).mode, 'side');
  assert.equal(sideScreen(side).canClose, true);
  assert.equal(sideScreen(parked).hasSide, true);
  assert.equal(
    sideScreen(side.replace('Ask a follow-up question', 'unsent draft').replaceAll('\x1b[2m', ''))
      .canClose,
    false,
  );
  assert.equal(
    sideScreen('Quote: Side from main thread · ^/ to switch · ^c to close\n\n' + main).mode,
    'main',
  );
  assert.equal(sideScreen('unrecognized modal').mode, 'unknown');
  assert.equal(sideScreen(side.replace('^/ to switch · ^c to close', '^/ to swi')).mode, 'side');
});
test('Codex prompt variants retain main, parked and side identity at high and ultra effort', () => {
  for (const prompt of ['›', '❯', '»'])
    for (const effort of ['high', 'ultra']) {
      const footer = `  GPT-6.1-Sol ${effort} · ~/workdir/swift · swift · main · Ready · Context 72% used · weekly 60% left`;
      const idle = `• Main answer\n\n${prompt} \x1b[2mAsk Codex to do anything\x1b[0m\n\n${footer}\n  ? for shortcuts`;
      const label = `${prompt} / ${effort}`;
      assert.equal(sideScreen(idle).mode, 'main', label);
      assert.equal(sideScreen(idle).hasSide, false, label);
      assert.equal(sideScreen(idle).inputOccupied, false, label);
      assert.equal(sideScreen(idle.replace('Ready', 'Working')).mode, 'main', label);
      const occupied = idle.replace('\x1b[2mAsk Codex to do anything\x1b[0m', '继续检查当前会话');
      assert.equal(sideScreen(occupied).mode, 'main', label);
      assert.equal(sideScreen(occupied).inputOccupied, true, label);
      const parkedNative = idle.replace(
        footer,
        `  GPT-6.1-Sol ${effort} · ~ · Main [${effort}]    ^/ for side`,
      );
      assert.equal(sideScreen(parkedNative).mode, 'main', label);
      assert.equal(sideScreen(parkedNative).hasSide, true, label);
      const sideNative = `• Side answer\n  Worked for 2s\n\n${prompt} \x1b[2mAsk a follow-up question\x1b[0m\n\n  GPT-6.1-Sol ${effort} · ~ · Agent  Side from main thread · ^/ to switch · ^c to close`;
      assert.equal(sideScreen(sideNative).mode, 'side', label);
      assert.equal(sideScreen(sideNative).canClose, true, label);
      const narrow = sideNative.replace(
        /  GPT-6\.1-Sol[^\n]+$/,
        '  Side from main thread · ^/ to swi',
      );
      assert.equal(sideScreen(narrow).mode, 'side', label);
      assert.equal(sideScreen(narrow).canClose, true, label);
      const tall =
        Array.from({ length: 160 }, (_, index) => `Earlier answer ${index}`).join('\n') +
        '\n' +
        idle;
      assert.equal(sideScreen(tall).mode, 'main', label);
    }
});
test('custom Codex status fields do not require model, account and directory to be adjacent or ordered', () => {
  const screen = (footer) =>
    `• Main answer\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  ${footer}\n  ? for shortcuts`;
  for (const account of ['wwh', 'work-account', '中文账号', 'arbitrary-label']) {
    for (const fields of [
      ['GPT-6.1-Sol max', account, '~/workdir/swift', 'swift', 'main', 'Ready'],
      [account, 'GPT-6.1-Sol max', '~/workdir/swift', 'Ready'],
      ['~/workdir/swift', account, 'GPT-6.1-Sol max', 'Ready'],
      ['Ready', 'swift', account, '~/workdir/swift', 'GPT-6.1-Sol max'],
      ['Context 72% used', account, 'GPT-6.1-Sol max', '~/workdir/swift', 'Working'],
      ['C:\\work\\swift', account, 'Ready', 'GPT-6.1-Sol max'],
      ['GPT-6.1-Sol max', account, '~/workdir/swift'],
    ]) {
      const raw = screen(fields.join(' · '));
      assert.equal(sideScreen(raw).mode, 'main', fields.join(' · '));
      assert.equal(sideScreen(raw).hasSide, false);
      const temporary = raw.replace(
        '\n  ? for shortcuts',
        '\n  Side from main thread · ^/ to switch · ^c to close',
      );
      assert.equal(sideScreen(temporary).mode, 'side', fields.join(' · '));
    }
  }
});
test('native directory fields retain their meaning beside the independently aligned warning', () => {
  for (const warning of ['⚠ 1 warning · f2 to view', '⚠ 1 · f2']) {
    for (const fields of [
      `GPT-6.1-Sol ultra · ~                  ${warning}`,
      `~                  ${warning} · GPT-6.1-Sol ultra`,
      `wwh · GPT-6.1-Sol max · ~                  ${warning}`,
    ])
      assert.equal(
        sideScreen(`» \x1b[2mAsk Codex to do anything\x1b[0m\n\n  ${fields}`).mode,
        'main',
        fields,
      );
  }
});
test('a right-aligned Goal state does not hide the model or authorize an incomplete main footer', () => {
  for (const footer of [
    'GPT-6-Astra ultra · wwh · ~/workdir/cannbench · task           Pursuing goal (44s)',
    '~/workdir/cannbench · wwh · GPT-6-Astra ultra           Pursuing goal (44s)',
    'wwh · ~/workdir/cannbench\n  GPT-6-Astra ultra           Pursuing goal (44s)',
  ]) {
    const raw = `» \x1b[2mAsk Codex to do anything\x1b[0m\n\n  ${footer}\n  ? for shortcuts`;
    assert.equal(sideScreen(raw).mode, 'main', footer);
    assert.equal(sideScreen(raw).inputOccupied, false);
    assert.equal(
      sideScreen(raw + '\n  Side from main thread · ^/ to switch · ^c to close').mode,
      'side',
    );
  }
  for (const footer of [
    'Pursuing goal (44s)',
    'wwh · Pursuing goal (44s)',
    '~/project · Pursuing goal (44s)',
  ])
    assert.equal(sideScreen(`» \n\n  ${footer}`).mode, 'unknown');
  assert.equal(
    sideScreen('› old\n\n  GPT-6-Astra ultra · ~/old\n\n» current\n\n  Pursuing goal (44s)').mode,
    'unknown',
  );
});
test('shortcuts, running status and modal hints cannot independently prove a native main conversation', () => {
  for (const raw of [
    '› \n\n  wwh · Ready\n  ? for shortcuts',
    '› \n\n  wwh · Working\n  ? for shortcuts',
    '› \n\n  GPT-6.1-Sol max · wwh · Ready\n  ? for shortcuts',
    '› draft\n\n  wwh · main\n  ? for shortcuts',
    '› draft\n\n  wwh · Ready',
    'wwh · Ready\n  ? for shortcuts\n\n› current draft',
    '› draft\n\n  Documentation says Ready · this is an example\n  ? for shortcuts',
    '› draft\n\n  ? for shortcuts',
    '› draft\n\n  esc to clear\n  ? for shortcuts',
    '› history search\n\n  ctrl+r to search history\n  ? for shortcuts',
    '› \n\n  Press Ctrl-C again to quit\n  ? for shortcuts',
  ])
    assert.equal(sideScreen(raw).mode, 'unknown', raw);
});
test('only the current footer determines identity despite quoted side labels and slash suggestions', () => {
  const ultra = main.replace('›', '»').replace('high', 'ultra');
  const quoted =
    'Side from another thread · ^/ to switch · ^c to close\n  GPT-6.1-Sol ultra · ~/old · Ready\n\n';
  assert.equal(sideScreen(quoted + ultra).mode, 'main');
  assert.equal(sideScreen(quoted + ultra).hasSide, false);
  const draft = ultra.replace(
    '\x1b[2mAsk Codex to do anything\x1b[0m',
    'Side from another thread · ^/ to switch',
  );
  assert.equal(sideScreen(draft).mode, 'main');
  assert.equal(sideScreen(draft).hasSide, false);
  assert.equal(sideScreen(draft).inputOccupied, true);
  const suggestions = '› /model  choose a model\n\n' + ultra;
  assert.equal(sideScreen(suggestions).mode, 'main');
  assert.equal(sideScreen(suggestions).inputOccupied, false);
  for (const raw of [
    'GPT-6.1-Sol ultra · ~/old · Ready\n\n» current draft',
    'Side from another thread · ^/ to switch\n\n» current draft',
    '» current draft\n\nA quoted section · another section',
    quoted + Array.from({ length: 20 }, () => 'Modal content').join('\n'),
  ])
    assert.equal(sideScreen(raw).mode, 'unknown');
});
function fixture() {
  let raw = main;
  const pane = {
      paneId: 'p',
      terminalId: 't',
      runtimeId: '123:456',
      agent: { label: 'codex', session: { value: 'main' } },
    },
    writes = [];
  const controller = new CodexSide({
    herdr: { readPane: async () => raw },
    exactPane: async () => pane,
    settleMs: 0,
    paste: async (_id, text) => {
      writes.push(text);
      raw = main.replace('\x1b[2mAsk Codex to do anything\x1b[0m', text);
    },
    press: async (_id, keys) => {
      writes.push(keys);
      raw = keys[0] === 'enter' ? side : keys[0] === 'ctrl+c' ? main : raw === side ? parked : side;
    },
  });
  return {
    controller,
    pane,
    writes,
    set: (value) => {
      raw = value;
    },
    body: async (action) => ({ ...(await controller.read(pane)), requestId: action, action }),
  };
}
test('open, park, resume and close use one native input each and duplicate requests do not replay', async () => {
  const f = fixture();
  const opened = await f.body('open');
  assert.equal((await f.controller.handle(opened)).mode, 'side');
  await f.controller.handle(opened);
  assert.equal(f.writes.length, 2);
  assert.equal((await f.controller.handle(await f.body('main'))).mode, 'main');
  assert.equal((await f.controller.handle(await f.body('side'))).mode, 'side');
  const closed = await f.body('close');
  assert.equal((await f.controller.handle(closed)).hasSide, false);
  await f.controller.handle(closed);
  assert.equal(f.writes.filter((k) => k[0] === 'ctrl+c').length, 1);
});
test('external navigation, replacement process and changed request reject without input', async () => {
  const f = fixture();
  f.set(side);
  const body = await f.body('close');
  f.set(main);
  await assert.rejects(f.controller.handle(body), { code: 'SIDE_CHANGED' });
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.controller.handle({ ...body, action: 'main' }), {
    code: 'SIDE_REQUEST_CHANGED',
  });
  f.set(side);
  const next = { ...(await f.body('close')), requestId: 'replacement' };
  f.pane.runtimeId = '999:456';
  await assert.rejects(f.controller.handle(next), { code: 'SESSION_CHANGED' });
  assert.equal(f.writes.length, 0);
});
test('main input cannot enter a side thread and close cannot interrupt its work or clear a draft', async () => {
  const f = fixture();
  f.set(side);
  await assert.rejects(f.controller.assertMain(f.pane), { code: 'SIDE_ACTIVE' });
  f.set(side.replace('^c to close', '^c to interrupt'));
  await assert.rejects(f.controller.handle(await f.body('close')), { code: 'SIDE_NOT_CLOSABLE' });
  assert.equal(f.writes.length, 0);
  f.set('unrecognized modal');
  await assert.rejects(f.controller.assertMain(f.pane), { code: 'SIDE_UNKNOWN' });
});
test('a temporarily obscured footer recovers to Ultra main without replaying input or retaining unknown', async () => {
  const f = fixture();
  f.set('redrawing current native footer');
  assert.equal((await f.controller.read(f.pane)).mode, 'unknown');
  await assert.rejects(f.controller.assertMain(f.pane), { code: 'SIDE_UNKNOWN' });
  f.set(main.replace('›', '»').replace('high', 'ultra'));
  assert.equal((await f.controller.read(f.pane)).mode, 'main');
  await f.controller.assertMain(f.pane);
  f.set(side.replace('›', '»').replace('high', 'ultra'));
  await assert.rejects(f.controller.assertMain(f.pane), { code: 'SIDE_ACTIVE' });
  f.set('redrawing current native footer');
  await assert.rejects(f.controller.assertMain(f.pane), { code: 'SIDE_UNKNOWN' });
  f.set(main.replace('›', '»').replace('high', 'ultra'));
  await f.controller.assertMain(f.pane);
  assert.equal(f.writes.length, 0);
});
test('main input rechecks a transient unknown footer without sending native input', async () => {
  const pane = fixture().pane,
    ultra = main.replace('›', '»').replace('high', 'ultra');
  const screens = ['redrawing native footer', 'redrawing native footer', ultra];
  let reads = 0,
    checks = 0;
  const controller = new CodexSide({
    herdr: { readPane: async () => screens[Math.min(reads++, screens.length - 1)] },
    exactPane: async () => {
      checks++;
      return pane;
    },
    settleMs: 0,
    press: async () => assert.fail('Status recovery must never send native keys'),
    paste: async () => assert.fail('Status recovery must never paste native input'),
  });
  await controller.assertMain(pane);
  assert.equal(reads, 3);
  assert(checks >= 1);
});
test('a retry observes a side switch and rejects a replacement process without using an older main state', async () => {
  const pane = fixture().pane;
  let reads = 0;
  const controller = new CodexSide({
    herdr: { readPane: async () => (reads++ ? side.replace('›', '»') : 'redrawing native footer') },
    exactPane: async () => pane,
    settleMs: 0,
  });
  await assert.rejects(controller.assertMain(pane), { code: 'SIDE_ACTIVE' });
  reads = 0;
  const replaced = new CodexSide({
    herdr: { readPane: async () => (reads++ ? main : 'redrawing native footer') },
    exactPane: async () => ({ ...pane, runtimeId: 'replaced:456' }),
    settleMs: 0,
  });
  await assert.rejects(replaced.assertMain(pane), { code: 'SESSION_CHANGED' });
  assert.equal(reads, 1, 'A replacement process must be rejected before another native read');
});

const unknown = 'redrawing native footer';
const explicit = { requestId: 'explicit-retry', recoverUnknown: true };
function recoveryFixture({ recover, exact, read, raw = unknown } = {}) {
  const pane = {
    paneId: 'p',
    terminalId: 't',
    runtimeId: '123:456',
    agent: { label: 'codex', session: { value: 'main' } },
  };
  let current = pane;
  const calls = { recover: [], exact: [], read: [] };
  const state = {
    pane,
    calls,
    setRaw: (value) => {
      raw = value;
    },
    setPane: (value) => {
      current = value;
    },
  };
  state.controller = new CodexSide({
    settleMs: 0,
    herdr: {
      readPane: async (id, options) => {
        calls.read.push({ id, options });
        return read ? read(calls.read.length, state) : raw;
      },
    },
    exactPane: async (id) => {
      calls.exact.push(id);
      return exact ? exact(calls.exact.length, state) : current;
    },
    recoverUnknown: async (info) => {
      calls.recover.push(info);
      return recover ? recover(info, state) : undefined;
    },
    press: async () => assert.fail('CodexSide recovery integration must never write native keys'),
    paste: async () => assert.fail('CodexSide recovery integration must never paste native input'),
  });
  return state;
}

test('explicit recovery runs once after readonly retries and authorizes only a fresh exact main read', async () => {
  const f = recoveryFixture({
    recover: (info, state) => {
      assert.equal(state.calls.read.length, 4);
      assert.equal(state.calls.exact.length, 4);
      assert.deepEqual(info, {
        pane: state.pane,
        requestId: explicit.requestId,
        reason: 'prewrite-unknown',
      });
      state.setRaw(main);
      return { mode: 'unknown' };
    },
  });
  await f.controller.assertMain(f.pane, explicit);
  assert.equal(f.calls.recover.length, 1);
  assert.equal(f.calls.exact.length, 6);
  assert.equal(f.calls.read.length, 5);
  for (const { id, options } of f.calls.read) {
    assert.equal(id, f.pane.paneId);
    assert.deepEqual(options, { source: 'recent', lines: 40, ansi: true, exact: true });
  }
});

test('ordinary calls and absent, blank or non-string request ids never opt into recovery', async () => {
  for (const options of [
    undefined,
    {},
    { requestId: 'only-id' },
    { recoverUnknown: true },
    { recoverUnknown: true, requestId: '' },
    { recoverUnknown: true, requestId: '  \n' },
    { recoverUnknown: true, requestId: 42 },
    { recoverUnknown: 'true', requestId: 'id' },
    { recoverUnknown: 1, requestId: 'id' },
  ]) {
    const f = recoveryFixture();
    await assert.rejects(f.controller.assertMain(f.pane, options), { code: 'SIDE_UNKNOWN' });
    assert.equal(f.calls.recover.length, 0);
    assert.equal(f.calls.read.length, 4);
  }
  const f = recoveryFixture();
  delete f.controller.recoverUnknown;
  await assert.rejects(f.controller.assertMain(f.pane, explicit), { code: 'SIDE_UNKNOWN' });
  assert.equal(f.calls.read.length, 4);
});

test('poll reads, already-main frames and ordinary transient redraws never call recovery', async () => {
  const poll = recoveryFixture();
  for (let index = 0; index < 3; index++)
    assert.equal((await poll.controller.read(poll.pane)).mode, 'unknown');
  assert.equal(poll.calls.recover.length, 0);
  assert.equal(poll.calls.exact.length, 0);
  const ready = recoveryFixture({ raw: main });
  await ready.controller.assertMain(ready.pane, explicit);
  assert.equal(ready.calls.recover.length, 0);
  assert.equal(ready.calls.read.length, 1);
  const transient = recoveryFixture({ read: (count) => (count < 3 ? unknown : main) });
  await transient.controller.assertMain(transient.pane, explicit);
  assert.equal(transient.calls.recover.length, 0);
  assert.equal(transient.calls.read.length, 3);
});

test('side before or during readonly retries is rejected without attempting recovery', async () => {
  for (const read of [() => side, (count) => (count < 4 ? unknown : side)]) {
    const f = recoveryFixture({ read });
    await assert.rejects(f.controller.assertMain(f.pane, explicit), { code: 'SIDE_ACTIVE' });
    assert.equal(f.calls.recover.length, 0);
  }
});

function replacements(pane) {
  return [
    { ...pane, paneId: 'replaced' },
    { ...pane, terminalId: 'replaced' },
    { ...pane, runtimeId: 'replaced:456' },
    { ...pane, agent: { ...pane.agent, label: 'claude' } },
    { ...pane, agent: { ...pane.agent, session: { value: 'replaced' } } },
    null,
  ];
}

test('complete identity is rechecked immediately before recovery and after it returns', async () => {
  const initial = recoveryFixture().pane;
  for (const replacement of replacements(initial)) {
    const before = recoveryFixture({
      exact: (count, state) => (count < 4 ? state.pane : replacement),
    });
    await assert.rejects(before.controller.assertMain(before.pane, explicit), {
      code: 'SESSION_CHANGED',
    });
    assert.equal(before.calls.recover.length, 0);
    assert.equal(before.calls.read.length, 4);
    const after = recoveryFixture({
      recover: (_info, state) => {
        state.setPane(replacement);
        state.setRaw(main);
      },
    });
    await assert.rejects(after.controller.assertMain(after.pane, explicit), {
      code: 'SESSION_CHANGED',
    });
    assert.equal(after.calls.recover.length, 1);
    assert.equal(
      after.calls.read.length,
      4,
      'Do not read a replacement target as the original session',
    );
  }
});

test('recovery return value never substitutes for the real unknown or side screen', async () => {
  for (const raw of [unknown, side]) {
    const f = recoveryFixture({
      recover: (_info, state) => {
        state.setRaw(raw);
        return { mode: 'main' };
      },
    });
    await assert.rejects(f.controller.assertMain(f.pane, explicit), {
      code: raw === side ? 'SIDE_ACTIVE' : 'SIDE_UNKNOWN',
    });
    assert.equal(f.calls.recover.length, 1);
    assert.equal(f.calls.read.length, 5);
  }
});

test('all recovery exceptions fail closed even when the screen becomes main; SESSION_CHANGED is preserved', async () => {
  for (const value of [new Error('failed recovery'), undefined, null, false, 0, '']) {
    const f = recoveryFixture({
      recover: (_info, state) => {
        state.setRaw(main);
        throw value;
      },
    });
    await assert.rejects(f.controller.assertMain(f.pane, explicit), { code: 'SIDE_UNKNOWN' });
    assert.equal(f.calls.recover.length, 1);
  }
  const changed = Object.assign(new Error('identity changed within recovery'), {
    code: 'SESSION_CHANGED',
  });
  const f = recoveryFixture({
    recover: () => {
      throw changed;
    },
  });
  await assert.rejects(f.controller.assertMain(f.pane, explicit), (error) => error === changed);
  assert.equal(f.calls.recover.length, 1);
});

test('failed pre/post recovery target or read observations never authorize native input', async () => {
  for (const failingExactCount of [4, 5]) {
    const f = recoveryFixture({
      exact: (count, state) => {
        if (count === failingExactCount) throw null;
        return state.pane;
      },
    });
    await assert.rejects(f.controller.assertMain(f.pane, explicit), { code: 'SIDE_UNKNOWN' });
    assert.equal(f.calls.recover.length, failingExactCount === 4 ? 0 : 1);
  }
  const f = recoveryFixture({
    read: (count) => {
      if (count === 5) throw undefined;
      return unknown;
    },
  });
  await assert.rejects(f.controller.assertMain(f.pane, explicit), { code: 'SIDE_UNKNOWN' });
  assert.equal(f.calls.recover.length, 1);
  const identity = recoveryFixture({
    recover: (_info, state) => {
      state.setPane({ ...state.pane, terminalId: 'new-terminal' });
      throw new Error('recovery failed while target changed');
    },
  });
  await assert.rejects(identity.controller.assertMain(identity.pane, explicit), {
    code: 'SESSION_CHANGED',
  });
});

test('recovery receives the fresh equivalent pane object while retaining the original binding', async () => {
  let callbackPane;
  const f = recoveryFixture({
    exact: (_count, state) => ({ ...state.pane, title: 'fresh dashboard metadata' }),
    recover: (info, state) => {
      callbackPane = info.pane;
      state.setRaw(main);
    },
  });
  await f.controller.assertMain(f.pane, explicit);
  assert.notEqual(callbackPane, f.pane);
  assert.equal(callbackPane.title, 'fresh dashboard metadata');
  assert.equal(Conversation.binding(callbackPane), Conversation.binding(f.pane));
});

test('explicit recovery checks reject identity changes during the final or transient main read', async () => {
  const initial = recoveryFixture().pane;
  for (const replacement of replacements(initial)) {
    const f = recoveryFixture({
      recover: (_info, state) => {
        state.setRaw(main);
      },
      read: (count, state) => {
        if (count === 5) {
          state.setPane(replacement);
          return main;
        }
        return unknown;
      },
    });
    await assert.rejects(f.controller.assertMain(f.pane, explicit), { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.recover.length, 1);
    assert.equal(f.calls.read.length, 5);
  }
  for (const replacingRead of [2, 3]) {
    const f = recoveryFixture({
      read: (count, state) => {
        if (count === replacingRead) {
          state.setPane({ ...state.pane, terminalId: 'replaced-during-read' });
          return main;
        }
        return unknown;
      },
    });
    await assert.rejects(f.controller.assertMain(f.pane, explicit), { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.recover.length, 0);
    assert.equal(f.calls.read.length, replacingRead);
  }
});
test('structured side sends retain durable receipts across restart and never replay after an uncertain native result', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-side-receipts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pane = {
    paneId: 'p',
    terminalId: 't',
    runtimeId: 'fixture',
    agent: { label: 'codex', session: { value: 'main' } },
  };
  let count = 0,
    uncertain = false;
  const options = {
    herdr: { readPane: async () => side },
    exactPane: async () => pane,
    receiptFile: () => path.join(directory, 'receipts.json'),
    native: async (_pane, op) => {
      if (op === 'send') {
        count++;
        if (uncertain) throw new Error('lost reply');
        return { data: { submitted: true } };
      }
      return {
        mainId: 'main',
        sideId: 'side',
        activeId: 'side',
        data: { thread: { id: 'side', turns: [] } },
      };
    },
  };
  let controller = new CodexSide(options),
    view = await controller.read(pane);
  const body = {
    ...view,
    action: 'send',
    text: 'side text',
    sideId: 'side',
    requestId: 'confirmed',
  };
  assert.equal((await controller.handle(body)).submitted, true);
  assert.equal(count, 1);
  controller = new CodexSide(options);
  assert.equal((await controller.handle(body)).submitted, true);
  assert.equal(count, 1);
  view = await controller.read(pane);
  uncertain = true;
  const lost = {
    ...view,
    action: 'send',
    text: 'another side text',
    sideId: 'side',
    requestId: 'uncertain',
  };
  await assert.rejects(controller.handle(lost), /lost reply/);
  assert.equal(count, 2);
  controller = new CodexSide(options);
  await assert.rejects(controller.handle(lost), (error) => error.code === 'SIDE_INPUT_UNCONFIRMED');
  assert.equal(count, 2);
  assert(!fs.readFileSync(path.join(directory, 'receipts.json'), 'utf8').includes('side text'));
});
test('concurrent side submissions on different panes preserve both durable receipts', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-side-concurrent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const panes = ['a', 'b'].map((id) => ({
    paneId: id,
    terminalId: id,
    runtimeId: id,
    agent: { label: 'codex', session: { value: 'main-' + id } },
  }));
  let sends = 0;
  const release = [];
  const options = {
    herdr: { readPane: async () => side },
    exactPane: async (id) => panes.find((pane) => pane.paneId === id),
    receiptFile: () => path.join(directory, 'receipts.json'),
    native: async (pane, op) => {
      if (op === 'send') {
        sends++;
        await new Promise((resolve) => {
          release.push(resolve);
          if (release.length === 2) for (const done of release) done();
        });
        return { data: { submitted: true } };
      }
      return {
        mainId: 'main-' + pane.paneId,
        sideId: 'side-' + pane.paneId,
        activeId: 'side-' + pane.paneId,
        data: { thread: { id: 'side-' + pane.paneId, turns: [] } },
      };
    },
  };
  let controller = new CodexSide(options);
  const bodies = await Promise.all(
    panes.map(async (pane) => ({
      ...(await controller.read(pane)),
      action: 'send',
      text: 'private temporary text',
      requestId: 'concurrent-' + pane.paneId,
    })),
  );
  await Promise.all(bodies.map((body) => controller.handle(body)));
  assert.equal(sends, 2);
  const receipts = JSON.parse(fs.readFileSync(options.receiptFile(), 'utf8')).receipts;
  assert.equal(Object.keys(receipts).length, 2);
  assert(Object.values(receipts).every((receipt) => receipt.submitted));
  controller = new CodexSide(options);
  await Promise.all(bodies.map((body) => controller.handle(body)));
  assert.equal(sends, 2);
});
