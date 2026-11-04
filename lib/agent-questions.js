'use strict';
/**
 * Agent 的提问：读出来给页面显示，页面作答后按原生的方式在终端里答（docs/PRODUCT_SPEC.md 2.6）。
 *
 * 两家的提问机制完全不同，各自一个模块（2026-09-25 拆开）：
 *   lib/questions/claude.js   AskUserQuestion 分步对话框、多选、确认页、工具审批
 *   lib/questions/codex.js    request_user_input(_async)：收起/展开、每问单独提交、存档里的回答记录
 * 这里只做两家共同的部分：读存档与画面、按会话身份给每道题一个 challenge、防重复提交、
 * 作答前后核对目标会话没有换人、记下提交结果。
 */
const { stripAnsi } = require('../public/ansi');
const { sendPaneKeys, sendPaneAnswer, pastePaneText } = require('./herdr-input');
const { fail, digest, pause } = require('./questions/common');
const claude = require('./questions/claude');
const codex = require('./questions/codex');

const providers = { claude, codex };
const providerOf = (pane) =>
  /claude/i.test(pane.agent?.label || '')
    ? 'claude'
    : /codex/i.test(pane.agent?.label || '')
      ? 'codex'
      : null;

/** 兼容旧调用：按 Agent 取存档里待答的提问。 */
function pendingQuestion(provider, lines) {
  return /claude/i.test(provider) ? claude.pendingQuestion(lines) : codex.pendingQuestion(lines);
}

class AgentQuestions {
  constructor({
    herdr,
    exactPane,
    readLines,
    readPendingQuestion,
    readQuestionState,
    receiptFile,
    restoreMain = false,
    requireProcess = false,
    operate = (_id, run) => run(),
    isControllingPane = () => false,
    beforeAnswer = async () => {},
    keys = (id, value) => sendPaneKeys(id, value, { socketFile: herdr.socketPath }),
    text = (paneId, value, options) =>
      sendPaneAnswer(paneId, value, { socketFile: herdr.socketPath, ...options }),
    paste = (id, value) => pastePaneText(id, value, { socketFile: herdr.socketPath }),
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      readLines,
      readPendingQuestion,
      readQuestionState,
      restoreMain,
      requireProcess,
      operate,
      isControllingPane,
      beforeAnswer,
      keys,
      text,
      paste,
    });
    this.busy = new Set();
    this.sent = new Map();
    this.questionViews = new Map();
    this.requests = new Map();
    this.receipts = new (require('./questions/receipts').QuestionReceipts)(receiptFile);
    this.state = { goalPrompts: new Map() };
  }

  async read(pane, { nativeOnly = false } = {}) {
    const provider = providerOf(pane);
    const sessionId = pane.agent?.session?.value || '';
    const preSession = provider === 'codex' && !sessionId;
    if (
      !provider ||
      this.isControllingPane(pane.paneId) ||
      (!sessionId && !(preSession && pane.runtimeId && pane.terminalId))
    )
      return null;
    const precomputed =
      provider === 'codex' && (this.readQuestionState || this.readPendingQuestion);
    let lines = [],
      pending;
    const archive = async () => {
      lines = preSession || precomputed ? [] : await this.readLines(pane).catch(() => []);
      pending = preSession
        ? null
        : precomputed
          ? this.readQuestionState
            ? (await this.readQuestionState(pane)).pending
            : await this.readPendingQuestion(pane)
          : undefined;
    };
    let screen, rawScreen;
    try {
      // Herdr's detection source returns normalized text even when ANSI is
      // requested. Foreground overlays need the current screen's dim/bold
      // attributes to distinguish their input from the retained parent.
      rawScreen = await this.herdr.readPane(pane.paneId, {
        lines: 100,
        exact: true,
        source: 'recent',
        ansi: true,
      });
      screen = stripAnsi(rawScreen);
    } catch (error) {
      if (
        nativeOnly ||
        provider === 'claude' ||
        this.state.goalPrompts.has(pane.paneId) ||
        this.state.nativePrompts?.has(pane.paneId)
      )
        throw error;
      await archive();
      if (precomputed ? pending : codex.pendingQuestion(lines)) throw error;
      return null;
    }
    // Native confirmations belong to the live terminal, not the transcript.
    // A slow or unavailable archive must not hide the menu blocking input.
    let found =
      provider === 'codex'
        ? codex.inspect({ pane, lines: [], screen, rawScreen, state: this.state, pending: null })
        : null;
    if (!found && !nativeOnly) {
      await archive();
      found = providers[provider].inspect({
        pane,
        lines,
        screen,
        rawScreen,
        state: this.state,
        pending,
      });
    }
    // Before native session creation, only the currently visible foreground
    // menu is controllable. Neither an archive nor a composer is authority.
    if (!found || (preSession && !found.nativeModal)) return null;
    const { identity, fingerprint, ...prompt } = found;
    if (prompt.queued)
      this.questionViews.set(pane.paneId, {
        terminalId: pane.terminalId,
        runtimeId: pane.runtimeId,
        sessionId: pane.agent.session.value,
        expanded: Boolean(prompt.expanded),
      });
    const base = [pane.paneId, pane.terminalId, pane.runtimeId || null, pane.agent.name, sessionId];
    const challenge = digest([...base, ...identity, fingerprint ?? null]);
    const receipt = prompt.collapsed
      ? null
      : this.receipts.forQuestion(digest([pane.paneId, sessionId, challenge]));
    const binding = {
      provider,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      runtimeId: pane.runtimeId || '',
      sessionId,
      canWrite: !this.requireProcess || Boolean(pane.runtimeId),
    };
    // These archived candidates support local browsing only. Submission still
    // locates the exact live tool/index after verifying the native main thread.
    const archived = prompt.queued ? (precomputed ? pending : codex.pendingQuestion(lines)) : null;
    const items = archived
      ? (archived.calls || [archived])
          .flatMap((call) =>
            call.questions
              .filter((q) => !q.answered)
              .map((q) => {
                const id = digest([...base, call.id, q.index, null]);
                const record = this.receipts.forQuestion(
                  digest([pane.paneId, pane.agent.session.value, id]),
                );
                return {
                  ...binding,
                  toolId: call.id,
                  index: q.index,
                  total: call.questions.length,
                  stage: 'question',
                  queued: true,
                  blocking: false,
                  question: q.question,
                  header: q.header,
                  options: q.options || [],
                  allowText: q.allowText,
                  challenge: id,
                  draftKey: digest([...base, call.id, q.index, 'question', q.index]),
                  delivery: this.sent.get(id) || record?.delivery || null,
                  ...(record ? { receiptRequestId: record.requestId } : {}),
                };
              }),
          )
          .filter((q) => !['sent', 'skipped'].includes(q.delivery))
      : [];
    return {
      ...prompt,
      ...binding,
      ...(preSession ? { preSession: true } : {}),
      challenge,
      canWrite: !this.requireProcess || Boolean(pane.runtimeId),
      draftKey: digest([...base, ...identity, prompt.stage, prompt.index]),
      delivery: prompt.collapsed ? null : this.sent.get(challenge) || receipt?.delivery || null,
      ...(prompt.queued ? { items } : {}),
      ...(receipt ? { receiptRequestId: receipt.requestId } : {}),
    };
  }

  async answer(payload) {
    const action = payload.action || 'answer';
    if (
      ![
        'answer',
        'open',
        'next',
        'previous',
        'main',
        'skip',
        'native-up',
        'native-down',
        'native-toggle',
      ].includes(action)
    )
      return Promise.reject(fail('不支持这个问题操作。', 400));
    if (payload.requestId !== undefined && !/^[\w:-]{1,128}$/.test(payload.requestId))
      return Promise.reject(fail('请求标识无效。', 400));
    const key = payload.requestId ? `${payload.paneId}:${payload.requestId}` : '';
    const signature = digest([
      payload.paneId,
      payload.sessionId,
      payload.challenge,
      action,
      payload.choices || [],
      payload.text || '',
      payload.confirm || false,
    ]);
    const prior = this.receipts.get(key),
      active = this.requests.get(key);
    if ((prior && prior.signature !== signature) || (active && active.signature !== signature))
      return Promise.reject(fail('同一请求标识不能用于不同操作。'));
    if (active) return active.promise;
    if (prior)
      return Promise.resolve({
        ok: true,
        delivery: prior.delivery,
        repeated: true,
        requestId: payload.requestId,
      });
    const questionKey = digest([payload.paneId, payload.sessionId, payload.challenge]);
    if (['answer', 'skip'].includes(action) && this.receipts.forQuestion(questionKey))
      throw fail('这个问题已有操作记录，请核对原操作结果。');
    const promise = Promise.resolve()
      .then(() =>
        this.operate(payload.paneId, () =>
          this.perform(payload, { key, signature, action, questionKey }),
        ),
      )
      .finally(() => {
        if (key) this.requests.delete(key);
      });
    if (key) this.requests.set(key, { signature, promise });
    return promise;
  }

  async perform(payload, request) {
    const { paneId, sessionId, challenge } = payload;
    if (this.busy.has(paneId)) throw fail('答案正在提交。');
    this.busy.add(paneId);
    let written = false;
    try {
      const pane = await this.exactPane(paneId);
      if (this.requireProcess && !pane.runtimeId)
        throw fail('无法确认原生运行实例，请刷新后重试。');
      if (typeof sessionId !== 'string' || (pane.agent?.session?.value || '') !== sessionId)
        throw fail('目标会话已改变。');
      let live = await this.read(pane);
      const resolve = (q) =>
        q?.challenge === challenge
          ? q
          : ['answer', 'skip'].includes(request.action)
            ? q?.items?.find((item) => item.challenge === challenge)
            : null;
      let prompt = resolve(live);
      if (!prompt) throw fail('问题已变化，请查看当前问题。');
      if (
        !sessionId &&
        !(prompt.preSession && prompt.nativeModal && pane.runtimeId && pane.terminalId)
      )
        throw fail('尚未确认当前原生选项。');
      if (live.challenge !== challenge) {
        // The user browsed another question locally. Reveal the main footer
        // for the existing identity check, then navigate only on this submit.
        await this.ensureMain(pane, true);
        live = await this.read(pane);
      }
      if (!live || !resolve(live)) throw fail('问题已变化，请查看当前问题。');
      await this.beforeAnswer(pane, live);
      live = await this.read(pane);
      prompt = resolve(live);
      if (!prompt) throw fail('问题已变化，请查看当前问题。');
      if (live.challenge !== challenge)
        prompt = {
          ...prompt,
          collapsed: true,
          expanded: false,
          navigation: live.navigation,
          remaining: live.remaining,
          browseCount: live.items?.length,
        };
      if (this.sent.has(challenge) && ['answer', 'skip'].includes(request.action))
        throw fail('答案已提交，请等待 Agent 更新。');
      const again = await this.exactPane(paneId);
      if (
        again.runtimeId !== pane.runtimeId ||
        again.terminalId !== pane.terminalId ||
        (again.agent?.session?.value || '') !== sessionId ||
        again.agent?.name !== pane.agent?.name
      )
        throw fail('目标会话已改变。');
      // 作答过程中每读一次都要核对还是同一个会话：换人了就停，不往别人的终端里按键。
      const current = async (allowSessionCreation = false) => {
        const now = await this.exactPane(paneId);
        return now.runtimeId === pane.runtimeId &&
          now.terminalId === pane.terminalId &&
          ((now.agent?.session?.value || '') === sessionId ||
            (allowSessionCreation && prompt.preSession)) &&
          now.agent?.name === pane.agent?.name &&
          now.agent?.label === pane.agent?.label
          ? now
          : null;
      };
      const poll = async (accept, tries = 20, allowSessionCreation = false) => {
        for (let i = 0; i < tries; i++) {
          await pause(50);
          const now = await current(allowSessionCreation);
          if (!now) return { ok: false };
          const q = await this.read(now, { nativeOnly: Boolean(prompt.nativeModal) });
          if (accept(q)) return { ok: true, q };
        }
        return { ok: false };
      };
      const record = {
        signature: request.signature,
        questionKey: request.questionKey,
        action: request.action,
        requestId: payload.requestId,
        paneId,
        sessionId,
        toolId: prompt.toolId,
        index: prompt.index,
        ...(request.action === 'answer'
          ? {
              answerHash: codex.answerDigest(
                payload.text?.trim() || prompt.options?.[payload.choices?.[0]]?.label || '',
              ),
            }
          : {}),
      };
      const writing = () => {
        if (!written) this.receipts.put(request.key, { ...record, delivery: 'uncertain' });
        written = true;
      };
      const io = {
        keys: async (keys) => {
          if (!keys.length) return;
          if (!(await current())) throw fail('目标会话已改变。');
          writing();
          await this.keys(paneId, keys);
        },
        text: async (text) => {
          if (!(await current())) throw fail('目标会话已改变。');
          writing();
          await this.text(paneId, text, {
            beforeSubmit: async () => {
              if (!(await current())) throw fail('目标会话已改变。');
            },
          });
        },
        paste: async (text) => {
          if (!(await current())) throw fail('目标会话已改变。');
          writing();
          await this.paste(paneId, text);
        },
        reread: async (accept, tries) => {
          const r = await poll((q) => Boolean(q) && accept(q), tries);
          return r.ok ? r.q : null;
        },
        // A confirmed startup choice may create its session. That transition
        // is accepted only for observing the result, never for another key.
        until: async (accept, tries) =>
          (await poll(accept, tries, Boolean(prompt.preSession && prompt.nativeModal))).ok,
        confirm: async (expected) => {
          for (let i = 0; i < 40; i++) {
            const now = await current();
            if (!now) return false;
            const state = this.readQuestionState
              ? await this.readQuestionState(now)
              : codex.questionState(await this.readLines(now));
            if (codex.hasReceipt(state, expected)) return true;
            await pause(25);
          }
          return false;
        },
      };
      let outcome;
      if (request.action === 'answer')
        outcome = await providers[prompt.provider].answer({ prompt, payload, io });
      else if (['native-up', 'native-down', 'native-toggle'].includes(request.action)) {
        if (!prompt.nativeModal?.scrollable) throw fail('当前选项不支持滚动。', 400);
        if (request.action === 'native-toggle' && !prompt.nativeModal.toggle)
          throw fail('当前选项不支持切换勾选。', 400);
        await io.keys([
          request.action === 'native-toggle'
            ? 'space'
            : request.action === 'native-up'
              ? 'up'
              : 'down',
        ]);
        outcome = (await io.reread((q) => q.nativeModal?.title === prompt.nativeModal.title))
          ? 'navigated'
          : 'uncertain';
      } else {
        if (prompt.provider !== 'codex' || !prompt.queued)
          throw fail('这个问题不支持该操作。', 400);
        if (request.action === 'skip')
          prompt = { ...prompt, ...(await codex.navigateQueued({ prompt, io })) };
        if (request.action === 'main') {
          writing();
          await this.ensureMain(pane, true);
          outcome = 'navigated';
        } else {
          const nav = prompt.navigation;
          const key =
            request.action === 'open' && prompt.collapsed
              ? nav.open
              : request.action === 'next' && nav.canNext
                ? nav.next
                : request.action === 'previous' && (nav.canPrevious || nav.canMain)
                  ? nav.previous
                  : request.action === 'skip' && prompt.expanded && nav.canSkip
                    ? 'ctrl+]'
                    : '';
          if (!key) throw fail('原生问题已变化，请查看当前操作。');
          await io.keys([key]);
          const changed = await io.until(
            (q) =>
              request.action === 'open'
                ? Boolean(q?.expanded)
                : request.action === 'skip'
                  ? !q ||
                    q.toolId !== prompt.toolId ||
                    q.index !== prompt.index ||
                    q.remaining !== prompt.remaining
                  : !q || q.collapsed || q.toolId !== prompt.toolId || q.index !== prompt.index,
            30,
          );
          outcome = changed ? (request.action === 'skip' ? 'skipped' : 'navigated') : 'uncertain';
        }
      }
      if (['answer', 'skip'].includes(request.action)) this.remember(challenge, outcome);
      if (
        this.restoreMain &&
        prompt.provider === 'codex' &&
        prompt.queued &&
        request.action === 'answer'
      )
        await this.ensureMain(pane, true);
      this.receipts.put(request.key, { ...record, delivery: outcome });
      return { ok: true, delivery: outcome, requestId: payload.requestId };
    } catch (error) {
      if (written && ['answer', 'skip'].includes(request.action))
        this.remember(challenge, 'uncertain');
      error.deliveryUncertain = written;
      throw error;
    } finally {
      this.busy.delete(paneId);
    }
  }

  async receipt(paneId, requestId) {
    const item = this.receipts.get(`${paneId}:${requestId}`);
    if (!item) throw fail('没有找到这次问题操作。', 404);
    if (item.delivery === 'uncertain' && item.action === 'answer') {
      const pane = await this.exactPane(paneId);
      if (pane.agent?.session?.value === item.sessionId) {
        const state = this.readQuestionState
          ? await this.readQuestionState(pane)
          : codex.questionState(await this.readLines(pane));
        if (codex.hasReceipt(state, item))
          this.receipts.put(item.key, { ...item, delivery: 'sent' });
      }
    }
    return { ok: true, requestId, delivery: this.receipts.get(item.key).delivery };
  }

  async ensureMain(pane, force = false) {
    if (providerOf(pane) !== 'codex') return;
    const observed = this.questionViews.get(pane.paneId);
    // Ordinary agent.prompt submissions retain their direct path. Only a
    // known expanded question needs focus recovery before another operation.
    if (
      !force &&
      !(
        observed?.expanded &&
        observed.terminalId === pane.terminalId &&
        observed.runtimeId === pane.runtimeId &&
        observed.sessionId === pane.agent.session.value
      )
    )
      return;
    const read = async () =>
      stripAnsi(
        await this.herdr.readPane(pane.paneId, { lines: 100, exact: true, source: 'detection' }),
      );
    const panel = (screen) =>
      screen
        .slice(screen.lastIndexOf('Queued follow-up inputs'))
        .split('\n')
        .filter((line) => line.trim())
        .join('\n');
    const isMain = (screen) => {
      if (codex.COLLAPSED.test(screen.slice(screen.lastIndexOf('Queued follow-up inputs'))))
        return true;
      const area = require('./agent-composer').readStatusArea(screen);
      return Boolean(
        area.composerHint ||
        (area.composer && area.statusline?.length) ||
        /^\s*[›❯]\s*$/m.test(screen),
      );
    };
    for (let i = 0; i < 128; i++) {
      let screen, nav;
      for (let retry = 0; retry < 30; retry++) {
        screen = await read();
        nav = codex.navigation(screen);
        if (nav.expanded || isMain(screen)) break;
        await pause(25);
      }
      if (!nav.expanded) {
        if (!isMain(screen)) throw fail('尚未确认原生主输入框，请稍后重试。');
        this.questionViews.delete(pane.paneId);
        return;
      }
      if (!(nav.canPrevious || nav.canMain)) throw fail('无法识别原生问题的返回操作。');
      const now = await this.exactPane(pane.paneId);
      if (
        now.runtimeId !== pane.runtimeId ||
        now.terminalId !== pane.terminalId ||
        now.agent?.session?.value !== pane.agent.session.value
      )
        throw fail('目标会话已改变。');
      const before = panel(screen);
      await this.keys(pane.paneId, [nav.previous]);
      let changed = false;
      for (let retry = 0; retry < 30; retry++) {
        await pause(25);
        screen = await read();
        if (panel(screen) !== before) {
          changed = true;
          break;
        }
      }
      if (!changed) throw fail('尚未确认返回原生主输入框，请重试。');
    }
    throw fail('尚未返回原生主输入框。');
  }

  // Expanded asynchronous questions hide Codex's thread footer. Reveal it for
  // the check, then restore the exact question before any answer is written.
  // This runs inside perform's existing per-pane operation, not a route preflight.
  async verifyQuestionThread(pane, prompt, check) {
    if (prompt.provider === 'codex' && prompt.nativeModal) {
      // A foreground native dialog, unlike a main-thread prompt, intentionally
      // covers its parent's composer. Revalidate that exact dialog and process;
      // revealing or requiring the background composer would target the wrong UI.
      const current = await this.exactPane(pane.paneId);
      if (
        !pane.runtimeId ||
        current.runtimeId !== pane.runtimeId ||
        current.terminalId !== pane.terminalId ||
        (current.agent?.session?.value || '') !== (pane.agent?.session?.value || '')
      )
        throw fail('目标会话已改变。');
      const live = await this.read(current);
      if (live?.nativeModal?.key !== prompt.nativeModal.key)
        throw fail('原生确认界面已变化，请查看当前选项。');
      return;
    }
    if (prompt.provider !== 'codex' || !prompt.queued || !prompt.expanded) return check();
    await this.ensureMain(pane, true);
    await check();
    let current = await this.read(pane);
    for (let i = 0; i < prompt.position; i++) {
      const now = await this.exactPane(pane.paneId);
      if (
        now.runtimeId !== pane.runtimeId ||
        now.terminalId !== pane.terminalId ||
        now.agent?.session?.value !== pane.agent.session.value
      )
        throw fail('目标会话已改变。');
      const key = current?.collapsed
        ? current.navigation.open
        : current?.navigation.canNext
          ? current.navigation.next
          : '';
      if (!key) throw fail('无法恢复原问题，请查看当前问题。');
      await this.keys(pane.paneId, [key]);
      const previous = current;
      let changed = false;
      for (let retry = 0; retry < 30; retry++) {
        await pause(25);
        current = await this.read(now);
        if (current?.expanded && (previous.collapsed || current.position !== previous.position)) {
          changed = true;
          break;
        }
      }
      if (!changed) throw fail('尚未确认恢复原问题，请重试。');
    }
    if (current?.challenge !== prompt.challenge) throw fail('问题已变化，请查看当前问题。');
  }

  remember(challenge, value) {
    this.sent.set(challenge, value);
    while (this.sent.size > 512) this.sent.delete(this.sent.keys().next().value);
  }
}

module.exports = {
  AgentQuestions,
  pendingQuestion,
  claudeDialog: claude.claudeDialog,
  codexDialog: codex.codexDialog,
  visibleClaudeQuestion: claude.visibleClaudeQuestion,
};
