/**
 * 换页跟手（直接操纵）：左栏页、文件页进出时，页面实时跟着手指走，松手时按位置和速度决定
 * 完成还是弹回，剩下那一段用与手指速度衔接的缓动补完（2026-09-24 用户要求）。原来是划过
 * 56px 才触发、再播一段固定动画，像按了一下键，慢一点就显得卡。
 *
 * 这与系统「右滑返回」同一种做法（Apple 的交互式转场、Material 的预测性返回）：一比一跟随，
 * 快甩即使距离短也算数，慢拖过不了四成就弹回。松手判断与换标签共用 StudioTabDrag.decide。
 *
 * 开关状态仍由外壳原来的函数改（setOpen），这里只在拖的过程中用行内样式接管位移，结束时交还
 * 给样式表 —— 两者的终点一致，交接不会跳。层级见 docs/INTERACTION_DESIGN.md 第 2 节。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioPageDrag = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  let active = null;

  /**
   * 开始一次跟手换页。
   * @param {object} options
   *   kind          'open-sidebar' | 'close-sidebar' | 'open-files' | 'close-files'
   *   dx            起手时手指的横向位移；at / downAt 这一刻与按下那一刻的时间
   *   sidebar, scrim, page, conversation   参与移动的四个节点
   *   setOpen(which, open)   改开关状态，which 是 'sidebar' 或 'files'
   * @returns {{ move(dx, time), end(time) }}
   */
  function start({ kind, dx, at, downAt = at, sidebar, scrim, page, conversation, setOpen }) {
    const { decide, sample, settleDuration, EASE } = StudioTabDrag;
    const opening = kind.startsWith('open'),
      which = kind.endsWith('files') ? 'files' : 'sidebar';
    const files = which === 'files';
    let initial = opening ? 0 : 1;
    if (active?.which === which) {
      // Re-grab the currently rendered position, including an unfinished settle.
      const node = files ? page : sidebar,
        transform = getComputedStyle(node).transform;
      if (transform && transform !== 'none') {
        const x = new DOMMatrixReadOnly(transform).m41;
        const w = files
          ? page.parentElement.getBoundingClientRect().width
          : sidebar.getBoundingClientRect().width;
        if (w) initial = files ? 1 - x / w : 1 + x / w;
      } else initial = 1;
    }
    active?.finish();
    // 打开的那一步先把状态改过去（内容随之准备好），拖到一半松手弹回时再改回来。
    if (opening) setOpen(which, true);
    const width = files
      ? page.parentElement.getBoundingClientRect().width || innerWidth
      : sidebar.getBoundingClientRect().width || innerWidth * 0.84;
    const nodes = files ? [page, conversation] : [sidebar, scrim];
    // 按下那一刻也是一个采样点：只有一次移动的快速一划，也算得出速度。
    let progress = initial;
    const samples = [[downAt, 0]];
    const paint = (value, duration = 0) => {
      progress = Math.max(0, Math.min(1, value));
      const transition = duration
        ? `transform ${duration}ms ${EASE}, opacity ${duration}ms linear`
        : 'none';
      for (const node of nodes) {
        node.style.transition = transition;
        node.style.visibility = 'visible';
      }
      if (files) {
        page.style.transform = `translateX(${(1 - progress) * 100}%)`;
        conversation.style.transform = `translateX(${-30 * progress}%)`;
      } else {
        sidebar.style.transform = `translateX(${(progress - 1) * 100}%)`;
        scrim.style.opacity = String(progress);
      }
    };
    const clear = () => {
      for (const node of nodes)
        for (const key of ['transition', 'visibility', 'transform', 'opacity'])
          node.style[key] = '';
    };
    const move = (offset, time) => {
      // 往「打开」的方向为正：打开文件页是往左拖，打开左栏是往右拖。
      const toward = files ? -offset : offset;
      paint(initial + toward / width);
      sample(samples, time, toward);
    };
    move(dx, at);
    let timer = 0,
      finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clear();
      if (active === controller) active = null;
    };
    const controller = {
      which,
      finish,
      move: (offset, time) => {
        if (!finished) move(offset, time);
      },
      cancel() {
        if (finished) return;
        setOpen(which, !opening);
        finish();
      },
      end(time) {
        if (finished) return;
        const { commit: open, velocity } = decide(samples, time, progress);
        const target = open ? 1 : 0;
        const duration =
          typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 0
            : settleDuration(Math.abs(target - progress) * width, velocity);
        paint(target, duration);
        setOpen(which, open);
        if (duration) timer = setTimeout(finish, duration + 20);
        else finish();
      },
    };
    active = controller;
    return controller;
  }

  return { start, finish: () => active?.finish() };
});
