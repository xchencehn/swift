'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalScreen } = require('../lib/terminal-screen');
const { WatchStreamParser } = require('../lib/watch-stream');
const { chatStatus } = require('../lib/chat-status');
const {
  projectTerminalScreen,
  parseCodexFooter,
  codexModelField,
  hasCodexModelAndDirectory,
} = require('../public/native-status');
const text = (rows) => rows.map((row) => row.map((span) => span.text).join('')).join('\n');

function setup(t, options = {}) {
  const snapshots = [],
    screen = new TerminalScreen({
      cols: 80,
      rows: 12,
      ...options,
      onScreen: (value) => snapshots.push(value),
    });
  t.after(() => screen.close());
  return { screen, snapshots };
}

test('VT 重建支持中文、组合字符、逐格覆盖、清行、滚动和备用屏幕', async (t) => {
  const { screen, snapshots } = setup(t);
  await screen.feed('\x1b[H中A\x1b[1;3HB\r\ne\u0301C', { full: true });
  assert.equal(text(snapshots.at(-1).rows), '中B\néC');
  await screen.feed('\x1b[1;1H\x1b[2KREPLACED');
  assert(text(snapshots.at(-1).rows).startsWith('REPLACED\néC'));
  await screen.feed('\x1b[?1049h\x1b[HAlternate screen');
  assert.equal(text(snapshots.at(-1).rows), 'Alternate screen');
  await screen.feed('\x1b[?1049l');
  assert(text(snapshots.at(-1).rows).startsWith('REPLACED'));
  await screen.feed(
    '\x1b[2J\x1b[H' + Array.from({ length: 15 }, (_, i) => 'row-' + i).join('\r\n'),
  );
  assert.equal(snapshots.at(-1).rows.length, 12);
  assert(text(snapshots.at(-1).rows).endsWith('row-14'));
});

test('新布局和未知措辞保留完整画面，已知布局保留 Recap 后全部附加提示及颜色', async (t) => {
  const { screen, snapshots } = setup(t);
  await screen.feed(
    'Worked for 19s · 16:23\r\n↳ Recap: native recap\r\n' +
      '\x1b[31m■ Server connection could not be restored\x1b[0m\r\n' +
      'Future warning without any recognized vocabulary\r\n› Ask Codex\r\nGPT-6.1-Sol · Ready · Context 23% used',
    { full: true },
  );
  const value = snapshots.at(-1);
  assert.equal(value.projection.recognized, true);
  assert(text(value.projection.rows).includes('Future warning'));
  assert(value.projection.rows.some((row) => row.some((span) => span.color === 'rgb(205,49,49)')));
  await screen.feed('\x1b[2J\x1b[H陌生布局\r\nA completely new native banner', { full: true });
  assert.equal(snapshots.at(-1).projection.recognized, false);
  assert.equal(text(snapshots.at(-1).rows), '陌生布局\nA completely new native banner');
});

test('完整帧替换清除旧屏幕、旧属性和不完整转义，增量在完整帧前不会被采纳', async (t) => {
  const { screen, snapshots } = setup(t);
  await screen.feed('STRAY INCREMENTAL');
  assert.equal(snapshots.length, 0);
  await screen.feed('\x1b[31mOld screen\x1b[', { full: true });
  await screen.feed('New screen', { full: true });
  assert.equal(text(snapshots.at(-1).rows), 'New screen');
  assert.equal(snapshots.at(-1).rows[0][0].color, undefined);
  assert.equal(snapshots.at(-1).revision, 2);
  screen.close();
  await screen.feed('After close');
  assert.equal(snapshots.length, 2);
});

test('观察协议保留完整帧边界，任意 JSON 分块和 UTF-8 分块不破坏画面', async (t) => {
  const { screen, snapshots } = setup(t);
  const tasks = [],
    parser = new WatchStreamParser({
      onFrame: (data, frame) => tasks.push(screen.feed(data, frame)),
      onEnd: () => {},
    });
  const bytes = Buffer.from('中A'),
    stream =
      [
        {
          type: 'terminal.frame',
          encoding: 'ansi',
          full: true,
          bytes: Buffer.from('\x1b[H').toString('base64'),
        },
        ...[bytes.subarray(0, 2), bytes.subarray(2)].map((chunk) => ({
          type: 'terminal.frame',
          encoding: 'ansi',
          bytes: chunk.toString('base64'),
        })),
      ]
        .map(JSON.stringify)
        .join('\n') + '\n';
  for (let i = 0; i < stream.length; i += 3) parser.push(stream.slice(i, i + 3));
  await Promise.all(tasks);
  assert.equal(text(snapshots.at(-1).rows), '中A');
});
test('观察协议保留有界的原生帧尺寸，无尺寸旧格式仍兼容', () => {
  const frames = [],
    parser = new WatchStreamParser({ onFrame: (data, frame) => frames.push(frame), onEnd() {} });
  for (const dimensions of [{ width: 80, height: 200 }, {}, { width: 500, height: -1 }]) {
    parser.push(
      JSON.stringify({
        type: 'terminal.frame',
        encoding: 'ansi',
        full: true,
        bytes: Buffer.from('x').toString('base64'),
        ...dimensions,
      }) + '\n',
    );
  }
  assert.deepEqual(frames, [{ full: true, cols: 80, rows: 200 }, { full: true }, { full: true }]);
});

test('完整原生 footer 的模型大小写不触发存档回退', () => {
  const footer =
    'GPT-6.1-Sol medium · compete · master · Ready · Context 23% used · weekly 78% left';
  const result = chatStatus(
    { statusline: [footer] },
    { agent: { label: 'codex', status: 'unknown' } },
    { model: 'gpt-6.1-sol' },
  );
  assert.equal(result.statusSource, 'terminal');
  const rendered = result.statusline.join(' ');
  for (const token of ['master', 'Ready', 'Context 23% used', 'weekly 78% left'])
    assert(rendered.includes(token));
  assert(!rendered.includes('unknown'));
});

test('默认前景和背景的反色仍保留可读属性', async (t) => {
  const { screen, snapshots } = setup(t);
  await screen.feed('\x1b[7mSelected\x1b[0m\x1b[6n', { full: true });
  assert.equal(text(snapshots.at(-1).rows), 'Selected');
  assert.equal(snapshots.at(-1).rows[0][0].inverse, true);
});

test('structured observation coalesces extraction after VT writes and flushes the latest complete frame', async (t) => {
  const { screen, snapshots } = setup(t, { snapshotIntervalMs: 1000 });
  await screen.feed('Worked for 1s\r\n› prompt\r\nGPT · Ready · Context 23%', { full: true });
  for (let i = 2; i <= 10; i++) await screen.feed(`\x1b[1;1HWorked for ${i}s`);
  assert.equal(snapshots.length, 0);
  screen.flush();
  assert.equal(snapshots.length, 1);
  assert(text(snapshots[0].rows).includes('Worked for 10s'));
  screen.close();
});

test('Codex idle footer is recognized without prior work and without a visible composer', async (t) => {
  const { screen, snapshots } = setup(t);
  for (const body of [
    '› Ask Codex\r\nGPT-6.1-Sol · Ready · Context 2% used',
    'Select a model\r\nGPT-6.1-Sol · Ready · Context 2% used',
  ]) {
    await screen.feed(body, { full: true });
    const p = snapshots.at(-1).projection;
    assert.equal(p.recognized, true);
    assert.deepEqual(p.rows, []);
    assert.match(text(p.statusRows), /Ready/);
  }
});
test('empty composers and background-painted padding do not invalidate a footer', () => {
  const { projectTerminalScreen } = require('../public/native-status');
  const rows = [
    'Worked for 2s',
    '›',
    'GPT-6.1-Sol · Ready · Context 2% used',
    ...Array(50).fill('   '),
  ].map((text) => [{ text, background: '#000000' }]);
  const p = projectTerminalScreen(rows);
  assert(p.recognized);
  assert.equal(text(p.rows), 'Worked for 2s');
});

test('recorded native Codex compaction remains visible with the default or configured footer, then clears', async (t) => {
  const fs = require('node:fs'),
    path = require('node:path'),
    { readStatusArea } = require('../lib/agent-composer');
  const { screen, snapshots } = setup(t, { cols: 120, rows: 60 });
  for (const version of ['0.162.1', '0.163.0']) {
    const recorded = fs.readFileSync(
      path.join(__dirname, `fixtures/codex-status/v${version}-compacting.txt`),
      'utf8',
    );
    for (const frame of [
      recorded,
      recorded.replace(/GPT-6\.1-Sol default[^\n]*/, 'GPT-6.1-Sol · Working · Context 99% used'),
    ]) {
      await screen.feed(frame.replaceAll('\n', '\r\n'), { full: true });
      const projection = snapshots.at(-1).projection;
      assert.equal(projection.recognized, true);
      assert.match(text(projection.rows), /Compacting context \(0s/);
      assert.match(text(projection.rows), /Making room to continue/);
      assert.match(text(projection.statusRows), /GPT-6.1-Sol/);
      assert.match(readStatusArea(frame).activity, /Compacting context/);
    }
  }
  await screen.feed('Worked for 2s\r\n› Ask Codex\r\nGPT-6.1-Sol · Ready · Context 7% used', {
    full: true,
  });
  assert.equal(snapshots.at(-1).projection.recognized, true);
  assert.doesNotMatch(text(snapshots.at(-1).projection.rows), /Compacting/);
  assert.doesNotMatch(readStatusArea(text(snapshots.at(-1).rows)).activity, /Compacting/);
});
test('old compaction history does not validate a later unknown footer or become current activity', () => {
  const { projectTerminalScreen } = require('../public/native-status');
  const project = (lines) => projectTerminalScreen(lines.map((text) => [{ text }]));
  const history = [
    '• Compacting context (2s • esc to interrupt)',
    'Worked for 3s',
    '› Ask Codex',
    'Future layout · unknown footer',
  ];
  assert.equal(project(history).recognized, false);
  const current = project([...history.slice(0, 3), 'GPT-6.1-Sol · Ready · Context 7% used']);
  assert.equal(current.recognized, true);
  assert.doesNotMatch(text(current.rows), /Compacting/);
});

test('the shared Codex footer parser preserves native rows and separates independently aligned fields', () => {
  const lines = [
    '• Working (49s • esc to interrupt)',
    '» Ask Codex',
    '',
    '  ~/workdir/cannbench · wwh · GPT-6-Astra ultra       Pursuing goal (44s)',
    '  ? for shortcuts',
    '   ',
  ];
  const before = lines.slice(),
    footer = parseCodexFooter(lines);
  assert.deepEqual(lines, before);
  assert.equal(footer.prompt, 1);
  assert.equal(footer.footerIndex, 3);
  assert.deepEqual(footer.rows, before.slice(3, 5));
  assert.equal(footer.text, before.slice(3, 5).join('\n'));
  assert.deepEqual(footer.fields, [
    '~/workdir/cannbench',
    'wwh',
    'GPT-6-Astra ultra',
    'Pursuing goal (44s)',
    '? for shortcuts',
  ]);
  assert.deepEqual(codexModelField(footer.fields[2]).slice(1, 3), ['GPT-6-Astra', 'ultra']);
  assert.equal(codexModelField('GPT-6-Astra ultra Pursuing goal (44s)'), null);
});

test('the reported Codex goal footer keeps its activity, native colors and right-aligned status', async (t) => {
  const { screen, snapshots } = setup(t, { cols: 250, rows: 24 });
  const footer =
    '  GPT-6-Astra ultra · wwh · ~/workdir/cannbench/.worktrees/169-CompressedSparseAttentionCoreV2/tasks/169-CompressedSparseAttentionCoreV2 · 169-CompressedS…';
  await screen.feed(
    '• Working (49s • esc to interrupt)\r\n' +
      '  Tip: You can resume a previous conversation by running codex resume\r\n\r\n' +
      '› \x1b[2mAsk Codex to do anything\x1b[0m\r\n\r\n' +
      `\x1b[36m${footer}\x1b[0m        \x1b[34mPursuing goal (44s)\x1b[0m\r\n  ? for shortcuts`,
    { full: true },
  );
  const projection = snapshots.at(-1).projection;
  assert.equal(projection.recognized, true);
  assert.match(text(projection.rows), /Working \(49s/);
  assert.match(text(projection.rows), /Tip: You can resume/);
  assert.equal(
    text(projection.statusRows),
    `${footer}        Pursuing goal (44s)\n  ? for shortcuts`,
  );
  assert(
    projection.statusRows[0].some(
      (span) => span.color === 'rgb(36,114,200)' && span.text.includes('Pursuing goal'),
    ),
  );
});

test('Codex goal footers accept custom item order, multiline layouts and every native prompt variant', () => {
  const project = (lines) => projectTerminalScreen(lines.map((text) => [{ text }]));
  for (const prompt of ['›', '❯', '»']) {
    for (const footer of [
      ['  GPT-6-Astra ultra · arbitrary-account · ~/project · task…       Pursuing goal (44s)'],
      ['  ~/project · 中文账号 · GPT-6-Astra ultra       Goal paused'],
      ['  Pursuing goal (44s)       GPT-6-Astra ultra · ~/project'],
      ['  ~/project', '  arbitrary-account · GPT-6-Astra ultra', '  task…       Goal stalled'],
      ['  C:\\work\\project · GPT-6-Astra ultra       Goal achieved'],
      ['  GPT-6-Astra ultra · ~       ⚠ 1 warning · f2 to view'],
      ['  GPT-6-Astra ultra · ~/project'],
    ]) {
      const lines = [
        '• Working (49s • esc to interrupt)',
        '',
        `${prompt} Ask Codex`,
        '',
        ...footer,
        '  ? for shortcuts',
      ];
      const projection = project(lines);
      assert.equal(projection.recognized, true, lines.join('\n'));
      assert.equal(text(projection.rows), '• Working (49s • esc to interrupt)');
      assert.equal(text(projection.statusRows), [...footer, '  ? for shortcuts'].join('\n'));
    }
  }
});

test('unrecognized current footers cannot borrow goal text or a configured footer from earlier conversation', () => {
  const project = (lines) => projectTerminalScreen(lines.map((text) => [{ text }]));
  const history = [
    '• Working (1s • esc to interrupt)',
    '› old prompt',
    '',
    '  GPT-6-Astra ultra · ~/old · Ready · Context 2% used       Pursuing goal (1s)',
    '',
  ];
  for (const prompt of ['›', '❯', '»'])
    for (const current of [
      ['  Future layout · unknown footer'],
      ['  Pursuing goal (44s)', '  ? for shortcuts'],
      ['  wwh · task…       Pursuing goal (44s)'],
      ['  GPT-6-Astra ultra'],
      ['  ~/project'],
    ]) {
      const lines = [...history, `${prompt} current draft`, '', ...current];
      const projection = project(lines);
      assert.equal(projection.recognized, false, lines.join('\n'));
      assert.deepEqual(projection.statusRows, []);
    }
  const current = project([
    ...history,
    '» current draft',
    '',
    '  GPT-6-Astra ultra · ~/current       Pursuing goal (44s)',
  ]);
  assert.equal(current.recognized, true);
  assert.deepEqual(current.rows, []);
  assert.equal(
    text(current.statusRows),
    '  GPT-6-Astra ultra · ~/current       Pursuing goal (44s)',
  );
});

test('custom footer evidence requires a current composer gap and a bounded native footer', () => {
  for (const lines of [
    ['  GPT-6-Astra ultra · ~/project       Pursuing goal (44s)'],
    ['› current draft', '  GPT-6-Astra ultra · ~/project       Pursuing goal (44s)'],
    [
      '› current draft',
      '',
      '  GPT-6-Astra ultra · ~/project',
      ...Array(8).fill('  footer continuation'),
    ],
  ]) {
    assert.equal(parseCodexFooter(lines).footerIndex, -1);
    assert.equal(projectTerminalScreen(lines.map((text) => [{ text }])).recognized, false);
  }
});

test('recorded narrow native footers retain truncated model identifiers beside independently rendered status', () => {
  // Codex 0.163.0 produced these one-space boundaries at 100 and 45 columns.
  const recorded = [
    '  ~ · GPT-6.1-So… Goal paused (/goal resume)    ⚠ 1 warning · f2 to view',
    '  ~ · GPT-6… Pursuing goal (2s)    ⚠ 1 · f2',
  ];
  for (const footer of recorded) {
    const rows = ['• Working (2s • esc to interrupt)', '', '› Ask Codex', '', footer].map(
      (text) => [{ text }],
    );
    const projection = projectTerminalScreen(rows);
    assert.equal(projection.recognized, true, footer);
    assert.deepEqual(projection.statusRows, rows.slice(-1));
    assert.equal(text(projection.rows), '• Working (2s • esc to interrupt)');
    for (const field of parseCodexFooter(rows.map((row) => row[0].text)).fields)
      assert.equal(
        codexModelField(field),
        null,
        'A truncated display must not produce an exact model or effort',
      );
  }
});

test('one-space footer boundaries depend on model syntax rather than the adjacent status wording', () => {
  const project = (footer) =>
    projectTerminalScreen(['» Ask Codex', '', `  ~/project · ${footer}`].map((text) => [{ text }]));
  for (const model of [
    'GPT-6-Astra ultra',
    'codex-mini high fast',
    'o3 medium',
    'GPT-6…',
    'codex-m…',
    'o3…',
  ]) {
    const footer = `${model} A future native indicator`;
    const projection = project(footer);
    assert.equal(projection.recognized, true, footer);
    assert.equal(text(projection.statusRows), `  ~/project · ${footer}`);
    assert.equal(
      codexModelField(footer),
      null,
      'Presence recognition must not guess an exact setting from additional text',
    );
  }
  for (const footer of [
    'An example says GPT-6… A future native indicator',
    'An example says GPT-6-Astra ultra A future native indicator',
    'unknown-model… A future native indicator',
    'GPT-… A future native indicator',
    'GPT-6…suffix A future native indicator',
    'GPT-6-Astra ultr… A future native indicator',
    'GPT-6-Astra ultraSuffix A future native indicator',
  ])
    assert.equal(project(footer).recognized, false, footer);
  const history = [
    '› old',
    '',
    '  ~ · GPT-6… A future native indicator',
    '',
    '» current',
    '',
    '  A future native indicator',
  ];
  assert.equal(projectTerminalScreen(history.map((text) => [{ text }])).recognized, false);
});

test('a native narrow Goal footer remains visible when the model is completely omitted', () => {
  const footers = [
    '  ~… Goal paused (/goal resume)    ⚠ 1 · f2',
    '  ~… Pursuing goal (44s)    ⚠ 1 · f2',
    '  ~/project… Pursuing goal (1m 4s)',
    '  ~ · Goal paused (/goal resume)',
    '  Goal paused (/goal resume)    ~/project',
    '  C:\\work\\project… · Pursuing goal (2s)',
  ];
  for (const footer of footers) {
    const rows = ['» Ask Codex', '', footer].map((text) => [{ text }]);
    const projection = projectTerminalScreen(rows),
      parsed = parseCodexFooter(rows.map((row) => row[0].text));
    assert.equal(projection.recognized, true, footer);
    assert.deepEqual(projection.statusRows, rows.slice(-1));
    assert.equal(
      hasCodexModelAndDirectory(parsed.fields),
      false,
      'Display recognition cannot prove a main conversation',
    );
    for (const field of parsed.fields)
      assert.equal(
        codexModelField(field),
        null,
        'No absent model or reasoning setting may be reconstructed',
      );
  }
});

test('narrow Goal display evidence rejects missing directories, historical footers and incomplete state text', () => {
  const project = (lines) => projectTerminalScreen(lines.map((text) => [{ text }]));
  for (const footer of [
    'Goal paused (/goal resume)',
    'Pursuing goal (44s)',
    'arbitrary account · Goal paused (/goal resume)',
    '~… A future native indicator',
    '~… Goal paused',
    '~… Goal paused (/goal resu…)',
    '~… Pursuing goal (soon)',
    '~invalid · Goal paused (/goal resume)',
    'An example says ~… Goal paused (/goal resume)',
  ])
    assert.equal(project(['» Ask Codex', '', `  ${footer}`]).recognized, false, footer);
  for (const lines of [
    ['~… Goal paused (/goal resume)'],
    ['» Ask Codex', '~… Goal paused (/goal resume)'],
    ['» Ask Codex', '', '~… Goal paused (/goal resume)', ...Array(8).fill('footer continuation')],
    ['› old', '', '~… Goal paused (/goal resume)', '', '» current', '', 'Unknown current footer'],
  ])
    assert.equal(project(lines).recognized, false, lines.join('\n'));
});
