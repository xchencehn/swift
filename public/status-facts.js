'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioStatusFacts = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  /**
   * 状态区的换行判据。完整策略见 docs/STATUS_WRAPPING.md。
   *
   * 一句话:状态区的每一行都是若干条**事实**接起来的,换行只能落在事实之间 ——
   * 不丢、不断、不乱序。服务端按语义把一行分成组(权限模式、后台进程各自成行),
   * 行内排到哪儿换由客户端按真实宽度决定。
   *
   * 🔑 服务端(`lib/chat-status.js`)与前端(`public/app.js`)共用这一份。分成两份写,
   * 迟早对不上 —— 那时表现是「网页上和终端不一样」,而没人说得清是哪一步变的。
   */

  /** 权限模式那一段:它说的是这个会话敢不敢直接动机器,不该和用量挤在一起。 */
  const MODE_RE = /^\s*(?:[⏵▶►]|bypass permissions|accept edits|plan mode)/i;
  /**
   * 「后台还剩什么在跑」。⚠️ 只认**整段开头就是计数**的形状,不在句子中间乱断。
   * `← 7 agents` 是工作区里有几个 agent、不是后台进程,不单独触发换行。
   */
  const BACKGROUND_RE = /^\s*\d+\s+(?:shells?|monitors?|background\s+(?:terminals?|agents?))\b/i;

  /** 这一段属于哪一组。组只决定在哪儿断行,不改内容也不改顺序。 */
  function groupOf(text) {
    const value = String(text ?? '');
    if (MODE_RE.test(value)) return 'mode';
    if (BACKGROUND_RE.test(value)) return 'background';
    return 'main';
  }

  /**
   * 把一行切成事实。返回 `[{ start, end, text, group }]`,下标是相对原串的字符位置,
   * 调用方据此去切带颜色的 span(见 `lib/chat-status.js` 的 spanSlice)。
   *
   * 分隔符有三种:` · `/` • `(两侧带空格)、连续两个以上空格、`主机名:路径` 里那个 `:`。
   *
   * ⚠️ **括号里的不算分隔符** —— `(26m 15s · ↓ 36 tokens · esc to interrupt)` 是一条
   * 事实的一部分,在里面断开就把一句话劈成两半。`weekly 60%·2d5h` 里那个 `·` 两侧
   * 没有空格,同样不算。
   *
   * ⚠️ 分隔符**跟在前一条事实后面**,不单独成段:否则换行之后 `·` 会掉到行首。
   */
  function splitFacts(line) {
    const text = String(line ?? '');
    const cuts = [];
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(' || ch === '[') {
        depth += 1;
        continue;
      }
      if (ch === ')' || ch === ']') {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth) continue;
      // ` · ` / ` • `:分隔符连同两侧空格一起归前一条事实,切点落在它后面。
      const dot = /^\s[·•]\s+/.exec(text.slice(i));
      if (dot) {
        cuts.push(i + dot[0].length);
        i += dot[0].length - 1;
        continue;
      }
      // 连续空格顶开的两段。
      const gap = /^ {2,}/.exec(text.slice(i));
      if (gap) {
        cuts.push(i + gap[0].length);
        i += gap[0].length - 1;
        continue;
      }
      // `主机名:路径`:主机与目录是两件事,终端只是用一个冒号把它们连在一起。
      if (
        ch === ':' &&
        /[^\s:@]@[^\s:@]+$/.test(text.slice(0, i)) &&
        /^[~/]/.test(text.slice(i + 1))
      ) {
        cuts.push(i + 1);
      }
    }
    const bounds = [0, ...cuts.filter((at) => at > 0 && at < text.length), text.length];
    const facts = [];
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const start = bounds[i],
        end = bounds[i + 1];
      const piece = text.slice(start, end);
      if (!piece.trim()) {
        // 全是空白的一段并进前一条,不产生一条空事实。
        if (facts.length) facts[facts.length - 1].end = end;
        continue;
      }
      facts.push({ start, end, text: piece, group: groupOf(piece) });
    }
    for (const fact of facts) fact.text = text.slice(fact.start, fact.end);
    return facts;
  }

  /**
   * 按语义把一行分组成行。**一行最多切一刀**,切在第一条 `background` 事实前面,
   * 它后面的全部归第二行;切开的地方把分隔符去掉 —— 那一刀代替了分隔符的作用。
   *
   * @returns {Array<{ facts: Array, start: number, end: number }>}
   */
  function toRows(line) {
    const text = String(line ?? '');
    const facts = splitFacts(text);
    if (!facts.length) return [];
    const at = facts.findIndex((fact, index) => index > 0 && fact.group === 'background');
    const row = (pieces) => ({
      facts: pieces,
      start: pieces[0].start,
      end: pieces[pieces.length - 1].end,
    });
    if (at < 0) return [row(facts)];
    const head = facts.slice(0, at),
      tail = facts.slice(at);
    // 上一行末尾那个分隔符不要留着:断行已经把两段分开了。
    const trimmed = { ...head[head.length - 1] };
    trimmed.end = trimmed.start + trimmed.text.replace(/[\s·•]+$/, '').length;
    trimmed.text = text.slice(trimmed.start, trimmed.end);
    // 下一行开头的空白同样不要。
    const first = { ...tail[0] };
    const lead = first.text.length - first.text.replace(/^\s+/, '').length;
    first.start += lead;
    first.text = text.slice(first.start, first.end);
    return [row([...head.slice(0, -1), trimmed]), row([first, ...tail.slice(1)])];
  }

  return { splitFacts, toRows, groupOf, MODE_RE, BACKGROUND_RE };
});
