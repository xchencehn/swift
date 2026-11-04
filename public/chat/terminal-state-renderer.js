(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('./terminal-state'));
  else root.StudioTerminalStateRenderer = factory(root.StudioTerminalState);
})(typeof globalThis === 'undefined' ? this : globalThis, function (stateProtocol) {
  'use strict';
  const { applyTerminalState, validateRow } = stateProtocol;
  const CSI = '\x1b[',
    OSC = '\x1b]',
    ST = '\x1b\\';
  // Same foreground adaptation as the ANSI renderer. Explicit backgrounds and
  // application RGB colors remain unchanged.
  const nativeForeground = new Map([
    [0xcdd6f4, -1],
    [0x9399b2, 8],
    [0x89b4fa, 4],
    [0x63a8f8, 12],
    [0x94e2d5, 6],
    [0xeba0ac, 9],
    [0xa6e3a1, 2],
    [0xf38ba8, 1],
    [0xcba6f7, 5],
  ]);
  const safeText = (value) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  function style(cell, adapt) {
    const codes = ['0'],
      flags = cell[4];
    for (const [bit, code] of [
      [0, 1],
      [1, 3],
      [2, 2],
      [3, 5],
      [4, 7],
      [5, 8],
      [6, 9],
      [7, 53],
    ])
      if (flags & (1 << bit)) codes.push(String(code));
    if ((flags >> 8) & 7) codes.push(`4:${(flags >> 8) & 7}`);
    for (const [index, code] of [
      [2, 38],
      [3, 48],
      [5, 58],
    ]) {
      let color = cell[index];
      if (index === 2 && adapt && color >= 0x1000000)
        color = nativeForeground.get(color & 0xffffff) ?? color;
      if (color < 0) continue;
      if (color >= 0x1000000)
        codes.push(`${code};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`);
      else codes.push(`${code};5;${color}`);
    }
    return CSI + codes.join(';') + 'm';
  }
  function create({ terminalId, adaptNativeColors = false, previousDisplay } = {}) {
    let state = null,
      buffer = '',
      decoder = new TextDecoder(),
      disposed = false;
    let previous = previousDisplay?.rows || [],
      dimensions = previousDisplay?.dimensions || '',
      lastCursor = previousDisplay?.cursor || '';
    let viewCols = 80,
      viewRows = 24,
      top = null,
      epoch = null,
      displayed = [],
      displayCols = 0;
    const history = new Map(),
      rows = new WeakMap();
    const first = () => (state ? state.first_row + (state.row_offset || 0) : 0);
    function storeHistory(start, content) {
      content.forEach((row, index) => history.set(start + index, row));
      // Bound every terminal independently. Keep the current reading window
      // and recent history; older pages can be read again from the runtime.
      if (history.size > 4096)
        for (const index of history.keys()) {
          if (top !== null && index >= top && index < top + viewRows) continue;
          history.delete(index);
          if (history.size <= 4096) break;
        }
    }
    function apply(frame) {
      const next = applyTerminalState(state, frame, terminalId);
      const nextEpoch = next.history_epoch ?? next.revision;
      if (epoch !== nextEpoch) {
        history.clear();
        top = null;
        epoch = nextEpoch;
      }
      state = next;
      if (Array.isArray(frame.history)) storeHistory(frame.history_start, frame.history);
      storeHistory(first(), state.content);
    }
    function row(source, cols) {
      if (!source) return CSI + '0m' + ' '.repeat(cols);
      let cached = rows.get(source);
      if (cached?.cols === cols) return cached.text;
      let text = '',
        currentStyle = '',
        link = null;
      for (let x = 0; x < cols; x++) {
        const cell = source.cells[x];
        if (cell?.[1] === 0) continue;
        const nextStyle = cell ? style(cell, adaptNativeColors) : CSI + '0m';
        if (nextStyle !== currentStyle) {
          text += nextStyle;
          currentStyle = nextStyle;
        }
        const nextLink = cell?.[6] ? safeText(cell[6]) : null;
        if (nextLink !== link) {
          text += OSC + '8;;' + (nextLink || '') + ST;
          link = nextLink;
        }
        text += !cell || cell[1] === 3 || x + cell[1] > cols ? ' ' : safeText(cell[0]) || ' ';
      }
      if (link) text += OSC + '8;;' + ST;
      rows.set(source, { cols, text });
      return text;
    }
    function liveTop() {
      let end = state.rows;
      // Keep the native bottom, including status/hint rows below the cursor.
      // Follow an active cursor only when it would otherwise be above the view.
      if (viewRows < state.rows && state.cursor[2] && state.cursor[1] < state.rows - viewRows)
        end = Math.max(viewRows, state.cursor[1] + 1);
      return first() + end - viewRows;
    }
    function render({ cols = viewCols, rows: height = viewRows } = {}) {
      viewCols = cols;
      viewRows = height;
      if (disposed || !state) return '';
      const start = top ?? liveTop(),
        size = `${cols}:${height}`,
        resized = dimensions !== size;
      let output = resized ? CSI + '2J' : '';
      const next = [],
        visible = [];
      for (let y = 0; y < height; y++) {
        const index = start + y,
          local = index - first();
        const cells = local >= 0 && local < state.rows ? state.content[local] : history.get(index);
        visible[y] = cells;
        next[y] = row(cells, cols);
        if (resized || previous[y] !== next[y]) output += `${CSI}${y + 1};1H${next[y]}`;
      }
      const cy = first() + state.cursor[1] - start,
        cx = state.cursor[0];
      const hidden = !state.cursor[2] || top !== null || cy < 0 || cy >= height || cx >= cols;
      const cursor = `${CSI}${Math.max(0, Math.min(height - 1, cy)) + 1};${Math.min(cols - 1, cx) + 1}H${CSI}?25${hidden ? 'l' : 'h'}${CSI}${state.cursor_shape || 0} q`;
      const changed = output || cursor !== lastCursor;
      previous = next;
      dimensions = size;
      lastCursor = cursor;
      displayed = visible;
      displayCols = cols;
      return changed ? `${CSI}?7l${output}${CSI}0m${cursor}${CSI}?7h${CSI}?2004h` : '';
    }
    function acceptHistory(response) {
      if (response.boot_id !== state?.boot_id || response.history_epoch !== state?.history_epoch)
        return;
      if (
        !Number.isSafeInteger(response.start) ||
        response.start < 0 ||
        !Array.isArray(response.content) ||
        response.content.length > 2048
      )
        throw new Error('Invalid native terminal history');
      for (const row of response.content) validateRow(row, state.cols);
      storeHistory(response.start, response.content);
    }
    return {
      get state() {
        return state;
      },
      write(bytes) {
        if (disposed) return;
        buffer += decoder.decode(bytes, { stream: true });
        let end;
        const received = [];
        while ((end = buffer.indexOf('\n')) >= 0) {
          if (end > 32 * 1024 * 1024) throw new Error('Native terminal frame exceeds limit');
          const frame = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (frame.type === 'terminal_history') {
            acceptHistory(frame);
            received.push(frame.requestId);
          } else apply(frame);
        }
        if (buffer.length > 32 * 1024 * 1024)
          throw new Error('Native terminal frame exceeds limit');
        return received;
      },
      render,
      selectionText(range) {
        if (!range || !displayed.length) return undefined;
        const { start, end } = range;
        if (!start || !end || start.y < 0 || end.y > displayed.length || start.y > end.y)
          return undefined;
        let text = '';
        for (let y = start.y; y <= end.y && y < displayed.length; y++) {
          const current = displayed[y];
          const wrapped =
            y > start.y &&
            displayCols >= (current?.cells.length || 0) &&
            current?.wrap_continuation &&
            displayed[y - 1]?.soft_wrapped;
          if (y > start.y && !wrapped) text += '\n';
          const left = y === start.y ? start.x : 0,
            right = y === end.y ? end.x : displayCols;
          let line = '';
          for (let x = left; x < Math.min(right, displayCols); x++) {
            const cell = current?.cells[x];
            if (cell && (cell[1] === 0 || cell[1] === 3)) continue;
            line += cell ? safeText(cell[0]) || ' ' : ' ';
          }
          text +=
            current?.soft_wrapped && y < end.y && displayCols >= current.cells.length
              ? line
              : line.trimEnd();
        }
        return text;
      },
      scroll(direction, lines, source, forceLocal = false) {
        if (!state || (!forceLocal && (state.mouse_tracking || state.alternate_screen)))
          return false;
        const bottom = liveTop(),
          floor = state.row_offset || 0;
        top = Math.max(
          floor,
          Math.min(bottom, (top ?? bottom) + (direction === 'up' ? -lines : lines)),
        );
        if (top >= bottom) top = null;
        return true;
      },
      toBottom() {
        top = null;
      },
      historyRequest() {
        if (!state || state.alternate_screen || state.history_epoch === undefined) return null;
        const start = Math.max(state.row_offset || 0, (top ?? liveTop()) - 200);
        const end = Math.min(first(), (top ?? liveTop()) + viewRows);
        for (let i = start; i < end; i++)
          if (!history.has(i))
            return {
              boot_id: state.boot_id,
              revision: state.revision,
              history_epoch: state.history_epoch,
              start: i,
              limit: Math.min(256, Math.max(1, Math.floor(8192 / state.cols)), end - i),
            };
        return null;
      },
      history: acceptHistory,
      restart() {
        disposed = true;
        return create({
          terminalId,
          adaptNativeColors,
          previousDisplay: { rows: previous, dimensions, cursor: lastCursor },
        });
      },
      dispose() {
        disposed = true;
        state = null;
        buffer = '';
        history.clear();
      },
    };
  }
  return { create };
});
