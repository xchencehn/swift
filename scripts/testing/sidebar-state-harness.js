'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/testing/sidebar-state/browser');
const viewports = [
  { name: 'desktop', width: 1920, height: 1080, touch: false },
  { name: 'tablet', width: 1024, height: 768, touch: true },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'mobile-small', width: 320, height: 640, touch: true },
];
const tabs = {
  workspace: '#sidebarWorkspaces',
  recent: '#sidebarRecent',
  history: '#sidebarHistory',
};
const modes = Object.keys(tabs);
const offsets = { workspace: 180, recent: 460, history: 740 };

function populate(state) {
  state.productionPresentation = true;
  state.sync = true;
  const seed = structuredClone(state.sessions['pane-codex']);
  const repository = 'sidebar-state-repository';
  state.workspaces.push(
    {
      workspaceId: 'repository',
      label: 'Repository',
      cwd: '/fixture/repository',
      worktree: {
        repo_key: repository,
        is_linked_worktree: false,
        checkout_path: '/fixture/repository',
      },
    },
    {
      workspaceId: 'linked',
      label: 'Linked worktree',
      cwd: '/fixture/repository-linked',
      worktree: {
        repo_key: repository,
        is_linked_worktree: true,
        checkout_path: '/fixture/repository-linked',
      },
    },
  );
  for (let i = 0; i < 60; i++) {
    const workspaceId = 'space-' + i,
      group = i < 30 ? 'Alpha' : 'Beta';
    state.workspaces.push({
      workspaceId,
      label: group + ' Space ' + i,
      cwd: '/fixture/project-' + i,
    });
    for (let j = 0; j < 2; j++) {
      const id = 'sidebar-pane-' + i + '-' + j,
        session = structuredClone(seed);
      Object.assign(session.pane, {
        paneId: id,
        terminalId: id + '-terminal',
        tabId: id + '-tab',
        workspaceId,
        workspace: group + ' Space ' + i,
        title: group + ' Agent ' + i + '-' + j,
        displayAgent: group + ' Agent ' + i + '-' + j,
        tabTitle: group + ' Tab ' + i + '-' + j,
        cwd: '/fixture/project-' + i,
      });
      session.pane.agent.session.value = id + '-session';
      state.sessions[id] = session;
    }
  }
  for (const id of ['repository', 'linked']) {
    const session = structuredClone(seed);
    Object.assign(session.pane, {
      paneId: id,
      terminalId: id + '-terminal',
      tabId: id + '-tab',
      workspaceId: id,
      workspace: id,
      title: id,
      cwd: '/fixture/' + id,
    });
    session.pane.agent.session.value = id + '-session';
    state.sessions[id] = session;
  }
  state.tabs = Object.values(state.sessions).map((s) => ({
    tab_id: s.pane.tabId,
    workspace_id: s.pane.workspaceId,
    label: s.pane.title,
  }));
  state.history = Array.from({ length: 120 }, (_, i) => ({
    provider: 'codex',
    sessionId: 'sidebar-archive-' + i,
    title: (i < 60 ? 'Alpha' : 'Beta') + ' Archive ' + i,
    cwd: '/fixture/archive-' + i,
    lastMessageAt: Date.now() - (i + 1) * 60000,
    updatedAt: Date.now(),
  }));
}

async function oneViewport(browser, viewport) {
  const fixture = await createFixture();
  populate(fixture.state);
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [],
    releases = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort(),
  );
  const list = page.locator('#chatPickerList');
  const narrow = viewport.width < 761;
  const result = { viewport, ok: false, checks: [], measurements: [] };
  let stage = 'startup',
    animated = false;
  const mark = (name) => result.checks.push(name);
  const snapshot = async (label) => {
    const measurement = await list.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const visible = [...el.children].find((child) => {
        const r = child.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom;
      });
      return {
        mode: el.dataset.mode,
        top: el.scrollTop,
        height: el.clientHeight,
        scrollHeight: el.scrollHeight,
        visible:
          visible?.dataset.paneId ||
          visible?.dataset.historyId ||
          visible?.dataset.workspaceId ||
          '',
        overflow: document.documentElement.scrollWidth - innerWidth,
        mainPanelScrollLeft: document.querySelector('.main-panel').scrollLeft,
        mainPanelHeight: document.querySelector('.main-panel').getBoundingClientRect().height,
        viewportHeight: innerHeight,
      };
    });
    result.measurements.push({ label, ...measurement });
    return measurement;
  };
  const assertTop = async (top, label) => {
    await expect
      .poll(() => list.evaluate((el, target) => Math.abs(el.scrollTop - target) <= 1, top), {
        message: label,
      })
      .toBe(true);
    const value = await snapshot(label);
    assert(
      Math.abs(value.top - top) <= 1,
      label + ': ' + JSON.stringify(value) + ' expected ' + top,
    );
    assert.equal(value.overflow, 0);
    assert.equal(
      value.mainPanelScrollLeft,
      0,
      label + ': Focusing navigation must not scroll the main viewport',
    );
    assert(
      value.mainPanelHeight > 0 && value.mainPanelHeight <= value.viewportHeight + 1,
      label + ': The main grid item must stay within the viewport height',
    );
  };
  const scroll = async (top, label) => {
    const actual = await list.evaluate((el, value) => {
      el.scrollTop = value;
      el.dispatchEvent(new Event('scroll'));
      return el.scrollTop;
    }, top);
    assert.equal(actual, top, 'Fixture must have enough actual content for ' + label);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await assertTop(top, label);
  };
  const selected = async (mode) => {
    await expect(page.locator(tabs[mode])).toHaveAttribute('aria-selected', 'true');
    await expect(list).toHaveAttribute('data-mode', mode);
    if (mode === 'history') await expect(list.locator('.history-item')).toHaveCount(120);
  };
  const select = async (mode) => {
    await page.locator(tabs[mode]).click();
    await selected(mode);
  };
  const isOpen = () =>
    page.evaluate(
      (narrow) =>
        narrow
          ? document.querySelector('#chatSidebar').classList.contains('open')
          : !document.querySelector('#chatView').classList.contains('sidebar-collapsed'),
      narrow,
    );
  const closed = () => expect.poll(isOpen).toBe(false);
  const open = async (expected) => {
    assert.equal(await isOpen(), false);
    await page.locator('#chatDrawerToggle').click();
    await expect.poll(isOpen).toBe(true);
    await selected('workspace');
    if (expected !== undefined)
      await assertTop(expected, 'Every reopen restores Spaces own position');
  };
  const close = async () => {
    if (narrow)
      await page.locator('#chatPickerScrim').click({ position: { x: viewport.width - 3, y: 80 } });
    else await page.locator('#chatSidebarCollapse').click();
    await closed();
  };
  // Synthetic touch events exercise the application recognizer. Native browser
  // wheel scrolling is checked separately; this is not a physical-device claim.
  const swipe = async (
    right,
    target = '#chatPickerList',
    { short = false, cancel = false } = {},
  ) => {
    await page.locator(target).evaluate(
      async (el, options) => {
        const box = el.getBoundingClientRect(),
          x = box.left + box.width * (options.right ? 0.22 : 0.78);
        const y = box.top + Math.min(box.height / 2, 200);
        const hit = document.elementFromPoint(x, y);
        const target = hit && el.contains(hit) ? hit : el;
        const touch = (at) => ({ identifier: 7, target, clientX: at, clientY: y });
        const event = (type, at, ended = false) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.assign(event, { touches: ended ? [] : [touch(at)], changedTouches: [touch(at)] });
          target.dispatchEvent(event);
        };
        event('touchstart', x);
        const delta = (options.right ? 1 : -1) * (options.short ? 25 : box.width * 0.65);
        event('touchmove', x + delta);
        if (
          options.animated &&
          (!document.querySelector('.tab-glider') ||
            !el.parentElement.querySelector('.session-list[aria-hidden="true"][inert]') ||
            !el.style.transform)
        ) {
          throw new Error('Animated swipe must actually start the tab transition before release');
        }
        if (options.short) await new Promise((resolve) => setTimeout(resolve, 120));
        event(options.cancel ? 'touchcancel' : 'touchend', x + delta, true);
      },
      { right, short, cancel, animated },
    );
    await expect(page.locator('.tab-glider')).toHaveCount(0);
    await expect.poll(() => list.evaluate((el) => el.style.transform)).toBe('');
  };
  const seedOffsets = async () => {
    for (const mode of modes) {
      await select(mode);
      await scroll(offsets[mode], 'Seed ' + mode);
    }
  };
  const roundTrip = async (label) => {
    for (const mode of ['workspace', 'recent', 'history', 'recent', 'workspace']) {
      await select(mode);
      await assertTop(offsets[mode], label + ' ' + mode);
    }
  };
  const refresh = async (mode, label) => {
    if (mode === 'history') fixture.state.history[0].title = 'Alpha Archive 0 ' + label;
    else if (mode === 'workspace')
      fixture.state.workspaces = fixture.state.workspaces.map((workspace, i, all) =>
        i === all.length - 1 ? { ...workspace, label: 'Beta Space refreshed ' + label } : workspace,
      );
    else
      fixture.state.sessions['sidebar-pane-0-0'].pane.displayAgent =
        'Alpha Agent refreshed ' + label;
    // The fixture dashboard retains workspace references. Replace changed
    // records like a real snapshot, and advance its archive safety refresh.
    fixture.state.clockAdvance = (fixture.state.clockAdvance || 0) + 61000;
    fixture.changed();
    await fixture.synced();
    await expect(list).toContainText(label);
  };
  const textPoints = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    return locator.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) if (node.textContent.trim().length >= 4) break;
      if (!node) throw new Error('Expected actual visible text for selection');
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(8, node.length));
      const box = range.getClientRects()[0];
      return { x: box.left + 1, end: box.right - 1, y: box.top + box.height / 2 };
    });
  };
  const dragText = async (locator, releaseOutsideControl = false) => {
    const point = await textPoints(locator);
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.end, point.y, { steps: 8 });
    if (releaseOutsideControl) {
      const sidebarBox = await page.locator('#chatSidebar').boundingBox();
      await page.mouse.move(sidebarBox.x + 2, sidebarBox.y + 2, { steps: 3 });
    }
    await page.mouse.up();
    return page.evaluate(() => getSelection().toString());
  };
  const waitForDrawer = async () => {
    if (narrow)
      await expect
        .poll(() =>
          page
            .locator('#chatSidebar')
            .evaluate((el) => Math.abs(el.getBoundingClientRect().left) <= 1),
        )
        .toBe(true);
  };
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await expect(page.locator('.sidebar-modes [role="tab"]')).toHaveText([
      'spaces',
      'agent',
      'archive',
      'files',
    ]);
    await page.evaluate(() => document.fonts.ready);
    if (!(await isOpen())) await open();
    await select('workspace');
    await page.screenshot({ path: path.join(output, viewport.name + '-initial.png') });
    stage = 'three independent page offsets';
    await seedOffsets();
    await roundTrip('Button round trip');
    mark('threeIndependentOffsetsByButtons');

    stage = 'reduced motion swipes';
    for (const [right, mode] of [
      [false, 'recent'],
      [false, 'history'],
      [true, 'recent'],
      [true, 'workspace'],
    ]) {
      await swipe(right);
      await selected(mode);
      await assertTop(offsets[mode], 'Reduced motion swipe ' + mode);
    }
    mark('reducedMotionSwipesKeepEachOffset');
    stage = 'close and reopen from each page';
    for (const mode of modes) {
      await select(mode);
      await assertTop(offsets[mode], 'Before close ' + mode);
      await close();
      await open(offsets.workspace);
      await select(mode);
      await assertTop(offsets[mode], 'Other page retained after reopening ' + mode);
    }
    mark(narrow ? 'scrimCloseReopensSpaces' : 'buttonCollapseReopensSpaces');

    stage = 'selection closes navigation without losing other offsets';
    for (const mode of ['recent', 'history']) {
      await select(mode);
      const before = await list.evaluate((el) => el.scrollTop);
      const identity = await list.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const row = [...el.querySelectorAll('.session-item')].find((node) => {
          const r = node.getBoundingClientRect();
          return r.top >= box.top + 8 && r.bottom <= box.bottom - 8;
        });
        return row.dataset.paneId
          ? { key: 'data-pane-id', value: row.dataset.paneId }
          : { key: 'data-history-id', value: row.dataset.historyId };
      });
      await list.locator('[' + identity.key + '="' + identity.value + '"]').click();
      if (narrow) await closed();
      else await close();
      await open(offsets.workspace);
      await select(mode);
      await assertTop(before, 'Selection keeps ' + mode + ' position');
    }
    mark('paneAndArchiveSelectionReopenSpaces');
    // Return from read-only archive viewing before exercising live snapshots.
    await select('recent');
    const liveId = await list.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('[data-pane-id]')].find((node) => {
        const r = node.getBoundingClientRect();
        return r.top >= box.top + 8 && r.bottom <= box.bottom - 8;
      }).dataset.paneId;
    });
    await list.locator('[data-pane-id="' + liveId + '"]').click();
    await expect(page.locator('#chatArchivedNotice')).toBeHidden();
    if (narrow) await open(offsets.workspace);
    await seedOffsets();
    stage = 'closing and reopening with a horizontal gesture';
    await select('history');
    await swipe(false);
    await expect(page.locator('#sidebarFiles')).toHaveAttribute('aria-selected', 'true');
    await swipe(false, '#workspaceFilesTree');
    await closed();
    await swipe(true, '#chatLog');
    await expect.poll(isOpen).toBe(true);
    await selected('workspace');
    await assertTop(offsets.workspace, 'Gesture reopen keeps Spaces position');
    await select('history');
    await assertTop(offsets.history, 'Gesture close keeps Archive position');
    mark('gestureCloseFromFilesPreservesPagePositions');

    stage = 'visible and hidden snapshot refresh';
    for (const mode of modes) {
      await select(mode);
      await assertTop(offsets[mode], 'Before visible refresh ' + mode);
      await refresh(mode, 'visible-' + mode);
      await assertTop(offsets[mode], 'Visible refresh ' + mode);
      await close();
      await refresh(mode, 'hidden-' + mode);
      await open(offsets.workspace);
      await select(mode);
      await assertTop(offsets[mode], 'Hidden refresh ' + mode);
    }
    mark('visibleAndHiddenRefreshPreserveOffsets');

    stage = 'Space and linked worktree expansion';
    await select('workspace');
    await scroll(0, 'Reach repository folders');
    const heading = (id) =>
      list.locator('.chat-tree-group[data-workspace-id="' + id + '"] .chat-tree-toggle');
    await heading('repository').click();
    await expect(heading('repository')).toHaveAttribute('aria-expanded', 'false');
    await expect(heading('linked')).toHaveCount(0);
    await heading('space-0').click();
    await expect(heading('space-0')).toHaveAttribute('aria-expanded', 'false');
    await close();
    await open(0);
    await expect(heading('repository')).toHaveAttribute('aria-expanded', 'false');
    await expect(heading('linked')).toHaveCount(0);
    await heading('repository').click();
    await expect(heading('linked')).toHaveAttribute('aria-expanded', 'true');
    await heading('linked').click();
    await expect(heading('linked')).toHaveAttribute('aria-expanded', 'false');
    await select('recent');
    await select('workspace');
    await close();
    await open(0);
    await expect(heading('repository')).toHaveAttribute('aria-expanded', 'true');
    await expect(heading('linked')).toHaveAttribute('aria-expanded', 'false');
    await expect(heading('space-0')).toHaveAttribute('aria-expanded', 'false');
    await refresh('workspace', 'tree-refresh');
    await expect(heading('linked')).toHaveAttribute('aria-expanded', 'false');
    await page.screenshot({ path: path.join(output, viewport.name + '-tree-state.png') });
    mark('spaceAndWorktreeExpansionPreserved');

    stage = 'independent long search results and delayed Archive results';
    await seedOffsets();
    await select('workspace');
    await page.locator('#chatSearchToggle').click();
    const search = page.locator('#chatPickerSearch'),
      queryOffsets = {
        Alpha: { workspace: 120, recent: 260, history: 380 },
        Beta: { workspace: 210, recent: 350, history: 470 },
      };
    let releaseAlpha,
      alphaRequest,
      alphaRequested = false;
    await page.route('**/api/history?*', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('q');
      if (query === 'Alpha' && !alphaRequested) {
        alphaRequested = true;
        alphaRequest = route.request();
        await new Promise((resolve) => {
          releaseAlpha = resolve;
          releases.push(resolve);
        });
      }
      await route.continue();
    });
    for (const query of ['Alpha', 'Beta']) {
      await search.fill(query);
      for (const mode of modes) {
        await page.locator(tabs[mode]).click();
        await expect(list).toHaveAttribute('data-mode', mode);
        if (mode === 'history' && query === 'Alpha') {
          await expect.poll(() => alphaRequested && typeof releaseAlpha === 'function').toBe(true);
          await search.fill('Beta');
          await expect(list.locator('.history-item')).toHaveCount(60);
          await scroll(queryOffsets.Beta.history, 'Beta Archive before delayed Alpha');
          const lateResponse = page.waitForResponse(
            (response) => response.request() === alphaRequest,
          );
          releaseAlpha();
          await (await lateResponse).finished();
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          await page.unrouteAll({ behavior: 'wait' });
          await expect(list.locator('.history-item')).toHaveCount(60);
          await expect(list.locator('.history-item').first()).toContainText('Beta Archive');
          await expect(list).not.toContainText('Alpha Archive');
          await assertTop(queryOffsets.Beta.history, 'Delayed Alpha cannot replace Beta position');
          await search.fill('Alpha');
          await expect(list.locator('.history-item')).toHaveCount(60);
        } else if (mode === 'history') await expect(list.locator('.history-item')).toHaveCount(60);
        await assertTop(
          query === 'Beta' && mode === 'history' ? queryOffsets.Beta.history : 0,
          'New search has its own position: ' + query + ' ' + mode,
        );
        await scroll(queryOffsets[query][mode], query + ' search ' + mode);
      }
    }
    for (const query of ['Alpha', 'Beta']) {
      let restoreRequested = false,
        releaseRestore;
      if (query === 'Alpha')
        await page.route('**/api/history?*', async (route) => {
          if (
            new URL(route.request().url()).searchParams.get('q') === 'Alpha' &&
            !restoreRequested
          ) {
            restoreRequested = true;
            await new Promise((resolve) => {
              releaseRestore = resolve;
              releases.push(resolve);
            });
          }
          await route.continue();
        });
      await search.fill(query);
      if (query === 'Alpha') {
        await expect
          .poll(() => restoreRequested && typeof releaseRestore === 'function')
          .toBe(true);
        await expect(list.locator('.history-item')).toHaveCount(0);
        await close();
        await open(queryOffsets.Alpha.workspace);
        await page.locator(tabs.history).click();
        await expect(list).toHaveAttribute('data-mode', 'history');
        releaseRestore();
        await page.unrouteAll({ behavior: 'wait' });
        await expect(list.locator('.history-item')).toHaveCount(60);
        await assertTop(
          queryOffsets.Alpha.history,
          'Pending Archive restoration survives empty and hidden rendering',
        );
      }
      for (const mode of modes) {
        await page.locator(tabs[mode]).click();
        await expect(list).toHaveAttribute('data-mode', mode);
        if (mode === 'history') {
          await expect(list.locator('.history-item')).toHaveCount(60);
          await expect(list.locator('.history-item').first()).toContainText(query + ' Archive');
        }
        await assertTop(queryOffsets[query][mode], 'Saved query position ' + query + ' ' + mode);
      }
    }
    await search.fill('');
    for (const mode of modes) {
      await select(mode);
      await assertTop(offsets[mode], 'Unfiltered position after search ' + mode);
    }
    await page.locator('#chatSearchToggle').click();
    mark('longSearchResultsDoNotBorrowOtherPageOrQueryOffsets');
    mark('delayedArchiveQueryCannotReplaceCurrentQueryPosition');
    mark('pendingArchiveRestorationSurvivesHiddenEmptyList');

    stage = 'animated tab transition and cancellation';
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    animated = true;
    await select('workspace');
    for (const [right, mode] of [
      [false, 'recent'],
      [false, 'history'],
      [true, 'recent'],
      [true, 'workspace'],
    ]) {
      await swipe(right);
      await selected(mode);
      await assertTop(offsets[mode], 'Animated swipe ' + mode);
    }
    await swipe(false, '#chatPickerList', { short: true });
    await selected('workspace');
    await assertTop(offsets.workspace, 'Short drag returns to original page and offset');
    await swipe(false, '#chatPickerList', { short: true, cancel: true });
    await selected('workspace');
    await assertTop(offsets.workspace, 'Canceled short drag preserves original page and offset');
    mark('animatedTabCommitAndShortCancellationPreserveOffsets');

    stage = 'native wheel scroll does not switch pages';
    const listBox = await list.boundingBox();
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
    const wheelBefore = await list.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, 160);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(wheelBefore);
    await selected('workspace');
    await assertTop(wheelBefore + 160, 'Native wheel scroll settles');
    const wheelAfter = await list.evaluate((el) => el.scrollTop);
    await close();
    await open(wheelAfter);
    mark('verticalWheelScrollIsPreservedAndDoesNotChangePage');

    stage = 'sidebar selection and long press boundaries';
    await waitForDrawer();
    // Start just after the regular poll has rebuilt its rows. Do not intercept
    // network requests or freeze the application's normal refresh behavior.
    const machineRefresh = await page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/machines',
      { timeout: 20000 },
    );
    await machineRefresh.finished();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const visibleTargets = await list.evaluate((el) => {
      const box = el.getBoundingClientRect(),
        visible = (node) => {
          const r = node.getBoundingClientRect();
          return r.top >= box.top + 8 && r.bottom <= box.bottom - 8;
        };
      return {
        paneId: [...el.querySelectorAll('[data-pane-id]')].find(visible).dataset.paneId,
        workspaceId: [...el.querySelectorAll('[data-workspace-id]')].find(visible).dataset
          .workspaceId,
      };
    });
    const row = list.locator('[data-pane-id="' + visibleTargets.paneId + '"]');
    const folder = list.locator(
      '[data-workspace-id="' + visibleTargets.workspaceId + '"] .chat-tree-toggle',
    );
    assert.equal(
      await page.locator('#chatSidebar').evaluate((el) => getComputedStyle(el).userSelect),
      'none',
    );
    for (const locator of [row, row.locator('.session-name'), folder.locator('.chat-tree-name')]) {
      assert.equal(
        await dragText(locator, true),
        '',
        'Sidebar labels must not create a browser text selection',
      );
    }
    if ((await folder.getAttribute('aria-expanded')) === 'false') await folder.click();
    mark('sidebarRowNameAndFolderCannotBeDragSelected');

    const menu = page.locator('.popover.context-menu[role="menu"]'),
      name = row.locator('.session-name');
    const point = await textPoints(name);
    const pointer = async (type, pointerId, extra = {}) =>
      name.dispatchEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: point.x,
        clientY: point.y,
        ...extra,
      });
    const osMenu = () =>
      name.evaluate((el, p) => {
        const event = new PointerEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          clientX: p.x,
          clientY: p.y,
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      }, point);
    await page.evaluate(() => {
      window.sidebarMenuAdds = 0;
      window.sidebarMenuObserver = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node.nodeType === 1 && node.matches('.popover.context-menu'))
              window.sidebarMenuAdds++;
      });
      window.sidebarMenuObserver.observe(document.body, { childList: true, subtree: true });
    });
    const paneBeforePress = await page.locator('#chatLog').getAttribute('data-pane-id');
    for (const osFirst of [false, true]) {
      await page.evaluate(() => {
        window.sidebarMenuAdds = 0;
      });
      await pointer('pointerdown', osFirst ? 92 : 91);
      if (osFirst) assert.equal(await osMenu(), true);
      await expect(menu).toBeVisible();
      await menu.evaluate((el) => {
        window.sidebarPressedMenu = el;
      });
      if (!osFirst) {
        const originalRow = await row.elementHandle(),
          session = fixture.state.sessions[visibleTargets.paneId];
        fixture.state.sessions[visibleTargets.paneId] = {
          ...session,
          pane: {
            ...session.pane,
            title: session.pane.title + ' refreshed',
            displayAgent: session.pane.displayAgent + ' refreshed',
            tokens: { ...session.pane.tokens, sidebarRefresh: 1 },
          },
        };
        fixture.changed();
        await fixture.synced();
        await expect.poll(() => originalRow.evaluate((el) => !el.isConnected)).toBe(true);
      }
      assert.equal(await osMenu(), true);
      // OS-first must cancel the pending timer while the finger is still down.
      if (osFirst) await page.waitForTimeout(560);
      assert(await menu.evaluate((el) => el === window.sidebarPressedMenu));
      assert.equal(await page.evaluate(() => window.sidebarMenuAdds), 1);
      await pointer('pointerup', osFirst ? 92 : 91);
      await name.dispatchEvent('click', {
        button: 0,
        detail: 1,
        clientX: point.x,
        clientY: point.y,
      });
      await expect(menu).toBeVisible();
      assert(await menu.evaluate((el) => el === window.sidebarPressedMenu));
      assert.equal(await page.evaluate(() => window.sidebarMenuAdds), 1);
      assert.equal(await page.locator('#chatLog').getAttribute('data-pane-id'), paneBeforePress);
      assert.equal(
        await isOpen(),
        true,
        'Long press release must not select a row and close navigation',
      );
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    }
    const folderName = folder.locator('.chat-tree-name'),
      folderPoint = await textPoints(folderName);
    const expandedBeforePress = await folder.getAttribute('aria-expanded');
    await folderName.dispatchEvent('pointerdown', {
      pointerId: 93,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: folderPoint.x,
      clientY: folderPoint.y,
    });
    await expect(menu).toBeVisible();
    await folderName.dispatchEvent('pointerup', {
      pointerId: 93,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: folderPoint.x,
      clientY: folderPoint.y,
    });
    await folderName.dispatchEvent('click', {
      button: 0,
      detail: 1,
      clientX: folderPoint.x,
      clientY: folderPoint.y,
    });
    await expect(menu).toBeVisible();
    assert.equal(await folder.getAttribute('aria-expanded'), expandedBeforePress);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    for (const [index, cancel] of ['move', 'scroll', 'multi', 'cancel'].entries()) {
      await pointer('pointerdown', 100 + index);
      if (cancel === 'move') await pointer('pointermove', 100 + index, { clientX: point.x + 20 });
      if (cancel === 'scroll') await list.dispatchEvent('scroll');
      if (cancel === 'multi') await pointer('pointerdown', 200 + index, { isPrimary: false });
      if (cancel === 'cancel') await pointer('pointercancel', 100 + index);
      await page.waitForTimeout(560);
      await expect(menu).toHaveCount(0);
      await pointer('pointerup', 100 + index);
      if (cancel === 'multi') await pointer('pointerup', 200 + index, { isPrimary: false });
    }
    await page.evaluate(() => window.sidebarMenuObserver.disconnect());
    mark('sidebarHoldAndOsContextMenuOpenOnceWithoutSelectingRows');
    mark('sidebarHoldCancelsOnMovementScrollMultitouchAndCancel');

    await page.locator('#chatSearchToggle').click();
    const editableSearch = page.locator('#chatPickerSearch');
    assert.equal(await editableSearch.evaluate((el) => getComputedStyle(el).userSelect), 'text');
    await editableSearch.fill('Alpha');
    await editableSearch.click();
    await editableSearch.press('Control+A');
    assert.deepEqual(
      await editableSearch.evaluate((el) => [el.selectionStart, el.selectionEnd]),
      [0, 5],
    );
    await page.keyboard.insertText('Beta');
    await expect(editableSearch).toHaveValue('Beta');
    assert.equal(
      await editableSearch.evaluate(
        (el) =>
          !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      ),
      false,
    );
    await expect(menu).toHaveCount(0);
    await editableSearch.fill('');
    await page.locator('#chatSearchToggle').click();
    if (narrow) {
      await close();
      await expect(page.locator('#chatPickerScrim')).not.toBeVisible();
    }
    const bodyText = page.locator('#chatLog .chat-msg[data-role="assistant"] p').last();
    const bodySelection = await dragText(bodyText);
    assert(bodySelection.trim().length > 0, 'Chat body remains selectable');
    assert.equal(
      await bodyText.evaluate(
        (el) =>
          !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      ),
      false,
    );
    assert.equal(await page.evaluate(() => getSelection().toString()), bodySelection);
    await expect(menu).toHaveCount(0);
    if (!viewport.touch) {
      await page.locator('#chatSidebar').evaluate((el) =>
        el.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 2,
            clientY: 150,
          }),
        ),
      );
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: '复制选中内容', exact: true })).toHaveCount(
        0,
      );
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => getSelection().removeAllRanges());
    if (narrow) await open();
    await selected('workspace');
    await scroll(wheelAfter, 'Restore position after selection boundary checks');
    await waitForDrawer();
    mark('searchRemainsEditableAndChatBodySelectionIsPreserved');
    await page.screenshot({ path: path.join(output, viewport.name + '-final.png') });
    assert.equal(
      fixture.state.requests.filter(
        (r) =>
          r.route === 'POST /api/messages' ||
          r.route === 'POST /api/messages/interrupt' ||
          r.route === 'POST /api/command-interaction' ||
          r.route === 'POST /api/history/resume' ||
          r.route === 'POST /api/agents/start',
      ).length,
      0,
    );
    assert(!fixture.state.frames.some((frame) => /terminal\.(input|paste|key)/.test(frame)));
    assert.deepEqual(fixture.state.unexpected, []);
    assert.deepEqual(errors, []);
    mark('navigationDoesNotSendMessagesOrNativeInput');
    result.ok = true;
  } catch (error) {
    result.stage = stage;
    result.error = error.stack;
    result.browserErrors = errors;
    result.requests = fixture.state.requests.slice(-20);
    await page
      .screenshot({ path: path.join(output, viewport.name + '-failure.png'), fullPage: true })
      .catch(() => {});
  } finally {
    releases.forEach((release) => release());
    await context.close();
    await fixture.close();
  }
  console.log(
    (result.ok ? 'PASS ' : 'FAIL ') +
      viewport.name +
      (result.error ? ' ' + stage + ': ' + result.error : ''),
  );
  return result;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(root),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of viewports) results.push(await oneViewport(browser, viewport));
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(root),
    unchanged = JSON.stringify(before) === JSON.stringify(after);
  const report = {
    ok: unchanged && results.every((r) => r.ok),
    before,
    after,
    browser: 'firefox',
    touch: 'synthetic application gestures; real browser wheel scrolling',
    productionInput: false,
    results,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  assert(unchanged, 'Source changed during sidebar validation');
  assert(report.ok, 'Sidebar state browser failures; see ' + path.join(output, 'report.json'));
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
