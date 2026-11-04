'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, normalize } = require('../public/chat/input-history');

// 最小的输入框替身：只要 value 与选区。
function input(value = '', caret = value.length) {
  return {
    value,
    selectionStart: caret,
    selectionEnd: caret,
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    },
  };
}
const key = (name, extra = {}) => ({
  key: name,
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  ...extra,
});

test('↑ 从最新一条往回翻，到头不动；↓ 往回走，翻过最新一条还原草稿', () => {
  let session = 'a';
  const applied = [];
  const history = create({
    entries: () => ['第一条', '第二条', '第三条'],
    key: () => session,
    apply: (text) => applied.push(text),
  });
  const box = input('正在写');
  // 光标在第一行末尾也算第一行：只要前面没有换行。
  assert.equal(history.keydown(key('ArrowUp'), box), true);
  assert.equal(box.value, '第三条');
  assert.equal(history.keydown(key('ArrowUp'), box), true);
  assert.equal(box.value, '第二条');
  assert.equal(history.keydown(key('ArrowUp'), box), true);
  assert.equal(box.value, '第一条');
  assert.equal(history.keydown(key('ArrowUp'), box), true);
  assert.equal(box.value, '第一条', '最早一条再按不动');
  assert.equal(history.keydown(key('ArrowDown'), box), true);
  assert.equal(box.value, '第二条');
  assert.equal(history.keydown(key('ArrowDown'), box), true);
  assert.equal(box.value, '第三条');
  assert.equal(history.keydown(key('ArrowDown'), box), true);
  assert.equal(box.value, '正在写', '翻过最新一条还原草稿');
  assert.equal(history.navigating(), false);
  assert.equal(history.keydown(key('ArrowDown'), box), false, '没在翻时 ↓ 不管');
  assert.deepEqual(applied, ['第三条', '第二条', '第一条', '第二条', '第三条', '正在写']);
});

test('多行时光标不在首行不翻、不在末行不往回；有修饰键、有选区、没有历史都不管', () => {
  const history = create({ entries: () => ['旧的'], key: () => 'a' });
  assert.equal(
    history.keydown(key('ArrowUp'), input('第一行\n第二行')),
    false,
    '光标在第二行：行间移动',
  );
  assert.equal(history.keydown(key('ArrowUp', { shiftKey: true }), input('')), false);
  const selected = input('选中');
  selected.selectionStart = 0;
  assert.equal(history.keydown(key('ArrowUp'), selected), false);
  assert.equal(
    create({ entries: () => [], key: () => 'a' }).keydown(key('ArrowUp'), input('')),
    false,
    '没有历史就照常',
  );
  // 翻出一条多行消息：光标放在开头，↓ 先在行间走，到了末行才往回。
  const multi = create({ entries: () => ['第一行\n第二行'], key: () => 'a' });
  const box = input('');
  multi.keydown(key('ArrowUp'), box);
  assert.equal(box.selectionStart, 0);
  assert.equal(multi.keydown(key('ArrowDown'), box), false, '不在末行：行间移动');
  box.setSelectionRange(box.value.length, box.value.length);
  assert.equal(multi.keydown(key('ArrowDown'), box), true);
  assert.equal(box.value, '');
});

test('每个会话各一份：换了会话，翻到一半的状态作废，从新会话的最新一条开始', () => {
  let session = 'a';
  const histories = { a: ['A1', 'A2'], b: ['B1'] };
  const history = create({ entries: () => histories[session], key: () => session });
  const box = input('');
  history.keydown(key('ArrowUp'), box);
  assert.equal(box.value, 'A2');
  session = 'b';
  box.value = '';
  box.setSelectionRange(0, 0);
  history.keydown(key('ArrowUp'), box);
  assert.equal(box.value, 'B1');
});

test('相邻重复与空白的只留一条', () => {
  assert.deepEqual(normalize(['a', ' a ', '', 'b', 'a']), ['a', 'b', 'a']);
});

test('显式导航与方向键共用历史位置，多行和选区不阻止触摸切换并完整恢复草稿', () => {
  const history = create({ entries: () => ['第一条\n下一行', '最新一条\n下一行'] });
  const box = input('未发送的草稿\n仍在编辑');
  box.setSelectionRange(2, 7);
  assert.equal(history.move(-1, box), true);
  assert.equal(box.value, '最新一条\n下一行');
  assert.equal(history.keydown(key('ArrowUp'), box), true);
  assert.equal(box.value, '第一条\n下一行');
  assert.equal(history.move(1, box), true);
  assert.equal(box.value, '最新一条\n下一行');
  assert.equal(history.move(1, box), true);
  assert.equal(box.value, '未发送的草稿\n仍在编辑');
  assert.equal(history.navigating(), false);
  assert.equal(history.move(1, box), false);
});

test('显式导航拒绝不可编辑输入和无效方向，换会话不带回原会话草稿', () => {
  let owner = 'a';
  const history = create({ key: () => owner, entries: () => (owner === 'a' ? ['A'] : ['B']) });
  const box = input('A 草稿');
  box.disabled = true;
  assert.equal(history.move(-1, box), false);
  box.disabled = false;
  box.readOnly = true;
  assert.equal(history.move(-1, box), false);
  box.readOnly = false;
  assert.equal(history.move(0, box), false);
  assert.equal(history.move(-1, box), true);
  assert.equal(box.value, 'A');
  owner = 'b';
  box.value = 'B 草稿';
  assert.equal(history.move(1, box), false);
  assert.equal(box.value, 'B 草稿');
  history.move(-1, box);
  assert.equal(box.value, 'B');
  history.move(1, box);
  assert.equal(box.value, 'B 草稿');
});

test('输入法预编辑的方向键不消费输入历史', () => {
  const history = create({ entries: () => ['历史'] });
  const box = input('正在选词');
  assert.equal(history.keydown(key('ArrowUp', { isComposing: true }), box), false);
  assert.equal(history.keydown(key('ArrowUp', { keyCode: 229 }), box), false);
  assert.equal(box.value, '正在选词');
  assert.equal(history.navigating(), false);
});
