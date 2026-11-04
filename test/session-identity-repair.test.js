'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionIdentityRepair, resumedSessionId } = require('../lib/session-identity-repair');

const ID = '01a0c727-f356-7b63-a29b-22c1019e91d7';

test('从进程自己的恢复参数里取会话 id，别的参数不算', () => {
  assert.equal(resumedSessionId('codex', [`node /home/u/.npm-global/bin/codex resume ${ID}`]), ID);
  assert.equal(resumedSessionId('claude', [`claude --resume ${ID}`]), ID);
  assert.equal(resumedSessionId('claude', [`claude --resume=${ID} --model x`]), ID);
  assert.equal(resumedSessionId('codex', ['node /x/codex']), null, '新开的会话没有 id 可取');
  assert.equal(
    resumedSessionId('codex', [`python3 script.py resume ${ID}`]),
    null,
    '不是 codex 进程不算',
  );
  assert.equal(resumedSessionId('claude', [`codex resume ${ID}`]), null, '按这个 pane 的 Agent 认');
});
test('Codex resume 按原生 argv 跳过选项值，不把配置或提示中的 UUID 当作会话', async () => {
  const launch = [
    '/x/codex',
    'resume',
    '--no-daemon',
    '--model',
    'fixture-model',
    '-c',
    'model_reasoning_effort="high"',
    '--cd',
    '/fixture/path with spaces',
    ID,
  ];
  assert.equal(resumedSessionId('codex', [launch]), ID);
  assert.equal(
    resumedSessionId('codex', [
      ['/x/codex', 'resume', ID, '--no-daemon', '--model=fixture', 'a prompt'],
    ]),
    ID,
  );
  assert.equal(
    resumedSessionId('codex', [['node', '/x/codex.js', '--model=fixture', 'resume', '--', ID]]),
    ID,
  );
  for (const argv of [
    ['/x/codex', 'resume', '--model', ID],
    ['/x/codex', '-c', `note="codex resume ${ID}"`],
    ['/x/codex', 'exec', 'resume', ID],
    ['/x/codex', 'resume', '--last', ID],
    ['/x/codex', 'resume', '--fork', ID],
    ['/x/codex', 'resume', ID, '--fork'],
    ['/x/codex', 'resume', ID, '--last'],
    ['/x/codex', 'resume', '--unknown-option', ID],
    ['/x/codex', 'resume', 'a prompt containing', ID],
  ])
    assert.equal(resumedSessionId('codex', [argv]), null);
  const fixture = setup({ argv: launch.join(' ') });
  fixture.repair.herdr.readProcessInfo = async () => ({ foreground_processes: [{ argv: launch }] });
  assert.deepEqual(await fixture.repair.check([lost]), [true]);
  assert.equal(fixture.reports[0].params.agent_session_id, ID);
});

function setup({ argv = `node /x/codex resume ${ID}`, exists = true } = {}) {
  let clock = 1000;
  const reports = [];
  const repair = new SessionIdentityRepair({
    herdr: { readProcessInfo: async () => ({ foreground_processes: [{ argv: argv.split(' ') }] }) },
    locate: () => (exists ? '/x/rollout.jsonl' : null),
    request: async (method, params) => {
      reports.push({ method, params });
      return {};
    },
    now: () => clock,
  });
  return {
    repair,
    reports,
    tick: (ms) => {
      clock += ms;
    },
  };
}
const lost = {
  paneId: 'w9:pEW',
  cwd: '/x',
  agent: { label: 'codex', status: 'working', session: null },
};

test('有 Agent 却没有身份：按恢复参数补报给 Herdr，同一个 pane 不反复报', async () => {
  const { repair, reports, tick } = setup();
  assert.deepEqual(await repair.check([lost]), [true]);
  assert.equal(reports[0].method, 'pane.report_agent_session');
  assert.deepEqual(
    { ...reports[0].params, seq: 0 },
    {
      pane_id: 'w9:pEW',
      source: 'herdr:codex',
      agent: 'codex',
      seq: 0,
      agent_session_id: ID,
      session_start_source: 'resume',
    },
  );
  await repair.check([lost]);
  assert.equal(reports.length, 1, '20 秒内不重试');
  tick(21000);
  await repair.check([lost]);
  assert.equal(reports.length, 2);
});

test('已有身份、认不出参数、存档不存在，都不报', async () => {
  const withIdentity = setup();
  await withIdentity.repair.check([{ ...lost, agent: { ...lost.agent, session: { value: ID } } }]);
  assert.equal(withIdentity.reports.length, 0);
  const fresh = setup({ argv: 'node /x/codex' });
  assert.deepEqual(await fresh.repair.check([lost]), [false]);
  const gone = setup({ exists: false });
  assert.deepEqual(await gone.repair.check([lost]), [false]);
  assert.equal(fresh.reports.length + gone.reports.length, 0);
});

test('普通启动在核验内容后再次检查进程、终端和会话身份，不向终端写消息', async () => {
  const first =
    'Native conversation evidence provides the exact historical content belonging only to this pane and this session.';
  const second =
    'A second independent archive line verifies the association while the original native process remains unchanged.';
  for (const change of ['none', 'process', 'terminal', 'session', 'screen']) {
    const reports = [],
      pane = { ...lost, terminalId: 'term-original', agentTitle: 'Native title' };
    let reads = 0;
    const repair = new SessionIdentityRepair({
      herdr: {
        readProcessInfo: async () => ({
          foreground_processes: [{ name: 'codex', pid: 123, argv: ['/x/codex'] }],
        }),
        readPane: async () =>
          ++reads === 2 && change === 'screen' ? 'Another conversation' : `${first}\n${second}`,
        dashboard: async () => ({
          panes: [
            {
              ...pane,
              ...(change === 'terminal' ? { terminalId: 'term-replacement' } : {}),
              ...(change === 'session'
                ? { agent: { ...pane.agent, session: { value: 'already-bound' } } }
                : {}),
            },
          ],
        }),
      },
      discovery: { discover: async () => ({ sessionId: ID, texts: [first, second] }) },
      readFile: async () =>
        `123 (codex) ${Array.from({ length: 20 }, (_, i) => (i === 19 ? (change === 'process' && reads === 2 ? '222' : '111') : '0')).join(' ')}`,
      locate: () => '/fixture/archive.jsonl',
      request: async (method, params) => reports.push({ method, params }),
    });
    assert.deepEqual(await repair.check([pane]), [change === 'none']);
    assert.equal(reports.length, change === 'none' ? 1 : 0, change);
    if (reports.length) {
      assert.equal(reports[0].method, 'pane.report_agent_session');
      assert.equal(reports[0].params.agent_session_id, ID);
    }
  }
});

test('已有但过时的 Codex 身份依据当前存档补报，任何确认竞争都拒绝更新', async () => {
  const currentId = '01a164b6-3367-76e2-94ff-143fc14c1eb8';
  for (const change of [
    'none',
    'process',
    'file',
    'current',
    'terminal',
    'session',
    'provider',
    'cwd',
    'missing',
    'ambiguous',
  ]) {
    const reports = [],
      pane = { ...lost, terminalId: 'original', agent: { ...lost.agent, session: { value: ID } } };
    let reads = 0;
    const active = { sessionId: currentId, file: '/fixture/current.jsonl', runtime: '123:111' };
    const repair = new SessionIdentityRepair({
      herdr: {
        readProcessInfo: async () => ({
          foreground_processes: [{ name: 'codex', pid: 123, argv: ['codex', 'resume', ID] }],
        }),
        dashboard: async () => ({
          panes:
            change === 'missing'
              ? []
              : [
                  {
                    ...pane,
                    ...(change === 'terminal' ? { terminalId: 'replaced' } : {}),
                    ...(change === 'cwd' ? { cwd: '/different' } : {}),
                    ...(change === 'session'
                      ? { agent: { ...pane.agent, session: { value: 'already-updated' } } }
                      : {}),
                    ...(change === 'provider' ? { agent: { ...pane.agent, label: 'claude' } } : {}),
                  },
                ],
        }),
      },
      activeSession: {
        read: async () => {
          if (change === 'ambiguous') return null;
          if (++reads === 1) return active;
          return {
            ...active,
            ...(change === 'process' ? { runtime: '123:222' } : {}),
            ...(change === 'file' ? { file: '/fixture/replaced.jsonl' } : {}),
            ...(change === 'current' ? { sessionId: ID } : {}),
          };
        },
      },
      locate: () => '/fixture/old.jsonl',
      request: async (method, params) => reports.push({ method, params }),
    });
    assert.deepEqual(await repair.check([pane]), [change === 'none'], change);
    assert.equal(reports.length, change === 'none' ? 1 : 0, change);
    if (reports.length) {
      assert.equal(reports[0].params.agent_session_id, currentId);
      assert.equal(
        reports[0].params.session_start_source,
        'resume',
        'Herdr must explicitly allow replacing the stale session binding',
      );
    }
  }
});

test('已正确绑定的当前存档不重复补报，没有存档证据也不恢复旧启动身份', async () => {
  for (const active of [
    null,
    { sessionId: ID, runtime: '123:111', file: '/fixture/current.jsonl' },
  ]) {
    const { repair, reports } = setup();
    repair.activeSession = { read: async () => active };
    assert.deepEqual(
      await repair.check([{ ...lost, agent: { ...lost.agent, session: { value: ID } } }]),
      [false],
    );
    assert.equal(reports.length, 0);
  }
});

test('共享 daemon 报错已有身份时，只凭两次唯一终端内容证据修复，恢复参数不能覆盖已有身份', async () => {
  const correct = '01a164b6-3367-76e2-94ff-143fc14c1eb8';
  const texts = [
    'A current native terminal paragraph proves this conversation belongs to the foreground Codex client in this pane.',
    'Another independent native paragraph confirms the same conversation even though a shared daemon owns the archive writers.',
  ];
  for (const change of [
    'none',
    'process',
    'terminal',
    'session',
    'title',
    'cwd',
    'screen',
    'ambiguous',
    'already-correct',
  ]) {
    const pane = {
      ...lost,
      terminalId: 'terminal',
      agentTitle: 'native title',
      agent: { ...lost.agent, session: { value: ID } },
    };
    const reports = [],
      events = [];
    let reads = 0;
    const repair = new SessionIdentityRepair({
      herdr: {
        socketPath: '/fixture/correct-session.sock',
        readProcessInfo: async () => ({
          foreground_processes: [{ name: 'codex', pid: 123, argv: ['codex', 'resume', ID] }],
        }),
        readPane: async () => (++reads === 2 && change === 'screen' ? 'changed' : texts.join('\n')),
        dashboard: async () => ({
          panes: [
            {
              ...pane,
              ...(change === 'terminal' ? { terminalId: 'replaced' } : {}),
              ...(change === 'cwd' ? { cwd: '/different' } : {}),
              ...(change === 'title' ? { agentTitle: 'new title' } : {}),
              ...(change === 'session'
                ? { agent: { ...pane.agent, session: { value: 'changed' } } }
                : {}),
            },
          ],
        }),
      },
      prepare: async () => events.push('guard'),
      activeSession: {
        read: async () => {
          events.push('active');
          return null;
        },
      },
      discovery: {
        discover: async () =>
          change === 'ambiguous'
            ? null
            : { sessionId: change === 'already-correct' ? ID : correct, texts },
      },
      readFile: async () =>
        `123 (codex) ${Array.from({ length: 20 }, (_, i) => (i === 19 ? (change === 'process' && reads === 2 ? '222' : '111') : '0')).join(' ')}`,
      locate: () => '/fixture/current.jsonl',
      request: async (...args) => reports.push(args),
    });
    assert.deepEqual(await repair.check([pane]), [change === 'none'], change);
    assert.deepEqual(events, ['guard', 'active']);
    if (change === 'none') {
      assert.equal(reports[0][1].agent_session_id, correct);
      assert.equal(reports[0][1].session_start_source, 'resume');
      assert.equal(reports[0][2].socketFile, '/fixture/correct-session.sock');
    } else assert.equal(reports.length, 0, change);
  }
});
