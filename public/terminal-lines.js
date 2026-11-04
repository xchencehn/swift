(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudioTerminalLines = api.TerminalLines;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';

  /**
   * 从终端字节流里重建「某一行此刻长什么样」。
   *
   * 🔑 为什么需要它:终端重绘**不是按行输出的**,而是逐格光标定位写入 ——
   *
   *   \x1b[24;33H·  \x1b[24;35HGesticulating…  \x1b[24;61H5
   *
   * 跳到 24 行 33 列写一个符号,再跳到 35 列写状态词,再跳到 61 列写数字;
   * 列号不连续,中间是空白,整段一个换行符都没有。把转义序列当噪音剥掉、
   * 再按 `\n` 切行,得到的是把不同位置的字符首尾相连的结果 —— 那正是
   * 「状态字符乱序」的来源;正文同样是逐字定位写的,还会匹配到正文碎片。
   *
   * 所以只能按光标位置把字符放回格子里。这不是要写一个终端模拟器:
   * 只认「定位、换行、回车、清行、清屏、颜色」这几样,其余一律跳过 ——
   * 目标仅仅是把一行完整地读回来。
   */

  const ESC = '\x1b';

  class TerminalLines {
    constructor({ maxRows = 200, maxCols = 400 } = {}) {
      this.maxRows = maxRows;
      this.maxCols = maxCols;
      this.rows = new Map();
      this.row = 1;
      this.col = 1;
      this.color = null;
      this.pending = '';
      this.touched = new Set();
    }

    put(ch) {
      if (this.row < 1 || this.row > this.maxRows || this.col > this.maxCols) return;
      let line = this.rows.get(this.row);
      if (!line) {
        line = [];
        this.rows.set(this.row, line);
      }
      line[this.col - 1] = { ch, color: this.color };
      this.touched.add(this.row);
      this.col += 1;
    }

    /** 读回某一行的可见文本。中间空位补空格,尾部空白去掉。 */
    text(row) {
      const line = this.rows.get(row);
      if (!line) return '';
      let out = '';
      for (let i = 0; i < line.length; i += 1) out += line[i] ? line[i].ch : ' ';
      return out.replace(/\s+$/, '');
    }

    /** 读回某一行的带色分段,形状与 parseAnsiLine 的输出一致。 */
    spans(row) {
      const line = this.rows.get(row);
      if (!line) return [];
      const out = [];
      for (let i = 0; i < line.length; i += 1) {
        const cell = line[i] || { ch: ' ', color: null };
        const last = out[out.length - 1];
        if (last && (last.color || null) === (cell.color || null)) last.text += cell.ch;
        else out.push({ text: cell.ch, ...(cell.color ? { color: cell.color } : {}) });
      }
      while (out.length && !out[out.length - 1].text.trim()) out.pop();
      return out;
    }

    /**
     * 喂一段数据,返回这次被改动过的行号。
     * @param {string} chunk 原始终端输出
     * @param {(codes: number[]) => (string|null|undefined)} toColor SGR 参数转颜色
     */
    feed(chunk, toColor) {
      this.touched.clear();
      const text = this.pending + String(chunk == null ? '' : chunk);
      this.pending = '';
      let i = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch !== ESC) {
          if (ch === '\n') {
            this.row += 1;
            i += 1;
            continue;
          }
          if (ch === '\r') {
            this.col = 1;
            i += 1;
            continue;
          }
          if (ch === '\b') {
            this.col = Math.max(1, this.col - 1);
            i += 1;
            continue;
          }
          if (ch < ' ') {
            i += 1;
            continue;
          }
          this.put(ch);
          i += 1;
          continue;
        }
        const rest = text.slice(i);
        const csi = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(rest);
        if (csi) {
          this.applyCsi(csi[1], csi[2], toColor);
          i += csi[0].length;
          continue;
        }
        const osc = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/.exec(rest);
        if (osc) {
          i += osc[0].length;
          continue;
        }
        const short = /^\x1b(?:[()][A-Za-z0-9]|[A-Za-z=><])/.exec(rest);
        if (short) {
          i += short[0].length;
          continue;
        }
        // 认不全:判断它是不是**被数据块边界切断的半截序列**,而不是按长度猜。
        // ⚠️ 按长度猜会出事:真彩色序列 `\x1b[0;38;2;249;226;175;49m` 比阈值长,
        // 于是 ESC 被当作不认识的字符跳过,后面的 `[0;38;2;249;2` 就原样写进了
        // 那一行 —— 实测状态行里出现过 `↓[0;38;2;249;2 almost done` 这种泄漏。
        if (/^\x1b\[[0-9;?]*$/.test(rest)) {
          this.pending = rest;
          break;
        } // 半截 CSI
        if (/^\x1b\][^\x07]*$/.test(rest)) {
          this.pending = rest;
          break;
        } // 半截 OSC
        if (/^\x1b.?$/.test(rest)) {
          this.pending = rest;
          break;
        } // ESC 刚到
        i += 1; // 确实不认识的序列,只跳过 ESC 本身
      }
      return [...this.touched];
    }

    applyCsi(params, letter, toColor) {
      const nums = params
        .split(';')
        .filter((p) => p !== '?')
        .map((p) => (p === '' ? 0 : Number(p)));
      switch (letter) {
        case 'H':
        case 'f':
          this.row = Math.max(1, nums[0] || 1);
          this.col = Math.max(1, nums[1] || 1);
          break;
        case 'A':
          this.row = Math.max(1, this.row - (nums[0] || 1));
          break;
        case 'B':
          this.row += nums[0] || 1;
          break;
        case 'C':
          this.col += nums[0] || 1;
          break;
        case 'D':
          this.col = Math.max(1, this.col - (nums[0] || 1));
          break;
        case 'G':
          this.col = Math.max(1, nums[0] || 1);
          break;
        case 'd':
          this.row = Math.max(1, nums[0] || 1);
          break;
        case 'K': {
          const line = this.rows.get(this.row);
          if (line) {
            const mode = nums[0] || 0;
            if (mode === 0) line.length = Math.max(0, this.col - 1);
            else if (mode === 1) for (let k = 0; k < this.col - 1; k += 1) line[k] = null;
            else line.length = 0;
            this.touched.add(this.row);
          }
          break;
        }
        case 'J':
          // 整屏清除:留着上一屏的残影会被认成状态行
          if ((nums[0] || 0) >= 2) {
            this.rows.clear();
            this.touched.clear();
          }
          break;
        case 'm': {
          if (!nums.length || nums.every((n) => n === 0)) {
            this.color = null;
            break;
          }
          const color = toColor ? toColor(nums) : undefined;
          if (color !== undefined) this.color = color;
          break;
        }
        default:
          break;
      }
    }
  }

  return { TerminalLines };
});
