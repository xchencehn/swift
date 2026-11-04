'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TerminalLines } = require('../public/terminal-lines');

const E = '\x1b';

test('逐格光标定位写入要按位置放回去,不能首尾相连', () => {
  // 取自真实字节流:列号 33 / 35 / 61,中间是空白,整段没有换行
  const t = new TerminalLines();
  t.feed(`${E}[24;33H·${E}[24;35HGesticulating…${E}[24;61H5`);
  const line = t.text(24);
  assert.ok(line.includes('· Gesticulating…'), '符号与状态词之间的空格要留住');
  assert.ok(/Gesticulating…\s+5$/.test(line), '第 61 列那个数字不能被拼到状态词屁股上');
  assert.notEqual(line.trim(), '·Gesticulating…5');
});

test('同一行被覆写时,读到的是最后的样子', () => {
  const t = new TerminalLines();
  t.feed(`${E}[5;1HBrewing… (18s)`);
  t.feed(`${E}[5;1HBrewing… (19s)`);
  assert.equal(t.text(5), 'Brewing… (19s)');
});

test('清行之后旧内容不会留下尾巴', () => {
  const t = new TerminalLines();
  t.feed(`${E}[7;1H很长很长的一行内容`);
  t.feed(`${E}[7;1H${E}[K短`);
  assert.equal(t.text(7), '短');
});

test('整屏清除会丢掉上一屏的残影 —— 留着会被认成状态行', () => {
  const t = new TerminalLines();
  t.feed(`${E}[3;1H旧屏幕的内容`);
  t.feed(`${E}[2J`);
  assert.equal(t.text(3), '');
});

test('转义序列被数据块切断时,跨块拼回来', () => {
  const t = new TerminalLines();
  // 一次重绘被拆成两个 WebSocket 帧,定位序列正好断在中间
  t.feed(`${E}[12;`);
  t.feed(`5HBrewing…`);
  assert.equal(t.text(12).trim(), 'Brewing…');
});

test('颜色跟着格子走,能按段读回来', () => {
  const t = new TerminalLines();
  const toColor = (codes) =>
    codes[0] === 38 && codes[1] === 2 ? `rgb(${codes[2]},${codes[3]},${codes[4]})` : null;
  t.feed(`${E}[1;1H${E}[38;2;215;119;87m●${E}[0m${E}[1;3H${E}[38;2;153;153;153m(18s)`, toColor);
  const spans = t.spans(1);
  assert.equal(spans[0].text, '●');
  assert.equal(spans[0].color, 'rgb(215,119,87)');
  assert.ok(spans.some((s) => s.text.includes('(18s)') && s.color === 'rgb(153,153,153)'));
});

test('换行与回车照常工作 —— 普通输出不受影响', () => {
  const t = new TerminalLines();
  t.feed('第一行\r\n第二行');
  assert.equal(t.text(1), '第一行');
  assert.equal(t.text(2), '第二行');
});

test('只返回这次改动过的行,免得每次都全量扫', () => {
  const t = new TerminalLines();
  t.feed(`${E}[4;1H甲${E}[9;1H乙`);
  const touched = t.feed(`${E}[9;1H丙`);
  assert.deepEqual(touched, [9]);
});

test('长颜色序列被切断也不会泄漏成文本', () => {
  // 真彩色序列比早先那个长度阈值长,曾因此被当成普通字符写进行里:
  // 状态行出现过 `↓[0;38;2;249;2 almost done` 这样的泄漏。
  const t = new TerminalLines();
  t.feed(`${E}[5;1H↓ `);
  t.feed(`${E}[0;38;2;249;226;175;49`); // 半截,连结尾的 m 都还没到
  t.feed('m277 tokens');
  const line = t.text(5);
  assert.ok(!line.includes('38;2;249'), `转义参数泄漏进了文本: ${line}`);
  assert.ok(!line.includes('['), `方括号泄漏进了文本: ${line}`);
  assert.equal(line.trim(), '↓ 277 tokens');
});

test('半截 OSC 也要留到下一块', () => {
  const t = new TerminalLines();
  t.feed(`${E}[6;1H甲${E}]8;;http://exa`);
  t.feed(`mple.com${E}\\乙`);
  assert.equal(t.text(6), '甲乙');
});
