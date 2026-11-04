'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { inspectCodexScreen, projectTerminalScreen } = require('../public/native-status');
const { sideScreen } = require('../lib/codex-side');
const { codexBrowsing } = require('../lib/herdr-view');
const footer = 'GPT-6.1-Sol max · weekly 95% left · ~/project · task · Pursuing goal (50m)';
test('native display, thread and reading state agree across complete composer layouts', () => {
  for (const prompt of ['›', '❯', '»'])
    for (const gap of [[], ['']]) {
      const lines = [
        '• Working (51m 01s • esc to interrupt)',
        '',
        `${prompt} Ask Codex to do anything`,
        ...gap,
        footer,
      ];
      const state = inspectCodexScreen(lines);
      assert.equal(state.thread, 'main');
      assert.equal(state.inputTarget, 'composer');
      assert.equal(state.execution, 'running');
      assert.equal(state.reading, 'latest');
      assert(projectTerminalScreen(lines.map((text) => [{ text }])).recognized);
      assert.equal(sideScreen(lines.join('\n')).mode, state.thread);
    }
});
test('reading history remains independent of execution and tolerates native spacing and prompt variants', () => {
  for (const prompt of ['›', '❯', '»'])
    for (const divider of [' · ', '  ·  ']) {
      const lines = [
        '• Working (51m 01s • esc to interrupt)',
        '',
        `New activity${divider}↓ Back to bottom${divider}esc`,
        '',
        `${prompt} Ask Codex`,
        '',
        footer,
      ];
      const state = inspectCodexScreen(lines);
      assert.equal(state.thread, 'main');
      assert.equal(state.execution, 'running');
      assert.equal(state.reading, 'history');
      assert(state.capabilities.latest);
      assert(codexBrowsing(lines.join('\n')));
    }
  assert(!codexBrowsing('New activity · ↓ Back to bottom · esc\nordinary transcript\n› draft'));
});
test('question and menu input targets do not borrow main-thread authority from old footers', () => {
  const question = [
    '› old',
    '',
    footer,
    '• Queued follow-up inputs',
    '1 of 2',
    'Build target?',
    '› 1. Desktop',
    '  2. Mobile',
    'enter submit · ^] skip · shift+→ main prompt',
  ];
  assert.equal(inspectCodexScreen(question).inputTarget, 'question');
  assert.equal(inspectCodexScreen(question).thread, 'unknown');
  const menu = ['Choose a model', '› 1. GPT-6.1-Sol', '  2. Other', 'enter select · esc back'];
  assert.equal(inspectCodexScreen(menu).inputTarget, 'menu');
  assert.equal(inspectCodexScreen(menu).capabilities.compose, false);
});
test('multiline user drafts, partial footers and unknown layouts remain unverified', () => {
  for (const lines of [
    ['› explain this example', footer],
    ['› current', '', 'Future layout'],
    ['» Ask Codex', '~… Goal paused (/goal resume)'],
    ['›', '', '? for shortcuts'],
  ])
    assert.equal(inspectCodexScreen(lines).thread, 'unknown');
});
