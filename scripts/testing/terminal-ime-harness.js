'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');

const cases = [
  ['english', 'a'],
  ['digits-punctuation', '1.'],
  ['rapid', 'ab'],
  ['input-first', 'ab'],
  ['input-only', 'a'],
  ['delete', '\x7f\x7f'],
  ['delete-only', '\x7f'],
  ['forward-delete', '\x1b[3~'],
  ['soft-enter', '\r'],
  ['emoji', '🐈‍⬛'],
  ['legacy', 'ab'],
  ['legacy-delete', '\x7f\x7f'],
  ['legacy-enter', 'ab\r'],
  ['composition', '中文'],
  ['composition-controls', '中文'],
  ['composition-cancel', ''],
  ['composition-tail', '中文a'],
  ['composition-delete', ''],
  ['composition-twice', '中文文'],
  ['hardware', 'Ab1.\r\x7f\x03'],
  ['dispose-pending', ''],
];

// Replay DOM order against the shipped xterm and actual application socket.
// These are synthetic events, not a claim about a particular physical IME.
async function replay(el, kind) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
  const key = (type, keyCode = 229, name = 'Unidentified', composing = false) =>
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: name,
        keyCode,
        which: keyCode,
        isComposing: composing,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  const input = (value, data, inputType = 'insertText', isComposing = false) => {
    el.dispatchEvent(
      new InputEvent('beforeinput', {
        data,
        inputType,
        isComposing,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    el.value = value;
    el.dispatchEvent(
      new InputEvent('input', { data, inputType, isComposing, bubbles: true, composed: true }),
    );
  };
  const composition = (type, data = '') =>
    el.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, composed: true }));
  el.value = '';
  if (kind.startsWith('composition')) {
    key('keydown');
    composition('compositionstart');
    el.value = 'zhongwen';
    composition('compositionupdate', 'zhongwen');
    input('zhongwen', 'zhongwen', 'insertCompositionText', true);
    await pause();
    if (kind === 'composition-controls')
      for (const [name, code] of [
        ['PageDown', 34],
        ['PageUp', 33],
        ['Enter', 13],
        ['Escape', 27],
      ])
        key('keydown', code, name, true);
    const committed = kind === 'composition-cancel' ? '' : '中文';
    el.value = committed;
    composition('compositionupdate', committed);
    composition('compositionend', committed);
    input(committed, committed); // final input belongs to the composition finalizer
    if (kind === 'composition-tail') {
      key('keydown');
      input('中文a', 'a');
    }
    if (kind === 'composition-delete') {
      key('keydown');
      input('', null, 'deleteContentBackward');
    }
    if (kind === 'composition-twice') {
      composition('compositionstart');
      el.value = '中文wen';
      composition('compositionupdate', 'wen');
      el.value = '中文文';
      composition('compositionupdate', '文');
      composition('compositionend', '文');
      input('中文文', '文');
    }
    key('keyup');
  } else if (kind.startsWith('legacy') || kind === 'dispose-pending') {
    el.value = kind === 'legacy-delete' ? 'ab' : '';
    key('keydown');
    el.value = kind === 'legacy-delete' ? 'a' : 'a';
    key('keydown');
    el.value = kind === 'legacy-delete' ? '' : 'ab';
    if (kind === 'legacy-enter') key('keydown', 13, 'Enter');
    if (kind === 'dispose-pending') document.getElementById('chatModeToggle').click();
    else key('keyup');
  } else if (kind.includes('delete')) {
    el.value = 'ab';
    for (let index = 0; index < (kind === 'delete' ? 2 : 1); index++) {
      if (kind !== 'delete-only') key('keydown');
      input(
        el.value.slice(0, -1),
        null,
        kind === 'forward-delete' ? 'deleteContentForward' : 'deleteContentBackward',
      );
    }
    key('keyup');
  } else if (kind === 'soft-enter') {
    key('keydown');
    input('\n', null, 'insertLineBreak');
    key('keyup');
  } else {
    const text =
      kind === 'digits-punctuation'
        ? '1.'
        : kind === 'emoji'
          ? '🐈‍⬛'
          : ['rapid', 'input-first'].includes(kind)
            ? 'ab'
            : 'a';
    const values = kind === 'emoji' ? [text] : [...text];
    for (const value of values) {
      if (!['input-first', 'input-only'].includes(kind)) key('keydown');
      input(el.value + value, value);
      if (kind === 'input-first') key('keydown');
    }
    key('keyup');
  }
  await pause();
}

async function main() {
  const before = sourceFingerprint(process.cwd()),
    output = path.resolve('artifacts/testing/mobile-terminal-ime-fix/browser');
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'phone', width: 390, height: 844, touch: true },
      { name: 'desktop', width: 1280, height: 900, touch: false },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
      });
      try {
        for (const [kind, expected] of cases) {
          const page = await context.newPage(),
            errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          try {
            await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
            const toggle = page.locator('#chatModeToggle');
            // Presentation preference may persist across pages in this context.
            await expect(toggle).toBeVisible();
            if ((await toggle.getAttribute('aria-label')) === '切换到终端模式')
              await toggle.click();
            await expect(page.locator('#shellTerminal')).toContainText('native terminal');
            const textarea = page.locator('#shellTerminal .xterm-helper-textarea');
            await textarea.focus();
            const start = fixture.state.shellFrames.length;
            if (kind === 'hardware') {
              await page.keyboard.type('Ab1.');
              await page.keyboard.press('Enter');
              await page.keyboard.press('Backspace');
              await page.keyboard.press('Control+c');
            } else await textarea.evaluate(replay, kind);
            await page.waitForTimeout(100);
            const frames = fixture.state.shellFrames.slice(start),
              sent = frames
                .filter((frame) => frame.type === 'terminal.input')
                .map((frame) => frame.data)
                .join('');
            const result = { viewport: viewport.name, kind, sent, expected, errors };
            results.push(result);
            assert.equal(sent, expected, JSON.stringify(result));
            assert.deepEqual(errors, []);
            assert(
              !frames.some((frame) => frame.type === 'terminal.scroll'),
              'IME candidate keys must not scroll the terminal',
            );
            if (kind === 'dispose-pending') {
              await toggle.click();
              await expect(page.locator('#shellTerminal')).toContainText('native terminal');
              await page.waitForTimeout(100);
              assert.equal(
                fixture.state.shellFrames
                  .slice(start)
                  .filter((frame) => frame.type === 'terminal.input').length,
                0,
                'Disposed input must not be replayed on reconnect',
              );
            }
            console.log(`PASS ${viewport.name}: ${kind}`);
          } finally {
            await page.close();
          }
        }
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
    const after = sourceFingerprint(process.cwd());
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok:
            results.length === cases.length * 2 &&
            results.every((r) => r.sent === r.expected && !r.errors.length),
          before,
          after,
          browser: 'firefox',
          syntheticEvents: true,
          realPhone: false,
          productionInput: false,
          results,
        },
        null,
        2,
      ),
    );
    assert.equal(after.treeSha256, before.treeSha256, 'Source changed during verification');
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
