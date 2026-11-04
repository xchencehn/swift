'use strict';

/**
 * 从终端画面里读出 agent 输入框当前的内容。
 *
 * 手机上发一条消息是两步:先在底栏编辑好点「填入」写进 PTY,再按 Enter 发送。
 * 中间那一步的结果只在终端画面上,聊天视图里看不见,于是「填进去了没有」无从判断。
 * 这个模块把那块画面解析出来,让聊天视图也能显示同一个输入框。
 *
 * 两家 agent 的输入框长得不一样,按各自的边框特征认:
 *
 *   Claude Code   ────────────      两条横线夹着,内容跟在 ❯ 后面
 *                 ❯ 写好的内容
 *                 ────────────
 *
 *   Codex         › 写好的内容      单行,内容跟在 › 后面
 *
 * 🔑 只认这两种确定的形状,认不出来就返回空串 —— 宁可不显示,也不要把画面上
 * 别的东西(正在输出的正文、状态栏)当成用户输入显示出来。
 */

/**
 * 输入框里的提示文字(placeholder,以及按 Tab 才会落下来的补全建议)在终端里
 * 是**暗的** —— ANSI 的 dim 属性 `\x1b[2m`:
 *
 *   提示   \e[1m›\e[0m \e[2mAsk Codex to do anything\e[0m
 *   真实   \e[1m›\e[0m 检查一下 我们 mxops dev 最新代码
 *
 * 🔑 所以判据用 **dim 属性**,不是文本名单。名单只认得死的那几句英文,
 * 既认不出动态的补全建议,换个版本换句话就失效;而 dim 是这两家共同的表达方式。
 * 提示照样显示 —— 终端里就是显示着的,只是淡 —— 但要标出来让界面画得淡一点,
 * 不能让人以为那是自己打进去的字。
 */

/** 一行里除了横线和空白就没别的了,才算边框。至少 8 个才算,免得把正文里的破折号当框。 */
function isRule(line) {
  const trimmed = String(line || '').trim();
  return trimmed.length >= 8 && /^[─━—–-]+$/.test(trimmed);
}

/**
 * Codex 在运行时会往输入框那一带撒**盲文点阵字符**当装饰(星星点点的动效):
 *
 *   › Ask Codex to do anything           ⠂  ⠁
 *   › Ask Codex to do anything         ⠈
 *
 * 位置随机、每帧都变。连着读进来的话,输入框的内容就会一帧一个长度,
 * 显示出来一会儿宽一会儿窄。这些点不是用户打的字,读的时候剥掉。
 *
 * 🔑 只剥**输入框那一行**里的,不碰状态行 —— Claude 的 spinner(⠋⠙⠹)也是盲文,
 * 那是真正的状态、不能一起剥掉。
 */
function stripDecorDots(text) {
  // ⚠️ 只剥点并去掉行尾空白,**不要顺手压缩中间的空格** —— 用户粘进去的代码
  // 靠缩进表达结构,压了就毁了(实测撞到)。那些点都撒在内容右侧的空白区,
  // 剥掉之后 trimEnd 就干净了。
  return String(text ?? '')
    .replace(/[\u2800-\u28ff]/g, '')
    .trimEnd();
}

function stripPrompt(line) {
  // 去掉行首的提示符与它后面的一个空格;Claude 还可能在两侧留竖线边框。
  return String(line || '')
    .replace(/^\s*[│|]\s?/, '')
    .replace(/\s*[│|]\s*$/, '')
    .replace(/^\s*[❯›>»]\s?/, '')
    .trimEnd();
}

/** 整段内容是不是提示:去掉提示符之后,剩下的可见文字全是暗的。 */
function isHintOnly(spans) {
  const visible = spans.filter((span) => span.text.trim());
  if (!visible.length) return false;
  return visible.every((span) => span.dim);
}

/**
 * 终端底部除了输入框,还有两类信息,聊天视图里同样看不到:
 *
 *   ● 正文……
 *   · Moseying… (35s · ↓ 1.9k tokens)      ← 即时状态,只在运行时出现,在输入框**上方**
 *   ────────────────────────────
 *   ❯ 输入内容
 *   ────────────────────────────
 *       [Opus 5 (1M context)] eff:xhigh █████░░ 9%  weekly 60%·2d5h  host   ← 状态栏
 *     ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents            ← 模式行
 *
 * Codex 没有边框,状态栏就是 › 那行下面一行:
 *     gpt-6-astra high · ~/workdir/mxops · mxops · Ready · Context 25%
 */

const { stripAnsi, parseAnsiLine, matchActivityLine } = require('../public/ansi');
const {
  parseCodexFooter,
  hasCodexModelAndDirectory,
  projectTerminalScreen,
} = require('../public/native-status');

/** 只归一化空白。进度条留着 —— 它在终端里是带颜色的,一眼能看出满没满。 */
function tidyStatus(line) {
  return String(line || '')
    .replace(/\s{2,}/g, '  ')
    .trim();
}

/**
 * 状态栏长什么样。两家各有固定形状,只认这些形状:
 *
 *   Claude  [Opus 5 (1M context)] eff:high  9%  weekly 60%·2d5h  host
 *           ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents
 *   Codex   gpt-6-astra high · ~/workdir/mxops · Ready · Context 25% used
 */
function looksLikeStatus(line) {
  if (/^\[/.test(line)) return true; // Claude 的模型行
  if (/^[⏵▶►]/.test(line)) return true; // Claude 的权限模式行
  // Codex 的单行状态栏:用 · 分段,且带上下文或就绪标志
  return / · /.test(line) && /(Context|Ready|Working|tokens?\b|\d+%)/.test(line);
}

/**
 * 读终端底部的状态区。
 *
 * @returns {{composer: string, activity: string, statusline: string[]}}
 *   composer   输入框里的内容
 *   activity   正在做什么(只在运行时有)
 *   statusline 状态栏各行(模型、推理强度、上下文占用、权限模式……)
 */
function readStatusArea(raw) {
  // 画面可能带颜色。定位与匹配一律用剥干净的纯文本,着色只在最后一步对状态栏做 ——
  // 拿带转义序列的字符串去跑正则,匹配会被那些看不见的字符打断。
  const screen = stripAnsi(raw);
  const rawLines = String(raw ?? '').split('\n');
  const composer = readComposer(screen);
  if (!screen) {
    return {
      composer,
      composerHint: false,
      activity: '',
      activitySpans: [],
      statusline: [],
      statusSpans: [],
    };
  }
  const lines = screen.split('\n');

  // 输入框里那段是提示还是用户真打的字:看它在终端里是不是暗的。
  // 找到承载输入内容的那一行,拿它的原始转义序列判断。
  let composerHint = false;
  if (composer) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!/^\s*[│|]?\s*[❯›>»]/.test(lines[i])) continue;
      const spans = parseAnsiLine(rawLines[i] ?? '');
      // 提示符本身常带 bold,不算内容;只看提示符之后的部分
      const after = [];
      let seen = false;
      for (const span of spans) {
        if (!seen) {
          const cut = span.text.search(/[❯›>»]/);
          if (cut >= 0) {
            seen = true;
            const rest = span.text.slice(cut + 1);
            if (rest.trim()) after.push({ ...span, text: rest });
            continue;
          }
          continue;
        }
        after.push(span);
      }
      composerHint = isHintOnly(after);
      break;
    }
  }

  let activity = '';
  let activitySpans = [];
  let activityIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = matchActivityLine(lines[i]);
    if (!match) continue;
    activity = match.text;
    activityIndex = i;
    // 连同它自己的图标和颜色一起带走。Claude 的 `●` 与状态词是它的橙色 logo 色
    // rgb(215,119,87),Codex 有它自己的一套 —— 照搬各家原样,别另造一个通用样式:
    // 那既不像 Claude 也不像 Codex。
    activitySpans = parseAnsiLine((rawLines[i] ?? '').replace(/\s+$/, ''));
    break;
  }

  // Claude 在活动行正下方挂一条提示,形状固定:`  ⎿ Tip: …`(`Tip:` 前面那个是
  // 不换行空格)。它属于正文区而不是状态栏,所以取不到它的位置在状态栏锚点之上,
  // 只能顺着活动行往下数一行。
  //
  // 🔑 只认 `Tip:` 这个词,不认光秃秃的 `⎿` —— 工具结果的续行用的是同一个符号,
  // 把它当提示显示出来就是在会话底下贴一段别处的正文。
  let tip = readTip(lines, activityIndex);

  // 状态栏在最后一条边框线之后;Codex 没有边框,就取 › 那行之后。
  // 锚点必须落在画面末尾附近:pane 滚到历史位置时,正文里的 › 或破折号会
  // 冒充锚点,把后面的正文整段当成状态栏读出来(实测踩过)。
  const footer = parseCodexFooter(lines);
  const hasCodexFooter = hasCodexModelAndDirectory(footer.fields);
  const codexProjection = hasCodexFooter
    ? projectTerminalScreen(rawLines.map(parseAnsiLine))
    : null;
  if (codexProjection?.recognized) {
    const projected = codexProjection.rows || [];
    const active = projected.findIndex((row) =>
      matchActivityLine(row.map((span) => span.text).join('')),
    );
    activitySpans = active >= 0 ? projected[active] : [];
    activity =
      active >= 0 ? matchActivityLine(activitySpans.map((span) => span.text).join('')).text : '';
    tip = projected
      .filter((row, index) => index !== active)
      .map((row) =>
        row
          .map((span) => span.text)
          .join('')
          .trim(),
      )
      .filter(Boolean)
      .join('\n');
  }
  let anchor = hasCodexFooter ? footer.prompt : -1;
  for (let i = lines.length - 1; anchor < 0 && i >= 0 && lines.length - i <= 10; i -= 1) {
    if (isRule(lines[i]) || /^\s*[›❯»]/.test(lines[i])) {
      anchor = i;
      break;
    }
  }
  const statusline = [];
  const statusSpans = [];
  if (anchor >= 0) {
    for (let i = anchor + 1; i < lines.length; i += 1) {
      const clean = tidyStatus(lines[i]);
      // ⚠️ 不按长度丢行:完整的状态栏(模型 + 强度 + 进度条 + 额度 + 主机名)
      // 本来就会超过一百多字符,按长度筛等于把最全的那行扔掉。
      if (!clean) continue;
      // 🔑 要长得像状态栏才收。位置对不代表内容对 —— 认漏一行只是少显示一点,
      // 把正文当状态显示出来却是在骗人。
      if (!looksLikeStatus(clean) && !(hasCodexFooter && i >= footer.footerIndex)) continue;
      statusline.push(clean);
      // 同一行的带色版本:终端里模型名灰、推理强度黄、上下文条绿,那些颜色本身是信息。
      statusSpans.push(parseAnsiLine((rawLines[i] ?? '').replace(/\s+$/, '')));
    }
  }
  return {
    composer,
    composerHint,
    activity,
    activitySpans,
    tip,
    statusline,
    statusSpans,
    pendingInputs: codexProjection?.pendingInputs || [],
  };
}

/**
 * 活动行下面那条提示,只取正文。
 *
 * 提示长了终端会折行,续行只有缩进、没有 `⎿`,所以要顺着往下接一行。
 *
 * ⚠️ 缩进宽度是判据的一部分:续行与正文对齐,只缩进几格;而 `◎ /goal active` 那类
 * **右对齐**的行同样是「空格开头的普通文字」,靠的是上百个空格顶到右边。不限宽度
 * 就会把它接成提示的后半句(实测踩过)。
 */
function readTip(lines, activityIndex) {
  if (activityIndex < 0) return '';
  const head = /^\s*⎿\s*Tip:\s*(\S.*?)\s*$/.exec(lines[activityIndex + 1] ?? '');
  if (!head) return '';
  const next = lines[activityIndex + 2] ?? '';
  const continued =
    / {2,8}(\S.*?)\s*$/.test(next) &&
    /^ {2,8}\S/.test(next) &&
    !/[⎿※❯›◎]/.test(next) &&
    !/^\s*[─━-]{4,}/.test(next) &&
    !matchActivityLine(next)
      ? next.trim()
      : '';
  return continued ? `${head[1]} ${continued}` : head[1];
}

/**
 * @param {string} screen 终端可见区域的文本(herdr pane read --source visible)
 * @returns {string} 输入框里的内容;空着、认不出来、或只有提示语时返回空串
 */
function readComposer(screen) {
  if (typeof screen !== 'string' || !screen) return '';
  const lines = screen.split('\n');

  // Claude:自下往上找最后一对横线,取中间以 ❯ 开头的那些行。
  // 从下往上是因为画面上方的正文里也可能出现横线,而输入框总在最底下。
  let lower = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isRule(lines[i])) {
      lower = i;
      break;
    }
  }
  if (lower > 0) {
    let upper = -1;
    for (let i = lower - 1; i >= 0 && lower - i <= 12; i -= 1) {
      if (isRule(lines[i])) {
        upper = i;
        break;
      }
    }
    if (upper >= 0) {
      const inner = lines.slice(upper + 1, lower);
      if (inner.some((line) => /^\s*[│|]?\s*[❯›>»]/.test(line))) {
        // 续行会用空格对齐到提示符后面,那两格是排版不是内容,要剥掉;
        // 再多的缩进是用户自己打的(比如贴进来的代码),必须原样留住。
        const text = inner
          .map((line, index) =>
            index === 0 ? stripPrompt(line) : stripPrompt(line).replace(/^ {1,2}/, ''),
          )
          .map(stripDecorDots)
          .join('\n')
          .replace(/\n+$/, '');
        return text;
      }
    }
  }

  // Codex:没有框,取最后一条输入行；Ultra 使用 » 提示符。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*[›❯»]\s/.test(lines[i]) || /^\s*[›❯»]$/.test(lines[i].trimEnd())) {
      return stripDecorDots(stripPrompt(lines[i]));
    }
  }
  return '';
}

module.exports = { readComposer, readStatusArea, isRule, stripPrompt };
