'use strict';
const { spawn } = require('node:child_process');
const { WatchStreamParser } = require('./watch-stream');
const { createOutputControl } = require('./output-control');
const { clampInt } = require('./herdr-client');
const { PROTOCOL, openTerminalSession } = require('./herdr-terminal-session');
const { openTerminalState } = require('./herdr-terminal-state');
const { validKey } = require('../public/chat/terminal-keyboard');

// A native terminal controller is permanently bound to one terminal ID. It
// never attaches the Herdr TUI or writes through the current focused pane.
async function attachShellTerminal({
  ws,
  url,
  herdr,
  cwd,
  env,
  maxInputBytes,
  preparation,
  controlReleased,
  persistent = false,
}) {
  // Markers and ANSI bytes must enter the same WebSocket send order.
  // A separate asynchronous JSON queue could reset a screen after its bytes.
  const notify = (value) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(value));
  };
  const paneId = url.searchParams.get('pane'),
    terminalId = url.searchParams.get('terminalId');
  const runtimeId = url.searchParams.get('runtimeId');
  try {
    const snapshot = herdr.normalizeSnapshot(await herdr.snapshot());
    const pane = snapshot.panes.find((item) => item.paneId === paneId);
    if (!runtimeId || snapshot.runtimeId !== runtimeId || !pane || pane.terminalId !== terminalId)
      throw Object.assign(new Error('终端身份已经改变，请重新选择会话。'), {
        code: 'TERMINAL_IDENTITY_CHANGED',
      });
    if (ws.readyState !== 1) return;
    const retainControl = url.searchParams.get('retainControl') === '1';
    const direct = snapshot.protocol === PROTOCOL && Boolean(herdr.socketPath);
    const capabilities =
      direct && url.searchParams.get('stateFormat') === 'cells-v1'
        ? (await herdr.request('ping')).capabilities
        : null;
    const nativeState = capabilities?.terminal_state_version === 1;
    const semanticInput = nativeState && capabilities?.terminal_input_version === 1;
    if (ws.readyState !== 1) return;
    let cols = clampInt(url.searchParams.get('cols'), 20, 400, 100);
    let rows = clampInt(url.searchParams.get('rows'), 5, 200, 32);
    let stopped = false,
      announced = false,
      observer,
      controller,
      prepared,
      idleTimer,
      queuedBytes = 0,
      pointerDown = false,
      composing = false,
      geometry = '';
    let operations = Promise.resolve(),
      historyReading = false,
      visible = true;
    const historyRequests = new Set();
    const entries = new Set();
    let latestNative = null,
      sentNative = null,
      nativeBytes = null,
      nativeOffset = 0,
      nativeHistory = null;
    const output = createOutputControl({
      ws,
      acknowledged: ws.flowAcknowledged,
      pause: () => {
        for (const entry of entries)
          if (!direct || (!nativeState && entry.mode === 'observe'))
            entry.session ? entry.session.pause() : entry.child.stdout.pause();
      },
      resume: () => {
        for (const entry of entries)
          if (!direct || (!nativeState && entry.mode === 'observe'))
            entry.session ? entry.session.resume() : entry.child.stdout.resume();
        if (nativeState) queueMicrotask(flushNative);
      },
    });
    function end(entry) {
      if (!entry || entry.stopped) return entry?.closed;
      entry.stopped = true;
      clearTimeout(entry.timer);
      entry.reject(new Error('终端连接已结束。'));
      if (entry.session) return entry.session.close();
      // Detach releases Herdr's direct_attach_resize_locks. Never use takeover.
      entry.child.stdin.end(entry.mode === 'control' ? '{"type":"terminal.release"}\n' : undefined);
      if (entry.mode === 'observe') entry.child.kill('SIGTERM');
      entry.killTimer = setTimeout(() => entry.child.kill('SIGTERM'), 1500);
      entry.killTimer.unref?.();
      entry.forceTimer = setTimeout(() => entry.child.kill('SIGKILL'), 3000);
      entry.forceTimer.unref?.();
      return entry.closed;
    }
    let closed;
    const stop = () => {
      if (stopped) return closed;
      stopped = true;
      clearTimeout(idleTimer);
      output.stop();
      return (closed = Promise.all([...entries].map(end)));
    };
    const fail = (message) => {
      if (stopped) return;
      notify({ type: 'terminal.error', message, recoverable: true });
      stop();
      ws.close(1013, 'shell transport interrupted');
    };
    ws.shellTerminal = { stop, output };
    ws.once('close', stop);
    function deliver(data, frame, full) {
      const nextGeometry = `${frame.cols}:${frame.rows}`;
      if (nextGeometry !== geometry) {
        geometry = nextGeometry;
        notify({ type: 'terminal.geometry', cols: frame.cols, rows: frame.rows });
      }
      if (full) notify({ type: 'terminal.full' });
      if (!announced) {
        announced = true;
        notify({
          type: 'terminal.ready',
          transport: 'shell',
          paneId,
          terminalId,
          suspendable: direct && !nativeState,
          stateFormat: nativeState ? 'cells-v1' : 'ansi',
        });
      }
      const bytes = Buffer.from(data);
      if (persistent) {
        // Bound each scheduling turn so a large native repaint cannot occupy
        // the shared link ahead of every foreground frame.
        for (let offset = 0; offset < bytes.length; offset += 16384)
          if (!output.write(bytes.subarray(offset, offset + 16384))) break;
      } else output.write(bytes);
    }
    function flushNative() {
      if (stopped || output.blocked) return;
      // One partial frame and the newest state are retained. Superseded states
      // are reduced before transmission; their deltas are never sent against
      // a baseline the client did not receive.
      while (!output.blocked && !stopped) {
        if (!nativeBytes) {
          if (latestNative) {
            const state = latestNative;
            latestNative = null;
            const reset =
              !sentNative ||
              sentNative.cols !== state.cols ||
              sentNative.rows !== state.rows ||
              sentNative.alternate_screen !== state.alternate_screen;
            const frame = {
              ...state,
              content: undefined,
              base_revision: reset ? null : sentNative.revision,
              changes: state.content
                .map((row, index) => [index, row])
                .filter(([index, row]) => reset || sentNative.content[index] !== row),
            };
            const nextGeometry = `${state.cols}:${state.rows}`;
            if (nextGeometry !== geometry) {
              geometry = nextGeometry;
              notify({ type: 'terminal.geometry', cols: state.cols, rows: state.rows });
            }
            if (reset) notify({ type: 'terminal.full' });
            if (!announced) {
              announced = true;
              notify({
                type: 'terminal.ready',
                transport: 'shell',
                paneId,
                terminalId,
                suspendable: false,
                stateFormat: 'cells-v1',
                semanticInput,
              });
            }
            nativeBytes = Buffer.from(JSON.stringify(frame) + '\n');
            sentNative = state;
          } else if (nativeHistory) {
            nativeBytes = nativeHistory;
            nativeHistory = null;
          } else return;
          nativeOffset = 0;
        }
        if (!output.write(nativeBytes.subarray(nativeOffset, nativeOffset + 16384))) return;
        nativeOffset += 16384;
        if (nativeOffset >= nativeBytes.length) nativeBytes = null;
      }
    }
    function startState() {
      const session = openTerminalState({ socketPath: herdr.socketPath, terminalId });
      const entry = { session, mode: 'observe', ready: false, stopped: false, reject() {} };
      entries.add(entry);
      entry.pending = session.ready.then(() => {
        entry.ready = true;
        return entry;
      });
      entry.pending.catch(() => {});
      entry.closed = session.closed.then(() => {
        entries.delete(entry);
        if (!entry.stopped) fail('终端状态连接已断开，正在恢复。');
      });
      session.on('failure', () => {
        if (!entry.stopped) fail('终端状态连接已断开，正在恢复。');
      });
      session.on('state', (_frame, state) => {
        if (!stopped && !entry.stopped) {
          latestNative = state;
          flushNative();
        }
      });
      return entry;
    }
    function startDirect(mode) {
      const session = preparation
        ? preparation.take()
        : openTerminalSession({
            socketPath: herdr.socketPath,
            terminalId,
            mode,
            cols,
            rows: mode === 'observe' ? 200 : rows,
          });
      const entry = { session, mode, ready: false, stopped: false };
      entries.add(entry);
      entry.pending = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.pending.catch(() => {});
      entry.closed = session.closed.then(() => {
        entries.delete(entry);
        clearTimeout(entry.timer);
        entry.reject(new Error('终端连接已结束。'));
        if (!entry.stopped) fail('终端已断开，可能已被其他客户端接管，请重新连接。');
      });
      entry.timer = setTimeout(() => fail('连接终端超时，请重试。'), 10000);
      entry.timer.unref?.();
      session.on('failure', () => {
        if (!entry.stopped) fail('终端输入连接已断开，请重新连接；未重发按键。');
      });
      session.on('controlReady', () => {
        if (stopped || entry.stopped || entry.mode !== 'control') return;
        entry.ready = true;
        clearTimeout(entry.timer);
        entry.resolve(entry);
      });
      if (mode === 'pending')
        session.ready
          .then(() => {
            clearTimeout(entry.timer);
          })
          .catch(() => {});
      session.on('frame', (data, frame) => {
        if (stopped || entry.stopped) return;
        entry.ready = true;
        clearTimeout(entry.timer);
        entry.resolve(entry);
        // One continuous observer supplies every displayed frame. Acquiring or
        // releasing input never resets its delta baseline or restarts display.
        if (mode === 'observe') deliver(data, frame, frame.full);
      });
      if (preparation && mode !== 'pending')
        session.ready
          .then(() => {
            if (!stopped && !entry.stopped)
              session.activate(cols, mode === 'observe' ? 200 : rows, terminalId, mode);
          })
          .catch(() => {});
      return entry;
    }
    function start(mode) {
      if (nativeState && mode === 'observe') return startState();
      if (direct) return startDirect(mode);
      // Observing a short surface crops the native screen from its top. Keep
      // the complete bounded screen; the viewer chooses its visible rows.
      const captureRows = mode === 'observe' ? 200 : rows;
      const child = spawn(
        herdr.bin,
        [
          'terminal',
          'session',
          mode,
          terminalId,
          '--cols',
          String(cols),
          '--rows',
          String(captureRows),
        ],
        { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const entry = { child, mode, ready: false, stopped: false, full: false };
      entries.add(entry);
      entry.pending = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.pending.catch(() => {});
      entry.closed = new Promise((resolve) =>
        child.once('close', () => {
          entry.reject(new Error('终端连接已结束。'));
          entries.delete(entry);
          clearTimeout(entry.timer);
          clearTimeout(entry.killTimer);
          clearTimeout(entry.forceTimer);
          resolve();
          if (!entry.stopped) fail('终端已断开，可能已被其他客户端接管，请重新连接。');
        }),
      );
      entry.timer = setTimeout(() => fail('连接终端超时，请重试。'), 10000);
      entry.timer.unref?.();
      child.once('error', () => fail('无法连接这个终端，请重试。'));
      child.stdin.on('error', () => {
        if (!entry.stopped) fail('终端输入连接已断开，请重新连接；未重发按键。');
      });
      child.stderr.on('data', () => {}); // Do not expose native stderr or terminal contents.
      const parser = new WatchStreamParser({
        onFull: () => {
          entry.full = true;
        },
        onFrame: (data, frame) => {
          if (stopped || entry.stopped) return;
          if (!entry.ready) {
            entry.ready = true;
            clearTimeout(entry.timer);
            entry.resolve(entry);
            if (entry === controller) end(observer);
          }
          if (entry !== controller && controller?.ready) return;
          deliver(
            data,
            { cols: frame?.cols || cols, rows: frame?.rows || captureRows },
            entry.full,
          );
          entry.full = false;
        },
        onEnd: () => {
          if (!entry.stopped) fail('终端控制已结束，请重新连接。');
        },
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data) => {
        if (!entry.stopped) parser.push(data);
      });
      return entry;
    }
    function enqueue(bytes, operation) {
      if (queuedBytes + bytes > maxInputBytes * 2)
        return fail('终端输入繁忙，请重新连接；未重发按键。');
      queuedBytes += bytes;
      operations = operations
        .then(async () => {
          if (!stopped) await operation();
        })
        .catch(() => {
          if (!stopped) fail('终端输入连接已断开，请重新连接；未重发按键。');
        })
        .finally(() => {
          queuedBytes -= bytes;
        });
    }
    async function acquire(stillCurrent = () => true) {
      if (controlReleased) {
        await controlReleased;
        controlReleased = null;
      }
      if (stopped) throw new Error('Terminal connection closed');
      if (!stillCurrent()) return null;
      if (!controller) {
        controller = prepared || start('control');
        prepared = null;
        if (controller.mode === 'pending') {
          const current = controller;
          await current.session.ready;
          if (stopped || current.stopped) throw new Error('Terminal connection closed');
          if (!stillCurrent()) {
            prepared = current;
            controller = null;
            return null;
          }
          current.mode = 'control';
          current.session.activate(cols, rows, terminalId, 'control', { frames: !semanticInput });
          current.timer = setTimeout(() => fail('连接终端超时，请重试。'), 10000);
          current.timer.unref?.();
        }
        if (direct && !stopped) prepared = startDirect('pending');
      }
      return controller.pending;
    }
    async function release() {
      clearTimeout(idleTimer);
      if (!controller) return;
      const previous = controller;
      await end(previous);
      controller = null;
      pointerDown = false;
      composing = false;
      if (stopped) return;
      if (direct) {
        if (!prepared) prepared = startDirect('pending');
        return;
      }
      // A new observer starts with a full frame after the native TUI regains its geometry.
      end(observer);
      observer = start('observe');
    }
    function armRelease() {
      clearTimeout(idleTimer);
      if (!retainControl && !pointerDown && !composing) {
        idleTimer = setTimeout(() => enqueue(0, release), 1000);
        idleTimer.unref?.();
      }
    }
    observer = start('observe');
    if (direct) prepared = startDirect('pending');
    ws.on('message', (raw, binary) => {
      if (stopped || !announced || binary || raw.length > maxInputBytes * 2) return;
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (
        direct &&
        message?.type === 'terminal.visibility' &&
        typeof message.visible === 'boolean'
      ) {
        enqueue(1, async () => {
          visible = message.visible;
          if (!visible) {
            await release();
            if (!nativeState) {
              await end(observer);
              observer = null;
            }
          } else if (!observer && !stopped) {
            // A hidden view has no native stream to notice a server restart.
            if (herdr.normalizeSnapshot({}).runtimeId !== runtimeId)
              return fail('终端身份已经改变，请重新选择会话。');
            observer = start('observe');
            if (!prepared) prepared = startDirect('pending');
          }
        });
        return;
      }
      if (message?.type === 'terminal.history.request') {
        const requestId = message.requestId;
        if (
          typeof requestId !== 'string' ||
          !/^[\w:-]{1,80}$/.test(requestId) ||
          historyRequests.has(requestId)
        )
          return;
        historyRequests.add(requestId);
        if (historyRequests.size > 32)
          historyRequests.delete(historyRequests.values().next().value);
        if (historyReading || nativeHistory) {
          notify({ type: 'terminal.history', requestId, available: false });
          return;
        }
        historyReading = true;
        void (async () => {
          try {
            if (nativeState) {
              const range = message.range;
              if (
                !range ||
                !Number.isSafeInteger(range.start) ||
                range.start < 0 ||
                !Number.isSafeInteger(range.limit) ||
                range.limit < 1 ||
                range.limit > 256 ||
                !Number.isSafeInteger(range.history_epoch) ||
                typeof range.boot_id !== 'string' ||
                !Number.isSafeInteger(range.revision)
              )
                throw new Error('Invalid history range');
              const content = await herdr.request('terminal.history.read', {
                ...range,
                terminal_id: terminalId,
              });
              if (!stopped) {
                // History shares the terminal's bounded output credit and fair
                // scheduling, so a background read cannot bypass backpressure.
                nativeHistory = Buffer.from(
                  JSON.stringify({ type: 'terminal_history', requestId, ...content }) + '\n',
                );
                flushNative();
              }
              return;
            }
            const sameTarget = async () => {
              const snapshot = herdr.normalizeSnapshot(await herdr.snapshot());
              return (
                snapshot.runtimeId === runtimeId &&
                snapshot.panes.some(
                  (pane) => pane.paneId === paneId && pane.terminalId === terminalId,
                )
              );
            };
            if (!(await sameTarget())) {
              notify({ type: 'terminal.history', requestId, available: false });
              return;
            }
            const [text, visible] = await Promise.all(
              ['recent', 'visible'].map((source) =>
                herdr.readPane(paneId, { source, lines: 200, ansi: true, exact: true }),
              ),
            );
            if (stopped) return;
            if (!(await sameTarget())) {
              notify({ type: 'terminal.history', requestId, available: false });
              return;
            }
            notify(
              typeof text === 'string' &&
                typeof visible === 'string' &&
                Buffer.byteLength(text) <= 1024 * 1024 &&
                Buffer.byteLength(visible) <= 1024 * 1024
                ? { type: 'terminal.history', requestId, available: true, text, visible }
                : { type: 'terminal.history', requestId, available: false },
            );
          } catch {
            if (!stopped) notify({ type: 'terminal.history', requestId, available: false });
          } finally {
            historyReading = false;
          }
        })();
        return;
      }
      if (message?.type === 'terminal.focus' && typeof message.focused === 'boolean') {
        if (message.focused)
          enqueue(1, async () => {
            if (typeof message.composing === 'boolean') composing = message.composing;
            // Browser focus, reconnect and visibility are not input intent.
            if (composing && visible)
              await acquire(
                () => !persistent || (ws.foreground && ws.controlSelection === message.selectionId),
              );
            if (controller) armRelease();
          });
        else enqueue(1, release);
        return;
      }
      if (message?.type === 'terminal.resize') {
        const nextCols = clampInt(message.cols, 20, 400, cols),
          nextRows = clampInt(message.rows, 5, 200, rows);
        if (nextCols === cols && nextRows === rows) return;
        const widthChanged = nextCols !== cols;
        cols = nextCols;
        rows = nextRows;
        enqueue(1, async () => {
          const command = { type: 'terminal.resize', cols, rows };
          if (direct) {
            if (controller && (!persistent || ws.foreground))
              (await acquire()).session.write(command);
            if (!nativeState && widthChanged && observer) {
              const current = observer;
              await current.pending;
              if (!stopped && !current.stopped) current.session.write({ ...command, rows: 200 });
            }
          } else if (controller && (!persistent || ws.foreground))
            (await acquire()).child.stdin.write(JSON.stringify(command) + '\n');
          else if (widthChanged) {
            await end(observer);
            if (!stopped) observer = start('observe');
          }
        });
        return;
      }
      let command;
      if (
        semanticInput &&
        message?.type === 'terminal.key' &&
        validKey(message.key) &&
        ['press', 'repeat', 'release'].includes(message.kind) &&
        Number.isInteger(message.modifiers) &&
        message.modifiers >= 0 &&
        message.modifiers <= 15 &&
        (message.shiftedCodepoint == null ||
          (Number.isInteger(message.shiftedCodepoint) &&
            message.shiftedCodepoint >= 0 &&
            message.shiftedCodepoint <= 0x10ffff)) &&
        (message.text == null ||
          (typeof message.text === 'string' && Buffer.byteLength(message.text) <= 16))
      )
        command = {
          type: 'terminal.key',
          paneId,
          key: message.key,
          modifiers: message.modifiers,
          kind: message.kind,
          shiftedCodepoint: message.shiftedCodepoint ?? null,
          text: message.text ?? null,
        };
      if (
        message?.type === 'terminal.input' &&
        typeof message.data === 'string' &&
        Buffer.byteLength(message.data) <= maxInputBytes
      )
        command = { type: 'terminal.input', text: message.data };
      if (message?.type === 'terminal.scroll' && ['up', 'down'].includes(message.direction))
        command = {
          type: 'terminal.scroll',
          direction: message.direction,
          lines: clampInt(message.lines, 1, 100, 3),
          source: message.source === 'page_key' ? 'page_key' : 'wheel',
          column: clampInt(message.column, 0, 399, 0),
          row: clampInt(message.row, 0, 199, 0),
          modifiers: clampInt(message.modifiers, 0, 7, 0),
        };
      if (
        message?.type === 'terminal.mouse' &&
        ['down', 'up', 'drag', 'move'].includes(message.action) &&
        ['left', 'middle', 'right'].includes(message.button) &&
        Number.isInteger(message.column) &&
        message.column >= 0 &&
        message.column < 400 &&
        Number.isInteger(message.row) &&
        message.row >= 0 &&
        message.row < 200
      )
        command = {
          type: 'terminal.mouse',
          action: message.action,
          button: message.button,
          column: message.column,
          row: message.row,
          modifiers: clampInt(message.modifiers, 0, 7, 0),
        };
      if (command) {
        const currentInput = () =>
          !persistent || (ws.foreground && ws.controlSelection === message.selectionId);
        // Herdr consumes one wheel event per command in mouse/alternate modes;
        // batch touch steps over the wire, then preserve their native distance.
        const steps =
          command.type === 'terminal.scroll' && message.source === 'touch' ? command.lines : 1;
        const native = steps > 1 ? { ...command, lines: 1 } : command;
        const data = (JSON.stringify(native) + '\n').repeat(steps);
        enqueue(Buffer.byteLength(data), async () => {
          if (!currentInput()) return;
          if (!visible) return;
          if (command.type === 'terminal.mouse' && command.action === 'move' && !controller) return;
          const entry = await acquire(currentInput);
          if (stopped || !entry || entry.stopped || !currentInput()) return;
          if ((entry.session || entry.child.stdin).writableLength > maxInputBytes * 2)
            return fail('终端输入繁忙，请重新连接；未重发按键。');
          if (entry.session) entry.session.write(native, steps);
          else entry.child.stdin.write(data); // Each accepted operation is written once; failures are never replayed.
          if (command.type === 'terminal.mouse' && ['down', 'up'].includes(command.action))
            pointerDown = command.action === 'down';
          armRelease();
        });
      }
    });
  } catch (error) {
    const recoverable = error.code !== 'TERMINAL_IDENTITY_CHANGED';
    notify({
      type: 'terminal.error',
      message: recoverable ? '终端连接暂不可用，正在恢复。' : error.message,
      recoverable,
    });
    ws.close(
      recoverable ? 1013 : 1008,
      recoverable ? 'shell transport unavailable' : 'shell binding rejected',
    );
  }
}
module.exports = { attachShellTerminal };
