'use strict';
const { clearNativeComposer } = require('./native-composer');
/**
 * Codex 的模型、推理档位与速度档位：读画面、在终端里按键切换。与 Claude 的
 * `claude-control.js` 同一种做法 —— 控制面是 PTY，不对接 Codex 私有的 app-server。
 *
 * 菜单的样子是 2026-09-23 在探针会话里实测的（Codex v0.156.0）：
 *
 *   /model              → 「Select Reasoning Level for GPT-6-Astra」，光标停在当前档位；
 *                         也见过直接出模型列表「Select Model and Effort」，两种都要接得住
 *   档位菜单里按 Esc     → 「Select Model and Effort」，模型列表，当前那个标着 (current)
 *   模型列表里回车        → 进入那个模型的档位菜单
 *   「More reasoning…」   → 光标停上去时底部提示变成 `enter select`，回车进「Advanced Reasoning」
 *   `s`                 → 只对本会话生效，屏幕出现「Model changed to <slug> <档位> for this session only」
 *   /fast               → 开关速度档位，屏幕出现「Service tier set to priority|default」
 *
 * ⚠️ **`/fast` 没有只对本会话生效的版本。** 它切换运行中的档位，同时把 `service_tier`
 * 写进全局配置（2026-09-23 实测，`default` → `fast`）。所以确认之后要把配置里这一行
 * 恢复成切换前的原样：运行中的进程已把档位读进内存，不受影响；之后新开的会话照旧。
 *
 * ⚠️ 换模型之后状态行要过一两秒才刷新，这段时间里读到的仍是旧模型的档位，
 * 所以刚确认过的结果在短时间内优先于状态行。
 *
 * ⚠️ **档位菜单里绝不能按数字或回车。** 两者都以「设为默认」生效，会改写 Codex 的全局
 * 配置 `~/.codex/config.toml`，影响之后新开的每一个会话 —— 探针实测踩过一次。档位只能用
 * 方向键移动光标，再按 `s`。模型列表里回车只是选中模型、进入档位菜单，不会生效。
 */
const { stripAnsi } = require('../public/ansi');
const { readStatusArea } = require('./agent-composer');
const { herdrRequest } = require('./herdr-input');
const { apiError } = require('./message-queue');
const identity = require('./conversation-state').binding;

const fs = require('fs');
const os = require('os');
const path = require('path');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FRESH_MS = 10000;
const TIER_LINE = /^[ \t]*service_tier[ \t]*=.*$/m;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 把全局配置里的 `service_tier` 恢复成切换前那一行，其他内容保持切换之后的样子：
 * 只动 `/fast` 自己改的那一行，不回滚同一时刻别处对这个文件的修改。
 */
function restoreServiceTier(file, before) {
  const now = readText(file);
  if (now === null || now === before) return false;
  const previous = before === null ? null : (before.match(TIER_LINE)?.[0] ?? null);
  const current = now.match(TIER_LINE)?.[0] ?? null;
  if (previous === current) return false;
  let next;
  if (current !== null && previous !== null) next = now.replace(TIER_LINE, previous);
  else if (current !== null) next = now.replace(new RegExp(`${TIER_LINE.source}\\n?`, 'm'), '');
  else return false;
  const temporary = `${file}.agent-studio-${process.pid}`;
  fs.writeFileSync(temporary, next, { mode: fs.statSync(file).mode & 0o777 });
  fs.renameSync(temporary, file);
  return true;
}
const compact = (text) =>
  stripAnsi(String(text || ''))
    .replace(/\s/g, '')
    .toLowerCase();

/** 档位在菜单里的写法 → 档位 id。`More reasoning…` 不是档位，是进二级菜单的入口。 */
const EFFORT_LABELS = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra high': 'xhigh',
  max: 'max',
  ultra: 'ultra',
};
const MORE = 'more';
const ADVANCED = new Set(['max', 'ultra']);

/**
 * 认出屏幕上最后打开的那个选择菜单。认不出就返回 null —— 按键之前必须确认自己面对的
 * 是哪个菜单，认错了按下去的键就落在别处。
 */
function codexMenu(raw) {
  const text = stripAnsi(raw);
  const titles = [
    ...text.matchAll(
      /^\s*(Select Reasoning Level for (.+?)|Select Model and Effort|Advanced Reasoning)\s*$/gm,
    ),
  ];
  const title = titles.at(-1);
  if (!title) return null;
  const body = text.slice(title.index + title[0].length);
  const footer = body.match(/^\s*(enter (?:default|select|apply)[^\n]*esc back)\s*$/m);
  if (!footer) return null;
  const list = body.slice(0, footer.index);
  // ⚠️ 行内空白只能用 [ \t]：`\s` 会跨过换行，把下一行吞进上一行的说明里。
  const rows = [...list.matchAll(/^[ \t]*(›?)[ \t]*(\d+)\.[ \t]+(.+?)(?:[ \t]{2,}.*)?$/gm)].map(
    (match) => {
      const raw = match[3].trim();
      const current = /\(current\)/.test(raw);
      const label = raw.replace(/\s*\((current|default)\)/g, '').trim();
      return { selected: match[1] === '›', number: Number(match[2]), label, current };
    },
  );
  // 编号必须从 1 连续排下来，且只有一行被选中：否则可能认到了正文里的普通列表。
  if (
    !rows.length ||
    rows.some((row, index) => row.number !== index + 1) ||
    rows.filter((row) => row.selected).length !== 1
  )
    return null;
  const kind = title[1].startsWith('Select Reasoning')
    ? 'effort'
    : title[1] === 'Advanced Reasoning'
      ? 'advanced'
      : 'model';
  const efforts =
    kind === 'model'
      ? null
      : rows.map((row) =>
          /^more reasoning/i.test(row.label)
            ? MORE
            : EFFORT_LABELS[row.label.toLowerCase()] || null,
        );
  return {
    kind,
    model: kind === 'effort' ? title[2].trim() : null,
    rows,
    efforts,
    selected: rows.findIndex((row) => row.selected),
    footer: footer[1],
    fingerprint: title[0] + list,
  };
}

/**
 * 从可配置状态行的独立字段读取当前模型、推理强度和服务档位。
 * 这是运行中的那个进程此刻的真实状态，比存档里上一轮的 turn_context 新。
 */
function statusSettings(raw, models) {
  const { codexFooter, codexModelField } = require('./codex-footer');
  const { fields } = codexFooter(raw);
  for (const head of fields) {
    const match = codexModelField(head);
    if (!match) continue;
    const model = models.find(
      (item) => compact(item.label) === compact(match[1]) || compact(item.id) === compact(match[1]),
    );
    if (!model) continue;
    const effort =
      match[2].toLowerCase() === 'default'
        ? model.efforts.find((item) => item.isDefault)?.id || null
        : match[2].toLowerCase();
    return {
      model: model.id,
      effort,
      serviceTier: match[3] ? 'priority' : null,
      source: 'codex-native-screen',
    };
  }
  return null;
}

/** 折行后的确认按完整句计数，避免窄终端把同一条确认拆开。 */
const normalizedText = (raw) => stripAnsi(raw).replace(/\s+/g, ' ');
const count = (raw, pattern) => (normalizedText(raw).match(pattern) || []).length;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class CodexSettings {
  constructor({
    herdr,
    exactPane,
    operate = (_id, run) => run(),
    beforeApply = async () => {},
    keys,
    paste,
    timeoutMs = 10000,
    stepMs = 40,
    configFile = path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      'config.toml',
    ),
    now = Date.now,
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      operate,
      beforeApply,
      keys,
      paste,
      timeoutMs,
      stepMs,
      configFile,
      now,
    });
    this.keys =
      keys ||
      ((paneId, value) =>
        herdrRequest(
          'agent.send_keys',
          { target: paneId, keys: value },
          { socketFile: herdr.socketPath },
        ));
    this.paste =
      paste ||
      ((paneId, text) =>
        herdrRequest(
          'pane.send_input',
          { pane_id: paneId, text, keys: [] },
          { socketFile: herdr.socketPath },
        ));
    this.busy = new Set();
    this.observed = new Map();
  }

  /** 当前设置：先看运行中的进程（状态行），读不到再用最近一次切换的结果。 */
  async recorded(pane, catalog) {
    const observed = this.observed.get(identity(pane));
    if (observed && this.now() - Date.parse(observed.recordedAt) < FRESH_MS) return observed;
    try {
      const live = statusSettings(
        await this.herdr.readPane(pane.paneId, { lines: 100, ansi: true, exact: true }),
        catalog.models,
      );
      if (live) return live;
    } catch {
      /* 画面读不到时退到最近一次确认的结果 */
    }
    return observed || null;
  }

  apply(pane, settings, catalog) {
    return this.operate(pane.paneId, () => this.applyWithin(pane, settings, catalog));
  }

  async applyWithin(pane, settings, catalog) {
    const key = identity(pane);
    if (this.busy.has(pane.paneId)) throw apiError(409, 'SETTINGS_BUSY', '正在切换，请稍候');
    this.busy.add(pane.paneId);
    let opened = false;
    const check = async () => {
      const fresh = await this.exactPane(pane.paneId);
      if (identity(fresh) !== key || fresh.agent?.label !== 'codex')
        throw apiError(409, 'SESSION_CHANGED', '目标会话已改变');
      return fresh;
    };
    const screen = () => this.herdr.readPane(pane.paneId, { lines: 100, ansi: true, exact: true });
    const waitFor = async (
      predicate,
      code = 'CODEX_SETTINGS_UNCONFIRMED',
      message = '未确认切换，请在终端查看',
    ) => {
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await pause(this.stepMs);
      }
      throw apiError(409, code, message);
    };
    const press = async (keys) => {
      await check();
      await this.keys(pane.paneId, keys);
    };
    const menuOf = (kind) => async () => {
      const menu = codexMenu(await screen());
      return menu?.kind === kind ? menu : null;
    };
    // 一次发送移动键，再读取画面确认目标；确认前不发送执行键。
    const moveTo = async (menu, destination) => {
      for (let tries = 0; menu.selected !== destination; tries++) {
        if (tries > menu.rows.length)
          throw apiError(409, 'SELECTOR_CHANGED', '选择器已变化，请重新选择');
        const previous = menu.selected;
        const labels = menu.rows.map((row) => row.label).join('\n');
        await press(
          Array(Math.abs(destination - previous)).fill(destination > previous ? 'down' : 'up'),
        );
        menu = await waitFor(async () => {
          const value = codexMenu(await screen());
          if (
            value &&
            (value.kind !== menu.kind || value.rows.map((row) => row.label).join('\n') !== labels)
          )
            throw apiError(409, 'SELECTOR_CHANGED', '选择器已变化，请重新选择');
          return value?.selected === destination ? value : null;
        });
      }
      return menu;
    };
    try {
      await this.beforeApply(pane);
      const current = await check();
      if (!current.agent || current.agent.label !== 'codex')
        throw apiError(409, 'SESSION_CHANGED', '目标会话已改变');
      if ((current.agent.status || current.status) === 'blocked')
        throw apiError(409, 'AGENT_BLOCKED', 'Codex 正在等待回答或确认，请先处理当前问题。');
      const raw = await screen(),
        area = readStatusArea(raw);
      // 先认菜单：菜单开着时，读输入框会把菜单内容当成「输入框有字」。
      if (codexMenu(raw))
        throw apiError(409, 'SELECTOR_OPEN', '终端里已经打开了一个选择菜单，请先处理');
      await clearNativeComposer({
        pane,
        herdr: this.herdr,
        exactPane: this.exactPane,
        screen,
        press,
        timeoutMs: this.timeoutMs,
        stepMs: this.stepMs,
      });
      if (!/^\s*[›»](?:\s|$)/m.test(stripAnsi(raw)))
        throw apiError(
          409,
          'NATIVE_INPUT_UNAVAILABLE',
          '未识别到 Codex 输入框，请先处理当前原生页面。',
        );
      // A just-confirmed change can precede the footer redraw, especially in
      // narrow terminals. Use the same confirmed value returned to the client.
      const before = (await this.recorded(current, catalog)) || {};
      let result = { ...before };

      if (settings.model !== undefined || settings.effort !== undefined) {
        const model = catalog.models.find((item) => item.id === (settings.model ?? before.model));
        if (!model) throw apiError(409, 'MODEL_NOT_IN_SELECTOR', '无法确定目标模型');
        const effort =
          settings.effort ??
          (settings.model !== undefined && settings.model !== before.model ? null : before.effort);
        if (effort && !model.efforts.some((item) => item.id === effort))
          throw apiError(400, 'INVALID_EFFORT', '这个模型不支持指定的推理强度');
        const receipts = count(await screen(), /for this session only/g);

        await this.paste(pane.paneId, '/model');
        await waitFor(async () => compact(readStatusArea(await screen()).composer) === '/model');
        await press(['enter']);
        opened = true;
        // 两种入口都见过：有时先出当前模型的档位菜单，有时直接出模型列表（同为 v0.156.0）。
        let menu = await waitFor(async () => {
          const value = codexMenu(await screen());
          return value?.kind === 'effort' || value?.kind === 'model' ? value : null;
        });
        if (menu.kind === 'effort' && compact(menu.model) !== compact(model.label)) {
          await press(['esc']);
          menu = await waitFor(menuOf('model'));
        }
        if (menu.kind === 'model') {
          const destination = menu.rows.findIndex(
            (row) => compact(row.label) === compact(model.label),
          );
          if (destination < 0)
            throw apiError(409, 'MODEL_NOT_IN_SELECTOR', '这个模型不在当前的原生选择器里');
          menu = await moveTo(menu, destination);
          // 模型列表里的回车只是「选中这个模型、进入它的档位菜单」，不会生效。
          await press(['enter']);
          menu = await waitFor(async () => {
            const value = await menuOf('effort')();
            return value && compact(value.model) === compact(model.label) ? value : null;
          });
        }
        // 没指定档位时停在菜单给的位置：换模型时是它的默认档位，没换时是当前档位。
        const target = effort || menu.efforts[menu.selected];
        if (ADVANCED.has(target)) {
          const more = menu.efforts.indexOf(MORE);
          if (more < 0) throw apiError(400, 'INVALID_EFFORT', '这个模型不支持指定的推理强度');
          menu = await moveTo(menu, more);
          // 光标在「More reasoning…」上时回车是进二级菜单（底部提示是 enter select），不是生效。
          if (!/^enter select/.test(menu.footer))
            throw apiError(409, 'SELECTOR_CHANGED', '选择器已变化，请重新选择');
          await press(['enter']);
          menu = await waitFor(menuOf('advanced'));
        }
        const destination = menu.efforts.indexOf(target);
        if (destination < 0) throw apiError(400, 'INVALID_EFFORT', '这个模型不支持指定的推理强度');
        menu = await moveTo(menu, destination);
        // 按 s 之前最后核对一遍：光标确实在目标档位上。
        const final = codexMenu(await screen());
        if (!final || final.kind !== menu.kind || final.efforts?.[final.selected] !== target)
          throw apiError(409, 'SELECTOR_CHANGED', '选择器已变化，请重新选择');
        await press(['s']);
        const confirmation = new RegExp(
          `Model changed to ${escape(model.id)} ${escape(target)} for this session only`,
          'i',
        );
        await waitFor(async () => {
          const now = await screen();
          const actual = statusSettings(now, catalog.models);
          // A full scrollback window can discard one old receipt as a new one
          // arrives. In that case the current native footer confirms the value.
          const confirmed =
            count(now, /for this session only/g) > receipts ||
            (actual?.model === model.id && actual.effort === target);
          return (
            confirmation.test(normalizedText(now)) &&
            confirmed &&
            !codexMenu(now) &&
            /^\s*[›»](?:\s|$)/m.test(stripAnsi(now))
          );
        });
        opened = false;
        result = { ...result, model: model.id, effort: target };
      }

      if (settings.serviceTier !== undefined) {
        const wanted = settings.serviceTier ? 'priority' : null;
        const latest = statusSettings(await screen(), catalog.models) || result;
        if ((latest.serviceTier || null) !== wanted) {
          const receipts = count(await screen(), /Service tier set to/g);
          const config = readText(this.configFile);
          await this.paste(pane.paneId, '/fast');
          await waitFor(async () => compact(readStatusArea(await screen()).composer) === '/fast');
          await press(['enter']);
          // 确认靠「多出一句、而且最后一句是想要的那一档」：开关按错一次就是反的。
          await waitFor(async () => {
            const now = await screen();
            const last = [...stripAnsi(now).matchAll(/Service tier set to (\w+)/g)].at(-1)?.[1];
            return (
              count(now, /Service tier set to/g) > receipts &&
              last === (wanted ? 'priority' : 'default')
            );
          });
          // 写配置可能比屏幕上那句确认晚一点，等它落盘再恢复，免得恢复在前、写入在后。
          // 标准格式的目标值已经存在时，原生写入不会改变这一行，无需等待文件变化。
          // 其他情况仍等待落盘，再恢复原始行，避免恢复早于原生异步写入。
          const canonical = `service_tier = "${wanted ? 'fast' : 'default'}"`;
          if (config?.match(TIER_LINE)?.[0] !== canonical) {
            for (
              let waited = 0;
              waited < 2000 && readText(this.configFile) === config;
              waited += this.stepMs
            )
              await pause(this.stepMs);
          }
          restoreServiceTier(this.configFile, config);
        }
        result = { ...result, serviceTier: wanted };
      }

      const actual = {
        ...result,
        scope: 'session',
        recordedAt: new Date(this.now()).toISOString(),
        source: 'codex-native-confirmation',
      };
      await check();
      if (this.observed.size >= 256) this.observed.delete(this.observed.keys().next().value);
      this.observed.set(key, actual);
      return actual;
    } finally {
      // 只关自己认得出的选择菜单，最多退三层；绝不去按一个认不出的对话框。
      if (opened) {
        try {
          for (let i = 0; i < 3 && codexMenu(await screen()); i++) {
            await press(['esc']);
            await pause(this.stepMs);
          }
        } catch {
          /* 目标已变化：不再往里写 */
        }
      }
      this.busy.delete(pane.paneId);
    }
  }
}

module.exports = { CodexSettings, codexMenu, statusSettings, restoreServiceTier };
