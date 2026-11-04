'use strict';
const { clearNativeComposer, composerState } = require('./native-composer');
const { createHash, randomUUID } = require('node:crypto');
const { stripAnsi, parseAnsiLine } = require('../public/ansi');
const { readStatusArea } = require('./agent-composer');
const { parseCodexFooter, promptPattern } = require('../public/native-status');
const { codexInteraction, codexModelField } = require('./codex-footer');
const { herdrRequest } = require('./herdr-input');
const { apiError } = require('./message-queue');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keys = new Set([
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'enter',
  'esc',
  'tab',
  'backspace',
  'space',
  's',
  'k',
  'shift+enter',
]);
function validCommandText(text) {
  return (
    typeof text === 'string' &&
    text.length <= 2048 &&
    (/^\/[\w:.-]+(?: [^\r\n\x00-\x1f]*)?$/.test(text) ||
      /^\/goal [^\x00-\x09\x0b-\x1f\x7f]+$/.test(text))
  );
}
function nativeInput(raw, expected = '') {
  const area = readStatusArea(raw);
  if (area.composerHint) return '';
  if (!expected) return area.composer;
  const lines = stripAnsi(String(raw)).replace(/\r/g, '').split('\n');
  const footer = parseCodexFooter(lines),
    start = footer.prompt;
  if (start < 0) return area.composer;
  if (expected.startsWith('/goal ') && expected.includes('\n') && footer.footerIndex > start) {
    const visible = lines
      .slice(start, footer.footerIndex)
      .map((line, index) => (index ? line.replace(/^ {2}/, '') : line.replace(promptPattern, '')))
      .join('\n');
    if (visible.replace(/\s/g, '') === expected.replace(/\s/g, '')) return expected;
  }
  let at = 0;
  for (let i = start; i < lines.length; i++) {
    let part = i === start ? lines[i].replace(promptPattern, '') : lines[i].replace(/^ {2}/, '');
    if (i > start && (!lines[i].trim() || !lines[i].startsWith('  '))) break;
    part = part.replace(/[\u2800-\u28ff]/g, '').trimEnd();
    if (expected.slice(at).startsWith(part)) at += part.length;
    else {
      const spaces = /^ +/.exec(expected.slice(at))?.[0].length || 0;
      if (!spaces || !expected.slice(at + spaces).startsWith(part)) return area.composer;
      at += spaces + part.length;
    }
  }
  return at === expected.trimEnd().length ? expected : area.composer;
}
function projection(raw, lease) {
  const ansi = String(raw).replace(/\r/g, '').split('\n'),
    lines = ansi.map(stripAnsi);
  while (lines.length && !lines.at(-1).trim()) {
    lines.pop();
    ansi.pop();
  }
  const composer = parseCodexFooter(lines).prompt;
  const area = readStatusArea(raw);
  area.composer = nativeInput(raw, lease.draft);
  // Goal replacement is a centered native panel. Its surrounding history keeps
  // streaming, so use the existing panel bounds and keep descriptions separate.
  if (lease.command?.startsWith('/goal ')) {
    const panel = codexInteraction(raw).modal;
    if (panel?.kind === 'goal-replace') {
      const options = panel.lines.flatMap((line, row) => {
        const hit = /^\s*(›?)\s*\d+\.\s+(.+?)\s*$/.exec(line);
        if (!hit) return [];
        const [label, ...description] = hit[2].split(/\s{2,}/);
        return [{ label, description: description.join(' '), selected: hit[1] === '›', row }];
      });
      return finish(
        'menu',
        panel.lines.map((text) => [{ text }]),
        options,
        '',
      );
    }
  }
  let start = 0;
  while (
    start < lease.baseline.length &&
    start < lines.length &&
    lines[start] === lease.baseline[start]
  )
    start++;
  // The bounded native history window may have advanced since opening /.
  for (let skip = 1; skip < lease.baseline.length - 2; skip++) {
    const length = lease.baseline.length - skip;
    if (length <= start || length > lines.length) continue;
    if (lease.baseline.slice(skip).every((line, index) => line === lines[index])) start = length;
  }
  const options = [];
  // Slash candidates sit immediately above the native composer, not in history.
  if (composer >= 0 && area.composer.startsWith('/')) {
    for (let i = Math.max(start, composer - 24); i < composer; i++) {
      const hit = /^\s*(›?)\s*\/([\w:.-]+)(?:\s{2,}(\S.*))?\s*$/.exec(lines[i]);
      if (hit)
        options.push({
          label: '/' + hit[2],
          description: hit[3]?.trim() || '',
          selected: hit[1] === '›',
          row: i,
        });
    }
    return finish(
      'query',
      [],
      options,
      lease.draft && area.composer === lease.draft.trimEnd() ? lease.draft : area.composer,
    );
  }
  // Everything before the original composer is historical conversation. Keep
  // only the native command's new surface; no raw terminal screen is exposed.
  if (lease.command) {
    const echo = lines.findLastIndex((line) => line.trim() === lease.command.trim());
    if (echo >= start) start = echo;
  }
  const numbered = [];
  for (let i = start; i < lines.length; i++) {
    const hit = /^\s*(›?)\s*(\d+)\.\s+(.+?)\s*$/.exec(lines[i]);
    if (hit) numbered.push({ label: hit[3], selected: hit[1] === '›', row: i });
  }
  const menu =
    numbered.some((item) => item.selected) &&
    /\b(?:enter|esc)\b/i.test(lines.slice(start).join('\n'));
  if (menu) {
    let first = numbered.filter((item) => item.selected).at(-1).row;
    while (first > 0 && lines[first - 1].trim()) first--;
    let heading = first - 1;
    while (heading > 0 && !lines[heading].trim()) heading--;
    start = Math.max(start, heading);
    const offset = numbered.findIndex((item) => item.row >= first);
    if (offset > 0) numbered.splice(0, offset);
  }
  let end = lines.length;
  const nativeMenu =
    menu ||
    Boolean(
      lease.command &&
      /\besc (?:back|cancel|close|dismiss\s*&\s*close)\b/i.test(lines.slice(-8).join('\n')),
    );
  const ready = composer >= 0 && !nativeMenu && (!area.composer || area.composerHint);
  if (ready) end = composer;
  const rows = ansi
    .slice(start, end)
    .slice(-100)
    .map((line) => parseAnsiLine(line));
  while (rows.length && !rows[0].some((span) => span.text.trim())) rows.shift();
  while (rows.length && !rows.at(-1).some((span) => span.text.trim())) rows.pop();
  return finish(
    nativeMenu || !ready ? 'menu' : lease.command ? 'result' : 'idle',
    rows,
    menu ? numbered : [],
    area.composer,
  );
  function finish(mode, rows, options, input) {
    // Native Codex renders command errors as a square-bullet history cell.
    // A returned composer alone does not mean that the command succeeded.
    const failed =
      mode === 'result' &&
      rows.some((row) => /^\s*■(?:\s|$)/.test(row.map((span) => span.text).join('')));
    const visible = rows.map((row) => row.map((span) => span.text).join(''));
    const warning =
      lease.command === '/warnings' &&
      /\bk keep\s*&\s*next\b/.test(visible.at(-1) || '') &&
      /^\s*Warnings\s*[·•]\s*(\d+) of (\d+)\b/.exec(
        visible.find((line) => /^\s*Warnings\b/.test(line)) || '',
      );
    const value = {
      mode,
      rows,
      options,
      input,
      ...(failed ? { failed: true } : {}),
      ...(warning
        ? {
            surface: 'warnings',
            warningIndex: Number(warning[1]),
            warningCount: Number(warning[2]),
          }
        : {}),
    };
    return { ...value, revision: digest(value) };
  }
}
class CommandInteraction {
  constructor({
    herdr,
    exactPane,
    inputPane,
    operate = (_id, run) => run(),
    beforeWrite = async () => {},
    press,
    paste,
    settleMs = 40,
    emptyResultWaitMs = 1000,
    now = Date.now,
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      inputPane,
      operate,
      beforeWrite,
      settleMs,
      emptyResultWaitMs,
      now,
    });
    this.press =
      press ||
      ((id, value) =>
        herdrRequest(
          'agent.send_keys',
          { target: id, keys: value },
          { socketFile: herdr.socketPath },
        ));
    this.paste =
      paste ||
      ((id, text) =>
        herdrRequest(
          'pane.send_input',
          { pane_id: id, text, keys: [] },
          { socketFile: herdr.socketPath },
        ));
    this.leases = new Map();
    this.receipts = new Map();
  }
  async execute(body, locked = false) {
    if (typeof body.requestId !== 'string' || !/^[\w-]{1,110}$/.test(body.requestId))
      throw apiError(400, 'COMMAND_REQUEST_REQUIRED', '缺少有效的命令操作标识。');
    if (!validCommandText(body.text))
      throw apiError(400, 'INVALID_COMMAND_INPUT', '请输入有效的完整斜杠命令。');
    const pane = await this.target(body);
    const receiptKey = `execute:${body.runtimeId}:${body.terminalId}:${body.sessionId}:${body.clientId}:${body.requestId}`;
    const fingerprint = digest(body),
      receipt = this.receipts.get(receiptKey);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw apiError(409, 'COMMAND_REQUEST_CHANGED', '同一操作标识不能用于不同输入。');
      if (receipt.processRuntimeId !== pane.runtimeId)
        throw apiError(409, 'SESSION_CHANGED', 'Codex 进程已改变，请重新打开命令。');
      return receipt.promise;
    }
    const run = async () => {
      try {
        const view = await this.handle(
          { ...body, action: 'edit', requestId: body.requestId + '-edit' },
          true,
        );
        if (view.mode !== 'query' || view.pending || view.input !== body.text)
          throw apiError(
            409,
            'COMMAND_INPUT_UNCONFIRMED',
            '尚未确认完整的原生命令输入，本次没有提交。',
          );
        const exact = view.options.find((option) => option.label === body.text.trimEnd());
        if (view.options.length && !exact)
          throw apiError(409, 'COMMAND_MENU_CHANGED', '尚未确认完整的原生命令选项，本次没有提交。');
        const result = await this.handle(
          {
            ...body,
            ...(exact ? { action: 'pick', option: exact.label } : { action: 'key', key: 'enter' }),
            leaseId: view.leaseId,
            revision: view.revision,
            requestId: body.requestId + '-enter',
          },
          true,
        );
        if (result.mode === 'query' && !result.pending)
          throw apiError(
            409,
            'COMMAND_SUBMIT_UNCONFIRMED',
            '原生命令仍留在输入框中，执行结果尚未确认；不会重复提交。',
          );
        return result;
      } catch (error) {
        await this.clearUnsubmitted(body).catch(() => {});
        throw error;
      }
    };
    const promise = locked ? run() : this.operate(pane.paneId, run);
    this.receipts.set(receiptKey, { fingerprint, promise, processRuntimeId: pane.runtimeId });
    if (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value);
    return promise;
  }
  ownsQuery(screen, lease, body, pane) {
    if (
      !lease?.active ||
      !lease.processRuntimeId ||
      lease.processRuntimeId !== pane.runtimeId ||
      lease.submissionStarted ||
      lease.clientId !== body.clientId ||
      lease.id !== body.leaseId ||
      !lease.draft ||
      nativeInput(screen, lease.draft) !== lease.draft ||
      projection(screen, lease).mode !== 'query'
    )
      return false;
    const native = codexInteraction(screen);
    if (
      native.modal ||
      native.thread === 'side' ||
      native.reading === 'history' ||
      ['question', 'menu', 'form', 'authentication', 'confirmation'].includes(native.inputTarget)
    )
      return false;
    // The initial main-thread check happened before this lease typed anything.
    // A configured narrow footer can omit its directory, making the filled
    // composer unknown even though this exact command is still ours.
    return (
      native.thread === 'main' ||
      (native.footer.rows.length > 0 && native.footer.fields.some(codexModelField))
    );
  }
  async clearUnsubmitted(body) {
    let pane = await this.target(body);
    const lease = this.leases.get(`${body.runtimeId}:${body.terminalId}:${body.sessionId}`);
    if (
      !lease?.active ||
      lease.clientId !== body.clientId ||
      lease.submissionStarted ||
      lease.draft !== body.text
    )
      return;
    lease.draftCleared = false;
    const owned = { ...body, leaseId: lease.id };
    const raw = () => this.herdr.readPane(pane.paneId, { lines: 160, ansi: true, exact: true });
    if (!this.ownsQuery(await raw(), lease, owned, pane)) return;
    await this.beforeWrite(pane, {
      continuingStatusView: '',
      continuingCommandInput: true,
      clearingCommandInput: true,
    });
    pane = await this.target(body);
    if (!this.ownsQuery(await raw(), lease, owned, pane)) return;
    await this.target(body);
    await this.press(pane.paneId, ['ctrl+u']);
    for (let attempt = 0; attempt < 10; attempt++) {
      await pause(this.settleMs);
      await this.target(body);
      const screen = await raw(),
        native = codexInteraction(screen);
      if (
        native.footer.prompt >= 0 &&
        native.thread === 'main' &&
        native.inputTarget === 'composer' &&
        !native.modal &&
        !nativeInput(screen)
      ) {
        lease.active = false;
        lease.draft = '';
        lease.command = '';
        lease.awaiting = null;
        lease.awaitingInput = undefined;
        lease.draftCleared = true;
        return;
      }
      if (nativeInput(screen)) return;
    }
  }
  async target(body, allowTransition = false) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.clientId !== 'string' ||
      !/^[\w-]{1,128}$/.test(body.clientId)
    )
      throw apiError(400, 'INVALID_COMMAND_INTERACTION', '命令交互标识无效。');
    const dashboard = this.inputPane
      ? { runtimeId: this.herdr.normalizeSnapshot({}).runtimeId }
      : await this.herdr.dashboard();
    if (!body.runtimeId || dashboard.runtimeId !== body.runtimeId)
      throw apiError(409, 'RUNTIME_CHANGED', 'Herdr 运行实例已改变，请重新打开命令。');
    const pane = await (this.inputPane || this.exactPane)(body.paneId);
    if (!pane.agent || !String(pane.agent.label).toLowerCase().includes('codex'))
      throw apiError(409, 'UNSUPPORTED_PROVIDER', '当前原生命令通道仅支持 Codex。');
    if (!body.terminalId || pane.terminalId !== body.terminalId)
      throw apiError(409, 'SESSION_CHANGED', '命令目标会话已改变。');
    if (body.processRuntimeId && body.processRuntimeId !== pane.runtimeId)
      throw apiError(409, 'SESSION_CHANGED', 'Codex 进程已改变，请重新打开命令。');
    const existing = this.leases.get(`${body.runtimeId}:${body.terminalId}:${body.sessionId}`);
    if (
      existing?.active &&
      existing.processRuntimeId &&
      existing.processRuntimeId !== pane.runtimeId
    )
      throw apiError(409, 'SESSION_CHANGED', 'Codex 进程已改变，请重新打开命令。');
    if ((pane.agent.session?.value || '') !== body.sessionId) {
      const lease = this.leases.get(`${body.runtimeId}:${body.terminalId}:${body.sessionId}`);
      if (
        allowTransition &&
        lease?.clientId === body.clientId &&
        pane.runtimeId &&
        pane.runtimeId === lease.processRuntimeId &&
        ((lease.active && /^\/(?:new|resume|fork)(?:\s|$)/.test(lease.command)) ||
          (!body.sessionId && lease.submissionStarted && /^\/goal /.test(lease.command)))
      )
        return { ...pane, commandSessionChanged: true };
      throw apiError(409, 'SESSION_CHANGED', '命令目标会话已改变。');
    }
    return pane;
  }
  async handle(body, locked = false) {
    const pane = await this.target(body, true);
    if (pane.commandSessionChanged) return this.transition(body);
    if (!['read', 'edit', 'key', 'pick', 'close'].includes(body.action))
      throw apiError(400, 'INVALID_COMMAND_ACTION', '未知命令操作。');
    const id = `${body.runtimeId}:${pane.terminalId}:${body.sessionId}`;
    const run = async () => {
      if ((await this.target(body, true)).commandSessionChanged) return this.transition(body);
      for (const [key, value] of this.leases)
        if (this.now() - value.touched > 120000) this.leases.delete(key);
      let lease = this.leases.get(id);
      const raw = () => this.herdr.readPane(pane.paneId, { lines: 160, ansi: true, exact: true });
      if (lease?.active && lease.clientId !== body.clientId && this.now() - lease.touched < 30000)
        throw apiError(409, 'COMMAND_IN_USE', '另一个客户端正在操作此命令菜单。');
      if (body.action === 'close' && (!lease || !lease.active))
        return {
          ok: true,
          mode: 'idle',
          leaseId: lease?.id || '',
          rows: [],
          options: [],
          input: '',
          revision: digest('idle'),
        };
      if (body.action === 'read') {
        if (
          !lease ||
          lease.clientId !== body.clientId ||
          (body.leaseId && lease.id !== body.leaseId)
        )
          throw apiError(409, 'COMMAND_EXPIRED', '命令交互已结束，请重新输入 /。');
        lease.touched = this.now();
        const view = this.snapshot(lease, await raw());
        return body.revision === view.revision
          ? {
              ok: true,
              leaseId: lease.id,
              unchanged: true,
              revision: view.revision,
              submissionStarted: Boolean(lease.submissionStarted),
              ...(lease.draftCleared != null ? { draftCleared: lease.draftCleared } : {}),
            }
          : view;
      }
      if (typeof body.requestId !== 'string' || !/^[\w-]{1,128}$/.test(body.requestId))
        throw apiError(400, 'COMMAND_REQUEST_REQUIRED', '缺少命令操作请求标识。');
      const receiptKey = `${id}:${body.clientId}:${body.requestId}`,
        fingerprint = digest(body),
        receipt = this.receipts.get(receiptKey);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw apiError(409, 'COMMAND_REQUEST_CHANGED', '同一操作标识不能用于不同输入。');
        return receipt.promise;
      }
      const promise = (async () => {
        let screen = await raw();
        const ownedStatusView =
          lease?.active &&
          lease.clientId === body.clientId &&
          body.leaseId === lease.id &&
          projection(screen, lease).surface === 'warnings'
            ? 'warnings'
            : '';
        const continuingCommandInput = this.ownsQuery(screen, lease, body, pane);
        if (body.action === 'edit' && !(body.text === '/' || validCommandText(body.text)))
          throw apiError(409, 'COMMAND_EXPIRED', '请先输入 / 打开原生命令。');
        const initialInput = composerState(screen, 'codex').input;
        if (
          body.action === 'edit' &&
          !body.leaseId &&
          lease?.active &&
          lease.submissionStarted &&
          lease.draft
        )
          throw apiError(409, 'COMMAND_ACTION_PENDING', '上次命令结果尚未确认，不重复提交。');
        const preparation = await this.beforeWrite(pane, {
          continuingStatusView: ownedStatusView,
          continuingCommandInput,
        });
        const current = await this.target(body, true);
        if (current.commandSessionChanged) return this.transition(body);
        screen = await raw();
        if (
          body.action === 'edit' &&
          !body.leaseId &&
          !preparation?.composerCleared &&
          composerState(screen, 'codex').input !== initialInput
        )
          throw apiError(409, 'NATIVE_INPUT_CHANGED', '原生输入已在检查期间改变，未清空或发送。');
        if (continuingCommandInput && !this.ownsQuery(screen, lease, body, current))
          throw apiError(
            409,
            'NATIVE_INPUT_CHANGED',
            'Codex 输入已在核对期间改变，本次没有继续操作。',
          );
        if (ownedStatusView && projection(screen, lease).surface !== ownedStatusView)
          throw apiError(
            409,
            'COMMAND_MENU_CHANGED',
            '原生状态窗口已在核对期间改变，请按当前页面继续。',
          );
        if (
          body.action === 'edit' &&
          !body.leaseId &&
          !continuingCommandInput &&
          !ownedStatusView
        ) {
          if (!(body.text === '/' || validCommandText(body.text)))
            throw apiError(409, 'COMMAND_EXPIRED', '请先输入 / 打开原生命令。');
          if (lease?.active && lease.submissionStarted && lease.draft)
            throw apiError(409, 'COMMAND_ACTION_PENDING', '上次命令结果尚未确认，不重复提交。');
          const cleared = await clearNativeComposer({
            pane,
            herdr: this.herdr,
            exactPane: () => this.target(body),
            screen: raw,
            press: (keys) => this.press(pane.paneId, keys),
            stepMs: this.settleMs,
          });
          if (cleared || preparation?.composerCleared) {
            if (lease) lease.active = false;
            screen = await raw();
          }
        }
        if (!lease || !lease.active || lease.clientId !== body.clientId) {
          if (body.action !== 'edit' || !(body.text === '/' || validCommandText(body.text)))
            throw apiError(409, 'COMMAND_EXPIRED', '请先输入 / 打开原生命令。');
          const area = readStatusArea(screen),
            lines = stripAnsi(screen).replace(/\r/g, '').split('\n');
          const composer = parseCodexFooter(lines).prompt;
          if (composer < 0)
            throw apiError(
              409,
              'NATIVE_INPUT_UNAVAILABLE',
              '未识别到 Codex 输入框，请核对原生页面。',
            );
          lease = {
            id: randomUUID(),
            clientId: body.clientId,
            active: true,
            touched: this.now(),
            baseline: lines.slice(0, composer),
            processRuntimeId: pane.runtimeId,
            draft: '',
            command: '',
          };
          this.leases.set(id, lease);
        } else if (body.leaseId !== lease.id && !(body.action === 'close' && !body.leaseId))
          throw apiError(409, 'COMMAND_EXPIRED', '命令交互标识已改变。');
        const view = projection(screen, lease);
        if (
          view.surface === 'warnings' &&
          body.action === 'key' &&
          !['up', 'down', 'left', 'right', 'home', 'end', 'k', 'esc'].includes(body.key)
        )
          throw apiError(
            400,
            'INVALID_WARNING_ACTION',
            '请使用警告窗口提供的滚动、保留或忽略操作。',
          );
        if (
          lease.awaiting &&
          view.revision !== lease.awaiting &&
          !(view.mode === 'query' && view.input === lease.awaitingInput)
        ) {
          lease.awaiting = null;
          lease.awaitingInput = undefined;
          lease.draft = view.mode === 'query' ? view.input : '';
        }
        if (lease.awaiting || (lease.emptyResultSince != null && body.action !== 'close'))
          throw apiError(409, 'COMMAND_ACTION_PENDING', 'Codex 正在处理上一次命令操作，请稍后。');
        if (body.action === 'close' && lease.draft && view.input !== lease.draft) {
          lease.active = false;
          lease.draft = '';
          return {
            ok: true,
            leaseId: lease.id,
            mode: 'idle',
            rows: [],
            options: [],
            input: '',
            revision: digest('idle'),
          };
        }
        if (lease.draft && view.input !== lease.draft)
          throw apiError(409, 'NATIVE_INPUT_CHANGED', 'Codex 输入已改变，请重新打开命令。');
        const verify = async () => this.target(body);
        const press = async (value) => {
          await verify();
          const submitting = view.mode === 'query' && value.includes('enter');
          if (submitting) {
            lease.submissionStarted = true;
            lease.awaitingInput = lease.draft;
          }
          try {
            await this.press(pane.paneId, value);
          } catch (error) {
            if (submitting && error.deliveryUncertain === false) {
              lease.submissionStarted = false;
              lease.awaiting = null;
              lease.awaitingInput = undefined;
            }
            throw error;
          }
        };
        const paste = async (value) => {
          await verify();
          await this.paste(pane.paneId, value);
        };
        if (body.action === 'edit') {
          if (!(body.text === '/' || validCommandText(body.text)))
            throw apiError(400, 'INVALID_COMMAND_INPUT', '请输入有效的完整斜杠命令。');
          if (view.mode !== 'query' && lease.draft)
            throw apiError(409, 'COMMAND_MENU_OPEN', '当前为原生菜单，请使用方向键、回车或 Esc。');
          const area = readStatusArea(screen);
          if (nativeInput(screen, lease.draft) !== lease.draft)
            throw apiError(
              409,
              'NATIVE_INPUT_CHANGED',
              'Codex 输入已在其他地方改变，请核对后重新操作。',
            );
          if (lease.draft !== body.text) {
            if (lease.draft) await press(['ctrl+u']);
            lease.draft = body.text;
            await paste(body.text);
          }
        } else {
          if (
            ['key', 'pick'].includes(body.action) &&
            (body.revision !== view.revision ||
              (body.action === 'key' &&
                !keys.has(body.key) &&
                !/^(?:(?:ctrl|alt|shift)\+){1,3}(?:[a-z0-9]|enter|tab|backspace|up|down|left|right|space|home|end)$/.test(
                  body.key || '',
                ) &&
                !/^f(?:[1-9]|1[0-2])$/.test(body.key || '') &&
                !/^[1-9]$/.test(body.key || '') &&
                !(
                  body.key === 'text' &&
                  typeof body.text === 'string' &&
                  body.text.length <= 256 &&
                  !/[\x00-\x1f\x7f]/.test(body.text)
                )))
          )
            throw apiError(409, 'COMMAND_MENU_CHANGED', '原生菜单已改变，请按当前页面重新操作。');
          if (view.mode === 'query' && nativeInput(screen, lease.draft) !== lease.draft)
            throw apiError(409, 'NATIVE_INPUT_CHANGED', 'Codex 输入已改变，请重新打开命令。');
          if (body.action === 'close' || (body.key === 'esc' && view.mode === 'query')) {
            if (view.mode === 'query') {
              await press(['ctrl+u']);
              lease.draft = '';
              lease.command = '';
              lease.active = false;
            } else if (view.surface === 'warnings') {
              // Escape dismisses every visited warning. Normal close first
              // returns to item one, then keeps each item before leaving.
              lease.warningClosing ||= 'rewind';
              if (view.warningIndex === 1) lease.warningClosing = 'keep';
              lease.awaiting = view.revision;
              await press([lease.warningClosing === 'rewind' ? 'left' : 'k']);
            } else if (view.mode === 'menu') await press(['esc']);
            else lease.active = false;
          } else if (view.mode === 'query' || view.mode === 'menu') {
            if (body.action === 'pick') {
              const label = String(body.option || '');
              let current = view;
              const selected = current.options.findIndex((item) => item.selected),
                target = current.options.findIndex((item) => item.label === label);
              if (selected < 0 || target < 0)
                throw apiError(409, 'COMMAND_MENU_CHANGED', '原生选项已改变，请重新选择。');
              if (selected !== target) {
                await press(
                  Array(Math.abs(target - selected)).fill(target > selected ? 'down' : 'up'),
                );
                for (let step = 0; step < 12; step++) {
                  await pause(this.settleMs);
                  current = projection(await raw(), lease);
                  if (current.options.find((item) => item.selected)?.label === label) break;
                  if (step === 11)
                    throw apiError(409, 'COMMAND_MENU_UNCONFIRMED', '未确认原生菜单选择。');
                }
              }
              if (current.options.find((item) => item.selected)?.label !== label)
                throw apiError(409, 'COMMAND_MENU_CHANGED', '原生选项已改变，请重新选择。');
              if (view.mode === 'query') lease.command = label;
              lease.awaiting = current.revision;
              await press(['enter']);
            } else {
              if (body.key === 'enter') {
                if (view.mode === 'query')
                  lease.command =
                    view.options.find((option) => option.selected)?.label || lease.draft.trimEnd();
                lease.awaiting = view.revision;
              }
              if (view.surface === 'warnings' && ['k', 'esc'].includes(body.key))
                lease.awaiting = view.revision;
              if (body.key === 'text') await paste(body.text);
              else await press([body.key]);
            }
          } else throw apiError(409, 'COMMAND_FINISHED', '原生命令已结束。');
        }
        await pause(this.settleMs);
        lease.touched = this.now();
        screen = await raw();
        if (body.action === 'edit')
          for (
            let tries = 0;
            tries < 10 && nativeInput(screen, lease.draft) !== lease.draft;
            tries++
          ) {
            await pause(this.settleMs);
            screen = await raw();
          }
        if ((await this.target(body, true)).commandSessionChanged) return this.transition(body);
        const changed = projection(screen, lease);
        if (
          (body.action === 'close' || body.key === 'esc') &&
          !['query', 'menu'].includes(changed.mode)
        )
          lease.command = '';
        if (body.action === 'edit' && changed.input !== lease.draft) {
          throw apiError(
            409,
            'COMMAND_INPUT_UNCONFIRMED',
            '尚未确认 Codex 输入，请核对原生页面后再操作。',
          );
        }
        if (['key', 'pick'].includes(body.action) && changed.mode === 'query')
          lease.draft = body.key === 'tab' ? changed.input.trimEnd() + ' ' : changed.input;
        return this.snapshot(lease, screen);
      })();
      this.receipts.set(receiptKey, { fingerprint, promise });
      if (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value);
      return promise;
    };
    return locked ? run() : this.operate(pane.paneId, run);
  }
  transition(body) {
    const lease = this.leases.get(`${body.runtimeId}:${body.terminalId}:${body.sessionId}`);
    lease.active = false;
    lease.draft = '';
    return {
      ok: true,
      leaseId: lease.id,
      mode: 'idle',
      sessionChanged: true,
      rows: [],
      options: [],
      input: '',
      revision: digest('session-changed'),
    };
  }
  snapshot(lease, raw) {
    let view = projection(raw, lease);
    const finish = (extra) => ({
      ok: true,
      leaseId: lease.id,
      ...view,
      ...extra,
      submissionStarted: Boolean(lease.submissionStarted),
      ...(lease.draftCleared != null ? { draftCleared: lease.draftCleared } : {}),
    });
    // Working output can move the same slash candidates to different rows.
    // It does not prove that the queued Enter has consumed this draft.
    if (
      lease.awaiting &&
      view.revision !== lease.awaiting &&
      !(view.mode === 'query' && view.input === lease.awaitingInput)
    ) {
      lease.awaiting = null;
      lease.awaitingInput = undefined;
      lease.draft = view.mode === 'query' ? view.input : '';
      view = projection(raw, lease);
    }
    if (lease.awaiting) return finish({ pending: true });
    if (view.mode === 'result' && !view.rows.length) {
      // Codex can clear its composer before an asynchronous command publishes
      // its result. Keep the command and lease while that empty frame settles.
      lease.emptyResultSince ??= this.now();
      // Older clients also poll a pending menu after their composer is cleared.
      if (this.now() - lease.emptyResultSince < this.emptyResultWaitMs)
        return finish({ mode: 'menu', pending: true });
      lease.command = '';
      view = projection(raw, lease);
    }
    lease.emptyResultSince = null;
    if (view.mode === 'result' || view.mode === 'idle') lease.active = false;
    return finish();
  }
}
module.exports = { CommandInteraction, projection, nativeInput };
