'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { CommandInteraction, projection, nativeInput } = require('../lib/command-interaction');
const { CodexSide } = require('../lib/codex-side');
const { codexInteraction } = require('../lib/codex-footer');

function fixture() {
  const state = {
    input: '',
    result: '',
    writes: [],
    runtime: 'runtime',
    options: ['/status', '/ps'],
    selected: 0,
    executed: [],
    pane: {
      paneId: 'pane',
      terminalId: 'terminal',
      runtimeId: 'process',
      agent: { label: 'codex', session: { value: 'session' } },
    },
  };
  const raw = () =>
    '› Historical prompt\n\n• Working (2s • esc to interrupt)\n\n' +
    (state.input
      ? state.options
          .map(
            (option, index) =>
              `${index === state.selected ? '›' : ' '} ${option}      native command`,
          )
          .join('\n') + '\n\n'
      : '') +
    state.result +
    '\n» ' +
    (state.input || '\x1b[2mAsk Codex to do anything\x1b[0m') +
    '\n\ngpt-6-sol high · hh · weekly 84% left';
  const herdr = {
    dashboard: async () => ({ runtimeId: state.runtime }),
    readPane: async () => raw(),
  };
  const side = new CodexSide({ herdr, exactPane: async () => state.pane, settleMs: 0 });
  const contexts = [];
  const service = new CommandInteraction({
    herdr,
    exactPane: async () => state.pane,
    settleMs: 0,
    beforeWrite: async (pane, context) => {
      contexts.push(context);
      if (!context.continuingCommandInput) await side.assertMain(pane);
    },
    paste: async (_pane, text) => {
      state.writes.push({ text });
      state.input += text;
    },
    press: async (_pane, keys) => {
      state.writes.push({ keys });
      if (keys.includes('ctrl+u')) state.input = '';
      for (const key of keys) {
        if (key === 'down') state.selected++;
        if (key === 'up') state.selected--;
      }
      if (keys.includes('enter')) {
        const command = state.options[state.selected] || state.input;
        state.executed.push(command);
        state.input = '';
        state.result = command + '\nAccount: connected@example.test\n';
      }
    },
  });
  const body = {
    runtimeId: 'runtime',
    paneId: 'pane',
    terminalId: 'terminal',
    processRuntimeId: 'process',
    sessionId: 'session',
    clientId: 'client',
    requestId: 'execute',
    text: '/status',
  };
  return { state, raw, service, body, contexts };
}

test('real » composer stays separate from selected › slash candidates', () => {
  const f = fixture();
  f.state.input = '/status';
  const view = projection(f.raw(), { baseline: [], draft: '/status', command: '' });
  assert.equal(view.mode, 'query');
  assert.equal(view.input, '/status');
  assert.deepEqual(
    view.options.map((option) => option.label),
    ['/status', '/ps'],
  );
  assert.equal(view.options[0].selected, true);
  assert.equal(nativeInput(f.raw(), '/status'), '/status');
});

test('historical slash lines cannot become current options and narrow options need no description', () => {
  const history = ['History', '› /statusline      old example', ''];
  const lease = { baseline: history, draft: '/status', command: '' };
  const footer = '\n\ngpt-6-sol high · /fixture';
  const noMenu = projection(history.join('\n') + '\n» /status' + footer, lease);
  assert.deepEqual(noMenu.options, []);
  const narrow = projection(
    history.join('\n') + '\n› /status\n  /statusline\n\n» /status' + footer,
    lease,
  );
  assert.deepEqual(
    narrow.options.map((option) => option.label),
    ['/status', '/statusline'],
  );
  assert.equal(narrow.options[0].selected, true);
});

test('own command can submit after a narrow footer loses the empty composer hint', async () => {
  const f = fixture();
  assert.equal(codexInteraction(f.raw()).thread, 'main');
  const view = await f.service.execute(f.body);
  assert.equal(view.mode, 'result');
  assert.match(
    view.rows
      .flat()
      .map((span) => span.text)
      .join(''),
    /connected@example\.test/,
  );
  assert(f.contexts.some((context) => context.continuingCommandInput));
  assert.equal(f.state.writes.filter((write) => write.keys?.includes('enter')).length, 1);
  assert(!f.state.writes.some((write) => write.keys?.includes('esc')));
});

test('execute chooses the exact command rather than a selected longer prefix', async () => {
  const f = fixture();
  f.state.options = ['/statusline', '/status'];
  const view = await f.service.execute(f.body);
  assert.equal(view.mode, 'result');
  assert.deepEqual(f.state.executed, ['/status']);
  assert.equal(f.state.writes.filter((write) => write.keys?.includes('enter')).length, 1);
});

test('missing exact candidate clears only the unsubmitted owned command and does not replay it', async () => {
  const f = fixture();
  f.state.options = ['/statusline'];
  await assert.rejects(f.service.execute(f.body), { code: 'COMMAND_MENU_CHANGED' });
  assert.equal(f.state.input, '');
  assert.deepEqual(f.state.executed, []);
  const count = f.state.writes.length;
  await assert.rejects(f.service.execute(f.body), { code: 'COMMAND_MENU_CHANGED' });
  assert.equal(f.state.writes.length, count);
  const view = await f.service.handle({ ...f.body, action: 'read' });
  assert.equal(view.mode, 'idle');
  assert.equal(view.draftCleared, true);
  assert.equal(view.submissionStarted, false);
  assert(!f.state.writes.some((write) => write.keys?.includes('esc')));
});

test('a queued settings change does not prevent clearing the command rejected before Enter', async () => {
  const f = fixture(),
    check = f.service.beforeWrite;
  f.service.beforeWrite = async (pane, context) => {
    await check(pane, context);
    if (f.state.input && !context.clearingCommandInput)
      throw Object.assign(Error('settings queued'), { code: 'SETTINGS_BUSY' });
  };
  await assert.rejects(f.service.execute(f.body), { code: 'SETTINGS_BUSY' });
  assert.equal(f.state.input, '');
  assert.deepEqual(f.state.executed, []);
  assert.equal(f.state.writes.filter((write) => write.keys?.includes('ctrl+u')).length, 1);
});

test('an unreadable frame after Ctrl+U is not reported as a confirmed cleared draft', async () => {
  const f = fixture(),
    read = f.service.herdr.readPane,
    press = f.service.press;
  let clearing = false;
  f.state.options = ['/statusline'];
  f.service.press = async (pane, keys) => {
    await press(pane, keys);
    if (keys.includes('ctrl+u')) clearing = true;
  };
  f.service.herdr.readPane = async () => (clearing ? 'Unrecognized native redraw' : read());
  await assert.rejects(f.service.execute(f.body), { code: 'COMMAND_MENU_CHANGED' });
  const result = await f.service.handle({ ...f.body, action: 'read' });
  assert.equal(result.draftCleared, false);
  assert.equal(f.state.writes.filter((write) => write.keys?.includes('ctrl+u')).length, 1);
});

test('a definite Enter rejection can clear its draft, but an ambiguous Enter cannot', async () => {
  for (const certain of [true, false]) {
    const f = fixture(),
      press = f.service.press;
    f.service.press = async (pane, keys) => {
      if (!keys.includes('enter')) return press(pane, keys);
      throw Object.assign(Error('Enter failed'), certain ? { deliveryUncertain: false } : {});
    };
    await assert.rejects(f.service.execute(f.body), /Enter failed/);
    assert.equal(f.state.input, certain ? '' : '/status');
    assert.equal(
      f.state.writes.filter((write) => write.keys?.includes('ctrl+u')).length,
      certain ? 1 : 0,
    );
    const count = f.state.writes.length;
    await assert.rejects(f.service.execute(f.body), /Enter failed/);
    assert.equal(f.state.writes.length, count);
    const view = await f.service.handle({ ...f.body, action: 'read' });
    assert.equal(view.submissionStarted, !certain);
    if (!certain) assert(view.pending);
  }
});

test('failed execute never clears an external draft or a replacement process', async () => {
  for (const changed of ['draft', 'process']) {
    const f = fixture(),
      paste = f.service.paste;
    f.service.paste = async (...args) => {
      await paste(...args);
      if (changed === 'draft') f.state.input = 'External draft';
      else f.state.pane.runtimeId = 'replacement';
    };
    await assert.rejects(f.service.execute(f.body));
    assert.equal(f.state.input, changed === 'draft' ? 'External draft' : '/status');
    assert(!f.state.writes.some((write) => write.keys));
  }
});

test('external typing while the native prewrite check waits is never submitted or cleared', async () => {
  for (const when of ['before-paste', 'before-enter']) {
    const f = fixture(),
      check = f.service.beforeWrite;
    f.service.beforeWrite = async (pane, context) => {
      await check(pane, context);
      if (
        (when === 'before-paste' && !f.state.input) ||
        (when === 'before-enter' && context.continuingCommandInput)
      )
        f.state.input = 'External typing during prewrite';
    };
    await assert.rejects(f.service.execute(f.body));
    assert.equal(f.state.input, 'External typing during prewrite');
    assert.deepEqual(f.state.executed, []);
    assert(!f.state.writes.some((write) => write.keys));
    if (when === 'before-paste') assert.deepEqual(f.state.writes, []);
  }
});

test('a caller cannot forge continuation or cleanup authority', async () => {
  const f = fixture();
  f.state.input = 'External draft';
  await assert.rejects(
    f.service.execute({ ...f.body, continuingCommandInput: true, clearingCommandInput: true }),
  );
  assert.equal(f.contexts[0].continuingCommandInput, false);
  assert.equal(f.state.input, 'External draft');
  assert.deepEqual(f.state.writes, []);
});

test('a full execute cannot return an unsubmitted query as a successful result', async () => {
  const f = fixture();
  f.service.press = async (_pane, keys) => {
    if (keys.includes('enter')) f.state.input += ' x';
  };
  await assert.rejects(f.service.execute(f.body), { code: 'COMMAND_SUBMIT_UNCONFIRMED' });
});

test('Working output moving the candidates does not acknowledge or repeat a pending Enter', async () => {
  const f = fixture(),
    read = f.service.herdr.readPane;
  let prefix = '';
  f.service.herdr.readPane = async () => prefix + (await read());
  f.service.press = async (_pane, keys) => {
    f.state.writes.push({ keys });
    if (keys.includes('enter')) prefix = 'New Working output\n';
  };
  const first = await f.service.execute(f.body);
  assert.equal(first.pending, true);
  assert.equal(first.submissionStarted, true);
  prefix += 'More Working output\n';
  const pending = await f.service.handle({ ...f.body, action: 'read' });
  assert.equal(pending.pending, true);
  await f.service.execute(f.body);
  assert.equal(f.state.writes.filter((write) => write.keys?.includes('enter')).length, 1);
  f.state.input = '';
  f.state.result = '/status\nAccount: connected@example.test\n';
  const result = await f.service.handle({ ...f.body, action: 'read' });
  assert.equal(result.mode, 'result');
  assert(!result.pending);
});
