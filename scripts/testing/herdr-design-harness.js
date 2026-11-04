#!/usr/bin/env node
'use strict';
// Only local browser fixtures and a named Herdr with an empty HOME are used.
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { HerdrClient } = require('../../lib/herdr-client');
const { sendPaneMessage } = require('../../lib/herdr-input');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..'),
  output = path.join(root, 'artifacts/herdr-design');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function browserCases(browser, viewport) {
  const fixture = await createFixture();
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const selected = fixture.state.sessions['pane-codex'].pane;
  const other = fixture.state.sessions['pane-claude'].pane;
  selected.agent.status = other.agent.status = 'idle';
  other.agent.completionSeq = null;
  other.agent.stateChangeSeq = 10;
  other.tabId = 'other-tab';
  selected.tabId = 'selected-tab';
  other.tabTitle = selected.tabTitle = '123';
  other.sessionTitle = '独立会话 B';
  selected.sessionTitle = '独立会话 A';
  fixture.state.workspaces.push({ workspaceId: 'empty', label: '空分组' });
  try {
    await page.goto(fixture.url + '/?token=fixture');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
    const dot = page.locator('#chatPickerList [data-pane-id="pane-claude"] .status-dot');
    await expect(dot).toHaveAttribute('data-status', 'idle');
    other.agent.status = 'unknown';
    other.agent.message = 'network completed waiting';
    fixture.changed();
    await expect(dot).toHaveAttribute('data-status', 'unknown');
    await page.screenshot({ path: path.join(output, `${viewport.name}-unknown.png`) });
    other.agent.status = 'idle';
    other.agent.completionSeq = 12;
    other.agent.stateChangeSeq = 12;
    fixture.changed();
    await expect(dot).toHaveAttribute('data-status', 'done');
    await expect(dot).toHaveAttribute('aria-label', /本轮工作已完成/);
    await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
    await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
    await expect(page.locator('#chatCurrentDot')).toHaveAttribute('data-status', 'idle');
    await page.reload();
    await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
    // Move away before the new completion; the old message timestamp stays unchanged.
    if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
    await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    other.agent.completionSeq = 15;
    other.agent.stateChangeSeq = 15;
    fixture.changed();
    if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
    await expect(dot).toHaveAttribute('data-status', 'done');
    assert.equal(
      fixture.state.requests.filter((r) => r.route === 'POST /api/tabs/rename').length,
      0,
    );
    assert(fixture.state.requests.some((r) => r.route === 'POST /api/panes/view'));
    fixture.disconnect(true);
    await expect(dot).toHaveAttribute('data-status', 'offline');
    await expect(dot).toHaveAttribute('aria-label', /连接已断开/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `${viewport.name}-offline.png`) });
  } finally {
    await context.close();
    await fixture.close();
  }
}
async function nativeShellStartupCase({ launchOnly = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-shell-startup-'));
  const session = `swift-shell-startup-${process.pid}`,
    config = path.join(temporary, 'config.toml');
  await fs.mkdir(path.join(temporary, 'runtime'), { mode: 0o700 });
  await fs.mkdir(path.join(temporary, '.codex'));
  await fs.writeFile(
    config,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/bash"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  await fs.writeFile(
    path.join(temporary, '.bashrc'),
    'if [ -e "$HOME/slow-shell-startup" ]; then sleep 2; fi\nPS1="SWIFT_SHELL_READY> "\n',
  );
  await fs.writeFile(
    path.join(temporary, '.codex', 'config.toml'),
    `model_provider = "fixture"\nmodel = "fixture-model"\ncheck_for_update_on_startup = false\n[features]\nplugins = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(temporary)}]\ntrust_level = "trusted"\n`,
  );
  const env = {
    PATH: process.env.PATH,
    HOME: temporary,
    CODEX_HOME: path.join(temporary, '.codex'),
    XDG_CONFIG_HOME: path.join(temporary, '.config'),
    XDG_STATE_HOME: path.join(temporary, 'state'),
    XDG_DATA_HOME: path.join(temporary, 'data'),
    XDG_CACHE_HOME: path.join(temporary, 'cache'),
    XDG_RUNTIME_DIR: path.join(temporary, 'runtime'),
    HERDR_CONFIG_PATH: config,
    HERDR_SESSION: session,
    SHELL: '/bin/bash',
    ENV: '',
    BASH_ENV: '',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    DISABLE_AUTOUPDATER: '1',
  };
  const client = require('node-pty').spawn('herdr', ['--session', session], {
    env,
    cwd: temporary,
    cols: 100,
    rows: 32,
  });
  const drain = client.onData(() => {});
  let herdr;
  try {
    async function findSocket(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSocket() && entry.name === 'herdr.sock') return file;
        if (entry.isDirectory()) {
          const found = await findSocket(file);
          if (found) return found;
        }
      }
    }
    let socket;
    for (let i = 0; i < 100; i++) {
      socket = await findSocket(temporary);
      if (socket) break;
      await delay(100);
    }
    assert(socket, 'isolated slow Shell socket missing');
    herdr = new HerdrClient({ session, socketPath: socket });
    let view;
    for (let i = 0; i < 100; i++) {
      view = await herdr.dashboard();
      if (view.panes.length) break;
      await delay(50);
    }
    assert(view?.panes.length, 'isolated slow Shell did not start');
    const { invoke } = require('../../lib/herdr-ui');
    const perform = (method, params, expected) =>
      invoke(herdr, method, params, { runtimeId: view.runtimeId, ...expected });
    const workspaceId = view.workspaces[0].workspaceId;
    await fs.writeFile(path.join(temporary, 'slow-shell-startup'), '');
    const baseline = await perform('tab.create', { workspace_id: workspaceId });
    let baselineBusy = false,
      baselineError;
    for (let i = 0; i < 100; i++) {
      const info = await herdr.readProcessInfo(baseline.root_pane.pane_id);
      if (info.foreground_processes?.some((process) => process.pid !== info.shell_pid)) {
        baselineBusy = true;
        break;
      }
      await delay(10);
    }
    assert(baselineBusy, 'The baseline must observe the real Bash startup command');
    try {
      await herdr.request('agent.start', {
        pane_id: baseline.root_pane.pane_id,
        name: 'shell-startup-baseline',
        kind: 'codex',
      });
    } catch (error) {
      baselineError = { code: error.code, message: error.message };
    }
    assert.equal(
      baselineError?.code,
      'agent_pane_busy',
      'The old launch must reproduce the unavailable Shell error',
    );
    await perform('tab.close', { tab_id: baseline.tab.tab_id });
    const created = await perform('tab.create', { workspace_id: workspaceId });
    const launchAt = performance.now(),
      launchCalls = [],
      nativeRequest = herdr.request.bind(herdr);
    herdr.request = async (method, params, options) => {
      if (method === 'agent.start') launchCalls.push({ method, params });
      return nativeRequest(method, params, options);
    };
    // There is no fixture wait between tab.create and invoke('agent.start').
    const launch = await perform(
      'agent.start',
      { pane_id: created.root_pane.pane_id, name: 'delayed-codex', kind: 'codex' },
      { terminalId: created.root_pane.terminal_id },
    );
    assert.deepEqual(
      launch.argv,
      ['codex'],
      'Herdr must start Codex without model or reasoning overrides',
    );
    const shellStartupMs = Math.round(performance.now() - launchAt);
    herdr.request = nativeRequest;
    assert.equal(launchCalls.length, 1, 'Startup polling must never replay agent.start');
    assert(
      shellStartupMs >= 1500,
      'Swift must wait for actual Bash startup, not only Tab registration',
    );
    if (launchOnly) {
      await perform('tab.close', { tab_id: created.tab.tab_id });
      return {
        argv: launch.argv,
        singleNativeLaunch: true,
        shellStartupMs,
        emptyHome: true,
        externalModel: false,
        productionInput: false,
      };
    }
    let pane;
    for (let i = 0; i < 100; i++) {
      pane = (await herdr.dashboard()).panes.find(
        (item) => item.paneId === created.root_pane.pane_id,
      );
      if (
        pane?.agent?.label === 'codex' &&
        pane.agent.interactiveReady &&
        !pane.agent.launchPending
      )
        break;
      await delay(100);
    }
    await fs.writeFile(
      path.join(output, 'native-shell-startup.json'),
      JSON.stringify({ baselineError, shellStartupMs, launchCalls, launch, pane }, null, 2),
    );
    assert.equal(pane?.agent?.label, 'codex');
    assert.equal(pane.terminalId, created.root_pane.terminal_id);
    assert(
      pane.agent.interactiveReady && !pane.agent.launchPending,
      'The delayed Shell must start an interactive Codex',
    );
    await perform('tab.close', { tab_id: created.tab.tab_id });
    return {
      baselineError: baselineError.code,
      singleNativeLaunch: true,
      terminalIdentityPreserved: true,
      interactiveReady: true,
      shellStartupMs,
      emptyHome: true,
      externalModel: false,
      productionInput: false,
    };
  } finally {
    if (herdr) await herdr.request('server.stop', {}).catch(() => {});
    drain.dispose();
    try {
      client.kill();
    } catch {}
    // Terminate only Codex children carrying this fixture's exact CODEX_HOME.
    for (const name of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const values = (await fs.readFile(`/proc/${name}/environ`, 'utf8')).split('\0');
        if (
          values.includes('CODEX_HOME=' + env.CODEX_HOME) &&
          (await fs.readFile(`/proc/${name}/comm`, 'utf8')).trim().startsWith('codex')
        )
          process.kill(Number(name), 'SIGTERM');
      } catch {}
    }
    await delay(300);
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
async function nativeCases() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-herdr-design-'));
  const session = `swift-design-${process.pid}`,
    config = path.join(temporary, 'config.toml');
  await fs.writeFile(
    config,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  const env = {
    ...process.env,
    HOME: temporary,
    XDG_CONFIG_HOME: path.join(temporary, '.config'),
    XDG_STATE_HOME: path.join(temporary, 'state'),
    XDG_DATA_HOME: path.join(temporary, 'data'),
    XDG_CACHE_HOME: path.join(temporary, 'cache'),
    XDG_RUNTIME_DIR: path.join(temporary, 'runtime'),
    HERDR_CONFIG_PATH: config,
    HERDR_SESSION: session,
    SHELL: '/bin/sh',
    ENV: '',
    BASH_ENV: '',
  };
  for (const key of [
    'HERDR_ENV',
    'HERDR_PANE_ID',
    'HERDR_TAB_ID',
    'HERDR_WORKSPACE_ID',
    'HERDR_SOCKET_PATH',
  ])
    delete env[key];
  await fs.mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const run = (args) =>
    execFileSync('herdr', ['--session', session, ...args], {
      env,
      cwd: temporary,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const json = (args) => {
    const value = JSON.parse(run(args));
    if (value.error) throw new Error(value.error.message);
    return value.result || value;
  };
  const client = require('node-pty').spawn('herdr', ['--session', session], {
    env,
    cwd: temporary,
    cols: 100,
    rows: 32,
  });
  const drain = client.onData(() => {});
  try {
    let snapshot;
    for (let i = 0; i < 60; i++) {
      try {
        snapshot = json(['api', 'snapshot']).snapshot;
        if (snapshot?.panes?.length) break;
      } catch {}
      await delay(100);
    }
    assert(snapshot?.panes?.length, 'isolated Herdr did not start');
    const created = json([
      'workspace',
      'create',
      '--label',
      'split fixture',
      '--cwd',
      temporary,
      '--no-focus',
    ]);
    const first = created.root_pane.pane_id;
    const second = json(['pane', 'split', first, '--direction', 'right', '--no-focus']).pane
      .pane_id;
    async function findSocket(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSocket() && entry.name === 'herdr.sock') return file;
        if (entry.isDirectory()) {
          const found = await findSocket(file);
          if (found) return found;
        }
      }
      return null;
    }
    const socketFile = await findSocket(temporary);
    assert(socketFile, 'isolated socket missing');
    const herdr = new HerdrClient({ session, socketPath: socketFile });
    // Only the explicit isolated socket is used; no CLI fallback may resolve a live session.
    herdr.resolveTarget = async (target) => ({ paneId: target, tabId: created.tab.tab_id });
    for (const paneId of [second, first, second]) {
      await herdr.focusPane(paneId);
      const current = (await herdr.request('session.snapshot', {})).snapshot;
      assert.equal(current.focused_pane_id, paneId, 'focus must select the requested split');
    }
    await assert.rejects(
      sendPaneMessage(second, 'SWIFT_FIXTURE_MUST_NOT_REACH_SHELL', { socketFile }),
      (error) =>
        ['agent_not_found', 'agent_not_ready'].includes(error.code) &&
        error.deliveryUncertain === false,
    );
    const { invoke } = require('../../lib/herdr-ui');
    const view = await herdr.dashboard();
    const perform = (method, params, expected, options) =>
      invoke(herdr, method, params, { runtimeId: view.runtimeId, ...expected }, options);
    const identities = view.panes
      .filter((p) => p.tabId === created.tab.tab_id)
      .map((p) => [p.paneId, p.terminalId, p.agent?.session?.value || '']);
    const beforeMove = json(['pane', 'process-info', '--pane', second]).process_info;
    const separated = await perform(
      'tab.separate',
      { tab_id: created.tab.tab_id },
      { members: identities },
    );
    const movedPane = separated.separated[0];
    assert.equal(movedPane.terminal_id, view.panes.find((p) => p.paneId === second).terminalId);
    const afterMove = json(['pane', 'process-info', '--pane', movedPane.pane_id]).process_info;
    assert.equal(
      afterMove.shell_pid,
      beforeMove.shell_pid,
      'Separating Tabs must preserve the shell process',
    );
    assert.notEqual(movedPane.tab_id, created.tab.tab_id);
    assert.equal(
      (await herdr.dashboard()).panes.filter((p) => p.tabId === created.tab.tab_id).length,
      1,
    );
    await assert.rejects(
      perform(
        'pane.split',
        { target_pane_id: first, direction: 'down' },
        { terminalId: view.panes.find((p) => p.paneId === first).terminalId },
      ),
      { code: 'UNSUPPORTED_ACTION' },
    );
    const inheritanceDirectory = path.join(temporary, 'inherited-workspace');
    await fs.mkdir(inheritanceDirectory);
    const inheritanceSpace = json([
      'workspace',
      'create',
      '--label',
      'inherited directory',
      '--cwd',
      inheritanceDirectory,
      '--no-focus',
    ]);
    await perform('workspace.rename', {
      workspace_id: inheritanceSpace.workspace.workspace_id,
      label: 'renamed Space',
    });
    assert.equal(
      (await herdr.dashboard()).workspaces.find(
        (w) => w.workspaceId === inheritanceSpace.workspace.workspace_id,
      ).label,
      'renamed Space',
    );
    assert(
      (await fs.stat(inheritanceDirectory)).isDirectory(),
      'Renaming a Space must leave its directory intact',
    );
    const otherDirectory = path.join(temporary, 'other-workspace');
    await fs.mkdir(otherDirectory);
    json(['workspace', 'create', '--label', 'other directory', '--cwd', otherDirectory]);
    const inherited = await perform('tab.create', {
      workspace_id: inheritanceSpace.workspace.workspace_id,
      label: 'inherited-tab',
    });
    assert.equal(
      (await herdr.dashboard()).panes.find((p) => p.paneId === inherited.root_pane.pane_id).baseCwd,
      inheritanceDirectory,
      'Native directory inheritance must differ from both server cwd and focused workspace cwd',
    );
    await perform('tab.close', { tab_id: inherited.tab.tab_id });
    const newTab = await perform('tab.create', {
      workspace_id: created.workspace.workspace_id,
      label: 'structured-tab',
    });
    assert.equal(
      (await herdr.dashboard()).panes.find((p) => p.paneId === newTab.root_pane.pane_id).baseCwd,
      temporary,
      'Creating in a named workspace must inherit its directory rather than the focused workspace or server cwd',
    );
    await perform('tab.rename', { tab_id: newTab.tab.tab_id, label: 'renamed-tab' });
    await perform('tab.move', { tab_id: newTab.tab.tab_id, insert_index: 0 });
    assert.equal(
      (await herdr.dashboard()).tabs.filter(
        (t) => t.workspace_id === created.workspace.workspace_id,
      )[0].tab_id,
      newTab.tab.tab_id,
      'Native tab order must reflect tab.move',
    );
    const read = await perform('pane.read', { pane_id: first }, null, { read: true });
    assert.equal(typeof read.read.text, 'string');
    const destinationWorkspace = inheritanceSpace.workspace.workspace_id;
    const moved = await perform(
      'tab.move_to_workspace',
      { tab_id: movedPane.tab_id, workspace_id: destinationWorkspace },
      { terminalId: movedPane.terminal_id },
    );
    assert.equal(moved.move_result.pane.terminal_id, movedPane.terminal_id);
    assert.equal(
      (await herdr.dashboard()).panes.find((p) => p.terminalId === movedPane.terminal_id)
        .workspaceId,
      destinationWorkspace,
    );
    let nativeView;
    try {
      nativeView = await require('./native-view-fixture').run(herdr, first, temporary);
    } catch (error) {
      await fs.writeFile(
        path.join(output, 'native-view-failure.txt'),
        await herdr.readPane(first, { lines: 160, ansi: false }),
      );
      throw error;
    }
    await perform('tab.close', { tab_id: newTab.tab.tab_id });
    return {
      nativeView,
      version: snapshot.version,
      exactPaneFocus: true,
      shellPromptRejected: true,
      legacyTabsSeparatedWithSameProcess: true,
      tabCreateRenameClose: true,
      spaceRenamePreservesDirectory: true,
      tabInheritsTargetDirectory: true,
      exactPaneRead: true,
      moveTabToSpace: true,
    };
  } finally {
    try {
      run(['server', 'stop']);
    } catch {}
    drain.dispose();
    try {
      client.kill();
    } catch {}
    await require('./native-view-fixture').cleanup(temporary);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(root),
    nativeOnly = process.argv.includes('--native-only');
  if (process.argv.includes('--shell-startup-only')) {
    const shellStartup = await nativeShellStartupCase({ launchOnly: true }),
      after = sourceFingerprint(root);
    assert.equal(before.treeSha256, after.treeSha256, 'source changed during startup validation');
    console.log(JSON.stringify({ ok: true, before, after, shellStartup }));
    return;
  }
  if (!nativeOnly) {
    const browser = await firefox.launch({ headless: true });
    try {
      for (const viewport of viewports) await browserCases(browser, viewport);
    } finally {
      await browser.close();
    }
  }
  const native = {
      ...(await nativeCases()),
      shellStartup: await nativeShellStartupCase(),
      commands: await require('./native-command-harness').run(output),
    },
    after = sourceFingerprint(root);
  assert.equal(before.treeSha256, after.treeSha256, 'source changed during design validation');
  const report = {
    ok: true,
    before,
    after,
    viewports: nativeOnly ? [] : viewports.map((v) => v.name),
    native,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
