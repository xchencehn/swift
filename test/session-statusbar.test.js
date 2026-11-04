'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const Model = require('../public/chat/status-model');
const { create } = require('../public/chat/status');
const row = (text) => [{ text }];
const projection = (activity, footer, interaction = {}) => ({
  recognized: true,
  rows: activity.map(row),
  statusRows: footer.map(row),
  interaction: {
    thread: 'main',
    inputTarget: 'composer',
    execution: 'running',
    capabilities: { compose: true },
    ...interaction,
  },
});
test('native footer facts become labelled Swift data without terminal hints or invented identity labels', () => {
  const value = Model.parse({
    projection: projection(
      ['Worked for 1h 53m 34s'],
      [
        'GPT-6.1-Sol max · hh · weekly 47% left · ~/workdir/swift · swift · main · Ready',
        '? for shortcuts                                      ⚠ 1 warning · f2 to view',
      ],
    ),
  });
  assert.equal(value.model, 'GPT-6.1-Sol');
  assert.equal(value.effort, 'max');
  assert.equal(value.elapsedSeconds, 6814);
  assert.equal(value.running, false);
  assert.equal(value.warnings, 1);
  assert.equal(value.quotas[0].remaining, 47);
  assert.equal(value.directory, '~/workdir/swift');
  assert.deepEqual(
    value.metadata,
    ['hh', 'swift', 'main'].map((value) => ({ label: 'Native info', value })),
  );
  assert(!JSON.stringify(value).includes('shortcuts'));
  assert(!JSON.stringify(value).includes('f2 to view'));
});
test('context, quotas, compaction and background counts stay separate from command suggestions', () => {
  const value = Model.parse({
    projection: projection(
      [
        '• Compacting context (1m 2s • esc to interrupt)',
        '• 2 background terminals running · /ps to view',
      ],
      ['gpt-6-astra ultra · Context 74% used · weekly 95% left'],
    ),
  });
  assert.equal(value.compacting, true);
  assert.equal(value.running, true);
  assert.equal(value.elapsedSeconds, 62);
  assert.equal(value.background, 2);
  assert.equal(value.context, '74% used');
  assert.equal(value.quotas[0].remaining, 95);
  assert.equal(Model.formatDuration(6814), '1h 53m 34s');
});
test('legacy quota usage converts only explicit used percentages and preserves reset metadata', () => {
  const value = Model.parse({
    status: {
      activity: '• Working (2s • esc to interrupt)',
      statusline: ['weekly 82% used', '5h 4% left'],
      statusSpans: [[{ text: 'weekly 82% used', resetsAt: 1900000000 }], []],
      composer: 'other native draft',
    },
  });
  assert.equal(value.quotas[0].remaining, 18);
  assert.equal(value.quotas[1].remaining, 4);
  assert.equal(value.quotas[0].resetsAt, 1900000000);
  assert(value.nativeDraft);
});
test('a current unknown frame cannot resurrect historical footer fields or present a modal as activity', () => {
  const unknown = Model.parse({
    projection: {
      recognized: false,
      rows: [row('Worked for 1s')],
      statusRows: [row('gpt-6-sol high · /old')],
    },
  });
  assert.equal(unknown.model, '');
  assert.equal(unknown.directory, '');
  assert.equal(unknown.elapsedSeconds, null);
  const modal = Model.parse({
    projection: projection(['Configure Status Line'], [], {
      modal: { title: 'Configure Status Line' },
    }),
  });
  assert.equal(modal.modalTitle, 'Configure Status Line');
  assert.deepEqual(modal.notes, []);
});
test('native observations retain identity and revisions while the local clock stops on stale or completed data', () => {
  const original = global.document;
  global.document = { hidden: false, getElementById: () => null };
  let time = 10000,
    changes = 0;
  const pane = {
    paneId: 'p',
    terminalId: 't',
    runtimeId: '100:1',
    agent: { session: { value: 's' }, status: 'working' },
  };
  const state = {
    chatPaneId: 'p',
    chatAgents: [pane],
    connected: true,
    herdrRuntimeId: 'runtime',
    config: { rootDirectory: '/test' },
  };
  const controller = create({
    nodes: { chatView: { hidden: false }, banner: { hidden: true } },
    context: () => state,
    renderGoal() {},
    onInteraction: () => {
      changes++;
    },
    now: () => time,
  });
  const screen = (revision, value) => ({
    observerId: 'observer',
    revision,
    binding: 'p:s',
    terminalId: 't',
    rows: [],
    projection: value,
  });
  try {
    controller.claim('p');
    controller.beginScreen('observer');
    controller.screen(
      screen(1, projection(['• Working (10s • esc to interrupt)'], ['gpt-6-sol high · /test'])),
    );
    time += 2300;
    assert.equal(controller.summary().elapsedSeconds, 12);
    const initialChanges = changes;
    for (let revision = 2; revision <= 25; revision++)
      controller.screen(
        screen(
          revision,
          projection(['• Working (12s • esc to interrupt)'], ['gpt-6-sol high · /test']),
        ),
      );
    const afterSecondsChanged = changes;
    for (let revision = 26; revision <= 45; revision++)
      controller.screen(
        screen(
          revision,
          projection(['• Working (12s • esc to interrupt)'], ['gpt-6-sol high · /test']),
        ),
      );
    assert(afterSecondsChanged <= initialChanges + 1);
    assert.equal(
      changes,
      afterSecondsChanged,
      'Spinner revisions do not repaint semantic controls',
    );
    controller.screen(screen(1, projection(['Worked for 9s'], ['gpt-other high · /wrong'])));
    assert.equal(controller.summary().model, 'gpt-6-sol', 'Old revisions are rejected');
    controller.screenUnavailable({ observerId: 'other' });
    assert.equal(controller.summary().stale, false);
    controller.screenUnavailable({ observerId: 'observer' });
    assert(controller.summary().stale);
    time += 3000;
    assert.equal(
      controller.summary().elapsedSeconds,
      12,
      'Stale values describe the last native observation',
    );
    controller.screen(
      screen(46, projection(['Worked for 15s'], ['gpt-6-sol high · /test'], { execution: 'idle' })),
    );
    time += 3000;
    assert.equal(controller.summary().elapsedSeconds, 15);
    pane.runtimeId = '100:2';
    assert.equal(controller.interaction(), null);
    assert.equal(controller.summary().model, '');
    assert(changes > 0);
  } finally {
    controller.reset();
    global.document = original;
  }
});
test('the fallback clock restarts after native observer invalidation even when activity is unchanged', () => {
  const original = global.document;
  global.document = { hidden: false, getElementById: () => null };
  let time = 0;
  const pane = {
    paneId: 'p',
    terminalId: 't',
    agent: { session: { value: 's' }, status: 'working' },
  };
  const controller = create({
    nodes: { chatView: { hidden: false }, banner: { hidden: true } },
    context: () => ({ chatPaneId: 'p', chatAgents: [pane], connected: true }),
    renderGoal() {},
    now: () => time,
  });
  const status = { activity: '• Working (3s • esc to interrupt)', statusline: [] };
  try {
    controller.render(status);
    time += 1100;
    assert.equal(
      controller.summary().elapsedSeconds,
      4,
      'A zero monotonic origin is a valid clock calibration',
    );
    controller.claim('p');
    controller.beginScreen('observer');
    controller.screen({
      observerId: 'observer',
      revision: 1,
      binding: 'p:s',
      terminalId: 't',
      rows: [],
      projection: projection([], []),
    });
    assert.equal(controller.summary().elapsedSeconds, null);
    controller.invalidateStream();
    controller.render(status);
    time += 1100;
    assert.equal(controller.summary().elapsedSeconds, 4);
    controller.render(status);
    time += 1100;
    assert.equal(
      controller.summary().elapsedSeconds,
      5,
      'Identical metadata polls do not restart elapsed time',
    );
  } finally {
    controller.reset();
    global.document = original;
  }
});

test('Codex completed time and multiline Recap agree between VT and polling', () => {
  const { parseAnsiLine, matchActivityLine } = require('../public/ansi');
  const { projectTerminalScreen } = require('../public/native-status');
  const { readStatusArea } = require('../lib/agent-composer');
  const footer = 'GPT-6-Astra high · lj · weekly 21% left · ~/workdir/mxops · Ready';
  for (const [duration, clock, seconds] of [
    ['1m 27s', '11:17', 87],
    ['<1s', '2:28 AM', 1],
  ]) {
    const completed = `Worked for ${duration} • ${clock}`;
    const raw = `正文不属于状态\n${completed}\n\n  Recap: 已核验需求。\n    完整回顾保留后续验证事项。\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n${footer}`;
    const native = projectTerminalScreen(raw.split('\n').map(parseAnsiLine));
    assert.equal(native.recognized, true);
    assert.equal(native.interaction.execution, 'idle');
    const polling = readStatusArea(raw);
    assert.equal(polling.activity, completed);
    assert.equal(matchActivityLine(completed).running, false);
    for (const value of [Model.parse({ projection: native }), Model.parse({ status: polling })]) {
      assert.equal(value.activity, 'Worked');
      assert(value.completed);
      assert.equal(value.running, false);
      assert.equal(value.elapsedSeconds, seconds);
      assert.equal(value.completedAt, clock);
      assert.equal(value.elapsedText, duration.startsWith('<') ? duration : '');
      assert.match(value.notes.join(' '), /Recap: 已核验需求。/);
      assert.match(value.notes.join(' '), /完整回顾保留后续验证事项。/);
      assert(!value.notes.join(' ').includes('正文不属于状态'));
    }
    const running = readStatusArea(
      raw +
        '\n› 新请求\n• Working (2s • esc to interrupt)\n\n› Ask Codex to do anything\n\n' +
        footer,
    );
    const next = Model.parse({ status: running });
    assert.equal(next.completedAt, '');
    assert.equal(next.elapsedText, '');
    assert.equal(next.notes.length, 0);
    assert(next.running);
  }
  for (const prose of [
    'Worked for a living',
    'Worked for 1s and then wrote a test',
    'Quoted: Worked for 1s • 11:17',
  ])
    assert.equal(matchActivityLine(prose), null);
});
