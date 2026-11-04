'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { expect } = require('@playwright/test');
const { TerminalScreen } = require('../../lib/terminal-screen');
const { codexGoal } = require('../../lib/agent-goal');
async function publisher(fixture) {
  let frame;
  const screen = new TerminalScreen({
    cols: 250,
    rows: 45,
    onScreen: (value) => {
      frame = value;
    },
  });
  return {
    async publish(activity = 'Worked for 1h 53m 34s', extra = '', options = {}) {
      await screen.feed(
        '\x1b[H\x1b[2J' +
          activity +
          '\r\n' +
          (extra ? extra + '\r\n' : '') +
          '\r\n› \x1b[2mAsk Codex to do anything\x1b[0m\r\n\r\n' +
          (options.footer ??
            'GPT-6.1-Sol max · hh · Context 23% used · weekly 47% left · ~/workdir/swift · swift · feature/state-bar · Ready') +
          '\r\n' +
          (options.warnings === null
            ? '? for shortcuts'
            : `? for shortcuts                                    ⚠ ${options.warnings ?? 2} warnings · f2 to view`),
        { full: true },
      );
      assert(frame.projection.recognized);
      fixture.nativeScreen(frame, 'pane-codex');
      return frame;
    },
    async raw(value) {
      await screen.feed(value, { full: true });
      fixture.nativeScreen(frame, 'pane-codex');
      return frame;
    },
    close: () => screen.close(),
  };
}
async function facts(page, fixture, viewport, output) {
  const pub = await publisher(fixture);
  try {
    await pub.publish();
    await expect(page.locator('#chatExecutionState')).toHaveText('Worked');
    await expect(page.locator('#chatExecutionElapsed')).toHaveText('1h 53m 34s');
    await expect(page.locator('#chatQuotaAction')).toHaveText('weekly 47%');
    await expect(page.locator('#chatWarningsAction, #chatFeedbackAction, #sendState')).toHaveCount(
      0,
    );
    await expect(
      page.locator(
        '#chatNativeStatus, #chatNativeRegion, #chatNativeFooter, #chatActivity, #chatTip, #chatStatusline, #chatComposer',
      ),
    ).toHaveCount(0);
    await expect(page.locator('#chatLog')).not.toContainText('Worked for');
    // Observe the chat's own font loading; explicitly loading it here would hide a cold-start regression.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.locator('#commandInput').fill('状态栏操作期间保留草稿');
    const nativeWrites = () =>
      fixture.state.requests.filter(
        (row) =>
          row.route.startsWith('POST ') &&
          (/\/api\/(?:messages|herdr\/action|agent-settings|agents\/(?:questions|goal|interrupt))$/.test(
            row.route,
          ) ||
            (row.route === 'POST /api/command-interaction' && row.body?.action !== 'read')),
      ).length;
    const executed = () =>
      fixture.state.requests.filter(
        (row) => row.route === 'POST /api/command-interaction' && row.body.action === 'execute',
      );
    const executedBefore = executed().length;
    const posts = nativeWrites();
    const expectedAccountReads = viewport.fontScale ? 0 : 1;
    await page
      .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
      .click();
    const details = page.getByRole('region', { name: '会话状态', exact: true });
    await expect(details.locator('dt')).toContainText([
      'Session',
      'Status',
      'Account',
      'model',
      'Context',
      'Directory',
      'weekly',
      'Warnings',
    ]);
    const labels = await details.locator('dt').allTextContents();
    assert(labels.every((label) => /^[\x20-\x7e]+$/.test(label)));
    assert(!labels.some((label) => /alias|elapsed|delivery|native|reasoning/i.test(label)));
    await expect(
      details
        .locator('dl > div')
        .filter({ has: page.locator('dt', { hasText: /^model$/ }) })
        .locator('dd'),
    ).toHaveText(
      [
        fixture.state.sessions['pane-codex'].settings.model,
        fixture.state.sessions['pane-codex'].settings.effort,
      ]
        .filter(Boolean)
        .join(' '),
    );
    if (fixture.state.sessions['pane-codex'].pane.sessionFullTitle)
      await expect(details).toContainText(
        fixture.state.sessions['pane-codex'].pane.sessionFullTitle,
      );
    await expect(page.locator('#chatStatusDetailsAction')).toHaveCount(0);
    await expect(details).toContainText('connected@example.test (Pro)');
    assert.equal(
      nativeWrites() - posts,
      expectedAccountReads,
      'Opening status details reads the current account once per session',
    );
    await expect(details.locator('#chatInterrupt')).toBeDisabled();
    await expect(details.locator('.session-status-head')).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await expect(details).toContainText('Context');
    await expect(details).toContainText('Warnings');
    const cwd = fixture.state.sessions['pane-codex'].pane.cwd;
    if (cwd) await expect(details).toContainText(cwd);
    const geometry = await page.evaluate(() => {
      const box = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
      const region = document.querySelector('.session-status-popover');
      const font = (node) => {
        const style = getComputedStyle(node);
        return {
          fontFamily: style.fontFamily,
          fontSize: parseFloat(style.fontSize),
          lineHeight: parseFloat(style.lineHeight),
        };
      };
      const statusFont = font(document.querySelector('#chatExecutionState'));
      const canvas = document.createElement('canvas').getContext('2d');
      canvas.font = `${statusFont.fontSize}px ${statusFont.fontFamily}`;
      const advances = Array.from(
        { length: 95 },
        (_, index) => canvas.measureText(String.fromCharCode(32 + index)).width,
      );
      const resources = performance
        .getEntriesByType('resource')
        .map((row) => new URL(row.name).pathname);
      const resolveColor = (value) => {
        const node = document.createElement('span');
        node.style.color = value;
        document.body.append(node);
        const color = getComputedStyle(node).color;
        node.remove();
        return color;
      };
      return {
        controls: box('chatControls'),
        input: box('chatInput'),
        details: region.getBoundingClientRect().toJSON(),
        touchTargets: [...document.querySelectorAll('.chat-status-line button')]
          .filter((node) => node.getClientRects().length)
          .map((node) => {
            const style = getComputedStyle(node);
            return {
              label: node.textContent || node.ariaLabel,
              fixed: node.closest('.chat-status-fixed') !== null,
              width: node.getBoundingClientRect().width,
              height: node.getBoundingClientRect().height,
              fontSize: parseFloat(style.fontSize),
              lineHeight: parseFloat(style.lineHeight),
              paddingTop: parseFloat(style.paddingTop),
              paddingBottom: parseFloat(style.paddingBottom),
            };
          }),
        typography: {
          fields: [
            ...document.querySelectorAll(
              '.chat-status-field button, .chat-execution-state, .chat-execution-elapsed, .chat-status-separator',
            ),
          ].map((node) => ({
            name: node.id || node.parentElement.dataset.statusSlot + '-separator',
            ...font(node),
          })),
          uiFontFamily: getComputedStyle(document.documentElement).fontFamily,
          fixed: font(document.querySelector('#chatCurrentName')),
          detail: font(region.querySelector('dt')),
          faces: [...document.fonts]
            .filter((face) => face.family.replace(/["']/g, '') === 'Cascadia Mono')
            .map((face) => ({ status: face.status, style: face.style })),
          fontReady: document.fonts.check(`${statusFont.fontSize}px "Cascadia Mono"`, 'Wi0123'),
          fontFetched: resources.some((name) =>
            name.endsWith('/vendor/cascadia/CascadiaMono.woff2'),
          ),
          terminalLoaded:
            Boolean(document.querySelector('.xterm')) ||
            resources.some((name) => name.includes('/vendor/xterm/')),
          asciiGlyphs: advances.length,
          minAdvance: Math.min(...advances),
          maxAdvance: Math.max(...advances),
        },
        composerGap:
          document.querySelector('#chatInput').getBoundingClientRect().top -
          document.querySelector('#chatControls').getBoundingClientRect().bottom,
        fontScale:
          parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--device-font-scale'),
          ) || 1,
        statusFontSize: parseFloat(
          getComputedStyle(document.querySelector('#chatExecutionState')).fontSize,
        ),
        colors: {
          status: getComputedStyle(document.querySelector('#chatExecutionState')).color,
          background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
          detail: getComputedStyle(region.querySelector('dt')).color,
          detailBackground: getComputedStyle(region).backgroundColor,
          fixed: getComputedStyle(document.querySelector('#chatCurrentName')).color,
          detailValue: getComputedStyle(region.querySelector('dd')).color,
          detailEsc: getComputedStyle(region.querySelector('#chatInterrupt')).color,
          tokens: Object.fromEntries(
            ['muted', 'text', 'danger'].map((name) => [name, resolveColor(`var(--${name})`)]),
          ),
          semantic: [
            ['chatExecutionAction', 'var(--observe)'],
            ['chatIdentityAction', 'var(--goal-prefix, var(--observe))'],
            ['chatQuotaAction', 'var(--accent)'],
            ['chatModelAction', 'var(--observe)'],
            ['chatEffortAction', 'var(--goal-color, var(--observe))'],
          ].map(([id, token]) => ({
            id,
            color: getComputedStyle(document.getElementById(id)).color,
            original: resolveColor(token),
          })),
          slots: [...document.querySelectorAll('.chat-status-line button:not(:disabled)')]
            .filter((node) => node.getClientRects().length)
            .map((node) => ({
              label: node.ariaLabel || node.title,
              color: getComputedStyle(node).color,
            })),
        },
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.equal(geometry.overflow, 0);
    assert(geometry.details.left >= 0 && geometry.details.right <= viewport.width + 1);
    // The explicitly requested compact fixed controls are smaller than touch defaults.
    assert(
      geometry.touchTargets.every((row) => row.width > 0),
      JSON.stringify(geometry),
    );
    const scale = geometry.fontScale,
      baseline = 12 * scale;
    assert(
      geometry.touchTargets
        .filter((row) => !(viewport.touch && row.fixed))
        .every(
          (row) =>
            row.paddingTop === 2 &&
            row.paddingBottom === 4 &&
            Math.abs(row.height - baseline - 6) < 0.1 &&
            Math.abs(row.lineHeight - baseline) < 0.1 &&
            Math.abs(row.fontSize - (row.fixed ? 12 : 11) * scale) < 0.1,
        ),
      JSON.stringify(geometry),
    );
    if (viewport.touch)
      assert(
        geometry.touchTargets
          .filter((row) => row.fixed)
          .every((row) => row.width >= 44 && row.height >= 44),
        'Touch details must have an independent 44px target',
      );
    assert(Math.abs(geometry.composerGap) < 1, JSON.stringify(geometry));
    if (viewport.fontScale) assert.equal(scale, viewport.fontScale);
    const type = geometry.typography;
    assert(
      type.fontReady &&
        type.fontFetched &&
        type.faces.some((face) => face.style === 'normal' && face.status === 'loaded'),
      JSON.stringify(type),
    );
    assert.equal(type.terminalLoaded, false, 'Chat must load its font without mounting a terminal');
    assert.equal(
      type.fields.length,
      18,
      'Eight fields and nested status labels inherit the same font',
    );
    assert(
      type.fields.every(
        (row) =>
          /^['"]?Cascadia Mono['"]?(?:,|$)/.test(row.fontFamily) &&
          Math.abs(row.fontSize - 11 * scale) < 0.1 &&
          Math.abs(row.lineHeight - baseline) < 0.1,
      ),
      JSON.stringify(type),
    );
    assert(
      type.minAdvance > 0 && type.maxAdvance - type.minAdvance < 0.02 && type.asciiGlyphs === 95,
      JSON.stringify(type),
    );
    for (const row of [type.detail]) {
      assert.equal(row.fontFamily, type.uiFontFamily);
      assert(Math.abs(row.fontSize - baseline) < 0.1, JSON.stringify(row));
    }
    type.coldChatFontLoaded = true;
    type.asciiMonospaced = true;
    type.cascadiaMonoFields = true;
    type.nativeUiFontPreserved = true;
    const rgb = (value) =>
      value.startsWith('#')
        ? [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16))
        : value.startsWith('color(srgb ')
          ? value
              .slice(11)
              .split(/[\s/)]+/)
              .filter(Boolean)
              .slice(0, 3)
              .map((channel) => Number(channel) * 255)
          : value
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number);
    const luminance = (value) =>
      rgb(value)
        .map((channel) => channel / 255)
        .map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (one, two) => {
      const a = luminance(one),
        b = luminance(two);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    geometry.contrast = {
      status: contrast(geometry.colors.status, geometry.colors.background),
      detail: contrast(geometry.colors.detail, geometry.colors.detailBackground),
    };
    assert(
      geometry.contrast.status >= 4.5 && geometry.contrast.detail >= 4.5,
      JSON.stringify(geometry.contrast),
    );
    for (const slot of geometry.colors.slots)
      assert(contrast(slot.color, geometry.colors.background) >= 4.5, JSON.stringify(slot));
    const saturation = (value) => {
      const channels = rgb(value).map((channel) => channel / 255),
        max = Math.max(...channels),
        min = Math.min(...channels);
      return max === min ? 0 : (max - min) / (1 - Math.abs(max + min - 1));
    };
    for (const slot of geometry.colors.semantic) {
      assert(saturation(slot.color) < saturation(slot.original), JSON.stringify(slot));
    }
    assert.equal(
      new Set(geometry.colors.semantic.map((slot) => rgb(slot.color).join(','))).size,
      new Set(geometry.colors.semantic.map((slot) => rgb(slot.original).join(','))).size,
      'Native semantic colors must remain distinct',
    );
    for (const [actual, expected] of [
      ['detail', 'muted'],
      ['detailValue', 'text'],
      ['detailEsc', 'danger'],
    ]) {
      assert.deepEqual(
        rgb(geometry.colors[actual]),
        rgb(geometry.colors.tokens[expected]),
        actual + ' must retain its original theme color',
      );
    }
    type.scrollColorsSoftened = true;
    await expect(details.locator('.session-status-actions')).toBeInViewport();
    if (output) await page.screenshot({ path: path.join(output, viewport.name + '-details.png') });
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(
      page.locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible'),
    ).toBeFocused();
    await page
      .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
      .click();
    await expect(page.locator('.session-status-actions button')).toHaveText([
      'ESC',
      '刷新',
      '回到底部',
    ]);
    await page.keyboard.press('Escape');
    const added = executed().slice(executedBefore);
    assert(added.every((row) => row.body.text === '/status'));
    assert.equal(
      nativeWrites() - posts,
      expectedAccountReads,
      'Status and account details share the current account read',
    );
    await expect(page.locator('#commandInput')).toHaveValue('状态栏操作期间保留草稿');
    if (output)
      await page.screenshot({ path: path.join(output, viewport.name + '-statusbar.png') });
    return geometry;
  } finally {
    pub.close();
  }
}
async function progress(page, fixture, viewport, output) {
  const pub = await publisher(fixture);
  const input = page.locator('#commandInput');
  try {
    await input.fill('更新期间继续保留草稿');
    await pub.publish('• Working (10s • esc to interrupt)', '  └ Stable native summary.');
    await expect(page.locator('#chatExecutionState')).toHaveText('Working');
    await expect(page.locator('#chatStatusHint')).toHaveText('Stable native summary.');
    if (output)
      await page.screenshot({ path: path.join(output, viewport.name + '-working-hint.png') });
    await page.locator('#chatStatusHint').click();
    await expect(page.getByRole('region', { name: '提示', exact: true })).toHaveText(
      'Stable native summary.',
    );
    await expect(
      page.locator('.session-status-hint-content dl, .session-status-hint-content button'),
    ).toHaveCount(0);
    if (output)
      await page.screenshot({ path: path.join(output, viewport.name + '-hint-popover.png') });
    await page.evaluate(() => {
      const log = document.querySelector('#chatLog');
      log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - 120);
      const model = document.querySelector('#chatModelAction'),
        elapsed = document.querySelector('#chatExecutionElapsed');
      const note = document.querySelector('.session-status-hint-content');
      window.statusbarStability = {
        model,
        elapsed,
        note,
        top: log.scrollTop,
        height: log.scrollHeight,
        removed: 0,
        staticChanges: 0,
      };
      window.statusbarObserver = new MutationObserver((records) => {
        for (const record of records) statusbarStability.removed += record.removedNodes.length;
      });
      statusbarObserver.observe(document.querySelector('#chatControls'), {
        childList: true,
        subtree: true,
      });
      window.statusbarStaticObserver = new MutationObserver((records) => {
        statusbarStability.staticChanges += records.length;
      });
      statusbarStaticObserver.observe(model, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      statusbarStaticObserver.observe(note, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    for (let seconds = 11; seconds <= 17; seconds++) {
      fixture.nativeFull();
      await pub.publish(`• Working (${seconds}s • esc to interrupt)`, '  └ Stable native summary.');
      await expect(page.locator('#chatExecutionElapsed')).toHaveText(`${seconds}s`);
    }
    const stability = await page.evaluate(() => {
      statusbarObserver.disconnect();
      statusbarStaticObserver.disconnect();
      const old = statusbarStability;
      return {
        staticChanges: old.staticChanges,
        modelRetained: old.model === document.querySelector('#chatModelAction'),
        elapsedRetained: old.elapsed === document.querySelector('#chatExecutionElapsed'),
        noteRetained: old.note.isConnected,
        topDelta: document.querySelector('#chatLog').scrollTop - old.top,
        heightDelta: document.querySelector('#chatLog').scrollHeight - old.height,
      };
    });
    assert.equal(stability.staticChanges, 0);
    assert(stability.modelRetained && stability.elapsedRetained && stability.noteRetained);
    assert(
      Math.abs(stability.topDelta) <= 1 && stability.heightDelta === 0,
      JSON.stringify(stability),
    );
    await page.keyboard.press('Escape');
    await pub.publish(
      '• Compacting context (12s • esc to interrupt)',
      '  └ Making room to continue.',
    );
    await expect(page.locator('#chatExecutionState')).toHaveText('Compacting context');
    await pub.publish(
      'Worked for 1m 27s • 11:17',
      '  Recap: 已完成需求核对。\r\n    保留完整回顾和后续验证事项。',
    );
    await expect(page.locator('#chatExecutionState')).toHaveText('Worked');
    await expect(page.locator('#chatExecutionElapsed')).toHaveText('1m 27s · 11:17');
    await expect(page.locator('#chatStatusHint')).toContainText('Recap: 已完成需求核对。');
    if (output)
      await page.screenshot({ path: path.join(output, viewport.name + '-completion-recap.png') });
    await page.locator('#chatElapsedAction').scrollIntoViewIfNeeded();
    await page.locator('#chatElapsedAction').click();
    await expect(page.getByRole('region', { name: '耗时', exact: true })).toContainText('完成时间');
    await expect(page.getByRole('region', { name: '耗时', exact: true })).toContainText('11:17');
    await page.keyboard.press('Escape');
    await page.locator('#chatStatusHint').click();
    await expect(page.getByRole('region', { name: '提示', exact: true })).toContainText(
      '保留完整回顾和后续验证事项。',
    );
    await page.keyboard.press('Escape');
    await pub.publish('Worked for <1s • 2:28 AM');
    await expect(page.locator('#chatExecutionElapsed')).toHaveText('<1s · 2:28 AM');
    await expect(page.locator('#chatStatusHint')).toBeHidden();
    await pub.publish('Worked for 20s');
    await expect(page.locator('#chatExecutionState')).toHaveText('Worked');
    await expect(page.locator('#chatStatusHint')).toBeHidden();
    await page.waitForTimeout(1100);
    await expect(page.locator('#chatExecutionElapsed')).toHaveText('20s');
    await expect(input).toHaveValue('更新期间继续保留草稿');
    if (output)
      await fs.writeFile(
        path.join(output, viewport.name + '-stability.json'),
        JSON.stringify(stability, null, 2),
      );
    return stability;
  } finally {
    pub.close();
  }
}
async function goal(page, fixture, viewport, output) {
  fixture.state.sessions['pane-codex'].webStatus = {
    goal: codexGoal({ objective: '保留当前目标和预算，验证统一状态栏。', status: 'active' }),
  };
  fixture.changed();
  await expect(page.locator('#chatGoalState')).toHaveText('Pursuing goal');
  await facts(page, fixture, viewport, output);
  await progress(page, fixture, viewport, output);
  await expect(page.locator('#chatGoalText')).toContainText('保留当前目标和预算');
}
async function unknown(page, fixture, viewport, output) {
  const pub = await publisher(fixture);
  try {
    await pub.publish();
    await expect(page.locator('#chatExecutionState')).toHaveText('Worked');
    const stable = await page.locator('#chatControls').evaluate((node) => ({
      elapsed: node.querySelector('#chatExecutionElapsed').textContent,
      tone: node.querySelector('#chatExecutionAction').dataset.tone,
      width: node.querySelector('#chatStatusScroll').scrollWidth,
    }));
    const frame = await pub.raw(
      '\x1b[H\x1b[2J› old composer\r\nGPT-6.1-Sol max · /old-history\r\n\r\n» Ask Codex to do anything\r\n\r\n<future-footer> unknown',
    );
    assert(!frame.projection.recognized);
    await expect(page.locator('#chatStatusNotice')).toBeHidden();
    await expect(page.locator('#chatExecutionState')).toHaveText('Worked');
    assert.deepEqual(
      await page.locator('#chatControls').evaluate((node) => ({
        elapsed: node.querySelector('#chatExecutionElapsed').textContent,
        tone: node.querySelector('#chatExecutionAction').dataset.tone,
        width: node.querySelector('#chatStatusScroll').scrollWidth,
      })),
      stable,
      'brief native status loss must not change the visible status row',
    );
    await expect(page.locator('#chatLog')).not.toContainText('/old-history');
    await page
      .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
      .click();
    await expect(page.getByRole('region', { name: '会话状态', exact: true })).not.toContainText(
      '/old-history',
    );
    await page.keyboard.press('Escape');
    await pub.publish();
    await expect(page.locator('#chatStatusNotice')).toBeHidden();
    await pub.publish('Worked for 2s', '■ Server connection could not be restored');
    await expect(page.locator('#chatStatusNotice')).toBeHidden();
    await expect(page.locator('#chatExecutionState')).toHaveText('Worked');
    if (viewport.name === 'desktop') {
      await page.context().setOffline(true);
    }
    fixture.disconnect(true);
    await expect(page.locator('#chatExecutionState')).toHaveText('Worked');
    await expect(page.locator('#commandInput')).toBeEnabled();
    if (viewport.name === 'desktop') {
      await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'offline', {
        timeout: 5000,
      });
      await expect(page.locator('#chatExecutionState')).toHaveText('Offline', { timeout: 30000 });
      await expect(page.locator('#appShell')).not.toHaveAttribute('data-connection', 'connected');
      await page.context().setOffline(false);
    }
    fixture.disconnect(false);
    await pub.publish();
    await expect(page.locator('#chatExecutionState')).toHaveText('Worked', { timeout: 10000 });
    await expect(page.locator('#chatStatusNotice')).toBeHidden();
    if (output)
      await page.screenshot({ path: path.join(output, viewport.name + '-recovered.png') });
  } finally {
    fixture.disconnect(false);
    pub.close();
  }
}
async function dialogs(page, fixture) {
  const input = page.locator('#commandInput'),
    pub = await publisher(fixture);
  const title = () =>
    page.locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible');
  const execute = () =>
    fixture.state.requests.filter(
      (row) => row.route === 'POST /api/command-interaction' && row.body.action === 'execute',
    );
  try {
    await pub.publish();
    await input.fill('精简状态页保留聊天草稿');
    for (const terminal of [false, true]) {
      if (terminal) {
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#shellTerminal')).toBeVisible();
      }
      await title().click();
      const details = page.getByRole('region', { name: '会话状态', exact: true });
      await expect(details.locator('button')).toHaveText(['ESC', '刷新', '回到底部']);
      await expect(
        details.locator(
          '#chatWarningsAction, #chatBackgroundAction, #chatNativeAction, #chatShortcutsAction, #chatDetailsModel, #chatDetailsEffort, #chatDetailsMoveDraft',
        ),
      ).toHaveCount(0);
      await expect(details.locator('dt')).not.toContainText([
        '别名',
        '耗时',
        '消息投递',
        '原生提示',
      ]);
      const before = execute().length;
      await expect(details.locator('#chatRefreshStatus')).toBeEnabled();
      await details.locator('#chatRefreshStatus').click();
      await expect.poll(() => execute().length).toBe(before + 1);
      assert.equal(execute().at(-1).body.text, '/status');
      await expect(details).toContainText('connected@example.test');
      await expect(details.locator('#chatRefreshStatus')).toBeEnabled();
      const geometry = await details.locator('.session-status-actions').evaluate((row) => {
        const box = row.getBoundingClientRect(),
          children = [...row.children].map((node) => node.getBoundingClientRect().toJSON());
        return {
          left: box.left,
          right: box.right,
          center: (box.left + box.right) / 2,
          children,
          last: row === row.parentElement.lastElementChild,
        };
      });
      assert.equal(geometry.children[0].top, geometry.children[1].top);
      assert.equal(geometry.children[1].top, geometry.children[2].top);
      assert(Math.abs(geometry.children[0].left - geometry.left) < 1);
      assert(
        Math.abs((geometry.children[1].left + geometry.children[1].right) / 2 - geometry.center) <
          1,
      );
      assert(Math.abs(geometry.children[2].right - geometry.right) < 1);
      assert(geometry.last);
      await page.keyboard.press('Escape');
      await expect(details).toHaveCount(0);
      await expect(title()).toBeFocused();
      if (terminal) {
        await page.locator('#chatModeToggle').click();
        await expect(input).toHaveValue('精简状态页保留聊天草稿');
      }
    }
    assert(
      execute().every((row) => row.body.text === '/status'),
      'Details must not execute removed warning/background commands',
    );
    await title().click();
    await page.locator('#chatLatestAction').click();
    await expect(page.getByRole('region', { name: '会话状态', exact: true })).toHaveCount(0);
    await expect(input).toHaveValue('精简状态页保留聊天草稿');
  } finally {
    pub.close();
  }
}
async function legacy(page, fixture, viewport, output) {
  const session = fixture.state.sessions['pane-codex'];
  session.pane.agent.status = 'working';
  session.activity = '• Working (1h 2m 3s • esc to interrupt)';
  session.webStatus = {
    tip: 'Use /permissions to inspect the current permission mode.',
    statusline: ['gpt-test high · /fixture/workdir · weekly 81% left'],
  };
  fixture.changed();
  await expect(page.locator('#chatExecutionElapsed')).toHaveText(/1h 2m \d+s/);
  await page
    .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
    .click();
  const details = page.getByRole('region', { name: '会话状态', exact: true });
  await expect(details).not.toContainText('Use /permissions');
  await page.keyboard.press('Escape');
  await page.locator('#chatStatusHint').click();
  const tip = page.getByRole('region', { name: '提示', exact: true });
  await expect(tip).toContainText('Use /permissions');
  const height = await page
    .locator('#chatControls')
    .evaluate((node) => node.getBoundingClientRect().height);
  session.webStatus.tip += '很长的原生提示，不挤占状态栏。'.repeat(60);
  fixture.changed();
  await expect(tip).toContainText('很长的原生提示');
  assert.equal(
    await page.locator('#chatControls').evaluate((node) => node.getBoundingClientRect().height),
    height,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  if (output)
    await page.screenshot({
      path: path.join(output, viewport.name + '-legacy-status-details.png'),
    });
  await page.keyboard.press('Escape');
  session.activity = '';
  fixture.changed();
  await expect(page.locator('#chatExecutionState')).toHaveText('Working');
  session.pane.agent.status = 'done';
  fixture.changed();
  await expect(page.locator('#chatExecutionState')).not.toHaveText('Working');
}
async function legacyClock(page, fixture) {
  const session = fixture.state.sessions['pane-codex'];
  session.pane.agent.status = 'working';
  session.webStatus = {};
  for (const [native, formatted] of [
    ['19m 01s', '19m 1s'],
    ['1h 00m 01s', '1h 0m 1s'],
    ['01s', '1s'],
  ]) {
    session.activity = `• Working (${native} • esc to interrupt)`;
    fixture.changed();
    await expect(page.locator('#chatExecutionElapsed')).toHaveText(formatted);
  }
  fixture.activity('• Working (23m 59s • esc to interrupt)');
  await expect(page.locator('#chatExecutionElapsed')).toHaveText(/24m \d+s/, { timeout: 4000 });
  fixture.activity('• Working (59m 59s • esc to interrupt)');
  await expect(page.locator('#chatExecutionElapsed')).toHaveText(/1h 0m \d+s/, { timeout: 4000 });
}
async function fixedLayout(page, fixture, viewport, output) {
  const pub = await publisher(fixture);
  const desktopActions = !viewport.touch && viewport.width >= 761;
  const measure = () =>
    page.evaluate(() => {
      const line = document.querySelector('.chat-status-line').getBoundingClientRect();
      const rail = document.querySelector('.chat-status-details').getBoundingClientRect();
      const scroll = document.querySelector('#chatStatusScroll').getBoundingClientRect();
      const fields = [...document.querySelectorAll('.chat-status-field')].filter(
        (node) => !node.hidden,
      );
      const separator = getComputedStyle(document.querySelector('.chat-status-details'), '::after');
      return {
        slots: [...document.querySelectorAll('[data-status-slot]')].map((node) => ({
          name: node.dataset.statusSlot,
          width: node.getBoundingClientRect().width,
        })),
        fields: fields.map((node) => {
          const box = node.getBoundingClientRect(),
            button = node.querySelector('button');
          return {
            name: node.dataset.statusSlot,
            x: box.left,
            y: box.top,
            width: box.width,
            height: box.height,
            text: button.textContent,
            nowrap: getComputedStyle(button).whiteSpace,
            clipped: button.scrollWidth > button.clientWidth + 1,
          };
        }),
        dots: fields
          .map((node) => node.querySelector('.chat-status-separator'))
          .filter((node) => !node.hidden)
          .map((node) => ({
            text: node.textContent,
            color: getComputedStyle(node).color,
            ariaHidden: node.getAttribute('aria-hidden'),
          })),
        mutedColor: getComputedStyle(document.querySelector('.chat-status-separator')).color,
        lineHeight: line.height,
        lineLeft: line.left,
        lineRight: line.right,
        scroll: { left: scroll.left, right: scroll.right },
        lastFieldRight: fields.at(-1).getBoundingClientRect().right,
        railWidth: rail.width,
        railLeft: rail.left,
        railRight: rail.right,
        separator: {
          display: separator.display,
          left: parseFloat(separator.left),
          width: parseFloat(separator.width),
          height: parseFloat(separator.height),
          opacity: parseFloat(separator.opacity),
        },
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
  const nativeWrites = () =>
    fixture.state.requests.filter(
      (row) =>
        row.route.startsWith('POST ') &&
        (/\/api\/(?:messages|herdr\/action|agent-settings|agents\/(?:questions|goal|interrupt))$/.test(
          row.route,
        ) ||
          (row.route === 'POST /api/command-interaction' && row.body?.action !== 'read')),
    ).length;
  try {
    await pub.publish('• Working (9s • esc to interrupt)');
    await expect(page.locator('#chatExecutionElapsed')).toHaveText('9s');
    const initial = await measure(),
      samples = [];
    const rows = await page.evaluate(() =>
      ['.chat-status-activity', '.chat-status-hint-row', '.chat-status-line'].map((selector) =>
        document.querySelector(selector).getBoundingClientRect().toJSON(),
      ),
    );
    assert(rows.every((row) => Math.abs(row.height - initial.lineHeight) < 0.1));
    assert.equal(rows[0].bottom, rows[1].top);
    assert.equal(rows[1].bottom, rows[2].top);
    assert.deepEqual(
      initial.slots.map((item) => item.name),
      ['execution', 'elapsed', 'model', 'effort', 'identity', 'quota', 'directory', 'context'],
    );
    assert.equal(initial.scroll.left, initial.lineLeft);
    if (desktopActions) assert(initial.scroll.right < initial.railLeft);
    if (desktopActions) {
      assert(
        Math.abs(initial.railLeft - initial.lastFieldRight - 16) < 1,
        'Desktop actions follow the last status field',
      );
      assert(
        initial.railRight < initial.lineRight,
        'Desktop actions leave unused space on their right',
      );
      await expect(page.locator('#chatInterruptDesktop')).toBeVisible();
    } else {
      assert.equal(
        initial.railWidth,
        0,
        'Touch layout reserves no space for removed details button',
      );
      await expect(page.locator('#chatInterruptDesktop')).toBeHidden();
    }
    if (desktopActions) {
      assert.equal(initial.separator.left, -8);
      assert.equal(initial.separator.width, 1);
      assert(initial.separator.height < initial.lineHeight && initial.separator.opacity < 0.4);
    } else assert.equal(initial.separator.display, 'none');
    await expect(page.locator('#chatControls #chatInterrupt')).toHaveCount(0);
    await page.locator('#chatStatusScroll').hover();
    await page.mouse.wheel(180, 0);
    await expect(page.locator('#chatControls')).toBeVisible();
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    const states = [
      {
        activity: '• Working (59m 59s • esc to interrupt)',
        footer:
          'gpt-6-astra ultra · chen · Context 99% used · weekly 100% left · /very/long/directory · main',
        warnings: 999,
      },
      { activity: 'Worked for 1h 0m 0s', footer: 'gpt-6-sol high · /fixture', warnings: null },
      {
        activity: '• Compacting context (1h 0m 1s • esc to interrupt)',
        footer: 'gpt-6-astra max · chen · Context 3% used · weekly 4% left · /fixture',
        warnings: 0,
      },
    ];
    for (const sample of states) {
      await pub.publish(sample.activity, '', sample);
      await expect(page.locator('#chatExecutionElapsed')).toHaveText(
        require('../../public/chat/status-model').formatDuration(
          require('../../public/chat/status-model').seconds(sample.activity),
        ),
      );
      const current = await measure();
      assert.equal(current.lineHeight, initial.lineHeight);
      assert.equal(current.pageOverflow, 0);
      if (desktopActions) assert(Math.abs(current.railLeft - current.lastFieldRight - 16) < 1);
      else {
        assert.equal(current.railLeft, initial.railLeft);
        assert.equal(current.railRight, initial.railRight);
      }
      assert.equal(
        current.dots.length,
        current.fields.filter((field) => !['execution', 'elapsed'].includes(field.name)).length - 1,
      );
      assert(
        current.dots.every(
          (dot) =>
            dot.text === '·' && dot.color === current.mutedColor && dot.ariaHidden === 'true',
        ),
      );
      assert(
        current.fields.every(
          (field) =>
            field.nowrap === 'nowrap' &&
            (!field.clipped || field.name === 'directory') &&
            Math.abs(field.height - initial.lineHeight) < 0.1,
        ),
      );
      samples.push(current);
    }
    const widths = (name) =>
      samples.map((sample) => sample.fields.find((field) => field.name === name)?.width || 0);
    assert(new Set(widths('execution')).size > 1);
    assert(new Set(widths('elapsed')).size > 1);
    assert(
      samples.some((sample) => !sample.fields.some((field) => field.name === 'identity')),
      'Missing values leave no empty field',
    );
    await pub.publish();
    const writes = nativeWrites();
    for (const [id, label, expected] of [
      ['chatExecutionAction', '会话状态', 'Worked'],
      ['chatElapsedAction', '耗时', '1h 53m 34s'],
      ['chatQuotaAction', '用量', 'weekly 47% left'],
    ]) {
      const button = page.locator('#' + id);
      await button.scrollIntoViewIfNeeded();
      if (viewport.touch) await button.tap();
      else await button.click();
      const panel = page.getByRole('region', { name: label, exact: true });
      await expect(panel).toContainText(expected);
      assert((await panel.locator('dl > div').count()) <= 2);
      const box = await panel.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= viewport.width + 1);
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(button).toBeFocused();
    }
    assert.equal(nativeWrites(), writes);
    await page.locator('#chatIdentityAction').scrollIntoViewIfNeeded();
    await page.locator('#chatIdentityAction').click();
    const account = page.getByRole('region', { name: '账号', exact: true });
    await expect(account).toContainText('connected@example.test');
    await expect(account).toContainText('每周剩余额度');
    await expect(account).toContainText('47%');
    await expect(account.locator('.session-status-head')).toHaveCount(0);
    await page.keyboard.press('Escape');
    const afterAccount = nativeWrites();
    await page
      .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
      .click();
    await expect(page.locator('.session-status-actions button')).toHaveText([
      'ESC',
      '刷新',
      '回到底部',
    ]);
    await page.keyboard.press('Escape');
    assert.equal(nativeWrites(), afterAccount, 'Opening cached details stays local');
    await page.locator('#chatStatusScroll').evaluate((node) => {
      node.scrollLeft = 0;
    });
    if (output) {
      await page.screenshot({ path: path.join(output, viewport.name + '-fixed-slots.png') });
      await fs.writeFile(
        path.join(output, viewport.name + '-fixed-slots.json'),
        JSON.stringify({ initial, samples, localDetailsNoInput: true }, null, 2),
      );
    }
    return {
      fixedSlots: initial.slots.length,
      stateChanges: states.length,
      lineHeight: initial.lineHeight,
      contentWidthFields: true,
      grayNativeSeparators: true,
      scrollOnLeft: true,
      detailsOnRight: true,
      interruptInMenuOnly: true,
      localDetailsNoInput: true,
      pinnedActionsVisible: true,
      stripGesturesDoNotNavigate: true,
    };
  } finally {
    pub.close();
  }
}
async function operationFeedback(page, fixture, viewport, output) {
  const input = page.locator('#commandInput'),
    send = page.locator('#sendButton');
  const measure = () =>
    page.locator('#chatControls').evaluate((node) => {
      const line = node.querySelector('.chat-status-line'),
        css = getComputedStyle(line);
      return {
        height: node.getBoundingClientRect().height,
        lineHeight: line.getBoundingClientRect().height,
        border: css.borderTopWidth,
        background: css.backgroundColor,
        slots: [...node.querySelectorAll('[data-status-slot]')].map((item) => {
          const box = item.getBoundingClientRect();
          return { name: item.dataset.statusSlot, width: box.width, height: box.height };
        }),
      };
    });
  const initial = await measure();
  const initialStatus = await page.locator('#chatExecutionState').textContent();
  assert.equal(initial.border, '0px');
  assert.equal(initial.background, 'rgba(0, 0, 0, 0)');
  await input.fill('验证操作收据保持单行');
  fixture.setSendBehavior('验证操作收据保持单行', 'hold');
  await send.click();
  await expect(page.locator('#chatExecutionState')).toHaveText(initialStatus);
  const pending = await measure();
  assert.equal(pending.height, initial.height);
  await expect
    .poll(() =>
      fixture.state.requests.some(
        (row) => row.route === 'POST /api/messages' && row.body.text === '验证操作收据保持单行',
      ),
    )
    .toBe(true);
  const request = fixture.state.requests.find(
    (row) => row.route === 'POST /api/messages' && row.body.text === '验证操作收据保持单行',
  );
  fixture.release(request.body.id);
  await expect(page.locator('#chatExecutionState')).toHaveText(initialStatus);
  const accepted = await measure();
  assert.equal(accepted.height, initial.height);
  assert.deepEqual(
    accepted.slots.map((slot) => slot.name),
    initial.slots.map((slot) => slot.name),
  );
  await page.locator('#chatStatusScroll').evaluate((node) => {
    node.scrollLeft = 0;
  });
  if (output)
    await page.screenshot({ path: path.join(output, viewport.name + '-inline-receipt.png') });
  await page.route('**/api/messages', async (route) => {
    if (
      route.request().method() !== 'POST' ||
      route.request().postDataJSON().text !== '核对丢失的响应'
    )
      return route.continue();
    await route.fetch();
    await route.abort();
  });
  await input.fill('核对丢失的响应');
  await send.click();
  await expect(page.locator('#chatExecutionState')).toHaveText('Unconfirmed');
  if (viewport.width <= 760)
    await expect(page.locator('#chatExecutionState')).toHaveText('Unconfirmed');
  assert.equal((await measure()).height, initial.height);
  await page.locator('#chatExecutionAction').click();
  const details = page.getByRole('region', { name: '会话状态', exact: true });
  await expect(details).toContainText('结果尚未确认，请先核对，再决定是否重试。');
  await expect(page.locator('#chatDeliveryCheck')).toBeVisible();
  const posts = fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length;
  await input.fill('核对期间的新草稿');
  await page.locator('#chatDeliveryCheck').click();
  await expect(details).not.toContainText('Accepted');
  await expect(input).toHaveValue('核对期间的新草稿');
  assert.equal(
    fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
    posts,
  );
  assert.equal((await measure()).height, initial.height);
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await page.locator('#chatStatusScroll').evaluate((node) => {
    node.scrollLeft = 0;
  });
  return {
    noBorder: true,
    threeRowsDuringPendingAcceptanceAndUncertainty: true,
    readonlyReceiptCheck: true,
    preservedDraft: true,
    height: initial.height,
  };
}
async function settings(page, fixture) {
  const input = page.locator('#commandInput'),
    model = page.locator('#chatModelAction');
  const statusBeforeSettings = await page.locator('#chatExecutionState').textContent();
  const writes = () =>
    fixture.state.requests.filter((row) => row.route === 'POST /api/agent-settings');
  const before = writes().length;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/agent-settings', async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  try {
    await model.scrollIntoViewIfNeeded();
    await model.click();
    const menu = page.getByRole('menu');
    await expect(menu).toHaveAttribute('aria-label', 'Model');
    await expect(menu.locator('.popover-title')).toHaveCount(0);
    await expect(menu.locator('.popover-sub')).toHaveCount(0);
    await menu.getByRole('menuitem').filter({ hasText: '测试模型二' }).click();
    await expect(menu).toHaveAttribute('aria-label', 'Reasoning');
    await expect(menu.locator('.popover-sub')).toHaveCount(0);
    await menu.getByRole('menuitem').filter({ hasText: 'low' }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('#chatExecutionState')).toHaveText(statusBeforeSettings);
    await page
      .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
      .click();
    await expect(page.locator('#chatInterrupt')).toBeDisabled();
    await page.keyboard.press('Escape');
    await input.fill('设置异步保存期间的新草稿');
    await expect(input).toBeEnabled();
    release();
    await expect.poll(() => fixture.state.sessions['pane-codex'].settings.effort).toBe('low');
    await expect(model).toHaveText('codex-fixture-model-alternate');
    const effort = page.locator('#chatEffortAction');
    await effort.scrollIntoViewIfNeeded();
    await effort.click();
    await expect(menu).toHaveAttribute('aria-label', 'Reasoning');
    await expect(menu.locator('.popover-title')).toHaveCount(0);
    await menu.getByRole('menuitem').filter({ hasText: 'high' }).click();
    await expect.poll(() => fixture.state.sessions['pane-codex'].settings.effort).toBe('high');
    assert.equal(writes().length - before, 2);
    await expect(input).toHaveValue('设置异步保存期间的新草稿');
    return {
      modelSelectable: true,
      reasoningSelectable: true,
      shortNativeLabels: true,
      asyncPendingEditable: true,
      nativeSettingWrites: 2,
    };
  } finally {
    release();
    await page.unroute('**/api/agent-settings');
  }
}
async function queryRecovery(page, fixture) {
  const pub = await publisher(fixture),
    input = page.locator('#commandInput'),
    send = page.locator('#sendButton');
  let loseStatus = true;
  const writes = () =>
    fixture.state.requests.filter(
      (item) => item.route === 'POST /api/command-interaction' && item.body.action === 'execute',
    );
  const baseline = writes().length;
  await page.route('**/api/command-interaction', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action !== 'execute') return route.continue();
    if (body.text === '/status' && loseStatus) {
      loseStatus = false;
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  try {
    await pub.publish('• Working (4s • esc to interrupt)');
    await input.fill('查询等待期间保留的新草稿');
    await page.locator('#chatIdentityAction').scrollIntoViewIfNeeded();
    await page.locator('#chatIdentityAction').click();
    const account = page.getByRole('region', { name: '账号', exact: true });
    await account.getByRole('button', { name: '刷新账号' }).click();
    await expect(account).toContainText('connected@example.test');
    await expect(send).toBeEnabled();
    await expect(input).toHaveValue('查询等待期间保留的新草稿');
    await page.keyboard.press('Escape');
    assert.equal(
      writes()
        .slice(baseline)
        .filter((item) => item.body.text === '/status').length,
      1,
    );
    const session = fixture.state.sessions['pane-codex'];
    session.pane.agent.status = 'working';
    session.webStatus = {
      ...session.webStatus,
      goal: codexGoal({ objective: '中断时保留Goal与后台终端。', status: 'active' }),
    };
    fixture.changed();
    await pub.publish(
      '• Working (8s • esc to interrupt)',
      '• 1 background terminal running · /ps to view',
    );
    await expect(page.locator('#chatGoalText')).toContainText('中断时保留Goal与后台终端');
    const goalBefore = structuredClone(session.webStatus.goal),
      executeBeforeMenu = writes().length;
    await input.fill('中断前的新草稿');
    await expect(page.locator('#chatControls #chatInterrupt')).toHaveCount(0);
    await page
      .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
      .click();
    const desktopInterrupt = page.locator('#chatInterruptDesktop'),
      desktopActions = await desktopInterrupt.isVisible();
    const details = page.getByRole('region', { name: '会话状态', exact: true });
    const stop = desktopActions
      ? desktopInterrupt
      : details.getByRole('button', { name: 'ESC', exact: true });
    await expect(stop).toBeEnabled();
    assert.equal(writes().length, executeBeforeMenu);
    if (desktopActions) await page.keyboard.press('Escape');
    const callsBefore = (fixture.state.interruptCalls || []).length;
    let finishInterrupt;
    fixture.state.interruptGate = new Promise((resolve) => {
      finishInterrupt = resolve;
    });
    try {
      await stop.evaluate((button) => {
        button.click();
        button.click();
      });
      await expect.poll(() => (fixture.state.interruptCalls || []).length).toBe(callsBefore + 1);
      await expect(stop).toBeDisabled();
      await expect(stop).toHaveAttribute('aria-busy', 'true');
      await input.fill('中断等待期间继续编辑的新草稿');
      await expect(input).toBeEnabled();
      finishInterrupt();
      await expect.poll(() => session.pane.agent.status).toBe('idle');
      await pub.publish('Worked for 9s', '• 1 background terminal running · /ps to view');
      await expect(stop).toBeDisabled();
      await expect(stop).toHaveAttribute('aria-busy', 'false');
      if (desktopActions)
        await page
          .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
          .click();
      await expect(details).toContainText('Background terminals');
      await expect(
        details
          .locator('dl > div')
          .filter({ hasText: /^Background terminals/ })
          .locator('dd'),
      ).toHaveText('1');
      await expect(page.locator('#chatGoalText')).toContainText('中断时保留Goal与后台终端');
      assert.deepEqual(session.webStatus.goal, goalBefore);
      assert.equal(
        writes().length,
        executeBeforeMenu,
        'Menu interrupt must not execute /status or /stop',
      );
      const interruption = fixture.state.requests
        .filter((row) =>
          ['POST /api/messages/interrupt', 'POST /api/agents/interrupt'].includes(row.route),
        )
        .at(-1);
      assert.equal(interruption.body.currentTurn, true);
      assert.equal(interruption.body.paneId, 'pane-codex');
      await expect(input).toHaveValue('中断等待期间继续编辑的新草稿');
      await page.keyboard.press('Escape');
      await expect(details).toHaveCount(0);
      assert.equal(
        (fixture.state.interruptCalls || []).length,
        callsBefore + 1,
        'Escape closes this menu without interrupting again',
      );
      await expect(page.locator('#chatInterrupt')).toHaveCount(0);
    } finally {
      finishInterrupt();
      delete fixture.state.interruptGate;
    }
    return {
      accountReplyRecovered: true,
      removedNativeActionsAbsent: true,
      noRepeatedExecute: true,
      accountReadPreservedDraft: true,
      interruptExecuted: true,
      desktopInterrupt: desktopActions,
      detailsReadAccount: true,
      interruptBusyDisabled: true,
      interruptPreservedDraft: true,
      currentTurnOnly: true,
      goalAndBackgroundPreserved: true,
    };
  } finally {
    await page.unroute('**/api/command-interaction');
    pub.close();
  }
}
module.exports = {
  publisher,
  facts,
  progress,
  goal,
  unknown,
  dialogs,
  legacy,
  legacyClock,
  fixedLayout,
  operationFeedback,
  settings,
  queryRecovery,
};
