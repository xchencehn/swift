'use strict';

// All writes belong to a verified caller-owned history edit operation.
const { createHash, randomUUID } = require('node:crypto');
const { NativeWatch, rowsToAnsi } = require('./codex-rewind-watch');
const { TerminalScreen } = require('./terminal-screen');
const { readStatusArea } = require('./agent-composer');
const { sideScreen } = require('./codex-side');
const { matchActivityLine, stripAnsi } = require('../public/ansi');
const { textOf, parseCodexFooter, hasCodexModelAndDirectory } = require('../public/native-status');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => digest(a) === digest(b);
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
// Display wrapping is not an identity. Identity comes from the caller's full
// native receipt order and acknowledged navigation from the latest prompt.
const comparable = (text) => String(text || '').replace(/[\p{White_Space}\uFEFF]/gu, '');
const unsafePrefix = (text) => /^[\p{White_Space}\uFEFF]*[!/]/u.test(String(text || ''));
const ownerKey = (pane) =>
  digest([pane.paneId, pane.terminalId, pane.runtimeId, pane.agent?.session?.value]);

function composerSurface(frame, lines) {
  const footer = parseCodexFooter(lines),
    first = footer.prompt;
  if (
    first < 0 ||
    footer.footerIndex < 0 ||
    !(
      hasCodexModelAndDirectory(footer.fields) ||
      /^\s*esc again to edit previous message\s*$/.test(footer.text)
    )
  )
    return null;
  const cursor = frame.cursor;
  let end = footer.footerIndex - 1;
  while (end > first && !lines[end].trim() && end !== cursor?.y) end--;
  const rows = frame.rows.slice(first, end + 1),
    body = rows.map(textOf);
  let prefix = /^\s*[›❯»] /.exec(body[0]);
  if (!prefix) {
    // VT snapshots trim the unpainted blank after an empty prompt. Recover
    // that delimiter only at the current cursor, with a complete native
    // footer and exact glyph geometry; an older bare prompt proves nothing.
    const bare = /^ *[›❯»]$/.exec(body[0]);
    if (
      !bare ||
      !hasCodexModelAndDirectory(footer.fields) ||
      cursor?.y !== first ||
      !Number.isSafeInteger(cursor.x) ||
      cursor.x < bare[0].length + 1 ||
      frame.endColumns?.[first] !== bare[0].length
    )
      return null;
    prefix = [bare[0] + ' '];
  }
  body[0] = body[0].slice(prefix[0].length);
  for (let index = 1; index < body.length; index++) {
    if (!body[index].startsWith('  ') && body[index].trim()) return null;
    body[index] = body[index].slice(2);
  }
  const firstAfter = [];
  let skip = prefix[0].length;
  for (const span of rows[0]) {
    if (skip >= span.text.length) {
      skip -= span.text.length;
      continue;
    }
    firstAfter.push({ ...span, text: span.text.slice(skip) });
    skip = 0;
  }
  const content = [...firstAfter, ...rows.slice(1).flat()].filter((span) => span.text.trim());
  const hint = body.length === 1 && content.length > 0 && content.every((span) => span.dim);
  // Cursor position retains trailing spaces/newlines which VT's ordinary text
  // snapshot trims. Such spaces are still input and must block native writes.
  const cursorIn = cursor && cursor.y >= first && cursor.y <= end;
  if (cursorIn && !hint) {
    const lineIndex = cursor.y - first,
      indent = lineIndex === 0 ? prefix[0].length : 2;
    const visibleEnd = frame.endColumns?.[cursor.y];
    if (Number.isFinite(visibleEnd) && cursor.x > visibleEnd)
      body[lineIndex] += ' '.repeat(cursor.x - Math.max(indent, visibleEnd));
  }
  const input = hint ? '' : body.join('\n');
  return {
    first,
    end,
    input,
    hint,
    body,
    rows,
    cursorIn,
    cursorAtEnd: Boolean(cursorIn && cursor.y === end && cursor.x === frame.endColumns?.[end]),
    revision: digest([
      rows,
      cursor,
      frame.endColumns?.slice(first, end + 1),
      frame.isWrapped?.slice(first, end + 1),
    ]),
    watchId: frame.watchId,
    frameSequence: frame.frameSequence,
  };
}

function surface(frame) {
  const rows = frame.rows || [],
    lines = rows.map(textOf);
  const last = lines.findLastIndex((line) => line.trim());
  const browser = lines.findLastIndex(
    (line, index) => index === last && /^\s*Browsing(?: transcript)?(?:\s*·.*)?\s*$/.test(line),
  );
  const raw = frame.raw || lines.join('\n');
  const area = readStatusArea(raw),
    side = sideScreen(raw);
  const primed = /esc again to edit previous message\s*$/m.test(stripAnsi(raw));
  const viewportRows = frame.viewportRows || rows.length;
  const start = browser >= 0 ? Math.max(0, browser - viewportRows + 1) : 0;
  const inverse = rows
    .map((row, index) => ({ row, index }))
    .filter(
      (item) =>
        item.index >= start &&
        item.index < browser &&
        item.row.some((span) => span.inverse && span.text.trim()),
    );
  let selected = null;
  if (inverse.length) {
    const first = inverse[0].index,
      end = inverse.at(-1).index;
    const prompts = inverse.filter((item) => /^\s*[›❯»](?:\s|$)/.test(textOf(item.row)));
    if (prompts.length === 0 || (prompts.length === 1 && prompts[0].index === first)) {
      const selectedLines = rows.slice(first, end + 1).map((row) =>
        row
          .filter((span) => span.inverse)
          .map((span) => span.text)
          .join(''),
      );
      const headVisible = prompts.length === 1;
      if (headVisible) selectedLines[0] = selectedLines[0].replace(/^\s*[›❯»] ?/, '');
      selected = { text: selectedLines.join('\n'), headVisible, firstRow: first, lastRow: end };
    }
  }
  const mode =
    browser >= 0 ? 'selector' : side.mode === 'side' ? 'side' : primed ? 'primed' : side.mode;
  const composer = browser < 0 ? composerSurface(frame, lines) : null;
  return {
    mode,
    working: Boolean(matchActivityLine(area.activity)?.running),
    input: composer ? composer.input : null,
    inputHint: composer?.hint || false,
    composer,
    selected,
    frameRevision: digest(rows),
    raw,
    rows,
    cursor: frame.cursor,
    watchId: frame.watchId,
    frameSequence: frame.frameSequence,
    selectedRevision: selected
      ? digest([
          selected.firstRow,
          selected.lastRow,
          rows
            .slice(selected.firstRow, selected.lastRow + 1)
            .map((row) => row.filter((span) => span.inverse)),
        ])
      : null,
    // Whole-overlay revision is used only to protect ownership at confirmation;
    // movement acknowledgement uses the selected inverse region above.
    selectionRevision: browser >= 0 ? digest(rows.slice(start, browser + 1)) : null,
  };
}

class RewindNative {
  constructor({
    herdr,
    readScreen,
    readHistory,
    press,
    paste,
    sendMessage,
    verifyProcess,
    timeoutMs = 12000,
    navigationTimeoutMs = 30000,
    stepMs = 80,
    onObservation = () => {},
  }) {
    Object.assign(this, {
      herdr,
      readHistory,
      timeoutMs,
      navigationTimeoutMs,
      stepMs,
      onObservation,
    });
    this.owners = new Map();
    this.drafts = new Map();
    this.watches = new Map();
    this.verifyProcess =
      verifyProcess ||
      (async (pane) => {
        const pid = Number(String(pane.runtimeId || '').split(':')[0]);
        if (!pid || (await require('./codex-restart').processStart(pid)) !== pane.runtimeId)
          throw fail('SESSION_CHANGED', 'Codex 进程已改变，未继续操作。');
        if (
          herdr &&
          !(await herdr.readProcessInfo(pane.paneId)).foreground_processes?.some(
            (item) => item.pid === pid,
          )
        )
          throw fail('SESSION_CHANGED', 'Codex 已不在原终端前台，未继续操作。');
      });
    this.press =
      press ||
      ((pane, keys) =>
        require('./herdr-input').herdrRequest(
          'agent.send_keys',
          { target: pane.paneId, keys },
          { socketFile: herdr.socketPath },
        ));
    this.paste =
      paste ||
      ((pane, text) =>
        require('./herdr-input').pastePaneText(pane.paneId, text, {
          socketFile: herdr.socketPath,
        }));
    this.sendMessage =
      sendMessage ||
      ((pane, text) =>
        require('./herdr-input').sendPaneMessage(pane.paneId, text, {
          socketFile: herdr.socketPath,
        }));
    this.readScreen =
      readScreen ||
      (async (pane) => {
        const key = ownerKey(pane);
        let watch = this.watches.get(key);
        if (!watch) {
          watch = new NativeWatch({ herdr, pane, timeoutMs });
          this.watches.set(key, watch);
        }
        const before = await watch.read();
        const lines = before.rows.map(textOf),
          last = lines.findLastIndex((line) => line.trim());
        if (!/^\s*Browsing(?: transcript)?(?:\s*·.*)?\s*$/.test(lines[last] || '')) return before;
        // Herdr's observer serializer resolves inverse to concrete colors. Read
        // the original SGR metadata only while the independent VT frame remains
        // unchanged, and require every current row to align exactly with it.
        const raw = await herdr.readPane(pane.paneId, {
          source: 'recent',
          lines: 160,
          ansi: true,
          exact: true,
        });
        const parsed = new TerminalScreen({ cols: 250, rows: 180 });
        let original;
        try {
          await parsed.feed(raw.replace(/\r?\n/g, '\r\n'), { full: true });
          original = parsed.snapshot().rows;
        } finally {
          parsed.close();
        }
        const after = await watch.read();
        if (before.watchId !== after.watchId || before.frameSequence !== after.frameSequence)
          return after;
        const originalLines = original.map(textOf);
        const rawLast = originalLines.findLastIndex((line) => line.trim()),
          offset = rawLast - last;
        if (
          offset < 0 ||
          lines.some(
            (line, index) => line.trimEnd() !== (originalLines[index + offset] || '').trimEnd(),
          )
        )
          return after;
        const rows = original.slice(offset, offset + before.rows.length);
        return { ...after, rows, raw: rowsToAnsi(rows), originalInverseVerified: true };
      });
  }
  async observe(pane, label) {
    await this.verifyProcess(pane);
    const state = surface(await this.readScreen(pane));
    await this.verifyProcess(pane);
    await this.onObservation({ label, state });
    return state;
  }
  async wait(pane, verify, predicate, label) {
    const deadline = performance.now() + this.timeoutMs;
    do {
      await verify();
      const state = await this.observe(pane, label);
      if (predicate(state)) return state;
      await delay(this.stepMs);
    } while (performance.now() < deadline);
    throw fail('REWIND_NATIVE_UNCONFIRMED', `原生界面尚未确认${label}，不会重复发送按键。`);
  }
  assertMainEmpty(state) {
    if (state.mode === 'side') throw fail('SIDE_ACTIVE', '请先切回 Codex 主会话再编辑历史消息。');
    if (state.mode !== 'main')
      throw fail('REWIND_NATIVE_MODE', '原生界面已有菜单或无法确认主会话，未执行编辑。');
    if (!state.composer)
      throw fail('REWIND_COMPOSER_UNKNOWN', '无法确认完整的原生输入区域，未执行编辑。');
    if (state.input !== '') throw fail('NATIVE_INPUT_OCCUPIED', '原生输入框已有草稿，未覆盖草稿。');
  }
  assertSelected(state, target, { requireHead = false } = {}) {
    const excerpt = comparable(state.selected?.text),
      sourceText = comparable(target.sourceText);
    if (
      state.mode !== 'selector' ||
      !excerpt ||
      !sourceText.includes(excerpt) ||
      (state.selected.headVisible && !sourceText.startsWith(excerpt)) ||
      (requireHead && !state.selected.headVisible)
    )
      throw fail('REWIND_SELECTION_UNCONFIRMED', '无法确认选中了这条原始消息，未回退会话。');
  }
  async select({ pane, target, history, verify }) {
    if (
      !history?.complete ||
      !Array.isArray(history.targets) ||
      !Number.isSafeInteger(target.visibleIndex) ||
      target.visibleIndex < 0 ||
      history.targets[target.visibleIndex]?.messageId !== target.messageId ||
      !target.receiptVerified ||
      !(target.nativeUserItemId || target.nativeReceiptRecordId) ||
      !target.turnId
    )
      throw fail('REWIND_HISTORY_UNVERIFIED', '原生消息顺序或身份不完整，未执行编辑。');
    let state,
      localOwner = null;
    try {
      await verify();
      state = await this.observe(pane, 'before selection');
      this.assertMainEmpty(state);
      if (state.working) {
        await verify();
        await this.press(pane, ['esc']);
        state = await this.wait(
          pane,
          verify,
          (value) =>
            ['main', 'primed'].includes(value.mode) && !value.working && value.input === '',
          '任务中断或自然完成',
        );
        if (state.mode === 'main') this.assertMainEmpty(state);
      }
      if (state.mode !== 'primed') {
        await verify();
        await this.press(pane, ['esc']);
        await this.wait(
          pane,
          verify,
          (value) => value.mode === 'primed' && value.input === '',
          '历史编辑提示',
        );
      }
      await verify();
      await this.press(pane, ['esc']);
      state = await this.wait(pane, verify, (value) => value.mode === 'selector', '历史选择');
      let index = history.targets.length - 1;
      const owner = {
        id: randomUUID(),
        messageId: target.messageId,
        historyRevision: history.revision,
        branch: history.branch,
        selectionRevision: state.selectionRevision,
      };
      localOwner = owner;
      this.owners.set(ownerKey(pane), owner);
      this.assertSelected(state, history.targets[index]);
      const deadline = performance.now() + this.navigationTimeoutMs;
      while (index > target.visibleIndex) {
        if (performance.now() >= deadline)
          throw fail('REWIND_SELECTION_TIMEOUT', '选择历史消息超时，未回退会话。');
        const previous = state.selectedRevision;
        await verify();
        await this.press(pane, ['left']);
        state = await this.wait(
          pane,
          verify,
          (value) =>
            value.mode === 'selector' && value.selected && value.selectedRevision !== previous,
          '上一条历史消息',
        );
        index--;
        owner.selectionRevision = state.selectionRevision;
        this.assertSelected(state, history.targets[index]);
      }
      // Native may reveal only the end of a long UserHistoryCell. Scroll this
      // already proven selected cell until its prompt marker is visible; no
      // additional user-index movement is inferred from transcript scrolling.
      while (!state.selected.headVisible) {
        if (performance.now() >= deadline)
          throw fail('REWIND_SELECTION_TIMEOUT', '读取长历史消息超时，未回退会话。');
        const previous = state.selectedRevision;
        await verify();
        await this.press(pane, ['up']);
        state = await this.wait(
          pane,
          verify,
          (value) =>
            value.mode === 'selector' && value.selected && value.selectedRevision !== previous,
          '长消息首部',
        );
        owner.selectionRevision = state.selectionRevision;
        this.assertSelected(state, target);
      }
      this.assertSelected(state, target, { requireHead: true });
      return {
        messageId: target.messageId,
        turnId: target.turnId,
        nativeUserItemId: target.nativeUserItemId,
        nativeReceiptRecordId: target.nativeReceiptRecordId || null,
        ownerId: owner.id,
        visibleIndex: index,
        selectionRevision: state.selectionRevision,
        branch: history.branch,
        prefixIds: history.targets.slice(0, index).map((item) => item.messageId),
        selectedText: state.selected.text,
      };
    } catch (error) {
      // Selection is reversible. Cancel only while the caller's original
      // identity/order proof is still valid and this native selector remains.
      if (localOwner) {
        try {
          await this.cancel({
            pane,
            target,
            selection: { ownerId: localOwner.id },
            history,
            verify,
          });
        } catch {
          /* Cannot prove ownership: leave native state untouched. */
        }
      }
      throw error;
    }
  }
  async confirm({ pane, target, selection, verify }) {
    try {
      await verify();
      const state = await this.observe(pane, 'before revert');
      this.assertSelected(state, target, { requireHead: true });
      const owner = this.owners.get(ownerKey(pane));
      if (
        !owner ||
        owner.id !== selection.ownerId ||
        state.selectionRevision !== selection.selectionRevision ||
        selection.messageId !== target.messageId ||
        selection.turnId !== target.turnId ||
        selection.nativeUserItemId !== target.nativeUserItemId ||
        selection.nativeReceiptRecordId !== (target.nativeReceiptRecordId || null)
      )
        throw fail('REWIND_SELECTION_CHANGED', '原生选择已改变，未回退会话。');
      if (typeof this.readHistory !== 'function')
        throw fail('REWIND_HISTORY_UNAVAILABLE', '无法核对回退后的原生历史。');
      await verify();
    } catch (error) {
      try {
        await this.cancel({ pane, target, selection, verify });
      } catch {}
      throw error;
    }
    // The controller must durably persist revert_in_flight before this call.
    // This Enter is never retried, including when observation disconnects.
    this.owners.delete(ownerKey(pane));
    await this.press(pane, ['enter']);
    const deadline = performance.now() + this.timeoutMs;
    do {
      await this.verifyProcess(pane);
      let current;
      try {
        current = await this.readHistory(pane);
      } catch (error) {
        if (error.code !== 'ARCHIVE_CHANGED') throw error;
        await delay(this.stepMs);
        continue;
      }
      const ids = current.targets?.map((item) => item.messageId);
      const observed = await this.observe(pane, 'revert result');
      if (
        !same(current.branch, selection.branch) &&
        current.complete &&
        same(ids, selection.prefixIds) &&
        observed.mode === 'main' &&
        !observed.working &&
        observed.composer?.cursorAtEnd &&
        observed.input &&
        comparable(target.sourceText).endsWith(comparable(observed.input))
      ) {
        // The new immutable prefix and our one Enter establish the provenance
        // of a restored long draft even when its beginning is off screen.
        this.drafts.set(ownerKey(pane), {
          sourceDigest: digest(target.sourceText),
          revision: observed.composer.revision,
          watchId: observed.watchId,
          frameSequence: observed.frameSequence,
        });
        return {
          branch: current.branch,
          prefixIds: ids,
          prepared: true,
          sourceText: target.sourceText,
        };
      }
      await delay(this.stepMs);
    } while (performance.now() < deadline);
    throw fail('REWIND_REVERT_UNCONFIRMED', '已发送原生回退确认，结果尚未确认；不会再次回退。');
  }
  async replace({ pane, sourceText, text, verify }) {
    if (!String(text).trim() || unsafePrefix(text))
      throw fail('REWIND_COMMAND_TEXT', '编辑内容不能为空或以原生命令前缀开头。');
    const key = ownerKey(pane),
      own = this.drafts.get(key);
    const check = (state) => {
      if (
        !own ||
        own.sourceDigest !== digest(sourceText) ||
        state.mode !== 'main' ||
        state.working ||
        !state.input ||
        !state.composer?.cursorAtEnd ||
        state.composer.revision !== own.revision ||
        state.watchId !== own.watchId ||
        state.frameSequence !== own.frameSequence
      )
        throw fail('REWIND_DRAFT_CHANGED', '原生编辑草稿已改变，未覆盖输入框。');
    };
    await verify();
    check(await this.observe(pane, 'before replacement'));
    // Check again immediately before the single clear. This is a guarded PTY
    // key, not an atomic native compare-and-clear protocol: concurrent external
    // keystrokes after the final observation cannot be excluded by this API.
    await verify();
    check(await this.observe(pane, 'last owned draft check'));
    this.drafts.delete(key);
    await this.press(pane, ['ctrl+c']);
    await this.wait(
      pane,
      verify,
      (state) => state.mode === 'main' && !state.working && state.input === '',
      '清空本次恢复的草稿',
    );
    return { cleared: true, textDigest: digest(text), clearKeys: 1 };
  }
  async send({ pane, text, verify }) {
    if (unsafePrefix(text)) throw fail('REWIND_COMMAND_TEXT', '编辑内容不能以原生命令前缀开头。');
    await verify();
    const state = await this.observe(pane, 'before edited submit');
    if (state.mode !== 'main' || state.working || state.input !== '')
      throw fail('REWIND_DRAFT_CHANGED', '原生输入已改变，未再次发送。');
    await verify();
    // The controller must durably persist submit_in_flight before this call.
    return this.sendMessage(pane, text);
  }
  async cancel({ pane, target, selection, history, verify }) {
    await verify();
    const key = ownerKey(pane),
      owner = this.owners.get(key);
    const state = await this.observe(pane, 'cancel selection');
    if (!owner) {
      if (state.mode === 'main' && state.input === '')
        return { cancelled: false, alreadyMain: true };
      throw fail('REWIND_SELECTOR_NOT_OWNED', '无法确认本次历史选择，未发送取消按键。');
    }
    if (
      owner.messageId !== target.messageId ||
      selection?.ownerId !== owner.id ||
      (history && history.revision !== owner.historyRevision) ||
      state.mode !== 'selector' ||
      state.selectionRevision !== owner.selectionRevision
    )
      throw fail('REWIND_SELECTOR_NOT_OWNED', '原生历史选择已改变，未发送取消按键。');
    await verify();
    await this.press(pane, ['esc']);
    this.owners.delete(key);
    const main = await this.wait(
      pane,
      verify,
      (value) => value.mode === 'main' && value.input === '',
      '取消历史选择',
    );
    return { cancelled: true, mode: main.mode, input: main.input };
  }
  async close({ pane }) {
    if (!pane) return;
    const key = ownerKey(pane),
      watch = this.watches.get(key);
    this.watches.delete(key);
    this.drafts.delete(key);
    if (watch) await watch.close();
  }
  async read({ pane }) {
    const state = await this.observe(pane, 'read recovery');
    const history = typeof this.readHistory === 'function' ? await this.readHistory(pane) : null;
    return {
      mode: state.mode,
      working: state.working,
      input: state.input,
      selectedText: state.selected?.text || null,
      selectionRevision: state.selectionRevision,
      branch: history?.branch || null,
      userIds: history?.targets?.map((item) => item.messageId) || [],
    };
  }
}

module.exports = { RewindNative, surface, composerSurface, comparable, unsafePrefix };
