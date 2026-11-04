(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudioAnsi = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';

  /**
   * 终端画面的颜色解析。
   *
   * 状态栏在终端里是有颜色的(模型名灰、推理强度黄、上下文条绿、告警红),
   * 那些颜色本身就是信息 —— 一眼能看出「快满了」还是「还早」。读成纯文本就丢了,
   * 所以这里把 ANSI 转义序列解析成一段段带颜色的片段,让网页照着画。
   *
   * 只认颜色与粗细,其余转义(光标移动、清屏……)一律丢弃:画面已经渲染好了,
   * 那些控制序列在这里没有意义。
   */

  // eslint-disable-next-line no-control-regex
  const ANSI_PATTERN =
    /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[A-Za-z]/g;

  /** xterm 256 色调色板。0-15 基础色,16-231 是 6×6×6 立方体,232-255 是灰阶。 */
  function xterm256(index) {
    const base = [
      [0, 0, 0],
      [205, 49, 49],
      [13, 188, 121],
      [229, 229, 16],
      [36, 114, 200],
      [188, 63, 188],
      [17, 168, 205],
      [229, 229, 229],
      [102, 102, 102],
      [241, 76, 76],
      [35, 209, 139],
      [245, 245, 67],
      [59, 142, 234],
      [214, 112, 214],
      [41, 184, 219],
      [255, 255, 255],
    ];
    if (index < 16) return base[index];
    if (index < 232) {
      const n = index - 16;
      const step = (value) => (value ? value * 40 + 55 : 0);
      return [step(Math.floor(n / 36) % 6), step(Math.floor(n / 6) % 6), step(n % 6)];
    }
    const level = (index - 232) * 10 + 8;
    return [level, level, level];
  }

  function toCss([r, g, b]) {
    return `rgb(${r},${g},${b})`;
  }

  /** 去掉所有转义序列,只留可见文本。定位和匹配都该用这一份。 */
  function stripAnsi(text) {
    return String(text ?? '').replace(ANSI_PATTERN, '');
  }

  /**
   * 把一行拆成带颜色的片段。
   *
   * @returns {Array<{text: string, color?: string, bold?: boolean, dim?: boolean}>}
   */
  function parseAnsiLine(line, { themeColors = false } = {}) {
    const source = String(line ?? '');
    const spans = [];
    let color = null;
    let bold = false;
    let dim = false;
    let cursor = 0;
    const indexedColor = (index) => {
      const fallback = toCss(xterm256(index));
      if (!themeColors || index >= 16) return fallback;
      const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
      const role =
        index === 0 || index === 7 || index === 15
          ? 'text'
          : index === 8
            ? 'faint'
            : `terminal-${index >= 8 ? 'bright-' : ''}${names[index % 8]}`;
      return `var(--${role}, ${fallback})`;
    };

    const push = (text) => {
      if (!text) return;
      const last = spans[spans.length - 1];
      // 相邻同色的片段并起来,省得画出一串一个字的 span。
      // ⚠️ 可选字段不存在时是 undefined,而这里的状态是 null/false —— 要先归一化再比,
      // 否则 `undefined === false` 恒假,永远合并不了。
      const same =
        last &&
        (last.color ?? null) === color &&
        Boolean(last.bold) === bold &&
        Boolean(last.dim) === dim;
      if (same) {
        last.text += text;
        return;
      }
      spans.push({
        text,
        ...(color ? { color } : {}),
        ...(bold ? { bold } : {}),
        ...(dim ? { dim } : {}),
      });
    };

    ANSI_PATTERN.lastIndex = 0;
    let match;
    while ((match = ANSI_PATTERN.exec(source))) {
      push(source.slice(cursor, match.index));
      cursor = match.index + match[0].length;
      if (match[1] === undefined) continue; // 不是 SGR(颜色/字形)序列,忽略

      const codes = match[1] === '' ? [0] : match[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i += 1) {
        const code = codes[i];
        if (code === 0) {
          color = null;
          bold = false;
          dim = false;
        } else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) {
          bold = false;
          dim = false;
        } else if (code === 39) color = null;
        else if (code >= 30 && code <= 37) color = indexedColor(code - 30);
        else if (code >= 90 && code <= 97) color = indexedColor(code - 90 + 8);
        else if (code === 38) {
          // 38;5;N 是 256 色,38;2;R;G;B 是真彩色
          if (codes[i + 1] === 5) {
            color = indexedColor(codes[i + 2] || 0);
            i += 2;
          } else if (codes[i + 1] === 2) {
            color = toCss([codes[i + 2] || 0, codes[i + 3] || 0, codes[i + 4] || 0]);
            i += 4;
          }
        } else if (code === 48) {
          if (codes[i + 1] === 5) i += 2;
          else if (codes[i + 1] === 2) i += 4;
        }
        // 背景色(40-49、48)一概忽略:网页上有自己的底色,照搬终端的会花掉
      }
    }
    push(source.slice(cursor));
    return spans.filter((span) => span.text);
  }

  /** Render recorded output as text nodes; retain foreground emphasis across newlines. */
  function renderAnsi(target, text) {
    const source = String(text ?? '');
    target.replaceChildren();
    if (!source.includes('\x1b')) {
      target.textContent = source;
      return target;
    }
    for (const part of parseAnsiLine(source, { themeColors: true })) {
      const span = target.ownerDocument.createElement('span');
      span.textContent = part.text;
      if (part.color) span.style.color = part.color;
      if (part.bold) span.classList.add('ansi-bold');
      if (part.dim) span.classList.add('ansi-dim');
      target.append(span);
    }
    return target;
  }

  /**
   * agent 在输入框上方那一行的两种形态。放在这里是为了让**轮询**和**实时字节流**
   * 两条路用同一份判据 —— 分开写迟早会对不上,一边显示一边不显示。
   *
   *   运行中  ✽ Brewing… (3m 43s · ↓ 12.1k tokens)
   *   完成后  ✻ Crunched for 2m 27s · done 3:46 PM        (Claude)
   *           ─ Worked for 9m 15s ────────────────────     (Codex,前后是横线)
   *
   * 只认这两种确定的形状。流里还有正文、输入框、状态栏,错认一行比不认更糟。
   */
  // ⚠️ 少一个字符就会让某些帧整行认不出来。✳ U+2733 是 Claude Code 实际用过的
  // 一帧（2026-09-22 在手机终端截图里抓到），此前不在集合里。
  // Codex 0.163.0 motion.rs alternates • and dim ◦ without truecolor.
  const SPINNER = '*·•◦●○◍◉✻✽✳✢∗+⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒';
  // 状态词一律是**字母开头的英文词**(Brewing / Actualizing / Working…)。
  // ⚠️ 不能只要求「非空白」:状态栏那行 `⏵⏵ … · ← 7 agents` 在增量重绘时会留下
  // `· ←…` 这样的碎片,照样能凑出「符号 + 内容 + 省略号」的形状,于是被认成状态行
  // (实测抓到过)。要求字母开头就挡掉了。
  //
  // 省略号后面往往还跟着括号里的耗时,非贪婪到 `…` 就收会把它丢掉 —— 那正是
  // 最该看见的部分,所以括号这一段要一并带上(它也可能不存在)。
  // 状态词是**一个纯字母的词**(Brewing / Accomplishing / Working),紧跟省略号或括号。
  // ⚠️ 只要求「字母开头 + 后面随便什么 + 省略号」是不够的:状态栏那行被重绘到一半
  // 时会出现 `✽ mxops · p…` 这种半截货,照样能匹配,于是把别处的内容挂到了活动行上
  // (实测抓到过)。限定成单个词就挡掉了。
  const RUNNING_RE = new RegExp(
    `(?:^|[│┃])\\s*[${SPINNER}]\\s+[A-Za-z][A-Za-z'\u2019-]{1,24}(?:…\\s*(?:\\([^)\\n\\r]{0,80}\\))?|\\s*\\([^)\\n\\r]{0,80}\\))`,
  );
  // Codex uses a multi-word header while waiting for a foreground/background
  // command. Require a known waiting header or the terminal interruption hint.
  const COMMAND_RE = new RegExp(
    `(?:^|[│┃])\\s*[${SPINNER}]\\s+(?:Waiting for background terminal(?:\\s*[·•(…][^\\n\\r]*)?|(?:Running|Waiting for) [^\\n\\r]*\\([^\\n\\r]*\\besc to interrupt\\)[^\\n\\r]*)$`,
    'i',
  );
  // Recorded in Codex 0.162.1 and 0.163.0: this header has two words, unlike Working.
  const COMPACTION_RE = new RegExp(
    `(?:^|[│┃])\\s*[${SPINNER}]\\s+Compacting context\\s*\\([^\\n\\r)]{1,80}\\)\\s*$`,
  );
  const BACKGROUND_RE = /^\s*[·•]\s*\d+ background terminals? running\b[^\n\r]*/;
  // 供应商出错后的自动重试。这一条**不落存档**，只在终端画面上出现，
  // 而它恰恰是用户最需要知道的：Agent 不是卡住了，是在等下一次重试。
  // 认不出它，手机上就只看到长时间没有动静。
  const RETRY_RE = new RegExp(
    `(?:^|[│┃])\\s*[${SPINNER}]?\\s*API error(?:\\s*[·•][^\\n\\r]*)?(?:retrying|attempt)[^\\n\\r]*`,
    'i',
  );
  // 等待后台子代理结束。同样只在画面上，形状与「等待后台终端」不同：
  // 它没有括号里的中断提示，所以 COMMAND_RE 认不出来。
  const WAITING_AGENT_RE = new RegExp(
    `(?:^|[│┃])\\s*[${SPINNER}]\\s+Waiting for \\d+ background agents?[^\\n\\r]*`,
    'i',
  );
  // 完成态:图标或一段横线,后面跟「做了多久」。横线本身是装饰,显示时要剥掉。
  //
  // ⚠️ **动词不能写成固定的那几个。** Claude 的完成行和运行行一样每次换词
  // (Crunched / Brewed / Sizzled…),写死六个词的结果是换到别的词就整行认不出来 ——
  // 2026-09-22 在真实终端上抓到 `✻ Brewed for 1m 0s · done 1:35 AM` 整行丢失。
  // 换成「任意单词 + for + 一段时长」:时长的形状才是判据,它挡得住正文里的
  // 「Worked for a living」这类句子,而动词表挡不住换词。
  const DURATION = '\\d+(?:\\.\\d+)?\\s*(?:ms|s|m|h|d)(?:\\s+\\d+(?:\\.\\d+)?\\s*(?:ms|s|m|h|d))*';
  //
  // ⚠️ 时长后面只认两种固定的尾巴：「· done 3:46 PM」与「· 11 shells, 2 monitors still running」。
  // 原来是「后面随便 60 个字符」，于是 Claude 界面被往上翻过时叠在这一行上的
  // 「Jump to bottom (ctrl+End) ↓」也被吞进来，完成时刻还被它盖残成「done 9:2」；
  // 实时流逐格拼出来的内容每次不同，这一行就不停换字、宽度跟着变，手机上整页都在抖
  //（2026-09-23 用户截图指出）。认不全的尾巴宁可不要。
  const DONE_TAIL =
    '(?:\\s*·\\s*done\\s+\\d{1,2}:\\d{2}(?:\\s*[AP]M)?(?![\\d:]))?(?:\\s*·\\s*\\d+[^·\\n\\r]{0,60}?still running)?';
  const DONE_RE = new RegExp(
    `[${SPINNER}─━]\\s+[A-Za-z][A-Za-z'\u2019-]{1,24}\\s+for\\s+${DURATION}${DONE_TAIL}`,
  );

  // Codex writes completion metadata without a spinner, including subsecond turns.
  const CODEX_DONE_RE = new RegExp(
    `^\\s*Worked for\\s+(?:<\\s*)?${DURATION}(?:\\s*[•·]\\s*\\d{1,2}:\\d{2}(?:\\s*[AP]M)?)?\\s*$`,
    'i',
  );

  /**
   * 从一行(可带 ANSI)里认出状态行,返回可见文本;认不出返回空串。
   * @returns {{ text: string, running: boolean } | null}
   */
  /**
   * @returns {{ text: string, icon: string, body: string, running: boolean } | null}
   *   text    整行(含图标),给需要原样显示的地方
   *   icon    行首那个符号。它每帧都在变 —— 正因如此,**界面不该跟着它逐帧重绘**,
   *           否则就成了急促的闪烁。取到就行,动画由界面自己控制。
   *   body    去掉图标之后的部分。它变化得慢(状态词、秒数),用它当重绘的依据。
   *   running 在跑还是已经结束。结束那行是静态的,不该有动画。
   */
  function splitActivity(text, running) {
    const clean = text.trim();
    const match = new RegExp(`^([${SPINNER}─━])\\s+`).exec(clean);
    return {
      text: clean,
      icon: match ? match[1] : '',
      body: match ? clean.slice(match[0].length) : clean,
      running,
    };
  }

  function matchActivityLine(line) {
    const plain = stripAnsi(line);
    if (!plain.trim()) return null;
    // 重试优先于其他形状：它同时带着 spinner 和错误词，容易被别的判据先抓走，
    // 而「正在重试」比「正在跑」信息量大得多。
    const retry = RETRY_RE.exec(plain);
    if (retry) return splitActivity(retry[0].replace(/^[│┃]\s*/, ''), true);
    const waitingAgent = WAITING_AGENT_RE.exec(plain);
    if (waitingAgent) return splitActivity(waitingAgent[0].replace(/^[│┃]\s*/, ''), true);
    const compaction = COMPACTION_RE.exec(plain);
    if (compaction) return splitActivity(compaction[0].replace(/^[│┃]\s*/, ''), true);
    const command = COMMAND_RE.exec(plain);
    if (command) return splitActivity(command[0].replace(/^[│┃]\s*/, ''), true);
    const running = RUNNING_RE.exec(plain);
    if (running) {
      const suffix = BACKGROUND_RE.exec(plain.slice(running.index + running[0].length));
      return splitActivity(running[0].replace(/^[│┃]\s*/, '') + (suffix?.[0] || ''), true);
    }
    const codexDone = CODEX_DONE_RE.exec(plain);
    if (codexDone) return splitActivity(codexDone[0], false);
    const done = DONE_RE.exec(plain);
    if (done) {
      // Codex 那行两头是长横线,留着会在网页上拖出一条尾巴
      const text = done[0].replace(/[─━\s]+$/, '').trim();
      return text ? splitActivity(text, false) : null;
    }
    return null;
  }

  return { stripAnsi, parseAnsiLine, renderAnsi, xterm256, matchActivityLine, SPINNER };
});
