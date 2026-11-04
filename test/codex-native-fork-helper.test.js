'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { forkRight, quote, callHerdr } = require('../runtime/codex/codex-fork-right');

const id = '01a15a94-9a6e-7740-840a-2b3f9a91d979';
const childId = '01a15c7a-285f-7162-92eb-a9193a447d33';
function fixture(overrides = {}) {
  const calls = [];
  const pane = {
    pane_id: 'original',
    terminal_id: 'original-terminal',
    agent: 'codex',
    agent_session: { agent: 'codex', kind: 'id', value: id },
    foreground_cwd: "/tmp/project's $(touch should-not-exist)",
  };
  return {
    calls,
    pane,
    options: {
      env: { HERDR_ENV: '1', HERDR_PANE_ID: 'original' },
      fork: (parent, cwd) => {
        assert.equal(parent, id);
        assert.equal(cwd, pane.foreground_cwd);
        return childId;
      },
      readEnvironment: () => ({ CODEX_HOME: '/tmp/account home', SECRET: 'never-forward' }),
      herdr: (args) => {
        calls.push(args);
        if (overrides[args[1]]) return overrides[args[1]](args, pane, calls);
        switch (args[1]) {
          case 'get':
            return { pane: { ...pane } };
          case 'process-info':
            return { process_info: { foreground_processes: [{ name: 'codex', pid: 123 }] } };
          case 'split':
            return { pane: { pane_id: 'right' } };
          case 'run':
            return {};
          default:
            throw new Error('Unexpected operation');
        }
      },
    },
  };
}

test('fork targets the exact original session, runs only in the new right pane and preserves focus', () => {
  const f = fixture();
  const result = forkRight(f.options);
  assert.equal(result.newPane, 'right');
  assert.deepEqual(
    f.calls.find((args) => args[1] === 'split'),
    [
      'pane',
      'split',
      '--pane',
      'original',
      '--direction',
      'right',
      '--cwd',
      f.pane.foreground_cwd,
      '--no-focus',
    ],
  );
  const run = f.calls.find((args) => args[1] === 'run');
  assert.equal(run[2], 'right');
  assert.ok(run[3].includes(`'resume' '${childId}'`));
  assert.ok(run[3].includes("'CODEX_HOME=/tmp/account home'"));
  assert.ok(!run[3].includes('never-forward'));
  assert.ok(!run[3].includes('--last'));
  assert.ok(!f.calls.some((args) => ['focus', 'close', 'send', 'send-keys'].includes(args[1])));
});

test('shell quoting preserves spaces, quotes and substitutions literally', () => {
  const value = "a' b$(printf substituted)`printf substituted`;end";
  assert.equal(
    execFileSync('/bin/sh', ['-c', `printf %s ${quote(value)}`], { encoding: 'utf8' }),
    value,
  );
  assert.throws(() => quote('bad\nargument'));
  assert.throws(() => quote('bad\x03argument'));
});

test('custom command context wins over an inherited pane and explicit pane wins over both', () => {
  for (const [paneId, expected] of [
    [undefined, 'client-pane'],
    ['explicit-pane', 'explicit-pane'],
  ]) {
    const f = fixture();
    forkRight({
      ...f.options,
      paneId,
      dryRun: true,
      env: { ...f.options.env, HERDR_ACTIVE_PANE_ID: 'client-pane' },
    });
    assert.equal(f.calls[0][2], expected);
    assert.ok(!f.calls.some((args) => args[1] === 'split'));
  }
});

test('no context or missing session fails before splitting', () => {
  const f = fixture();
  assert.throws(() => forkRight({ ...f.options, env: {} }), /--pane/);
  f.pane.agent_session = null;
  assert.throws(() => forkRight(f.options), /会话 ID/);
  assert.ok(!f.calls.some((args) => args[1] === 'split'));
});

test('stale session metadata on an idle shell fails before splitting', () => {
  const f = fixture({
    'process-info': () => ({
      process_info: { foreground_processes: [{ name: 'bash', pid: 123 }] },
    }),
  });
  assert.throws(() => forkRight(f.options), /未运行 Codex/);
  assert.ok(!f.calls.some((args) => args[1] === 'split'));
});

test('the native slash command cannot fork a stale Herdr session', () => {
  const f = fixture();
  assert.throws(
    () => forkRight({ ...f.options, expectedSessionId: childId }),
    /当前 Codex 会话不同/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(forkRight({ ...f.options, expectedSessionId: id, dryRun: true }).sourceSession, id);
});

test('a session change during preparation fails before splitting', () => {
  const f = fixture({
    get: (args, pane, calls) => ({
      pane: { ...pane, terminal_id: calls.length > 1 ? 'replacement' : pane.terminal_id },
    }),
  });
  assert.throws(() => forkRight(f.options), /会话已变化/);
  assert.ok(!f.calls.some((args) => args[1] === 'split'));
});

test('ambiguous command failure reports the new pane without closing either pane or retrying', () => {
  const f = fixture({
    run: () => {
      throw new Error('timeout');
    },
  });
  assert.throws(() => forkRight(f.options), /right.*未确认成功/);
  assert.equal(f.calls.filter((args) => args[1] === 'run').length, 1);
  assert.ok(!f.calls.some((args) => args[1] === 'close'));
});

test('pane run accepts the official CLI empty success response and rejects a failure exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fork-cli-'));
  const binary = path.join(dir, 'herdr');
  const old = process.env.HERDR_BIN_PATH;
  try {
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.HERDR_BIN_PATH = binary;
    assert.deepEqual(callHerdr(['pane', 'run', 'new', 'command']), {});
    fs.writeFileSync(binary, '#!/bin/sh\nexit 1\n');
    assert.throws(() => callHerdr(['pane', 'run', 'new', 'command']));
  } finally {
    if (old === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = old;
    fs.rmSync(dir, { recursive: true });
  }
});

test('a split failure retains the new session ID for recovery', () => {
  const f = fixture({
    split: () => {
      throw new Error('server unavailable');
    },
  });
  assert.throws(() => forkRight(f.options), new RegExp(childId));
  assert.ok(!f.calls.some((args) => args[1] === 'run'));
});

function swiftFixture(overrides = {}) {
  const tabs = [{ tab_id: 'before' }, { tab_id: 'source' }, { tab_id: 'after' }];
  let serial = 0;
  const f = fixture({
    list: () => ({ tabs }),
    create: () => {
      const id = 'child-' + ++serial;
      tabs.push({ tab_id: id });
      return { tab: { tab_id: id }, root_pane: { pane_id: id + '-pane' } };
    },
    move: (args) => {
      const [tab] = tabs.splice(
        tabs.findIndex((t) => t.tab_id === args[2]),
        1,
      );
      tabs.splice(Number(args[3]), 0, tab);
      return {};
    },
    ...overrides,
  });
  Object.assign(f.pane, { tab_id: 'source', workspace_id: 'workspace' });
  f.options.env.HERDR_SESSION = 'swift';
  return { ...f, tabs };
}
test('Swift forks insert immediately to the right of the source Tab, including repeated forks', () => {
  const f = swiftFixture();
  const first = forkRight(f.options),
    second = forkRight(f.options);
  assert.deepEqual(
    f.tabs.map((t) => t.tab_id),
    ['before', 'source', 'child-2', 'child-1', 'after'],
  );
  assert.equal(first.placement, 'tab');
  assert.equal(second.newTab, 'child-2');
  assert.equal(first.newPane, 'child-1-pane');
  assert(
    f.calls
      .filter((a) => a[1] === 'create')
      .every((a) => a.includes('--no-focus') && a.includes('workspace')),
  );
  assert(!f.calls.some((a) => ['split', 'focus', 'close', 'send', 'send-keys'].includes(a[1])));
  assert(f.calls.filter((a) => a[1] === 'run').every((a) => a[2].startsWith('child-')));
});
test('Swift retains the new Tab and fork ID on an uncertain order response, without another create or split', () => {
  const f = swiftFixture({
    move: () => {
      throw new Error('lost response');
    },
  });
  assert.throws(() => forkRight(f.options), new RegExp('child-1.*' + childId + '.*未确认'));
  assert.equal(f.calls.filter((a) => a[1] === 'create').length, 1);
  assert(!f.calls.some((a) => ['split', 'run', 'close'].includes(a[1])));
});
