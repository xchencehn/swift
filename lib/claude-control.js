'use strict';
const { clearNativeComposer } = require('./native-composer');
const { parseLine } = require('./json-lines');
const { stripAnsi } = require('../public/ansi');
const { readStatusArea } = require('./agent-composer');
const { sendPaneKeys, pastePaneText } = require('./herdr-input');
const { apiError } = require('./message-queue');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compact = (text) => stripAnsi(String(text)).replace(/\s|`/g, '').toLowerCase();
const identity = require('./conversation-state').binding;

// Claude's TUI and extension both apply model settings inside the running
// process. For existing TUI sessions, use its native session-only selector.
// Do not send SDK control JSON to the unrelated peer-message socket.
function modelMenu(screen) {
  const text = stripAnsi(screen),
    condensed = compact(text);
  if (!condensed.includes('selectmodel') || !condensed.includes('stousethissessiononly'))
    return null;
  const title = [...text.matchAll(/Select\s*model/gi)].at(-1);
  if (!title) return null;
  const body = text.slice(title.index);
  const rows = [...body.matchAll(/^\s*([❯>]?)\s*(\d+)\.\s*(.+)$/gm)].map((match) => ({
    selected: Boolean(match[1]),
    number: Number(match[2]),
    label: match[3],
  }));
  if (rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const effort = body
    .match(/(?:[●○◐◑◒◓]\s*)?(Low|Medium|High|Extra|Xhigh|Max)\s*effort/i)?.[1]
    ?.toLowerCase();
  return {
    rows,
    selected: rows.findIndex((row) => row.selected),
    effort: effort === 'extra' ? 'xhigh' : effort,
  };
}
// This is the native cache-cost confirmation for the model the user already
// selected. Never accept a PreModelSwitch hook, permission or credit-consent UI.
function cacheSwitchConfirmation(raw) {
  const text = stripAnsi(raw)
    .replace(/^\s*[│┃]\s?/gm, '')
    .replace(/\s*[│┃]\s*$/gm, '');
  const title = [...text.matchAll(/(?:Switch\s*model|Change\s*effort\s*level)\?/gi)].at(-1);
  if (!title) return null;
  const body = text.slice(title.index),
    value = compact(body);
  const kind = /effort/i.test(title[0]) ? 'effort' : 'model';
  if (
    value.includes('premodelswitch') ||
    !value.includes('yournextresponsewillbeslowerandusemoretokens') ||
    !value.includes(
      `thisconversationiscachedforthecurrent${kind === 'model' ? 'model' : 'effortlevel'}.`,
    )
  )
    return null;
  const matches = [...body.matchAll(/^\s*([❯›>]?)\s*(\d+)\.\s*(.+)$/gm)];
  if (matches.length !== 2 || matches[0][2] !== '1' || matches[1][2] !== '2') return null;
  const rows = matches.map((row, i) => ({
    selected: Boolean(row[1]),
    label:
      row[3].trim() +
      (i === 0 ? ' ' + body.slice(row.index + row[0].length, matches[1].index).trim() : ''),
  }));
  const yes = rows.findIndex((row) => /^yes,\s*switch\s*to\s+/i.test(row.label));
  const no = rows.findIndex((row) => compact(row.label) === 'no,goback');
  const selected = rows.findIndex((row) => row.selected);
  if (yes < 0 || no < 0 || rows.filter((row) => row.selected).length !== 1) return null;
  const target = rows[yes].label.replace(/^yes,\s*switch\s*to\s+/i, '').trim();
  return { kind, target, selected, yes, rows, title: title[0], fingerprint: body };
}
/**
 * Claude 的**工具审批**提示。文案取自 Claude Code 二进制里的实际字符串（2026-09-22）：
 *
 *   Bash command
 *     mkdir -p ~/probe && cd ~/probe && rm -rf *
 *     在 WSL 家目录建测试目录
 *    Compound command contains cd with write operation — manual approval required
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again for mkdir commands
 *     3. No, and tell Claude what to do differently
 *
 * ⚠️ 这不是 `AskUserQuestion`，形状也不一样：没有 `← ☐ … ✔ Submit →` 那行表头，
 * 问句是固定的几句之一。此前只认 AskUserQuestion，所以审批提示在页面上完全不出现，
 * 只能回终端按键（2026-09-22 用户指出）。
 */
const APPROVAL_TITLES =
  /^\s*(Bash command|Edit file|Create file|Write file|Read file|MCP tool)\s*$/;
// 只认工具审批那几句。`Do you want to use this API key?` 是登录流程，不在这里答。
const APPROVAL_QUESTIONS =
  /(Do you want to proceed\?|Do you want to continue\?|Do you want to allow Claude to fetch this content\?|Do you want to allow this connection\?)/g;

function permissionPrompt(raw) {
  const text = stripAnsi(raw)
    .replace(/^\s*[│┃]\s?/gm, '')
    .replace(/\s*[│┃]\s*$/gm, '');
  const question = [...text.matchAll(APPROVAL_QUESTIONS)].at(-1);
  if (!question) return null;
  const body = text.slice(question.index);
  const rows = [...body.matchAll(/^\s*([❯›>]?)\s*(\d+)\.\s+(.+)$/gm)];
  // ⚠️ 编号必须从 1 连续排下来：正文里常有「1. 2. 3.」的普通列表，不连续就不是选项。
  if (rows.length < 2 || rows.some((row, index) => Number(row[2]) !== index + 1)) return null;
  const selected = rows.findIndex((row) => row[1]);
  if (selected < 0 || rows.filter((row) => row[1]).length !== 1) return null;
  // 标题与被审批的内容在问句之前。取最后一个标题，前面可能还有别的对话。
  const head = text.slice(0, question.index);
  const titles = [...head.matchAll(new RegExp(APPROVAL_TITLES.source, 'gm'))];
  const title = titles.at(-1);
  const detail = title ? head.slice(title.index + title[0].length).trim() : '';
  return {
    title: title ? title[1] : '需要你确认',
    detail: detail
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 800),
    question: question[1],
    rows: rows.map((row) => ({ label: row[3].trim() })),
    selected,
    fingerprint: body,
  };
}

const modelName = (text) => compact(text).replace(/\(1mcontext\)|\[1m\]/g, '');
function cacheSwitchPrompt(raw, model, effort) {
  const prompt = cacheSwitchConfirmation(raw);
  if (!prompt) return null;
  const matches =
    prompt.kind === 'model'
      ? modelName(prompt.target) === modelName(model.label)
      : effort &&
        compact(prompt.target)
          .replace(/effort$/, '')
          .replace(/^extra$/, 'xhigh') === compact(effort);
  if (!matches) return null;
  return [
    ...(prompt.selected === prompt.yes ? [] : [prompt.selected > prompt.yes ? 'up' : 'down']),
    'enter',
  ];
}
function receipt(raw, models) {
  let entry;
  try {
    entry = parseLine(raw);
  } catch {
    return null;
  }
  const text = typeof entry.message?.content === 'string' ? entry.message.content : '';
  if (!text.startsWith('<local-command-stdout>')) return null;
  const effortChange = stripAnsi(text).match(
    /^<local-command-stdout>Set effort level to (low|medium|high|xhigh|max)\b/,
  );
  if (effortChange)
    return {
      effort: effortChange[1],
      recordedAt: entry.timestamp,
      source: 'claude-native-confirmation',
    };
  const match = stripAnsi(text).match(
    /Set model to `([^`]+)` (for this session only|and saved as your default for new sessions)(?: with `([^`]+)` effort)?/,
  );
  if (!match) return null;
  const name = compact(match[1]).replace(/\(1mcontext\)|\[1m\]/g, '');
  const model = models.find((model) => compact(model.label) === name);
  if (!model) return null;
  return {
    model: model.id,
    ...(match[3] ? { effort: match[3] } : {}),
    scope: match[2] === 'for this session only' ? 'session' : 'default',
    recordedAt: entry.timestamp,
    source: 'claude-native-confirmation',
  };
}
function appliedHeader(raw, models) {
  const lines = stripAnsi(raw).split('\n');
  const index = lines.findIndex((line) => /Claude\s*Code\s*v\d+\.\d+\.\d+/.test(line));
  if (index < 0 || index > 8) return null;
  const text = compact(lines[index + 1] || '');
  const model = models.find(
    (model) =>
      text.includes(`${compact(model.label)}with`) || text.includes(`${compact(model.label)}·`),
  );
  const effort = text.match(/with(low|medium|high|extra|xhigh|max)effort·/)?.[1];
  if (!model) return null;
  return {
    model: model.id,
    ...(effort ? { effort: effort === 'extra' ? 'xhigh' : effort } : {}),
    source: 'claude-native-screen',
  };
}
class ClaudeControl {
  constructor({
    herdr,
    exactPane,
    readLines,
    catalog,
    operate = (_id, run) => run(),
    beforeApply = async () => {},
    keys = sendPaneKeys,
    paste = pastePaneText,
    timeoutMs = 10000,
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      readLines,
      catalog,
      operate,
      beforeApply,
      keys,
      paste,
      timeoutMs,
    });
    this.busy = new Set();
    this.observed = new Map();
  }
  async recorded(pane, lines) {
    const catalog = await this.catalog();
    let result = {};
    for (const raw of lines) {
      let entry;
      try {
        entry = parseLine(raw);
      } catch {
        continue;
      }
      if (
        entry.type === 'assistant' &&
        entry.message?.model &&
        result.source !== 'claude-native-confirmation'
      )
        result = { ...result, model: entry.message.model, recordedAt: entry.timestamp };
      const value = receipt(raw, catalog.models);
      if (value) result = { ...result, ...value };
    }
    const observed = this.observed.get(identity(pane));
    if (
      observed &&
      (result.source !== 'claude-native-confirmation' ||
        !result.recordedAt ||
        Date.parse(observed.recordedAt) >= Date.parse(result.recordedAt))
    )
      result = { ...result, ...observed };
    try {
      const live = appliedHeader(
        await this.herdr.readPane(pane.paneId, { lines: 100, ansi: true }),
        catalog.models,
      );
      if (live) result = { ...result, ...live };
    } catch {
      /* archive and previously confirmed state remain available */
    }
    return result;
  }
  apply(pane, settings, catalog) {
    return this.operate(pane.paneId, () => this.applyWithin(pane, settings, catalog));
  }

  async applyWithin(pane, settings, catalog) {
    const key = identity(pane);
    if (this.busy.has(pane.paneId)) throw apiError(409, 'SETTINGS_BUSY', '正在切换，请稍候');
    const model = catalog.models.find((model) => model.id === settings.model);
    if (!model?.primary)
      throw apiError(400, 'MODEL_NOT_IN_SELECTOR', '这个模型不在当前原生选择器中');
    this.busy.add(pane.paneId);
    let opened = false;
    const check = async () => {
      const fresh = await this.exactPane(pane.paneId);
      if (identity(fresh) !== key || fresh.agent?.label !== 'claude')
        throw apiError(409, 'SESSION_CHANGED', '目标会话已改变');
      return fresh;
    };
    const screen = async () => {
      await check();
      return this.herdr.readPane(pane.paneId, { lines: 100, ansi: true });
    };
    const waitFor = async (predicate) => {
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await pause(100);
      }
      throw apiError(409, 'CLAUDE_SETTINGS_UNCONFIRMED', '未确认切换，原生界面可能需要确认');
    };
    const press = async (keys) => {
      await check();
      await this.keys(pane.paneId, keys);
    };
    try {
      await this.beforeApply();
      const current = await check();
      if (!['idle', 'done', 'working'].includes(current.agent?.status || current.status))
        throw apiError(409, 'AGENT_NOT_READY', '请先处理当前会话中的确认');
      const raw = await screen(),
        area = readStatusArea(raw);
      if (!/^\s*[─━-]{8,}/m.test(stripAnsi(raw)))
        throw apiError(409, 'NATIVE_INPUT_UNAVAILABLE', '未识别到原生输入框');
      await clearNativeComposer({
        pane,
        herdr: this.herdr,
        exactPane: this.exactPane,
        screen,
        press,
        timeoutMs: this.timeoutMs,
      });
      const baseline = new Set(await this.readLines(pane).catch(() => []));
      await this.paste(pane.paneId, '/model');
      await waitFor(async () => compact(readStatusArea(await screen()).composer) === '/model');
      await press(['enter']);
      opened = true;
      let menu = await waitFor(async () => modelMenu(await screen()));
      const destination = menu.rows.findIndex(
        (row) =>
          compact(row.label).startsWith(compact(model.short)) &&
          compact(row.label).includes(compact(model.label)),
      );
      if (destination < 0)
        throw apiError(409, 'MODEL_NOT_IN_SELECTOR', '当前原生模型目录已变化，请重新选择');
      while (menu.selected !== destination) {
        const previous = menu.selected;
        await press([destination > previous ? 'down' : 'up']);
        menu = await waitFor(async () => {
          const value = modelMenu(await screen());
          return value && value.selected !== previous ? value : null;
        });
      }
      for (let tries = 0; settings.effort && menu.effort !== settings.effort; tries++) {
        const currentIndex = model.efforts.findIndex((item) => item.id === menu.effort),
          desired = model.efforts.findIndex((item) => item.id === settings.effort);
        if (currentIndex < 0 || desired < 0 || tries >= model.efforts.length)
          throw apiError(409, 'EFFORT_UNAVAILABLE', '当前模型不支持这个推理强度');
        const previous = menu.effort;
        await press([desired > currentIndex ? 'right' : 'left']);
        menu = await waitFor(async () => {
          const value = modelMenu(await screen());
          return value && value.effort !== previous ? value : null;
        });
      }
      // Recheck the highlighted model and scope immediately before committing.
      menu = modelMenu(await screen());
      if (
        !menu ||
        !compact(menu.rows[menu.selected].label).startsWith(compact(model.short)) ||
        (settings.effort && menu.effort !== settings.effort)
      )
        throw apiError(409, 'SELECTOR_CHANGED', '选择器已变化，请重新选择');
      await press(['s']);
      const cacheConfirmed = new Set();
      const actual = await waitFor(async () => {
        await check();
        const lines = await this.readLines(pane).catch(() => []);
        for (const raw of lines) {
          if (baseline.has(raw)) continue;
          const value = receipt(raw, catalog.models);
          if (
            value?.scope === 'session' &&
            value?.model === settings.model &&
            (!settings.effort || value.effort === settings.effort)
          )
            return value;
        }
        const raw = await screen();
        const confirmation = cacheSwitchConfirmation(raw);
        if (confirmation && !cacheConfirmed.has(confirmation.kind)) {
          const keys = cacheSwitchPrompt(raw, model, settings.effort);
          const fresh = await screen();
          if (keys && confirmation.fingerprint === cacheSwitchConfirmation(fresh)?.fingerprint) {
            cacheConfirmed.add(confirmation.kind);
            await press(keys);
          }
        }
        // While a turn runs, Claude can apply settings without writing a local
        // command record. Its live header is the same process's applied state.
        const header = appliedHeader(raw, catalog.models);
        if (
          !modelMenu(raw) &&
          !confirmation &&
          header?.model === settings.model &&
          (!settings.effort || header.effort === settings.effort)
        ) {
          return { ...header, scope: 'session', recordedAt: new Date().toISOString() };
        }
        return null;
      });
      if (this.observed.size >= 256) this.observed.delete(this.observed.keys().next().value);
      this.observed.set(key, actual);
      return actual;
    } finally {
      // Escape only our recognized selector, never approve an unexpected dialog.
      if (opened) {
        try {
          if (modelMenu(await screen())) await press(['esc']);
        } catch {
          /* changed target: do not write */
        }
      }
      this.busy.delete(pane.paneId);
    }
  }
}
module.exports = {
  permissionPrompt,
  ClaudeControl,
  modelMenu,
  receipt,
  cacheSwitchPrompt,
  cacheSwitchConfirmation,
  appliedHeader,
};
