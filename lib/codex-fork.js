'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { captureLaunch, processStart } = require('./codex-restart');
const { managedCodexBinary } = require('./codex-runtime');
const { readCodexGoalRecord } = require('./agent-goal');
const { CommandInteraction } = require('./command-interaction');
const { readStatusArea } = require('./agent-composer');
const { codexGoalDialog } = require('./questions/codex');
const { apiError } = require('./message-queue');
const { stripAnsi } = require('../public/ansi');
const uuid = (value) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value || '');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code, message) => apiError(409, code, message);
const quote = (value) => {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value))
    throw fail('FORK_LAUNCH_INVALID', '无法安全恢复这个 Codex 的启动配置，Fork 尚未开始。');
  return "'" + value.replaceAll("'", "'\\''") + "'";
};

// This is an observation of Codex's own continuation guard, never a database write.
function readGoalDeferral(threadId, { home }) {
  const name = fs
    .readdirSync(home)
    .filter((file) => /^goals_\d+\.sqlite$/.test(file))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (!name) return false;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, name), { readOnly: true });
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_goal_continuation_deferrals'",
      )
      .get();
    return Boolean(
      table &&
      db
        .prepare('SELECT 1 FROM thread_goal_continuation_deferrals WHERE thread_id = ?')
        .get(threadId),
    );
  } finally {
    db.close();
  }
}
function executeFork(binary, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { ...options, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // Native stderr may contain private configuration paths. The durable job
        // records the uncertain stage instead of exposing or retrying the command.
        if (error)
          reject(
            fail(
              'FORK_NATIVE_UNCONFIRMED',
              'Codex Fork 的结果尚未确认；不会自动重复创建，请先查看会话列表。',
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.end();
  });
}

async function resolveInstalledBinary() {
  // Pin the independently managed native release when present. Resolving its
  // `current` symlink also avoids running an updater-bearing shell launcher.
  let selected = process.env.SWIFT_CODEX_BIN || managedCodexBinary();
  if (!selected) {
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.resolve(directory, 'codex');
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        selected = candidate;
        break;
      } catch {}
    }
  }
  try {
    if (!selected || !path.isAbsolute(selected)) throw new Error('missing native Codex');
    const binary = await fs.promises.realpath(selected);
    await fs.promises.access(binary, fs.constants.X_OK);
    const version = await new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        ['--version'],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 },
        (error, output) => (error ? reject(error) : resolve(output.trim())),
      );
      child.stdin?.end();
    });
    return { binary, version };
  } catch {
    throw fail('FORK_NATIVE_UNSUPPORTED', '尚未确认当前 Codex 支持安全 Fork，原会话继续运行。');
  }
}

class CodexFork {
  constructor({
    herdr,
    exactPane,
    capture = (pane, options) => captureLaunch(herdr, pane, options),
    runCodex = executeFork,
    resolveBinary = resolveInstalledBinary,
    readGoal = readCodexGoalRecord,
    readDeferred = readGoalDeferral,
    pauseGoal,
    operate = (_id, work) => work(),
    timeoutMs = 30000,
    pollMs = 100,
    now = () => performance.now(),
    wait = delay,
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      capture,
      runCodex,
      resolveBinary,
      readGoal,
      readDeferred,
      pauseGoal,
      operate,
      timeoutMs,
      pollMs,
      now,
      wait,
    });
  }
  async run(parent, { validate = async () => {}, progress = async () => {}, sideId = null } = {}) {
    const partial = {},
      originalSession = parent.agent?.session?.value;
    let forkIssued = false,
      pendingMutation = false,
      runtimeId,
      launch;
    const stage = async (phase) => {
      partial.phase = phase;
      await progress({ ...partial });
    };
    const mutate = async (work) => {
      pendingMutation = true;
      const result = await work();
      pendingMutation = false;
      return result;
    };
    const sameParent = async () => {
      await validate();
      const current = await this.exactPane(parent.paneId),
        view = await this.herdr.dashboard();
      if (
        view.runtimeId !== runtimeId ||
        !current ||
        current.terminalId !== parent.terminalId ||
        current.workspaceId !== parent.workspaceId ||
        current.tabId !== parent.tabId ||
        current.runtimeId !== parent.runtimeId ||
        current.agent?.session?.value !== originalSession
      )
        throw fail('FORK_SOURCE_CHANGED', '原会话的身份或位置已经改变，未继续 Fork 操作。');
      return view;
    };
    const childPane = async () => {
      const view = await this.herdr.dashboard();
      if (view.runtimeId !== runtimeId)
        throw fail('FORK_RUNTIME_CHANGED', 'Herdr 运行实例已经改变，请查看已创建的分支。');
      const current = view.panes.find((pane) => pane.paneId === partial.paneId);
      if (
        !current ||
        current.terminalId !== partial.terminalId ||
        current.tabId !== partial.tabId ||
        current.workspaceId !== parent.workspaceId
      )
        throw fail('FORK_CHILD_CHANGED', '新 Tab 的终端或位置已经改变，请查看已创建的分支。');
      return current;
    };
    const goal = () => this.readGoal(partial.sessionId, { home: launch.goalHome });
    const deferred = () => this.readDeferred(partial.sessionId, { home: launch.goalHome });
    const requireDeferred = async (currentGoal) => {
      if (currentGoal?.status === 'active' && !(await deferred()))
        throw fail(
          'FORK_GOAL_NOT_DEFERRED',
          '分支 Goal 的原生暂停保护未确认；未继续启动或输入，请查看已创建的分支。',
        );
    };
    try {
      if (
        !uuid(originalSession) ||
        !parent.runtimeId ||
        !parent.terminalId ||
        !parent.workspaceId ||
        !parent.tabId ||
        !/^codex$/i.test(parent.agent?.label || '')
      )
        throw fail(
          'FORK_SOURCE_UNAVAILABLE',
          '这个 Codex 尚未建立可 Fork 的原生会话，请等待会话就绪。',
        );
      runtimeId = (await this.herdr.dashboard()).runtimeId;
      await sameParent();
      const currentBinary = await this.resolveBinary(),
        version = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)\b/.exec(currentBinary?.version || '');
      if (
        !version ||
        (Number(version[1]) === 0 && Number(version[2]) < 164) ||
        !path.isAbsolute(currentBinary.binary || '')
      )
        throw fail(
          'FORK_NATIVE_UNSUPPORTED',
          '当前 Codex 版本尚未确认支持安全 Fork，原会话继续运行。',
        );
      try {
        launch = await this.capture(parent, { binaryOverride: currentBinary.binary });
        launch.binary = currentBinary.binary;
      } catch {
        throw fail(
          'FORK_LAUNCH_INVALID',
          '无法安全读取原会话的启动配置，Fork 尚未开始；原会话继续运行。',
        );
      }
      const kept = launch.args.slice(0, -2);
      if (
        launch.args.at(-2) !== 'resume' ||
        launch.args.at(-1) !== originalSession ||
        !path.isAbsolute(launch.cwd) ||
        !path.isAbsolute(launch.binary)
      )
        throw fail('FORK_LAUNCH_INVALID', '无法安全恢复这个 Codex 的启动配置，Fork 尚未开始。');
      const sourceGoal = sideId
        ? null
        : await this.readGoal(originalSession, { home: launch.goalHome });
      // Parent command-line flags can enable Goals without changing config.toml.
      const options = sourceGoal ? [...kept, '--enable', 'goals'] : kept;
      const inheritedEnv = { ...process.env, ...launch.env };
      for (const key of Object.keys(inheritedEnv))
        if (key.startsWith('HERDR_') || ['CODEX_THREAD_ID', 'CODEX_SESSION_ID'].includes(key))
          delete inheritedEnv[key];
      for (const key of ['CODEX_HOME', 'CODEX_SQLITE_HOME'])
        if (!Object.hasOwn(launch.env, key)) delete inheritedEnv[key];
      [
        launch.binary,
        launch.cwd,
        ...options,
        ...Object.entries(launch.env).map(([key, value]) => key + '=' + value),
      ].forEach(quote);
      await sameParent();
      await stage('forking');
      forkIssued = true;
      const nativeSideFork = sideId
        ? await require('./codex-side-native').request(parent, 'fork', sideId)
        : null;
      if (sideId && !nativeSideFork?.data?.sessionId)
        throw fail('SIDE_NATIVE_UNAVAILABLE', '临时会话 Fork 未确认；不会自动重复创建。');
      const childOptions = [...options];
      if (sideId) {
        const settings = nativeSideFork.data;
        if (
          typeof settings.model !== 'string' ||
          !settings.model ||
          typeof settings.modelProvider !== 'string' ||
          !settings.modelProvider
        )
          throw fail(
            'FORK_LAUNCH_INVALID',
            '临时分支已创建，但模型设置未确认，请查看分支后再恢复。',
          );
        childOptions.push(
          '--model',
          settings.model,
          '-c',
          'model_provider=' + JSON.stringify(settings.modelProvider),
        );
        if (settings.reasoningEffort)
          childOptions.push(
            '-c',
            'model_reasoning_effort=' + JSON.stringify(settings.reasoningEffort),
          );
      }
      const output = sideId
        ? JSON.stringify({ type: 'thread.started', thread_id: nativeSideFork.data.sessionId })
        : await this.runCodex(
            launch.binary,
            [
              ...options,
              'exec',
              '--cd',
              launch.cwd,
              'fork',
              originalSession,
              '--json',
              '--thread-source',
              'user',
              '--skip-git-repo-check',
            ],
            { cwd: launch.cwd, env: inheritedEnv },
          );
      let events;
      try {
        events = String(output?.stdout ?? output)
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        throw fail(
          'FORK_NATIVE_UNCONFIRMED',
          'Codex Fork 返回了未确认的结果；不会自动重复创建，请先查看会话列表。',
        );
      }
      const ids = events
        .filter((event) => event.type === 'thread.started')
        .map((event) => event.thread_id);
      if (ids.length !== 1 || !uuid(ids[0]) || ids[0] === originalSession)
        throw fail(
          'FORK_NATIVE_UNCONFIRMED',
          'Codex 没有确认唯一的新会话；不会自动重复 Fork，请先查看会话列表。',
        );
      partial.sessionId = ids[0];
      await stage('forked');
      const inheritedGoal = await goal();
      // The parent may naturally finish or edit its Goal while the native
      // snapshot is taken. Trust that snapshot rather than requiring an older
      // observation's status, counters or objective to remain unchanged.
      if (
        sourceGoal &&
        !inheritedGoal &&
        (await this.readGoal(originalSession, { home: launch.goalHome }))
      )
        throw fail(
          'FORK_GOAL_UNCONFIRMED',
          '新会话已经创建，但继承的 Goal 未确认，请查看该分支；原会话继续运行。',
        );
      await requireDeferred(inheritedGoal);
      await sameParent();
      await stage('creating-tab');
      const created = await mutate(() =>
        this.herdr.request('tab.create', {
          workspace_id: parent.workspaceId,
          cwd: launch.cwd,
          label: 'Codex fork',
          focus: false,
        }),
      );
      Object.assign(partial, {
        tabId: created.tab?.tab_id,
        paneId: created.root_pane?.pane_id,
        terminalId: created.root_pane?.terminal_id,
      });
      await stage('tab-created');
      if (
        !partial.tabId ||
        !partial.paneId ||
        !partial.terminalId ||
        partial.paneId === parent.paneId ||
        partial.terminalId === parent.terminalId
      )
        throw fail(
          'FORK_TAB_UNCONFIRMED',
          '新会话已创建，但新 Tab 的身份未确认；不会自动重建，请查看会话列表。',
        );
      const view = await sameParent(),
        siblings = view.tabs.filter((tab) => tab.workspace_id === parent.workspaceId);
      await childPane();
      const index = siblings.findIndex((tab) => tab.tab_id === parent.tabId);
      if (index < 0 || !siblings.some((tab) => tab.tab_id === partial.tabId))
        throw fail('FORK_TAB_UNCONFIRMED', '新 Tab 的排列位置未确认，请查看已创建的分支。');
      await stage('positioning-tab');
      await mutate(() =>
        this.herdr.request('tab.move', { tab_id: partial.tabId, insert_index: index + 1 }),
      );
      await stage('tab-positioned');
      // A new shell can briefly own its foreground group before startup files
      // run. Observe the same idle shell twice before writing one command.
      const deadline = this.now() + this.timeoutMs;
      let shellRuntime,
        stable = false;
      const shellNames = new Set([
        'sh',
        'bash',
        'dash',
        'zsh',
        'fish',
        'ksh',
        'mksh',
        'csh',
        'tcsh',
        'elvish',
        'xonsh',
        'nu',
        'pwsh',
        'powershell',
        'cmd',
      ]);
      const availableShell = (info) =>
        info?.shell_pid > 0 &&
        info.foreground_process_group_id === info.shell_pid &&
        info.foreground_processes?.length > 0 &&
        info.foreground_processes.every((process) => process.pid === info.shell_pid) &&
        info.foreground_processes.some((process) =>
          shellNames.has(
            path
              .basename(process.name || '')
              .replace(/^-+/, '')
              .replace(/(?:\.exe)+$/i, '')
              .toLowerCase(),
          ),
        );
      for (;;) {
        await sameParent();
        const child = await childPane(),
          info = await this.herdr.readProcessInfo(partial.paneId);
        if (child.agent)
          throw fail('FORK_TAB_OCCUPIED', '新 Tab 已被其他进程使用，未发送恢复命令。');
        const pid = info?.shell_pid;
        const ready = availableShell(info);
        const currentRuntime = pid > 0 ? await processStart(pid) : '';
        if (shellRuntime && currentRuntime !== shellRuntime)
          throw fail('FORK_TAB_OCCUPIED', '新 Tab 的 Shell 已改变，未发送恢复命令。');
        shellRuntime ||= currentRuntime;
        if (ready && stable) break;
        stable = ready;
        if (this.now() >= deadline)
          throw fail('FORK_SHELL_UNAVAILABLE', '新 Tab 的 Shell 尚未就绪，未发送恢复命令。');
        await this.wait(this.pollMs);
      }
      await requireDeferred(await goal());
      const unset = [
        'CODEX_HOME',
        'CODEX_SQLITE_HOME',
        'CODEX_THREAD_ID',
        'CODEX_SESSION_ID',
      ].flatMap((key) => ['-u', key]);
      const command = [
        'env',
        ...unset,
        ...Object.entries(launch.env).map(([key, value]) => key + '=' + value),
        launch.binary,
        ...childOptions,
        'resume',
        partial.sessionId,
      ]
        .map(quote)
        .join(' ');
      await sameParent();
      await childPane();
      await stage('starting-child');
      const finalShell = await this.herdr.readProcessInfo(partial.paneId);
      await sameParent();
      await childPane();
      if (
        !availableShell(finalShell) ||
        (await processStart(finalShell.shell_pid)) !== shellRuntime
      )
        throw fail('FORK_TAB_OCCUPIED', '新 Tab 的 Shell 或前台进程已经改变，未发送恢复命令。');
      // `pane run` is the native CLI's atomic command+Enter operation; it is
      // not an RPC method in Herdr 0.9.3's bundled socket schema.
      await mutate(() =>
        this.herdr.run(['pane', 'run', partial.paneId, command], {
          env: { HERDR_SOCKET_PATH: this.herdr.socketPath },
        }),
      );
      await stage('child-started');
      const childDeadline = this.now() + this.timeoutMs;
      let child,
        sessionReported = false;
      for (;;) {
        await sameParent();
        await childPane();
        child = await this.exactPane(partial.paneId);
        if (
          child?.runtimeId &&
          /^codex$/i.test(child.agent?.label || '') &&
          !child.agent.session?.value &&
          !sessionReported
        ) {
          // Herdr 0.9.3 does not infer the resume UUID when launch options are
          // preserved. Publish only the new process's explicit final arguments.
          const pid = Number(child.runtimeId.split(':')[0]);
          const info = await this.herdr.readProcessInfo(partial.paneId),
            process = info.foreground_processes?.find((process) => process.pid === pid);
          const argv = (await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8'))
            .split('\0')
            .filter(Boolean);
          if (
            !process ||
            argv.at(-2) !== 'resume' ||
            argv.at(-1) !== partial.sessionId ||
            (await processStart(pid)) !== child.runtimeId
          )
            throw fail('FORK_CHILD_CHANGED', '新进程没有明确恢复本次分支，未绑定或输入该终端。');
          await childPane();
          await stage('binding-child');
          if ((await processStart(pid)) !== child.runtimeId)
            throw fail('FORK_CHILD_CHANGED', '新进程已经改变，未绑定该终端。');
          await mutate(() =>
            this.herdr.request('pane.report_agent_session', {
              pane_id: partial.paneId,
              source: 'herdr:codex',
              agent: 'codex',
              seq: Date.now() * 1e6,
              agent_session_id: partial.sessionId,
              session_start_source: 'resume',
            }),
          );
          sessionReported = true;
        }
        if (child?.agent?.session?.value && child.agent.session.value !== partial.sessionId)
          throw fail('FORK_CHILD_CHANGED', '新终端启动了其他会话，未执行 Goal 操作。');
        if (
          child?.runtimeId &&
          /^codex$/i.test(child.agent?.label || '') &&
          child.agent.session?.value === partial.sessionId
        ) {
          const raw = await this.herdr.readPane(partial.paneId, {
            lines: 100,
            ansi: true,
            exact: true,
          });
          const currentGoal = await goal();
          await requireDeferred(currentGoal);
          if (
            readStatusArea(raw).composerHint ||
            (currentGoal?.status !== 'active' && codexGoalDialog(stripAnsi(raw)))
          )
            break;
        }
        if (this.now() >= childDeadline)
          throw fail(
            'FORK_CHILD_UNAVAILABLE',
            '新 Tab 已启动，但尚未确认原生输入框就绪；不会重复启动，请查看该分支。',
          );
        await this.wait(this.pollMs);
      }
      const childRuntime = child.runtimeId;
      const verifyChild = async () => {
        await sameParent();
        await childPane();
        const current = await this.exactPane(partial.paneId);
        if (
          current?.runtimeId !== childRuntime ||
          current.agent?.session?.value !== partial.sessionId
        )
          throw fail('FORK_CHILD_CHANGED', '分支进程已经改变，未继续 Goal 操作。');
        await requireDeferred(await goal());
      };
      let currentGoal = await goal();
      await this.operate(partial.paneId, async () => {
        await verifyChild();
        currentGoal = await goal();
        // A paused/stalled inherited Goal can open Codex's resume question.
        // Select only its exact "Leave paused" option before returning an
        // editable composer; never confirm the default "Resume goal" option.
        const readDialog = async () =>
          codexGoalDialog(
            stripAnsi(
              await this.herdr.readPane(partial.paneId, { lines: 100, ansi: true, exact: true }),
            ),
          );
        let dialog = await readDialog();
        if (currentGoal && dialog?.question.startsWith('Resume paused goal?')) {
          const question = dialog.question;
          if (dialog.selected === 0) {
            await stage('selecting-paused-goal');
            await verifyChild();
            if ((await readDialog())?.question !== question)
              throw fail('FORK_GOAL_DIALOG_CHANGED', '分支的 Goal 确认已经改变，未提交选择。');
            await mutate(() =>
              this.herdr.request('agent.send_keys', { target: partial.paneId, keys: ['down'] }),
            );
          }
          const dialogDeadline = this.now() + this.timeoutMs;
          for (;;) {
            await verifyChild();
            dialog = await readDialog();
            if (dialog?.question !== question)
              throw fail('FORK_GOAL_DIALOG_CHANGED', '分支的 Goal 确认已经改变，未提交选择。');
            if (dialog.selected === 1) break;
            if (this.now() >= dialogDeadline)
              throw fail('FORK_GOAL_DIALOG_CHANGED', '尚未确认“保持暂停”的原生选项，未提交选择。');
            await this.wait(this.pollMs);
          }
          await stage('confirming-paused-goal');
          await verifyChild();
          const confirmed = await readDialog();
          if (confirmed?.question !== question || confirmed.selected !== 1)
            throw fail('FORK_GOAL_DIALOG_CHANGED', '分支的 Goal 选择已经改变，未提交选择。');
          await mutate(() =>
            this.herdr.request('agent.send_keys', { target: partial.paneId, keys: ['enter'] }),
          );
          for (;;) {
            await verifyChild();
            if (
              readStatusArea(
                await this.herdr.readPane(partial.paneId, { lines: 100, ansi: true, exact: true }),
              ).composerHint
            )
              break;
            if (this.now() >= dialogDeadline)
              throw fail(
                'FORK_GOAL_DIALOG_CHANGED',
                '分支 Goal 保持暂停，但输入框尚未就绪，请查看该分支。',
              );
            await this.wait(this.pollMs);
          }
        }
        if (
          currentGoal &&
          !['complete', 'budget_limited', 'budgetLimited', 'paused'].includes(currentGoal.status)
        ) {
          await verifyChild();
          await stage('pausing-goal');
          if (this.pauseGoal)
            await mutate(() => this.pauseGoal(child, { runtimeId, verify: verifyChild }));
          else {
            const commands = new CommandInteraction({
              herdr: this.herdr,
              exactPane: this.exactPane,
              beforeWrite: verifyChild,
              press: (id, keys) =>
                mutate(() => this.herdr.request('agent.send_keys', { target: id, keys })),
              paste: (id, text) =>
                mutate(() =>
                  this.herdr.request('pane.send_input', { pane_id: id, text, keys: [] }),
                ),
            });
            await commands.execute({
              paneId: partial.paneId,
              terminalId: partial.terminalId,
              sessionId: partial.sessionId,
              runtimeId,
              clientId: 'swift-session-fork',
              requestId: randomUUID(),
              text: '/goal pause',
            });
          }
          const pauseDeadline = this.now() + this.timeoutMs;
          for (;;) {
            await verifyChild();
            currentGoal = await goal();
            if (currentGoal?.status === 'paused') break;
            if (this.now() >= pauseDeadline)
              throw fail(
                'FORK_GOAL_UNCONFIRMED',
                '分支已创建，但 Goal 暂停结果尚未确认；原生延迟继续保护仍保留，请查看该分支。',
              );
            await this.wait(this.pollMs);
          }
        }
      });
      Object.assign(partial, {
        goalPaused: currentGoal?.status === 'paused',
        goalStatus: currentGoal?.status || null,
      });
      await stage('ready');
      const { sessionId, tabId, paneId, terminalId, goalPaused, goalStatus } = partial;
      return { sessionId, tabId, paneId, terminalId, goalPaused, goalStatus };
    } catch (error) {
      error.partial = { ...partial };
      if (pendingMutation || (forkIssued && !partial.sessionId)) error.deliveryUncertain = true;
      throw error;
    }
  }
}
module.exports = { CodexFork, readGoalDeferral, resolveInstalledBinary };
