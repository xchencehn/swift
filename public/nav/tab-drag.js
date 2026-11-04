/**
 * 标签页跟手（同一平面上的左右平移），左栏「工作区 / 最近 / 归档」与文件页「会话 / 搜索」共用。
 * 松手判断（decide）、速度采样（sample）与补完时长（settleDuration）也供换页（nav/page-drag.js）使用。
 *
 * 与换页（app.js 的 pageDrag）是两个层级，用空间区分主次（2026-09-24 与用户定下）：
 *   换页    新的一层从屏幕外盖上来，带阴影、下面一层变暗或被推开 ——「我进到了另一层」。
 *   换标签  只动内容区，标签行与标题栏不动；当前内容与相邻标签的内容并排在同一平面里被手指
 *           拖动，没有阴影、谁也不盖谁；选中底色跟着手指从一个标签滑向另一个，宽度跟着渐变。
 * 松手规则与换页一致：快甩即使距离短也切，慢拖过四成才切，手指停住再松手只看位置。
 *
 * 做法是「提前切换 + 快照」：列表只有一个容器、按当前标签渲染，没有现成的相邻内容。
 * 起手时把当前列表的原节点挪进一层快照、盖在原位跟着手指走，同时真的切到相邻标签，
 * 让真实列表渲染新内容、从旁边滑进来。松手完成就撤快照；弹回就切回原标签，画好了再撤快照。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioTabDrag = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EASE = 'var(--ease-spatial, cubic-bezier(.2, .8, .2, 1))';
  let active = null;

  /**
   * 松手时完成还是弹回（换页 nav/page-drag.js 用同一个函数）。
   * @param samples [[时间, 往目标方向的位移]…]，由 sample() 维护
   * @returns {{ commit: boolean, velocity: number }}  velocity 单位 px/ms，往目标方向为正
   */
  function decide(samples, time, progress) {
    const first = samples[0],
      last = samples[samples.length - 1];
    const resting = time - last[0] > 80; // 手指停住再松手：只看位置，不算甩
    const velocity =
      !resting && last !== first ? (last[1] - first[1]) / Math.max(last[0] - first[0], 1) : 0;
    return { commit: Math.abs(velocity) > 0.35 ? velocity > 0 : progress > 0.4, velocity };
  }

  /**
   * 记一个速度采样。按下那一刻是第一个采样，之后只留最近 5 个：速度看的是松手前那一小段，
   * 不是整个手势的平均（先慢拖、最后一甩，也要认成甩）。换页与换标签共用这一份。
   */
  function sample(samples, time, value) {
    samples.push([time, value]);
    if (samples.length > 5) samples.shift();
  }

  /** 剩下那一段的时长：按距离与手指速度，快甩更短，不另起一段慢动画。 */
  const settleDuration = (distance, velocity) =>
    Math.round(Math.max(90, Math.min(260, distance / Math.max(Math.abs(velocity), 1.2))));

  /**
   * 开始一次跟手切栏。
   * @param {object} options
   *   list      内容区（会被真实地切到新标签）
   *   targetList 目标内容区，省略时复用 list；独立内容区保留各自的 DOM 与滚动状态
   *   tabs      按顺序的标签按钮
   *   from, to  当前与目标标签的序号（相邻）
   *   offset    起手时手指的横向位移；at / downAt 这一刻与按下那一刻的时间
   *   select(index) → Promise|void   切到某个标签（渲染它的内容），弹回时也用它切回去
   *   onFinish() 清理动画后显露当前导航标签
   */
  function start({
    list,
    targetList = list,
    tabs,
    from,
    to,
    offset,
    at,
    downAt = at,
    select,
    beforeSelect,
    onFinish,
  }) {
    active?.finish();
    const direction = to > from ? 1 : -1;
    const host = list.parentElement;
    const width = list.getBoundingClientRect().width || 1;
    const scrolled = list.scrollTop,
      scrolledLeft = list.scrollLeft;
    beforeSelect?.();

    // 快照：把当前内容的**原节点**挪过来盖在列表原位，而不是复制一份。
    // ⚠️ 手指按住的那个元素必须留在页面里：触摸的后续事件一直发给按下时的那个元素，列表一重新渲染
    // 它就被移除，移动事件冒泡不到外层的手势监听 —— 起手那一帧之后页面就不再跟手，看着是「晃一下」
    // （2026-09-24 用户指出）。挪走后清掉列表的渲染缓存标记，保证相邻标签一定重新画出来。
    // files 与会话列表是独立容器；切换时原容器只隐藏，保留其节点与文件树控制器。
    // 共享容器仍移动原节点，确保列表重画后按下的目标继续接收触摸事件。
    const separate = targetList !== list;
    const positions = separate
      ? [list, ...list.querySelectorAll('*')]
          .map((node, index) => ({ index, top: node.scrollTop, left: node.scrollLeft }))
          .filter((pos) => pos.top || pos.left)
      : [];
    const shot = list.cloneNode(separate);
    shot.removeAttribute('id');
    if (!separate) shot.append(...list.childNodes);
    for (const node of shot.querySelectorAll('[id]')) node.removeAttribute('id');
    delete list.dataset.signature;
    shot.setAttribute('aria-hidden', 'true');
    shot.inert = true;
    const box = list.getBoundingClientRect(),
      hostBox = host.getBoundingClientRect();
    const background = getComputedStyle(host).backgroundColor;
    Object.assign(shot.style, {
      position: 'absolute',
      margin: '0',
      pointerEvents: 'none',
      zIndex: '1',
      left: `${box.left - hostBox.left - host.clientLeft}px`,
      top: `${box.top - hostBox.top - host.clientTop}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      boxSizing: 'border-box',
      background: background && background !== 'rgba(0, 0, 0, 0)' ? background : 'var(--bg)',
    });
    const hostPosition = getComputedStyle(host).position === 'static';
    if (hostPosition) host.style.position = 'relative';
    host.style.clipPath = 'inset(0)'; // 两份内容都只在内容区里露出来，不越界
    host.append(shot);
    shot.scrollTop = scrolled;
    shot.scrollLeft = scrolledLeft;
    if (positions.length) {
      const copies = [shot, ...shot.querySelectorAll('*')];
      for (const pos of positions) {
        copies[pos.index].scrollTop = pos.top;
        copies[pos.index].scrollLeft = pos.left;
      }
    }

    // 选中底色跟着手指走：拖动时由一块独立的底色画，按钮自己的选中底色先让开。
    const row = tabs[0].parentElement;
    const rowBox = row.getBoundingClientRect();
    const place = (button) => {
      const r = button.getBoundingClientRect();
      return {
        left: r.left - rowBox.left + row.scrollLeft,
        width: r.width,
        top: r.top - rowBox.top,
        height: r.height,
      };
    };
    const origin = place(tabs[from]),
      target = place(tabs[to]);
    const glider = document.createElement('span');
    glider.className = 'tab-glider';
    Object.assign(glider.style, { top: `${origin.top}px`, height: `${origin.height}px` });
    if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
    row.classList.add('tab-gliding');
    row.prepend(glider);

    // 真的切到相邻标签：列表渲染新内容，从旁边滑进来。
    // Selection and cached content never wait for network or the decoration.
    Promise.resolve(select(to)).catch(() => {});

    let progress = 0;
    const samples = [[downAt, 0]];
    const paint = (value, duration = 0) => {
      progress = Math.max(0, Math.min(1, value));
      const transition = duration
        ? `transform ${duration}ms ${EASE}, left ${duration}ms ${EASE}, width ${duration}ms ${EASE}`
        : 'none';
      shot.style.transition = targetList.style.transition = glider.style.transition = transition;
      shot.style.transform = `translateX(${-direction * progress * width}px)`;
      targetList.style.transform = `translateX(${direction * (1 - progress) * width}px)`;
      glider.style.left = `${origin.left + (target.left - origin.left) * progress}px`;
      glider.style.width = `${origin.width + (target.width - origin.width) * progress}px`;
    };
    const move = (dx, time) => {
      const toward = -direction * dx;
      paint(toward / width);
      sample(samples, time, toward);
    };
    move(offset, at);

    let timer = 0,
      finished = false,
      selected = to;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      shot.remove();
      glider.remove();
      row.classList.remove('tab-gliding');
      for (const key of ['transition', 'transform']) targetList.style[key] = '';
      host.style.clipPath = '';
      if (hostPosition) host.style.position = '';
      if (active === controller) active = null;
      onFinish?.();
    };
    const rollback = () => {
      if (selected === from) return;
      selected = from;
      Promise.resolve(select(from)).catch(() => {});
      list.scrollTop = scrolled;
      list.scrollLeft = scrolledLeft;
    };
    const controller = {
      move: (dx, time) => {
        if (!finished) move(dx, time);
      },
      finish: cleanup,
      cancel() {
        if (finished) return;
        rollback();
        cleanup();
      },
      end(time) {
        if (finished) return;
        const { commit, velocity } = decide(samples, time, progress);
        const goal = commit ? 1 : 0;
        const duration =
          typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 0
            : settleDuration(Math.abs(goal - progress) * width, velocity);
        paint(goal, duration);
        // Preserve the original target through touchend dispatch, then roll back before paint.
        // Never wait for history; a newer gesture invalidates this microtask.
        if (!commit) {
          if (duration)
            queueMicrotask(() => {
              if (!finished) rollback();
            });
          else rollback();
        }
        if (duration) timer = setTimeout(cleanup, duration + 20);
        else cleanup();
      },
    };
    active = controller;
    return controller;
  }

  return { start, decide, sample, settleDuration, EASE, finish: () => active?.finish() };
});
