'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { CommandInteraction, projection, nativeInput } = require('../lib/command-interaction');
const idle =
  'History stays here\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  fixture high · Ready · Context 1%';
test('multiline Goal acknowledgement uses only the current composer above its footer', () => {
  const command = '/goal 新的开发目标\n核对真实状态。';
  const raw =
    'Old tool output\n\n› /goal 新的开发目标\n  核对真实状态。\n\n  GPT-6.1-Sol default · ~/fixture\n  ? for shortcuts';
  assert.equal(nativeInput(raw, command), command);
  assert.notEqual(nativeInput(raw, '/goal 不同的目标\n核对真实状态。'), command);
  assert.notEqual(
    nativeInput(
      '› /goal 新的开发目标\n\n  GPT-6.1-Sol default · ~/fixture\n  核对真实状态。',
      command,
    ),
    command,
  );
});
test('Goal confirmation uses native panel boundaries and separates labels from descriptions', () => {
  const raw =
    'Unrelated tool output\n  \x1b[1mReplace goal?\x1b[0m\n  New objective: Revised\n\n\x1b[1m› 1. Replace current goal  \x1b[0mSet the new objective and start it now\n  2. Cancel                Keep the current goal\n\n  enter select · esc back';
  const view = projection(raw, { baseline: [], draft: '', command: '/goal Revised' });
  assert.equal(view.mode, 'menu');
  assert.deepEqual(
    view.options.map((option) => option.label),
    ['Replace current goal', 'Cancel'],
  );
  assert(!view.rows.some((row) => row.some((span) => span.text.includes('Unrelated'))));
});
function fixture() {
  const state = {
    input: '',
    menu: false,
    selected: 0,
    status: false,
    writes: [],
    runtime: 'runtime',
    pane: {
      paneId: 'pane',
      terminalId: 'term',
      agent: { label: 'codex', status: 'working', session: { value: 'session' } },
    },
  };
  function screen() {
    if (state.menu)
      return (
        'History stays here\n\n  Select Model and Effort\n\n' +
        (state.selected === 0 ? '›' : ' ') +
        ' 1. Model A\n' +
        (state.selected === 1 ? '›' : ' ') +
        ' 2. Model B\n\n  enter select · esc back'
      );
    if (state.input)
      return (
        'History stays here\n\n' +
        ['status', 'model', 'new']
          .filter((name) => name.startsWith(state.input.slice(1)))
          .map((name, i) => (i ? ' ' : '›') + ' /' + name + '      native command')
          .join('\n') +
        '\n\n› ' +
        state.input +
        '\n\n  fixture high · Ready · Context 1%'
      );
    if (state.status)
      return 'History stays here\n\n/status\n  Model: fixture\n  Session: session\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  fixture high · Ready · Context 1%';
    return idle;
  }
  const service = new CommandInteraction({
    herdr: {
      dashboard: async () => ({ runtimeId: state.runtime }),
      readPane: async () => screen(),
    },
    exactPane: async () => state.pane,
    settleMs: 0,
    press: async (id, keys) => {
      state.writes.push({ id, keys });
      for (const key of keys) {
        if (key === 'ctrl+u') state.input = '';
        if (key === 'down') state.selected = 1;
        if (key === 'up') state.selected = 0;
        if (key === 'esc') {
          state.menu = false;
          state.input = '';
        }
        if (key === 'enter') {
          if (state.menu) state.menu = false;
          else if (state.input === '/model') {
            state.menu = true;
            state.input = '';
          } else {
            state.status = true;
            state.input = '';
          }
        }
      }
    },
    paste: async (id, text) => {
      state.writes.push({ id, text });
      state.input += text;
    },
  });
  let serial = 0;
  const base = {
    paneId: 'pane',
    terminalId: 'term',
    sessionId: 'session',
    runtimeId: 'runtime',
    clientId: 'client',
  };
  const call = (action, extra = {}) =>
    service.handle({ ...base, action, requestId: 'request-' + ++serial, ...extra });
  return { state, service, call, base };
}
test('native slash edits and status execute through control input, even while working', async () => {
  const { state, call } = fixture();
  let view = await call('edit', { text: '/sta' });
  assert.equal(view.mode, 'query');
  assert.equal(view.input, '/sta');
  assert.equal(view.options[0].label, '/status');
  view = await call('edit', { text: '/status', leaseId: view.leaseId });
  assert(state.writes.some((row) => row.keys?.[0] === 'ctrl+u'));
  view = await call('key', { key: 'enter', leaseId: view.leaseId, revision: view.revision });
  assert.equal(view.mode, 'result');
  assert.match(
    view.rows
      .flat()
      .map((s) => s.text)
      .join('\n'),
    /Model: fixture/,
  );
  assert(!view.rows.flat().some((s) => s.text.includes('History stays here')));
  assert(state.writes.every((row) => row.id === 'pane'));
});
test('native command errors remain distinguishable from completed results', () => {
  const lease = { baseline: ['History', ''], command: '/goal resume', draft: '' };
  const failed = projection(
    'History\n\n\x1b[31m■ Failed to update thread goal: thread/goal/set failed in TUI\x1b[0m\n\n› \n\n model high · Ready',
    lease,
  );
  assert.equal(failed.mode, 'result');
  assert.equal(failed.failed, true);
  const completed = projection('History\n\n• Goal cleared\n\n› \n\n model high · Ready', lease);
  assert.equal(completed.mode, 'result');
  assert(!completed.failed);
  const content = projection(
    'History\n\n• Goal set: explain the failed test\n\n› \n\n model high · Ready',
    lease,
  );
  assert(!content.failed, 'Words in command arguments are not native error markers');
});
test('an empty native frame waits for the asynchronous command result without a second Enter', async () => {
  const { service, base, state, call } = fixture();
  let time = 0,
    failed = false;
  service.now = () => time;
  const read = service.herdr.readPane;
  service.herdr.readPane = async () =>
    failed
      ? 'History stays here\n\n\x1b[31m■ Failed to update thread goal\x1b[0m\n\n› \n\n fixture high · Ready'
      : read();
  const press = service.press;
  service.press = async (...args) => {
    await press(...args);
    if (args[1].includes('enter')) state.status = false;
  };
  const body = { ...base, text: '/goal resume', requestId: 'delayed-result' };
  let view = await service.execute(body);
  assert(view.pending);
  assert.equal(
    view.mode,
    'menu',
    'Previous clients must keep polling the existing pending menu state',
  );
  const writes = state.writes.length;
  await service.execute(body);
  assert.equal(state.writes.length, writes);
  await assert.rejects(
    call('key', { key: 'enter', leaseId: view.leaseId, revision: view.revision }),
    { code: 'COMMAND_ACTION_PENDING' },
  );
  time = 200;
  failed = true;
  view = await call('read', { leaseId: view.leaseId });
  assert.equal(view.failed, true);
  assert(!view.pending);
  assert.equal(state.writes.length, writes);
});
test('a native command with no output finishes after a bounded wait and can be closed immediately', async () => {
  const { service, base, state, call } = fixture();
  let time = 0;
  service.now = () => time;
  const press = service.press;
  service.press = async (...args) => {
    await press(...args);
    if (args[1].includes('enter')) state.status = false;
  };
  let view = await service.execute({ ...base, text: '/stop', requestId: 'empty-result' });
  assert(view.pending);
  time = 2000;
  view = await call('read', { leaseId: view.leaseId });
  assert.equal(view.mode, 'idle');
  assert(!view.pending);
  view = await service.execute({ ...base, text: '/stop', requestId: 'close-pending' });
  assert(view.pending);
  view = await call('close', { leaseId: view.leaseId });
  assert.equal(view.mode, 'idle');
  assert(!view.pending);
  assert.equal(state.writes.filter((w) => w.keys?.includes('enter')).length, 2);
  assert(!state.writes.some((w) => w.keys?.includes('esc')));
});
test('native selectors use live options and return through Escape', async () => {
  const { state, call } = fixture();
  let view = await call('edit', { text: '/model' });
  view = await call('key', { key: 'enter', leaseId: view.leaseId, revision: view.revision });
  assert.equal(view.mode, 'menu');
  assert.equal(view.options.length, 2);
  view = await call('key', { key: 'down', leaseId: view.leaseId, revision: view.revision });
  assert.equal(view.options[1].selected, true);
  view = await call('close', { leaseId: view.leaseId });
  assert.equal(view.mode, 'idle');
  assert.equal(state.menu, false);
});
test('runtime, session, competing clients and changed native input reject before writes', async () => {
  const { state, call, service, base } = fixture();
  let view = await call('edit', { text: '/status' });
  const before = state.writes.length;
  await assert.rejects(call('key', { key: 'enter', leaseId: view.leaseId, revision: 'old' }), {
    code: 'COMMAND_MENU_CHANGED',
  });
  await assert.rejects(
    service.handle({ ...base, clientId: 'another', action: 'edit', text: '/', requestId: 'other' }),
    { code: 'COMMAND_IN_USE' },
  );
  state.input = '/model';
  await assert.rejects(call('edit', { text: '/status', leaseId: view.leaseId }), {
    code: 'NATIVE_INPUT_CHANGED',
  });
  state.runtime = 'changed';
  await assert.rejects(
    call('key', { key: 'enter', leaseId: view.leaseId, revision: view.revision }),
    { code: 'RUNTIME_CHANGED' },
  );
  state.runtime = 'runtime';
  state.pane.terminalId = 'replacement';
  await assert.rejects(call('edit', { text: '/status' }), { code: 'SESSION_CHANGED' });
  assert.equal(state.writes.length, before);
});
test('a submitted first Goal may acquire its initial session only on the same process', async () => {
  const { state, service, base } = fixture();
  state.pane.runtimeId = 'process';
  const lease = {
    active: false,
    clientId: base.clientId,
    processRuntimeId: 'process',
    submissionStarted: true,
    command: '/goal First objective',
  };
  service.leases.set('runtime:term:', lease);
  const body = { ...base, sessionId: '', processRuntimeId: 'process' };
  assert((await service.target(body, true)).commandSessionChanged);
  await assert.rejects(service.target(body), { code: 'SESSION_CHANGED' });
  lease.submissionStarted = false;
  await assert.rejects(service.target(body, true), { code: 'SESSION_CHANGED' });
  lease.submissionStarted = true;
  state.pane.runtimeId = 'other';
  await assert.rejects(service.target(body, true), { code: 'SESSION_CHANGED' });
});
test('repeated key request is acknowledged once and query close never sends Escape to a working agent', async () => {
  const { state, call } = fixture();
  let view = await call('edit', { text: '/status' });
  const request = {
    key: 'enter',
    leaseId: view.leaseId,
    revision: view.revision,
    requestId: 'same-key',
  };
  const result = await call('key', request);
  const count = state.writes.length;
  assert.deepEqual(await call('key', request), result);
  assert.equal(state.writes.length, count);
  view = await call('edit', { text: '/status' });
  await call('close', { leaseId: view.leaseId });
  assert.equal(state.input, '');
  assert(!state.writes.some((row) => row.keys?.includes('esc')));
});
test('explicit commands clear occupied composer but reject control characters', async () => {
  const { state, call } = fixture();
  state.input = 'native draft';
  await call('edit', { text: '/status' });
  assert.equal(state.input, '/status');
  assert.deepEqual(state.writes[0].keys, ['ctrl+e', 'ctrl+u', 'ctrl+k']);
  state.writes.length = 0;
  state.input = '';
  await assert.rejects(call('edit', { text: '/status\nhello' }), { code: 'COMMAND_EXPIRED' });
  assert.equal(state.writes.length, 0);
});
test('a slash with no matching native candidate still remains editable', () => {
  const view = projection('History\n\n› /missing\n\n model high · Ready · Context 1%', {
    baseline: ['History', ''],
    command: '',
  });
  assert.equal(view.mode, 'query');
  assert.equal(view.options.length, 0);
  assert.equal(view.input, '/missing');
});

test('native ANSI rows with CRLF expose real slash candidates', () => {
  const raw =
    'History\r\n\r\n› /model         choose model\r\n  /status        inspect session\r\n\r\n› /\r\n';
  const view = projection(raw, { baseline: ['History', ''], draft: '/', command: '' });
  assert.equal(view.mode, 'query');
  assert.deepEqual(
    view.options.map((item) => item.label),
    ['/model', '/status'],
  );
});

test('closing a rejected start is harmless and a lost first response can be cancelled by its client', async () => {
  const { call, state } = fixture();
  let view = await call('close');
  assert.equal(view.mode, 'idle');
  assert.equal(state.writes.length, 0);
  await call('edit', { text: '/status' });
  view = await call('close');
  assert.equal(view.mode, 'idle');
  assert.equal(state.input, '');
});

test('new session commands close their old interaction only when the same Codex process remains', async () => {
  const { call, state, service } = fixture();
  state.pane.runtimeId = 'codex-process';
  let view = await call('edit', { text: '/new' });
  service.press = async () => {
    state.pane.agent.session.value = 'new-session';
    state.input = '';
  };
  view = await call('key', { key: 'enter', leaseId: view.leaseId, revision: view.revision });
  assert(view.sessionChanged);
  assert.equal(view.mode, 'idle');
});
test('ending a command after external typing preserves the external draft', async () => {
  const { call, state } = fixture();
  await call('edit', { text: '/status' });
  state.input = 'external native draft';
  const count = state.writes.length;
  const view = await call('close');
  assert.equal(view.mode, 'idle');
  assert.equal(state.input, 'external native draft');
  assert.equal(state.writes.length, count);
});

test('an accepted Enter awaiting a new native frame cannot be repeated', async () => {
  const { call, state, service } = fixture();
  let view = await call('edit', { text: '/status' });
  service.press = async (id, keys) => state.writes.push({ id, keys });
  view = await call('key', { key: 'enter', leaseId: view.leaseId, revision: view.revision });
  assert(view.pending);
  const count = state.writes.length;
  await assert.rejects(
    call('key', { key: 'enter', leaseId: view.leaseId, revision: view.revision }),
    { code: 'COMMAND_ACTION_PENDING' },
  );
  assert.equal(state.writes.length, count);
  state.input = '';
  state.status = true;
  view = await call('read', { leaseId: view.leaseId });
  assert.equal(view.mode, 'result');
  assert(!view.pending);
});

test('wrapped command arguments are confirmed without dropping spaces or accepting changed text', () => {
  const { nativeInput } = require('../lib/command-interaction');
  const raw =
    'History\n\n› /goal design details design\n  details design details\n\n fixture high · Ready · Context 1%';
  assert.equal(
    nativeInput(raw, '/goal design details design details design details'),
    '/goal design details design details design details',
  );
  assert.notEqual(
    nativeInput(raw, '/goal design details changed details design details'),
    '/goal design details changed details design details',
  );
});

test('command projection excludes prior history when the bounded native window advances', () => {
  const raw =
    'history 2\nhistory 3\nhistory 4\n\n Select Model and Effort\n\n› 1. Model A\n  2. Model B\n\n enter select · esc back';
  const view = projection(raw, {
    baseline: ['history 1', 'history 2', 'history 3', 'history 4', ''],
    draft: '',
    command: '/model',
  });
  assert.equal(view.mode, 'menu');
  assert(!view.rows.flat().some((span) => span.text.includes('history')));
});

test('one execute operation edits and confirms once, including an HTTP retry', async () => {
  const { service, base, state } = fixture();
  const body = { ...base, text: '/status', action: 'execute', requestId: 'execute-once' };
  const view = await service.execute(body);
  assert.equal(view.mode, 'result');
  assert.equal(state.writes.filter((row) => row.keys?.includes('enter')).length, 1);
  await service.execute(body);
  assert.equal(state.writes.filter((row) => row.keys?.includes('enter')).length, 1);
});
test('clicking a native selector batches movement and confirms the actual row before Enter', async () => {
  const { call, state } = fixture();
  let view = await call('edit', { text: '/model' });
  view = await call('key', { key: 'enter', leaseId: view.leaseId, revision: view.revision });
  await call('pick', { option: 'Model B', leaseId: view.leaseId, revision: view.revision });
  assert.equal(state.selected, 1);
  assert(state.writes.some((row) => row.keys?.[0] === 'down'));
});

test('execute holds one operation lock across native editing and Enter', async () => {
  const { service, base, state } = fixture();
  let inside = false,
    locks = 0;
  service.operate = async (_id, run) => {
    assert.equal(inside, false);
    inside = true;
    locks++;
    try {
      return await run();
    } finally {
      inside = false;
    }
  };
  const original = service.press;
  service.press = async (...args) => {
    assert(inside);
    return original(...args);
  };
  await service.execute({ ...base, text: '/status', requestId: 'atomic-execute' });
  assert.equal(locks, 1);
  assert.equal(state.status, true);
});
