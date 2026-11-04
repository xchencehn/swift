(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('../native-status'));
  else root.StudioTerminalRenderer = factory(root.StudioNativeStatus);
})(typeof globalThis === 'undefined' ? this : globalThis, function (nativeStatus) {
  'use strict';
  const CSI = '\x1b[';
  // These foreground colors are emitted as RGB by the native terminal stream,
  // so an xterm ANSI theme cannot otherwise adapt them. Keep unknown RGB colors
  // and all explicit RGB backgrounds intact.
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
  function attributes(cell, adaptNativeColors) {
    if (cell.isAttributeDefault()) return CSI + '0m';
    const codes = [0];
    for (const [method, code] of [
      ['isBold', 1],
      ['isDim', 2],
      ['isItalic', 3],
      ['isUnderline', 4],
      ['isBlink', 5],
      ['isInverse', 7],
      ['isInvisible', 8],
      ['isStrikethrough', 9],
      ['isOverline', 53],
    ])
      if (cell[method]()) codes.push(code);
    for (const background of [false, true]) {
      const rgb = background ? cell.isBgRGB() : cell.isFgRGB(),
        palette = background ? cell.isBgPalette() : cell.isFgPalette();
      const value = background ? cell.getBgColor() : cell.getFgColor();
      const adapted =
        rgb && !background && adaptNativeColors ? nativeForeground.get(value) : undefined;
      if (adapted === -1) codes.push(39);
      else if (adapted !== undefined) codes.push(38, 5, adapted);
      else if (rgb)
        codes.push(background ? 48 : 38, 2, (value >> 16) & 255, (value >> 8) & 255, value & 255);
      else if (palette) codes.push(background ? 48 : 38, 5, value);
    }
    return CSI + codes.join(';') + 'm';
  }
  function row(line, cols, adaptNativeColors) {
    let output = '',
      style = '';
    const reusable = line?.getCell(0);
    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x, reusable);
      if (cell && !cell.getWidth()) continue;
      if (cell && x + cell.getWidth() > cols) {
        output += ' ';
        continue;
      }
      const next = cell ? attributes(cell, adaptNativeColors) : CSI + '0m';
      if (next !== style) {
        output += next;
        style = next;
      }
      output += cell?.getChars() || ' ';
    }
    return output;
  }
  function text(line, cols, start = 0) {
    const edge = line?.getCell(cols - 1);
    return (
      line?.translateToString(true, start, edge?.getWidth() === 2 ? cols - 1 : cols).trimEnd() || ''
    );
  }
  // This terminal is never opened in the DOM and has no input handler. Native
  // clears and redraws are reduced here; only changed rows reach the visible
  // terminal, so a spinner cannot recreate the user's stable text or IME.
  function create({ Terminal, cols, rows, adaptNativeColors = false, previousDisplay }) {
    const source = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    let previous = previousDisplay?.rows || [],
      dimensions = previousDisplay?.dimensions || '',
      cursor = previousDisplay?.cursor || '',
      hidden = false,
      cursorStyle = 0,
      disposed = false;
    const modes = [];
    for (const final of ['h', 'l'])
      modes.push(
        source.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
          if (params.includes(25)) hidden = final === 'l';
          return false;
        }),
      );
    modes.push(
      source.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
        cursorStyle = Number(params[0]) || 0;
        return false;
      }),
    );
    modes.push(
      source.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
        hidden = false;
        return false;
      }),
    );
    let viewCols = cols,
      viewRows = rows;
    let head = '',
      headRevision = 0,
      history = null,
      candidate = null,
      lastFrame = null;
    let projected = null,
      rendered = null,
      blank = '',
      blankCols = 0;
    function scrollShift(previous, lines) {
      const matches = [];
      for (let shift = 1; shift < previous.length; shift++) {
        let overlap = 0;
        while (
          overlap < lines.length &&
          shift + overlap < previous.length &&
          previous[shift + overlap] === lines[overlap]
        )
          overlap++;
        if (lines.slice(0, overlap).filter(Boolean).length >= 8) matches.push(shift);
      }
      return matches.length === 1 ? matches[0] : 0;
    }
    function projection() {
      // Rendering, history requests and alignment inspect the same parsed frame.
      // Invalidate on native writes, not on each consumer of its text projection.
      if (projected) return projected;
      const buffer = source.buffer.active;
      let end = Math.min(source.rows, buffer.cursorY + 1);
      for (let y = source.rows - 1; y >= end; y--) {
        if (
          buffer
            .getLine(buffer.viewportY + y)
            ?.translateToString(true)
            .trim()
        ) {
          end = y + 1;
          break;
        }
      }
      const lines = Array.from({ length: end }, (_, y) =>
        text(buffer.getLine(buffer.viewportY + y), source.cols),
      );
      const nextHead = JSON.stringify([source.cols, source.rows, ...lines.slice(0, 4)]);
      if (head !== nextHead) {
        const shift =
          history && lastFrame?.cols === source.cols && lastFrame?.rows === source.rows
            ? scrollShift(lastFrame.lines, lines)
            : 0;
        const previousLines = lastFrame?.lines;
        const activeRows = lines.filter(Boolean).length;
        const allowedChanges = Math.min(3, Math.max(2, Math.floor(activeRows / 4)));
        const sameScreen =
          history &&
          lastFrame?.cols === source.cols &&
          lastFrame?.rows === source.rows &&
          previousLines?.length === lines.length &&
          lines.filter((line, y) => line && line === previousLines[y]).length >=
            Math.max(1, activeRows - allowedChanges) &&
          lines.filter((line, y) => line !== previousLines[y]).length <= allowedChanges;
        head = nextHead;
        candidate = null;
        if (shift) {
          headRevision++;
          history = {
            key: `${source.cols}:${headRevision}`,
            rows: [...history.rows, ...lastFrame.cells.slice(0, shift)].slice(-200),
          };
        } else if (!sameScreen) {
          headRevision++;
          history = null;
        }
      }
      return (projected = {
        buffer,
        end,
        lines,
        key: `${source.cols}:${headRevision}`,
        cells: new Map(),
        cellCols: 0,
      });
    }
    function historyKey() {
      if (disposed || source.modes.synchronizedOutputMode) return '';
      const { buffer, end, key } = projection();
      return source.rows > viewRows && viewRows > end && history?.key !== key
        ? `${key}:${buffer.cursorX}:${buffer.cursorY}:${Number(hidden)}:${cursorStyle}`
        : '';
    }
    function read() {
      // Native repaints can span several transport chunks. Parse and acknowledge
      // each chunk, but project rows only after DEC synchronized output ends.
      // Otherwise a cleared, half-filled screen changes the viewport anchor.
      if (disposed || source.modes.synchronizedOutputMode) return '';
      const frame = projection(),
        { buffer, end, lines, key } = frame;
      if (rendered === frame && dimensions === `${viewCols}:${viewRows}` && !candidate) return '';
      if (candidate?.key === key) {
        const native = candidate.visible;
        const offset = native
          ? candidate.whole.length - native.whole.length
          : candidate.lines.length - end;
        const aligned =
          candidate.binding === historyKey() &&
          (native
            ? native.lines.length === end &&
              lines.every((line, y) => line === native.lines[y] || line === native.leftEdge[y]) &&
              native.whole.every((line, y) => line === candidate.whole[offset + y])
            : lines.every((line, y) => line === candidate.lines[offset + y]));
        // History belongs above this screen only when its entire visible tail
        // matches the current frame. A stale read cannot replace native rows.
        if (offset >= 0 && aligned) {
          history = { key, rows: candidate.rows.slice(0, offset) };
          candidate = null;
        }
      }
      // Only a padded observation has an independent capture height. Anchor
      // its last useful row at the bottom of the local viewport; an ordinary
      // terminal at its own size must keep its native row coordinates.
      // Codex reserves a hint row below its separate model/directory status
      // even when typing hides "? for shortcuts". Keep that blank row in the
      // observation extent, including a first frame with an existing draft.
      const footer = source.rows > viewRows ? nativeStatus.parseCodexFooter(lines) : null;
      const reservedHint =
        footer?.footerIndex >= 0 &&
        footer.rows.length === 1 &&
        lines.at(-1).trim() &&
        nativeStatus.hasCodexModelAndDirectory(footer.fields);
      const bottom = Math.min(source.rows, end + Number(Boolean(reservedHint)));
      let top = source.rows > viewRows ? bottom - viewRows : Math.max(0, end - viewRows);
      // A native question can place the active cursor above the status tail.
      // Keep that interaction visible, but anchor it at the bottom too.
      if (!hidden && buffer.cursorY < top) top = buffer.cursorY - viewRows + 1;
      const size = `${viewCols}:${viewRows}`,
        resized = size !== dimensions;
      let output = resized ? CSI + '2J' : '';
      const next = [];
      if (blankCols !== viewCols) {
        blank = row(null, viewCols, adaptNativeColors);
        blankCols = viewCols;
      }
      if (frame.cellCols !== viewCols) {
        frame.cells.clear();
        frame.cellCols = viewCols;
      }
      for (let y = 0; y < viewRows; y++) {
        const sourceY = top + y;
        let cells;
        if (sourceY < 0)
          cells =
            history?.key === key ? history.rows[history.rows.length + sourceY] || blank : blank;
        else {
          cells = frame.cells.get(sourceY);
          if (cells === undefined) {
            cells = row(buffer.getLine(buffer.viewportY + sourceY), viewCols, adaptNativeColors);
            frame.cells.set(sourceY, cells);
          }
        }
        next[y] = cells;
        if (resized || previous[y] !== cells) output += `${CSI}${y + 1};1H${cells}`;
      }
      const cursorY = buffer.cursorY - top;
      const cursorHidden =
        hidden || cursorY < 0 || cursorY >= viewRows || buffer.cursorX >= viewCols;
      const nextCursor = `${CSI}${Math.max(0, Math.min(viewRows - 1, cursorY)) + 1};${Math.min(viewCols - 1, buffer.cursorX) + 1}H${CSI}?25${cursorHidden ? 'l' : 'h'}${CSI}${cursorStyle} q`;
      const changed = output || cursor !== nextCursor;
      previous = next;
      cursor = nextCursor;
      dimensions = size;
      rendered = frame;
      lastFrame =
        history && top <= 0
          ? { cols: source.cols, rows: source.rows, lines, cells: next.slice(-top, end - top) }
          : null;
      // xterm 6 refreshes every row when DEC mode 2026 ends. Native sync
      // markers stay in the source buffer; this small atomic write already
      // contains the finished delta and must not request another full repaint.
      return changed ? `${CSI}?7l${output}${CSI}0m${nextCursor}${CSI}?7h${CSI}?2004h` : '';
    }
    return {
      restart() {
        // A retired parser may never finish. Keep the visible diff baseline,
        // but give a replacement stream a fresh parser and independent queue.
        const next = create({
          Terminal,
          cols: source.cols,
          rows: source.rows,
          adaptNativeColors,
          previousDisplay: { rows: previous, dimensions, cursor },
        });
        disposed = true;
        for (const mode of modes) mode.dispose();
        source.dispose();
        return next;
      },
      write(
        bytes,
        {
          full = false,
          cols = source.cols,
          rows = source.rows,
          viewportCols = cols,
          viewportRows = rows,
          render = true,
        } = {},
      ) {
        if (disposed) return Promise.resolve('');
        projected = null;
        viewCols = viewportCols;
        viewRows = viewportRows;
        if (source.cols !== cols || source.rows !== rows) source.resize(cols, rows);
        if (full) {
          const prefix = new TextEncoder().encode(CSI + '!p' + CSI + '2J' + CSI + 'H');
          const frame = new Uint8Array(prefix.length + bytes.length);
          frame.set(prefix);
          frame.set(bytes, prefix.length);
          bytes = frame;
        }
        return new Promise((resolve) =>
          source.write(bytes, () => {
            projected = null;
            resolve(render ? read() : '');
          }),
        );
      },
      render({ cols, rows }) {
        viewCols = cols;
        viewRows = rows;
        return read();
      },
      historyKey,
      async history(recent, key, visible, { render = true, current = () => true } = {}) {
        if (
          disposed ||
          key !== historyKey() ||
          typeof recent !== 'string' ||
          recent.length > 1024 * 1024 ||
          (visible != null && (typeof visible !== 'string' || visible.length > 1024 * 1024))
        )
          return '';
        const currentCols = source.cols;
        const valid = () =>
          !disposed && current() && source.cols === currentCols && key === historyKey();
        async function parse(value) {
          if (!valid()) return null;
          // Spare cells beyond the largest captured width keep DEC no-wrap
          // overflow (including a wide glyph) outside the visible edge.
          const snapshot = new Terminal({
            cols: 402,
            rows: 200,
            scrollback: 0,
            allowProposedApi: true,
          });
          try {
            // The read API returns physical native rows. Parse at the bounded
            // maximum width, then crop cells; no-wrap alone overwrites its edge.
            await new Promise((resolve) =>
              snapshot.write(CSI + '?7l' + value.replace(/\r?\n/g, '\r\n'), resolve),
            );
            const buffer = snapshot.buffer.active,
              lines = [],
              rows = [],
              whole = [],
              leftEdge = [];
            for (let y = 0; y < snapshot.rows; y++) {
              // History is optional background work. Yield between bounded row
              // batches so keystrokes and current terminal output can proceed.
              if (y % 16 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (!valid()) return null;
              }
              const line = buffer.getLine(buffer.viewportY + y);
              lines.push(text(line, currentCols));
              whole.push(text(line, 400));
              rows.push(row(line, currentCols, adaptNativeColors));
              // Herdr's bounded observe frame can blank the leading wide cell
              // after the previous physical row is cut through a wide glyph.
              // Accept only that exact two-cell difference; all other cells,
              // rows, native history tail and request-time cursor must match.
              const previous = buffer.getLine(buffer.viewportY + y - 1);
              leftEdge.push(
                line?.getCell(0)?.getWidth() === 2 &&
                  previous?.getCell(currentCols - 1)?.getWidth() === 2
                  ? ('  ' + text(line, currentCols, 2)).trimEnd()
                  : null,
              );
            }
            while (whole.length && !whole.at(-1)) {
              whole.pop();
              rows.pop();
            }
            lines.length = whole.length;
            while (lines.length && !lines.at(-1)) lines.pop();
            return { lines, rows, whole, leftEdge };
          } finally {
            snapshot.dispose();
          }
        }
        const [parsed, native] = await Promise.all([
          parse(recent),
          visible == null ? null : parse(visible),
        ]);
        if (!parsed || (visible != null && !native) || !valid()) return '';
        candidate = { key: projection().key, binding: key, ...parsed, visible: native };
        return render ? read() : '';
      },
      dispose() {
        disposed = true;
        for (const mode of modes) mode.dispose();
        source.dispose();
      },
    };
  }
  return { create };
});
