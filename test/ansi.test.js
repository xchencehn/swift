'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stripAnsi, parseAnsiLine, xterm256, matchActivityLine } = require('../public/ansi');

const ESC = '\x1b';

test('剥掉转义序列只留可见文本', () => {
  const line = `${ESC}[0m${ESC}[38;2;153;153;153m[Opus 5] ${ESC}[0m${ESC}[38;5;3meff:high${ESC}[0m`;
  assert.equal(stripAnsi(line), '[Opus 5] eff:high');
  assert.equal(stripAnsi('没有颜色的一行'), '没有颜色的一行');
  assert.equal(stripAnsi(''), '');
  assert.equal(stripAnsi(null), '');
});

test('真彩色与 256 色都解析成 css 颜色', () => {
  // 取自真实画面:模型名是灰的,推理强度是黄的
  const line = `${ESC}[38;2;153;153;153m[Opus 5] ${ESC}[0m${ESC}[38;5;3meff:high${ESC}[0m`;
  const spans = parseAnsiLine(line);
  assert.equal(spans[0].text, '[Opus 5] ');
  assert.equal(spans[0].color, 'rgb(153,153,153)');
  assert.equal(spans[1].text, 'eff:high');
  assert.equal(spans[1].color, 'rgb(229,229,16)');
});

test('拼起来与原文一致,一个字符都不丢', () => {
  const line = `${ESC}[38;5;2m█░░░${ESC}[0m 9%  ${ESC}[1mweekly${ESC}[22m 60%`;
  assert.equal(
    parseAnsiLine(line)
      .map((s) => s.text)
      .join(''),
    stripAnsi(line),
  );
});

test('相邻同色片段并成一段', () => {
  const line = `${ESC}[38;5;1mAA${ESC}[38;5;1mBB${ESC}[0m`;
  const spans = parseAnsiLine(line);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, 'AABB');
});

test('粗体与重置', () => {
  const spans = parseAnsiLine(`${ESC}[1m粗${ESC}[0m常`);
  assert.equal(spans[0].bold, true);
  assert.equal(spans[1].bold, undefined);
});

test('背景色忽略掉 —— 照搬终端底色会把网页画花', () => {
  const spans = parseAnsiLine(`${ESC}[41m红底${ESC}[0m`);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].color, undefined);
  assert.equal(spans[0].text, '红底');
});

test('聊天前景色跟随终端主题，跨行保留，重置后恢复正文', () => {
  const spans = parseAnsiLine(
    `${ESC}[32m通过\n第二行${ESC}[39m 普通${ESC}[38;5;214m 警告${ESC}[0m`,
    { themeColors: true },
  );
  assert.match(spans[0].color, /^var\(--terminal-green,/);
  assert.equal(spans[0].text, '通过\n第二行');
  assert.equal(spans[1].color, undefined);
  assert.equal(spans[2].color, 'rgb(255,175,0)');
});

test('扩展背景色不改变前景、粗体和暗淡状态，OSC链接只保留文字', () => {
  assert.deepEqual(parseAnsiLine(`${ESC}[48;2;1;2;3m背景${ESC}[48;5;1m色`), [{ text: '背景色' }]);
  assert.equal(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\链接${ESC}]8;;${ESC}\\`), '链接');
  assert.equal(stripAnsi(`${ESC}]0;窗口标题\x07正文`), '正文');
});

test('非颜色的转义(光标移动之类)直接丢掉', () => {
  assert.equal(stripAnsi(`${ESC}[2J${ESC}[H正文${ESC}[K`), '正文');
});

test('256 色调色板的三段映射', () => {
  assert.deepEqual(xterm256(0), [0, 0, 0]);
  assert.deepEqual(xterm256(16), [0, 0, 0]); // 立方体起点
  assert.deepEqual(xterm256(231), [255, 255, 255]); // 立方体终点
  assert.deepEqual(xterm256(232), [8, 8, 8]); // 灰阶起点
  assert.deepEqual(xterm256(255), [238, 238, 238]); // 灰阶终点
});

test('browser stream and server polling use the same command activity matcher', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/ansi.js'), 'utf8'), context);
  const server = require('../public/ansi').matchActivityLine;
  for (const line of [
    '• Waiting for background terminal · sleep 12 (3s • esc to interrupt)',
    '• Working (3s • esc to interrupt) · 2 background terminals running · /ps to view',
    'gpt-6-astra high · Conte…',
    '✽ mxops · p…',
    '• Running tests is useful.',
  ]) {
    assert.equal(
      JSON.stringify(context.window.StudioAnsi.matchActivityLine(line)),
      JSON.stringify(server(line)),
    );
  }
});

test('重试与等待后台代理是即时状态，它们不落存档，只能从终端画面认出', () => {
  // 形状取自 2026-09-22 手机终端的真实画面。
  const retry = matchActivityLine('✳ API error · Retrying in 0s · attempt 1/2');
  assert(retry, '重试状态必须认得出：认不出手机上就只看到长时间没动静');
  assert.equal(retry.running, true);
  assert.match(retry.body, /Retrying in 0s · attempt 1\/2/);

  const waiting = matchActivityLine('✳ Waiting for 1 background agent to finish');
  assert(waiting, '等待后台代理与等待后台终端形状不同，不能只认后者');
  assert.match(waiting.body, /Waiting for 1 background agent/);
  assert(matchActivityLine('✻ Waiting for 3 background agents to finish'), '复数形式同样要认');

  // 不能把正文里提到这些词的句子当成状态行。
  assert.equal(matchActivityLine('正文里提到 API error 但不是状态行'), null);
  assert.equal(matchActivityLine('讨论 Waiting for 1 background agent 这个措辞'), null);
});

test('✳ 也是一帧图标，缺了它整行都认不出来', () => {
  // 这个字符此前不在集合里，实测在手机终端截图中出现过。
  for (const icon of ['✳', '✻', '✽', '·', '●']) {
    const line = matchActivityLine(`${icon} Brewing… (48m)`);
    assert(line, `图标 ${icon} 开头的活动行应当认得出`);
    assert.equal(line.icon, icon);
    assert.equal(line.body, 'Brewing… (48m)');
  }
});

test('完成行只认固定的尾巴：界面叠上来的「Jump to bottom」和被盖残的时刻都不收', () => {
  const { matchActivityLine } = require('../public/ansi');
  // 2026-09-23 用户截图：Claude 界面被往上翻过，导航提示叠在完成行上，把「9:20 PM」盖成「9:2」。
  assert.equal(
    matchActivityLine('✻ Worked for 7m 0s · done 9:2 Jump to bottom (ctrl+End) ↓').text,
    '✻ Worked for 7m 0s',
  );
  assert.equal(
    matchActivityLine('✻ Worked for 7m 0s · done 9:20 PM').text,
    '✻ Worked for 7m 0s · done 9:20 PM',
  );
  assert.equal(
    matchActivityLine('✻ Cogitated for 2m 27s · done 1:13 PM · 11 shells, 2 monitors still running')
      .text,
    '✻ Cogitated for 2m 27s · done 1:13 PM · 11 shells, 2 monitors still running',
  );
  assert.equal(matchActivityLine('─ Worked for 9m 15s ──────────').text, '─ Worked for 9m 15s');
});

test('Codex context compaction is a live activity shared by browser, polling and VT projection', () => {
  const vm = require('node:vm'),
    fs = require('node:fs'),
    context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/ansi.js'), 'utf8'), context);
  for (const icon of ['•', '⠋', '⠙']) {
    const line = `${icon} Compacting context (12s • esc to interrupt)`;
    const activity = matchActivityLine(line);
    assert.equal(activity.running, true);
    assert.equal(activity.body, 'Compacting context (12s • esc to interrupt)');
    assert.deepEqual(
      JSON.stringify(activity),
      JSON.stringify(context.window.StudioAnsi.matchActivityLine(line)),
    );
  }
  for (const line of [
    'Compacting context is useful.',
    '• Compacting context is useful.',
    '› Compacting context (12s)',
    '• The code says Compacting context (12s)',
  ])
    assert.equal(matchActivityLine(line), null);
});
