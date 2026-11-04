(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioTerminalState = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

  function validateRow(row, cols) {
    if (
      !Array.isArray(row?.cells) ||
      row.cells.length !== cols ||
      typeof row.soft_wrapped !== 'boolean' ||
      typeof row.wrap_continuation !== 'boolean'
    )
      throw new Error('Invalid native terminal row');
    for (const cell of row.cells) {
      if (
        !Array.isArray(cell) ||
        cell.length !== 7 ||
        typeof cell[0] !== 'string' ||
        !integer(cell[1], 0, 3) ||
        !integer(cell[2], -1, 0x1ffffff) ||
        !integer(cell[3], -1, 0x1ffffff) ||
        !integer(cell[4], 0, 0xffff) ||
        !integer(cell[5], -1, 0x1ffffff) ||
        (cell[6] !== null && typeof cell[6] !== 'string')
      )
        throw new Error('Invalid native terminal cell');
    }
  }

  // A patch is only meaningful against its exact base. Never repair a missing
  // update by applying it to a different terminal or by retaining partial rows.
  function applyTerminalState(previous, frame, terminalId) {
    if (
      frame?.type !== 'terminal_state' ||
      frame.version !== 1 ||
      frame.terminal_id !== terminalId ||
      typeof frame.boot_id !== 'string' ||
      !frame.boot_id ||
      !integer(frame.revision, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(frame.cols, 1, 65535) ||
      !integer(frame.rows, 1, 65535) ||
      frame.cols * frame.rows > 262144 ||
      !integer(frame.total_rows, frame.rows, Number.MAX_SAFE_INTEGER) ||
      frame.first_row !== frame.total_rows - frame.rows ||
      !Array.isArray(frame.changes)
    ) {
      throw new Error('Invalid native terminal state');
    }
    if (previous && (frame.boot_id !== previous.boot_id || frame.revision <= previous.revision))
      throw new Error('Native terminal identity or revision changed');
    const reset = frame.base_revision === null;
    if (
      !reset &&
      (!previous ||
        frame.base_revision !== previous.revision ||
        frame.cols !== previous.cols ||
        frame.rows !== previous.rows ||
        frame.alternate_screen !== previous.alternate_screen)
    )
      throw new Error('Native terminal patch base is unavailable');
    if (
      !Array.isArray(frame.cursor) ||
      frame.cursor.length !== 3 ||
      !integer(frame.cursor[0], 0, frame.cols - 1) ||
      !integer(frame.cursor[1], 0, frame.rows - 1) ||
      typeof frame.cursor[2] !== 'boolean'
    )
      throw new Error('Invalid native terminal cursor');
    if (frame.cursor_shape !== undefined && !integer(frame.cursor_shape, 0, 6))
      throw new Error('Invalid native terminal cursor shape');
    for (const mode of [
      'alternate_screen',
      'mouse_tracking',
      'mouse_sgr',
      'mouse_pixels',
      'bracketed_paste',
    ])
      if (typeof frame[mode] !== 'boolean') throw new Error('Invalid native terminal mode');
    if (frame.history_epoch !== undefined) {
      if (
        !integer(frame.history_epoch, 1, Number.MAX_SAFE_INTEGER) ||
        !integer(frame.row_offset, 0, Number.MAX_SAFE_INTEGER - frame.total_rows) ||
        !integer(frame.history_start, frame.row_offset, frame.row_offset + frame.first_row) ||
        !Array.isArray(frame.history) ||
        frame.history.length > 256 ||
        frame.history_start + frame.history.length > frame.row_offset + frame.first_row
      )
        throw new Error('Invalid native terminal history');
      for (const row of frame.history) validateRow(row, frame.cols);
    }
    const content = reset ? new Array(frame.rows) : previous.content.slice();
    const seen = new Set();
    for (const change of frame.changes) {
      if (!Array.isArray(change) || change.length !== 2)
        throw new Error('Invalid native terminal row');
      const [index, row] = change;
      if (
        !integer(index, 0, frame.rows - 1) ||
        seen.has(index) ||
        !Array.isArray(row?.cells) ||
        row.cells.length !== frame.cols ||
        typeof row.soft_wrapped !== 'boolean' ||
        typeof row.wrap_continuation !== 'boolean'
      )
        throw new Error('Invalid native terminal row');
      validateRow(row, frame.cols);
      content[index] = row;
      seen.add(index);
    }
    if (reset && seen.size !== frame.rows) throw new Error('Incomplete native terminal snapshot');
    return { ...frame, content };
  }

  return { applyTerminalState, validateRow };
});
