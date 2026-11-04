'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readComposer } = require('../lib/agent-composer');

// 画面样本取自真实终端(herdr pane read --source visible),边框字符原样保留。
const RULE = '────────────────────────────────';

test('Claude 的两条线之间读出输入内容', () => {
  const screen = ['上面是正文', '', RULE, '❯ 帮我看下这个报错', RULE, '  [Opus 5] eff:high'].join(
    '\n',
  );
  assert.equal(readComposer(screen), '帮我看下这个报错');
});

test('Claude 输入框空着时返回空串', () => {
  const screen = ['正文', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on'].join('\n');
  assert.equal(readComposer(screen), '');
});

test('Claude 的多行输入合成一段,续行的对齐空格剥掉', () => {
  const screen = [RULE, '❯ 第一行', '  第二行', RULE].join('\n');
  assert.equal(readComposer(screen), '第一行\n第二行');
});

test('用户自己打的缩进要留住,只剥掉对齐用的那两格', () => {
  const screen = [RULE, '❯ def f():', '      return 1', RULE].join('\n');
  assert.equal(readComposer(screen), 'def f():\n    return 1');
});

test('Codex 单行输入读得出来', () => {
  const screen = ['正文', '', '› 把这个函数拆开', '  gpt-6-astra high · ~/workdir'].join('\n');
  assert.equal(readComposer(screen), '把这个函数拆开');
});

test('提示语照样读出来,由 composerHint 区分它不是用户打的字', () => {
  // 设计变更:终端里提示是显示着的(只是暗),所以这里也显示,靠 dim 标记画淡,
  // 而不是当它不存在 —— 全丢掉就看不出「输入框里现在长什么样」。
  const screen = ['正文', '› Ask Codex to do anything', '  gpt-6-astra high'].join('\n');
  assert.equal(readComposer(screen), 'Ask Codex to do anything');
});

test('认不出形状就返回空串,绝不把正文当成输入', () => {
  assert.equal(readComposer('就是一段普通输出\n没有任何输入框'), '');
  assert.equal(readComposer(''), '');
  assert.equal(readComposer(null), '');
  // 正文里的破折号不该被当成边框
  assert.equal(readComposer('结论 —— 这样更好\n再来一句'), '');
});

test('正文里出现横线时仍取最底下那一对', () => {
  const screen = [
    '前面的表格',
    RULE,
    '表格内容',
    RULE,
    '中间正文',
    RULE,
    '❯ 真正的输入',
    RULE,
  ].join('\n');
  assert.equal(readComposer(screen), '真正的输入');
});

// ---- 终端底部状态区 ----
const { readStatusArea } = require('../lib/agent-composer');

test('读出即时状态与状态栏(Claude)', () => {
  const screen = [
    '● 正文若干',
    '· Moseying… (35s · ↓ 1.9k tokens)',
    RULE,
    '❯ 写了一半的内容',
    RULE,
    '    [Opus 5 (1M context)] eff:high █░░░░░░ 9%  weekly 60%·2d5h  host',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents',
  ].join('\n');
  const r = readStatusArea(screen);
  assert.equal(r.composer, '写了一半的内容');
  assert.equal(r.activity, '· Moseying… (35s · ↓ 1.9k tokens)');
  assert.equal(r.statusline.length, 2);
  // 进度条是装饰,百分比要留住
  assert.ok(r.statusline[0].includes('Opus 5'));
  assert.ok(r.statusline[0].includes('eff:high'));
  assert.ok(r.statusline[0].includes('9%'));
  // 进度条留着:它在终端里是带颜色的,一眼能看出满没满,剥掉就把这条信息丢了
  assert.ok(r.statusline[0].includes('█'));
  assert.ok(r.statusline[1].includes('bypass permissions'));
});

test('读出状态栏(Codex,没有边框)', () => {
  const screen = [
    '正文',
    '› Ask Codex to do anything',
    '  gpt-6-astra high · ~/workdir/mxops · Ready · Context 25%',
  ].join('\n');
  const r = readStatusArea(screen);
  assert.equal(r.composer, 'Ask Codex to do anything', '提示照样读出来');
  // 这个样本是纯文本、没有颜色信息,所以判不出 dim —— 那时就不猜,按真实输入对待。
  // 提示的识别要靠带 ANSI 的画面,见上面那两个用例。
  assert.equal(r.composerHint, false, '没有颜色信息时不猜');
  assert.equal(r.statusline[0], 'gpt-6-astra high · ~/workdir/mxops · Ready · Context 25%');
});

test('Goal footer uses the current model and directory layout, retaining native colors and padding', () => {
  const footer =
    '\x1b[33mGPT-6-Astra ultra\x1b[0m · wwh · ~/workdir/cannbench · task           \x1b[36mPursuing goal (44s)\x1b[0m';
  const raw = [
    '• Working (49s · esc to interrupt)',
    '» \x1b[2mAsk Codex to do anything\x1b[0m',
    '',
    footer,
    '  ? for shortcuts',
    ...Array(30).fill('  '),
  ].join('\n');
  const result = readStatusArea(raw);
  assert.equal(result.composerHint, true);
  assert.match(result.statusline[0], /GPT-6-Astra ultra.*Pursuing goal \(44s\)/);
  assert(result.statusSpans[0].some((span) => span.text.includes('Pursuing goal') && span.color));
  assert.equal(result.activity, '• Working (49s · esc to interrupt)');
  const reordered = readStatusArea(
    '› \n\n  ~/project · wwh\n  GPT-6-Astra ultra           Pursuing goal (45s)',
  );
  assert.match(reordered.statusline.join('\n'), /GPT-6-Astra ultra.*Pursuing goal \(45s\)/);
  const stale = readStatusArea(
    '› old\n\n  GPT-6-Astra ultra · ~/old\n\n» current\n\n  unknown footer',
  );
  assert.deepEqual(stale.statusline, []);
});

test('没在运行时没有即时状态', () => {
  const screen = ['正文', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on'].join('\n');
  assert.equal(readStatusArea(screen).activity, '');
});

test('认不出结构时三个字段都是空的,不硬凑', () => {
  const r = readStatusArea('一段普通输出\n没有任何输入框');
  assert.equal(r.composer, '');
  assert.equal(r.activity, '');
  assert.deepEqual(r.statusline, []);
});

test('位置对但内容不像状态栏的不收 —— 正文绝不能冒充状态', () => {
  // pane 滚到历史位置时,正文里的 › 会冒充锚点(实测踩过)
  const screen = [
    '› 上一轮的引用内容',
    '• 需要跟进，其中文档错误已修复，三个 PR 的门禁已通过。',
    '1. 文档门禁已处理。两处错误是上轮添加锚点时漏了标题前空行。',
  ].join('\n');
  assert.deepEqual(readStatusArea(screen).statusline, []);
});

test('锚点离画面末尾太远就不认', () => {
  const far = ['❯ 很久以前的一行', ...Array.from({ length: 20 }, (_, i) => `正文第 ${i} 行`)];
  assert.deepEqual(readStatusArea(far.join('\n')).statusline, []);
});

test('两家的即时状态行都认得出来', () => {
  const claude = ['正文', '· Moseying… (35s · ↓ 1.9k tokens)', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(claude).activity, '· Moseying… (35s · ↓ 1.9k tokens)');
  // Codex 没有省略号,但有括号里的耗时
  const codex = ['正文', '• Working (12s · Esc to interrupt)', '› Ask Codex to do anything'].join(
    '\n',
  );
  assert.equal(readStatusArea(codex).activity, '• Working (12s · Esc to interrupt)');
  // spinner 每帧字符都不同,都要认
  const braille = ['正文', '⠹ Thinking…', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(braille).activity, '⠹ Thinking…');
});

test('正文里的列表项不会被当成即时状态', () => {
  const screen = ['· 这是一条普通的列表项，没有耗时也没有省略号', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(screen).activity, '');
});

test('完整的状态栏不因为长就被丢掉', () => {
  const long =
    '[Opus 5 (1M context)] eff:high █░░░░░░░░░░░░░░░░░░░ 9%  weekly 60%·2d5h  ' +
    'chenchen2@DESKTOP-LIIC751:/home/developer/workdir/mxops/.code/mxops/third_party/triton-sparse/spu';
  const screen = ['正文', RULE, '❯', RULE, '    ' + long].join('\n');
  const r = readStatusArea(screen);
  assert.equal(r.statusline.length, 1);
  assert.ok(r.statusline[0].length > 160, '长行要留住,按长度筛会把最全的那行扔掉');
  assert.ok(r.statusline[0].includes('█'), '进度条要留住,它在终端里是带颜色的');
});

// ---- 提示 vs 真实输入 ----
const ESC = '\x1b';

test('输入框里的提示按 dim 认出来,不按文本名单', () => {
  // 取自真实画面:提示是 \e[2m(dim),真实输入没有
  const hint = ['正文', `${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`].join(
    '\n',
  );
  const real = ['正文', `${ESC}[1m›${ESC}[0m 检查一下最新代码`].join('\n');
  assert.equal(readStatusArea(hint).composerHint, true);
  assert.equal(readStatusArea(real).composerHint, false);
  // 提示照样读出来 —— 终端里它是显示着的,只是淡
  assert.equal(readStatusArea(hint).composer, 'Ask Codex to do anything');
  assert.equal(readStatusArea(real).composer, '检查一下最新代码');
});

test('换一句没见过的提示语也能认出来 —— 这正是名单做不到的', () => {
  const screen = ['正文', `${ESC}[1m›${ESC}[0m ${ESC}[2m随便换一句全新的提示${ESC}[0m`].join('\n');
  assert.equal(readStatusArea(screen).composerHint, true);
});

test('即时状态带上 agent 自己的图标与颜色', () => {
  // Claude 的 ● 与状态词是它的橙色 logo 色,括号里的耗时才是灰的
  const screen = [
    `${ESC}[38;2;215;119;87m● Accomplishing… ${ESC}[0m${ESC}[38;2;153;153;153m(1m 4s · ↓ 3.5k tokens)${ESC}[0m`,
    RULE,
    '❯',
    RULE,
  ].join('\n');
  const r = readStatusArea(screen);
  // 返回整行含图标 —— 图标是 agent 自己的,前端要原样显示它
  assert.equal(r.activity, '● Accomplishing… (1m 4s · ↓ 3.5k tokens)');
  const spans = r.activitySpans;
  assert.ok(spans.length >= 2, '应当拆成带色的片段');
  assert.equal(spans[0].color, 'rgb(215,119,87)', '图标与状态词用 agent 自己的色');
  assert.ok(
    spans.some((s) => s.color === 'rgb(153,153,153)'),
    '耗时是灰的',
  );
});

test('任务结束后那行也要认出来 —— 终端上有,聊天页不该没有', () => {
  // Claude 完成后是 `✻ Crunched for 2m 27s · done 3:46 PM`
  const claude = ['正文', '✻ Crunched for 2m 27s · done 3:46 PM', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(claude).activity, '✻ Crunched for 2m 27s · done 3:46 PM');
  // Codex 完成后是 `─ Worked for 9m 15s ─────…`,两头的横线是装饰要剥掉
  const codex = [
    '正文',
    '─ Worked for 9m 15s ─────────────────────',
    '› Ask Codex to do anything',
  ].join('\n');
  assert.equal(readStatusArea(codex).activity, '─ Worked for 9m 15s');
  // ⚠️ 完成行的动词每次都换。2026-09-22 在真实终端上抓到 `Brewed`，而当时的
  // 判据只认死六个词，整行就此丢失。
  const brewed = ['正文', '✻ Brewed for 1m 0s · done 1:35 AM', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(brewed).activity, '✻ Brewed for 1m 0s · done 1:35 AM');
  // 判据是「一段时长」而不是动词表，所以正文里的同形句子不会被当成完成行。
  const prose = ['● Worked for a living and never once complained', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(prose).activity, '');
});

test('运行中那行要连耗时一起带上,不能只到省略号为止', () => {
  const screen = ['· Moseying… (35s · ↓ 1.9k tokens)', RULE, '❯', RULE].join('\n');
  // 非贪婪匹配到 `…` 就收会把耗时丢掉,而那正是最该看见的部分
  assert.equal(readStatusArea(screen).activity, '· Moseying… (35s · ↓ 1.9k tokens)');
});

test('状态栏碎片不会被认成状态行', () => {
  // 增量重绘时 `⏵⏵ … · ← 7 agents` 会留下 `· ←…` 这样的碎片,
  // 它也是「符号 + 内容 + 省略号」的形状 —— 靠「状态词必须字母开头」挡掉。
  const screen = ['· ←…', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(screen).activity, '');
  const screen2 = ['✽ …', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(screen2).activity, '');
  // 正常的状态词照样认
  const ok = ['✽ Actualizing… (48s · thinking)', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(ok).activity, '✽ Actualizing… (48s · thinking)');
});

test('Codex 撒在输入框那一带的装饰点要剥掉,否则宽度一帧一个样', () => {
  // 运行时它会在输入框行随机位置撒盲文点,每帧位置都不同
  const a = ['正文', '› 检查一下最新代码           ⠂  ⠁', '  gpt-6-astra high · Ready'].join('\n');
  const b = ['正文', '› 检查一下最新代码      ⠈      ⡀   ⠄', '  gpt-6-astra high · Ready'].join(
    '\n',
  );
  assert.equal(readComposer(a), '检查一下最新代码');
  assert.equal(readComposer(b), '检查一下最新代码');
  assert.equal(readComposer(a), readComposer(b), '两帧读出来必须一样长,否则显示会抖');
});

test('状态行里的盲文 spinner 不能跟着被剥 —— 那是真状态', () => {
  const screen = ['⠹ Thinking…', RULE, '❯', RULE].join('\n');
  assert.equal(readStatusArea(screen).activity, '⠹ Thinking…');
});

test('command waiting headers and background terminal counts remain complete', () => {
  for (const activity of [
    '• Waiting for background terminal · sleep 12 (3s • esc to interrupt)',
    '• Running npm test (4s • esc to interrupt)',
    '• Working (4s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close',
  ]) {
    const screen = [activity, '›', 'gpt-6-astra high · Context 85% · Con…'].join('\n');
    assert.equal(readStatusArea(screen).activity, activity);
  }
  assert.equal(readStatusArea('gpt-6-astra high · Conte…').activity, '');
  assert.equal(readStatusArea('• Running tests is useful.').activity, '');
});
