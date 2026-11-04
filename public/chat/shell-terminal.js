(function (root) {
  'use strict';
  let assets;
  function loadAssets(path) {
    if (assets) return assets;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = path('/vendor/xterm/xterm.css');
    document.head.append(css);
    const script = (src) =>
      new Promise((resolve, reject) => {
        const node = document.createElement('script');
        node.src = path(src);
        node.onload = resolve;
        node.onerror = () => {
          node.remove();
          reject(new Error('终端组件加载失败，请重试。'));
        };
        document.head.append(node);
      });
    assets = script('/vendor/xterm/xterm.js')
      .then(() => script('/vendor/xterm/addon-fit.js'))
      .then(() => script('/vendor/xterm/addon-web-links.js'))
      .catch((error) => {
        assets = null;
        throw error;
      });
    return assets;
  }
  function create(options) {
    const { host, getRootDirectory } = options,
      sessions = new Map();
    let active = null,
      scope = '',
      channel;
    function stop() {
      for (const session of sessions.values()) session.surface.dispose();
      channel?.dispose();
      channel = null;
      sessions.clear();
      active = null;
      host.replaceChildren();
      host.hidden = true;
    }
    function update(pane, runtimeId, enabled) {
      const channelVersion = options.getChannelVersion?.() || 0;
      const sharedChannel = channelVersion >= 1;
      const nextScope = JSON.stringify([
        getRootDirectory?.() || '',
        runtimeId || '',
        channelVersion,
      ]);
      if (runtimeId && scope && nextScope !== scope) stop();
      if (runtimeId) scope = nextScope;
      const key =
        enabled && runtimeId && pane?.terminalId
          ? JSON.stringify([runtimeId, pane.paneId, pane.terminalId])
          : '';
      if (active?.key !== key) {
        active?.surface.suspend();
        active?.host.remove();
        active = null;
      }
      host.hidden = !key;
      if (!key) return;
      if (sharedChannel && !channel) channel = root.StudioTerminalChannel.create(options);
      let session = sessions.get(key);
      if (!session) {
        const container = document.createElement('div');
        container.className = 'shell-terminal-session';
        session = {
          key,
          host: container,
          surface: createSurface({ ...options, host: container, channel }),
        };
      }
      sessions.delete(key);
      sessions.set(key, session);
      if (active !== session) {
        host.replaceChildren(session.host);
        active = session;
      }
      session.surface.update(pane, runtimeId, true);
      // Multiplexed subscriptions parse in the background without painting.
      // Retain the working set; eviction closes its native subscription.
      const limit =
        sharedChannel || [...sessions.values()].some((entry) => entry.surface.canSuspend())
          ? 64
          : 6;
      while (sessions.size > limit) {
        const [oldest, entry] = sessions.entries().next().value;
        entry.surface.dispose();
        sessions.delete(oldest);
      }
    }
    root.addEventListener('pagehide', stop);
    return { update, stop, focus: () => active?.surface.focus(), active: () => Boolean(active) };
  }
  function createSurface({
    host,
    appPath,
    socketUrl,
    copyText,
    uploadClipboardFile,
    getRootDirectory,
    channel,
  }) {
    const shortSide = Math.min(
      root.screen?.width || root.innerWidth,
      root.screen?.height || root.innerHeight,
    );
    const phone = root.matchMedia('(pointer: coarse)').matches && shortSide < 600;
    const canvas = document.createElement('div');
    canvas.className = 'shell-terminal-canvas';
    canvas.setAttribute('role', 'region');
    canvas.setAttribute('aria-label', '会话交互终端');
    canvas.setAttribute('aria-busy', 'true');
    const keys = document.createElement('div');
    keys.className = 'shell-terminal-keys';
    keys.setAttribute('role', 'toolbar');
    keys.setAttribute('aria-label', '原生终端按键');
    const keyScroll = document.createElement('div');
    keyScroll.className = 'shell-terminal-key-scroll';
    const keyFixed = document.createElement('div');
    keyFixed.className = 'shell-terminal-key-fixed';
    keys.append(keyScroll, keyFixed);
    for (const [name, label, path] of [
      ['up', '上方向键', 'm6 11 6-6 6 6M12 5v14'],
      ['down', '下方向键', 'm6 13 6 6 6-6M12 5v14'],
      ['left', '左方向键', 'm11 6-6 6 6 6M5 12h14'],
      ['right', '右方向键', 'm13 6 6 6-6 6M5 12h14'],
      ['tab', 'Tab'],
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
      ['4', '4'],
      ['5', '5'],
      ['backspace', '退格'],
      ['esc', 'Esc'],
      ['enter', 'Enter'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.terminalKey = name;
      button.disabled = true;
      button.setAttribute('aria-label', label);
      button.title = label;
      if (path)
        button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`;
      else button.textContent = label;
      button.onpointerdown = (event) => event.preventDefault();
      button.onclick = () => sendKey(name);
      (['esc', 'enter'].includes(name) ? keyFixed : keyScroll).append(button);
    }
    const combos = document.createElement('div');
    combos.className = 'shell-terminal-combos';
    combos.setAttribute('role', 'toolbar');
    combos.setAttribute('aria-label', '终端组合快捷键');
    for (const [name, value, key, modifiers] of [
      ['Ctrl+C', '\x03', 'c', 2],
      ['Shift+Tab', '\x1b[Z', 'Tab', 1],
      ['Alt+↑', '\x1b[1;3A', 'ArrowUp', 4],
      ['Shift+↑', '\x1b[1;2A', 'ArrowUp', 1],
      ['Ctrl+A', '\x01', 'a', 2],
      ['Ctrl+E', '\x05', 'e', 2],
      ['Ctrl+L', '\x0c', 'l', 2],
      ['Ctrl+D', '\x04', 'd', 2],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.disabled = true;
      button.setAttribute('aria-label', name);
      button.onpointerdown = (event) => event.preventDefault();
      button.onclick = () => {
        if (!sendShortcut(key, modifiers)) sendInput(value);
        closeCombos();
      };
      combos.append(button);
    }
    combos.hidden = true;
    const toggleCombos = document.createElement('button');
    toggleCombos.type = 'button';
    toggleCombos.textContent = '组合';
    toggleCombos.setAttribute('aria-label', '组合键');
    toggleCombos.setAttribute('aria-expanded', 'false');
    toggleCombos.onpointerdown = (event) => event.preventDefault();
    toggleCombos.onclick = () => {
      combos.hidden = !combos.hidden;
      toggleCombos.setAttribute('aria-expanded', String(!combos.hidden));
    };
    keyFixed.prepend(toggleCombos);
    function closeCombos() {
      combos.hidden = true;
      toggleCombos.setAttribute('aria-expanded', 'false');
    }
    const deck = document.createElement('div');
    deck.className = 'shell-terminal-deck';
    deck.append(combos, keys);
    deck.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.isComposing && !combos.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeCombos();
      }
    });
    host.append(canvas, deck);
    canvas.addEventListener('pointerdown', closeCombos);
    let identity = '',
      generation = 0,
      terminal,
      fit,
      socket,
      ready = false,
      binding,
      dimensions = '',
      cleanup,
      themeKey = '',
      focusRequested = false,
      suspendable = false;
    let redraw = () => {},
      deactivate = () => {},
      sendShortcut = () => false,
      nativeGeometry,
      resizeFrame = 0;
    function syncControls() {
      for (const button of [...keys.querySelectorAll('button'), ...combos.children])
        button.disabled = !ready;
    }
    function sendInput(data) {
      if (!ready || !socket?.isOpen() || !binding || host.hidden || document.hidden) return false;
      return socket.send({ type: 'terminal.input', data });
    }
    function focusChanged(focused, composing = false) {
      if (focused && host.hidden) return;
      if (ready && socket?.isOpen())
        socket.send({
          type: 'terminal.focus',
          focused: Boolean(focused && !document.hidden && document.hasFocus()),
          composing,
        });
    }
    const onBlur = () => focusChanged(false);
    const onFocus = () => {
      if (canvas.contains(document.activeElement)) focusChanged(true);
    };
    function visibilityChanged() {
      if (socket?.setVisible) {
        socket.setVisible(!host.hidden && !document.hidden);
        return;
      }
      if (suspendable && ready && socket?.isOpen())
        socket.send({ type: 'terminal.visibility', visible: !host.hidden && !document.hidden });
    }
    const onVisibility = () => {
      if (document.hidden) focusChanged(false);
      visibilityChanged();
      if (!document.hidden) redraw();
    };
    root.addEventListener('blur', onBlur);
    root.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('focusin', () => focusChanged(true));
    function sendKey(name) {
      if (!ready || !socket?.isOpen() || !binding || host.hidden || document.hidden) return;
      const key =
        {
          up: 'ArrowUp',
          down: 'ArrowDown',
          left: 'ArrowLeft',
          right: 'ArrowRight',
          enter: 'Enter',
          esc: 'Escape',
          tab: 'Tab',
          backspace: 'Backspace',
        }[name] || name;
      if (sendShortcut(key, 0)) return;
      const arrow = { up: 'A', down: 'B', right: 'C', left: 'D' }[name];
      const data = arrow
        ? '\x1b' + (terminal?.modes.applicationCursorKeysMode ? 'O' : '[') + arrow
        : {
            enter: '\r',
            esc: '\x1b',
            tab: '\t',
            backspace: '\x7f',
            1: '1',
            2: '2',
            3: '3',
            4: '4',
            5: '5',
          }[name];
      if (data) sendInput(data);
    }
    function stop() {
      generation++;
      ready = false;
      suspendable = false;
      dimensions = '';
      themeKey = '';
      focusRequested = false;
      redraw = () => {};
      sendShortcut = () => false;
      nativeGeometry = null;
      if (resizeFrame) {
        root.cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
      }
      closeCombos();
      syncControls();
      cleanup?.();
      cleanup = null;
      socket?.disconnect('leave shell');
      socket = null;
      terminal?.dispose();
      terminal = null;
      canvas.replaceChildren();
    }
    function resize() {
      if (!terminal || host.hidden || !canvas.clientWidth || !canvas.clientHeight) return;
      const before = `${terminal.cols}:${terminal.rows}`;
      fit.fit();
      const screen = canvas.querySelector('.xterm-screen');
      canvas.style.setProperty('--terminal-screen-width', `${screen.clientWidth}px`);
      canvas.style.setProperty('--terminal-screen-height', `${screen.clientHeight}px`);
      const key = `${terminal.cols}:${terminal.rows}`;
      if (key !== before) redraw();
      if (ready && key !== dimensions) {
        dimensions = key;
        socket.send({ type: 'terminal.resize', cols: terminal.cols, rows: terminal.rows });
      }
    }
    function scheduleResize() {
      if (resizeFrame) return;
      resizeFrame = root.requestAnimationFrame(() => {
        resizeFrame = 0;
        resize();
      });
    }
    function theme() {
      if (!terminal || host.hidden || !host.isConnected) return;
      const style = getComputedStyle(host);
      const nextTheme = {
        background: style.getPropertyValue('--bg').trim(),
        foreground: style.getPropertyValue('--text').trim(),
        cursor: style.getPropertyValue('--text').trim(),
        cursorAccent: style.getPropertyValue('--bg').trim(),
        selectionBackground: style.getPropertyValue('--selection').trim(),
        selectionForeground: style.getPropertyValue('--text').trim(),
      };
      for (const name of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
        nextTheme[name] = style.getPropertyValue(`--terminal-${name}`).trim();
        nextTheme['bright' + name[0].toUpperCase() + name.slice(1)] = style
          .getPropertyValue(`--terminal-bright-${name}`)
          .trim();
      }
      const fontSize =
        (root.StudioTerminalFont?.current() || (phone ? 11.5 : 14)) *
        (parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--device-font-scale'),
        ) || 1);
      const key = JSON.stringify([nextTheme, fontSize]);
      if (key === themeKey) return;
      themeKey = key;
      terminal.options.theme = nextTheme;
      if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize;
      resize();
    }
    async function connect() {
      stop();
      const mine = generation;
      try {
        await Promise.all([
          loadAssets(appPath),
          document.fonts.load('14px "Cascadia Mono"').catch(() => {}),
        ]);
        if (mine !== generation || host.hidden) return;
        terminal = new root.Terminal({
          allowTransparency: false,
          fontFamily:
            '"Cascadia Mono", "Swift Terminal CJK", ui-monospace, Consolas, monospace, ' +
            getComputedStyle(host).fontFamily,
          fontSize: 14,
          lineHeight: 1.2,
          fontWeightBold: 'normal',
          minimumContrastRatio: 4.5,
          cursorBlink: false,
          scrollback: phone ? 0 : 2000,
          convertEol: false,
          allowProposedApi: false,
        });
        fit = new root.FitAddon.FitAddon();
        terminal.loadAddon(fit);
        terminal.open(canvas);
        // Phone history comes from the native terminal. Its display buffer must
        // not reflow old frames into the viewport during a local resize.
        if (phone) terminal.write('\x1b[?1049h');
        theme();
        // On phones the visible editor is the only text input. xterm's hidden
        // textarea must not reopen the system keyboard when the screen is tapped.
        const term = terminal;
        let painting = Promise.resolve(),
          parsing = Promise.resolve(),
          gesture,
          fullPending = false,
          firstReady = true,
          redrawPending = false,
          repaintNeeded = false;
        let renderer = null,
          rendererFormat = '',
          parserStream = null,
          semanticInput = false;
        const keyboard = root.StudioTerminalKeyboard?.create();
        const historyAttempts = new Map();
        let historyTimer = 0,
          historyPending = null,
          historySerial = 0,
          historyAt = 0;
        function requestHistory() {
          if (mine !== generation || !ready || !socket?.isOpen() || host.hidden || document.hidden)
            return;
          if (!renderer) return;
          const range = rendererFormat === 'cells-v1' ? renderer.historyRequest() : null;
          const key =
            rendererFormat === 'cells-v1'
              ? range && `${range.history_epoch}:${range.start}:${range.limit}`
              : renderer.historyKey();
          if (!key || (historyAttempts.get(key) || 0) >= 2 || historyPending) return;
          const delay =
            rendererFormat === 'cells-v1' ? 0 : Math.max(0, historyAt + 1000 - Date.now());
          if (delay) {
            if (!historyTimer)
              historyTimer = setTimeout(() => {
                historyTimer = 0;
                requestHistory();
              }, delay);
            return;
          }
          historyAt = Date.now();
          historyAttempts.set(key, (historyAttempts.get(key) || 0) + 1);
          if (historyAttempts.size > 32)
            historyAttempts.delete(historyAttempts.keys().next().value);
          historyPending = {
            key,
            requestId: `history-${mine}-${socket.generation}-${++historySerial}`,
          };
          socket.send({
            type: 'terminal.history.request',
            requestId: historyPending.requestId,
            ...(range ? { range } : {}),
          });
        }
        redraw = () => {
          repaintNeeded = true;
          if (redrawPending || mine !== generation || host.hidden || document.hidden) return;
          // xterm schedules the visible animation frame. Queue the latest parsed
          // state now, without adding another frame of latency before its writer.
          redrawPending = true;
          const parsed = parsing,
            stream = socket?.generation;
          painting = painting
            .then(async () => {
              await parsed;
              if (
                mine !== generation ||
                stream !== socket?.generation ||
                host.hidden ||
                document.hidden
              )
                return;
              repaintNeeded = false;
              const cells = renderer?.render({ cols: term.cols, rows: term.rows });
              if (cells) await new Promise((resolve) => term.write(cells, resolve));
              if (mine === generation && stream === socket?.generation && ready) {
                canvas.setAttribute('aria-busy', 'false');
                canvas.setAttribute('aria-label', '会话交互终端，已连接');
                requestHistory();
              }
            })
            .finally(() => {
              if (stream === socket?.generation) {
                redrawPending = false;
                if (repaintNeeded) redraw();
              }
            });
        };
        term.loadAddon(
          new root.WebLinksAddon.WebLinksAddon((event, uri) => {
            if (event.ctrlKey || event.metaKey) root.open(uri, '_blank', 'noopener,noreferrer');
          }),
        );
        socket = (channel || root.StudioSocket)[channel ? 'createSocket' : 'create']({
          url: () => {
            const url = socketUrl();
            url.searchParams.delete('observe');
            url.searchParams.delete('screen');
            for (const [key, value] of Object.entries({
              shell: '1',
              pane: binding.paneId,
              terminalId: binding.terminalId,
              runtimeId: binding.runtimeId,
              cols: term.cols,
              rows: term.rows,
            }))
              url.searchParams.set(key, value);
            url.searchParams.set('retainControl', '1');
            url.searchParams.set('stateFormat', 'cells-v1');
            return url;
          },
          onBinary: (bytes) => {
            const full = fullPending,
              geometry = nativeGeometry,
              stream = socket.generation;
            fullPending = false;
            // Parse every byte in order, independently of the visible writer.
            // A burst can then paint the latest complete state instead of
            // serially displaying every intermediate native redraw.
            const parsed = (parsing = parsing.then(() => {
              if (mine !== generation || stream !== socket?.generation) return;
              if (rendererFormat === 'cells-v1') {
                const received = renderer.write(bytes);
                if (received?.includes(historyPending?.requestId)) historyPending = null;
                return;
              }
              return renderer.write(bytes, {
                full,
                cols: geometry?.cols || term.cols,
                rows: geometry?.rows || term.rows,
                viewportCols: term.cols,
                viewportRows: term.rows,
                render: false,
              });
            }));
            // Acknowledge parsed state, independently of display refresh. Many
            // native frames arriving together need only one visible redraw.
            return parsed.then(() => redraw());
          },
          onMessage: (message) => {
            if (mine !== generation) return;
            if (
              message.type === 'terminal.history' &&
              message.requestId === historyPending?.requestId
            ) {
              const pending = historyPending,
                stream = socket.generation;
              if (!message.available) {
                historyPending = null;
                historyAttempts.set(pending.key, 2);
                return;
              }
              // Prepare history independently; an old read must never hold up
              // the current echo or write a frame computed before newer output.
              const current = () =>
                mine === generation &&
                stream === socket?.generation &&
                historyPending === pending &&
                !host.hidden &&
                !document.hidden;
              void renderer
                .history(message.text, pending.key, message.visible, { render: false, current })
                .catch(() => {
                  if (current()) historyAttempts.set(pending.key, 2);
                })
                .finally(() => {
                  const active = current();
                  if (historyPending === pending) historyPending = null;
                  if (active) redraw();
                });
            }
            if (
              message.type === 'terminal.geometry' &&
              Number.isInteger(message.cols) &&
              message.cols > 0 &&
              message.cols <= 400 &&
              Number.isInteger(message.rows) &&
              message.rows > 0 &&
              message.rows <= 200
            )
              nativeGeometry = { cols: message.cols, rows: message.rows };
            if (message.type === 'terminal.full') {
              if (renderer && parserStream !== null && parserStream !== socket.generation) {
                renderer = renderer.restart();
                parsing = Promise.resolve();
                painting = Promise.resolve();
                redrawPending = false;
                repaintNeeded = false;
              }
              parserStream = socket.generation;
              fullPending = true;
            }
            if (message.type === 'terminal.ready') {
              const format = message.stateFormat === 'cells-v1' ? 'cells-v1' : 'ansi';
              if (!renderer || rendererFormat !== format) {
                renderer?.dispose();
                rendererFormat = format;
                term.options.scrollback = format === 'cells-v1' || phone ? 0 : 2000;
                renderer =
                  format === 'cells-v1'
                    ? root.StudioTerminalStateRenderer.create({
                        terminalId: binding.terminalId,
                        adaptNativeColors: true,
                      })
                    : root.StudioTerminalRenderer.create({
                        Terminal: root.Terminal,
                        cols: term.cols,
                        rows: term.rows,
                        adaptNativeColors: true,
                      });
              }
              semanticInput = message.semanticInput === true && Boolean(keyboard);
              ready = true;
              suspendable = message.suspendable === true;
              visibilityChanged();
              dimensions = '';
              resize();
              syncControls();
              // Initial desktop entry may place the local caret. Recovery never
              // does; neither path grants native control without real input.
              if (
                !host.hidden &&
                (focusRequested ||
                  (firstReady && matchMedia('(hover: hover) and (pointer: fine)').matches)) &&
                !document.hidden &&
                document.hasFocus() &&
                (!document.activeElement?.matches('input, textarea, select') ||
                  canvas.contains(document.activeElement))
              )
                term.focus();
              focusRequested = false;
              firstReady = false;
            }
            if (message.type === 'terminal.error') {
              ready = false;
              canvas.setAttribute('aria-busy', 'true');
              canvas.setAttribute('aria-label', '会话交互终端，连接不可用');
              syncControls();
            }
          },
          onState: (kind) => {
            if (mine !== generation) return;
            if (kind !== 'connected') {
              gesture = null;
              pressed = null;
              selecting = null;
              selectionGesture = false;
              ready = false;
              dimensions = '';
              fullPending = false;
              keyboard?.clear();
              clearTimeout(historyTimer);
              historyTimer = 0;
              historyPending = null;
              historyAttempts.clear();
              canvas.setAttribute('aria-busy', 'true');
              canvas.setAttribute('aria-label', '会话交互终端，连接恢复中');
              syncControls();
            }
          },
        });
        sendShortcut = (key, modifiers) => {
          if (!semanticInput || !ready || !socket?.isOpen() || host.hidden || document.hidden)
            return false;
          const command = {
            type: 'terminal.key',
            key,
            modifiers,
            shiftedCodepoint: null,
            kind: 'press',
            text: [...key].length === 1 && !modifiers ? key : null,
          };
          renderer.toBottom();
          redraw();
          if (!socket.send(command)) return false;
          socket.send({ ...command, kind: 'release', text: null });
          return true;
        };
        const selectedText = () =>
          renderer?.selectionText?.(term.getSelectionPosition()) ?? term.getSelection();
        const copySelection = () => {
          const text = selectedText();
          if (!text) return;
          if (copyText) copyText(text);
          else root.navigator.clipboard?.writeText(text).catch(() => {});
        };
        const copy = (event) => {
          if (rendererFormat !== 'cells-v1' || !term.hasSelection() || !event.clipboardData) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          event.clipboardData.setData('text/plain', selectedText());
        };
        canvas.addEventListener('copy', copy, true);
        let pasteQueue = Promise.resolve();
        const enqueuePaste = (load) => {
          const target = { ...binding },
            rootDirectory = getRootDirectory?.();
          const current = () =>
            mine === generation &&
            ready &&
            socket?.isOpen() &&
            rootDirectory === getRootDirectory?.() &&
            Object.keys(target).every((key) => target[key] === binding[key]);
          pasteQueue = pasteQueue
            .then(async () => {
              if (!current()) return;
              const { files = [], text = '' } = await load();
              const paths = [];
              for (const file of files) {
                if (!current()) return;
                if (file.size > 20 * 1024 * 1024) throw new Error('剪贴板文件超过 20 MiB。');
                if (!uploadClipboardFile) throw new Error('当前连接不支持图片粘贴。');
                const attachment = await uploadClipboardFile(file, target);
                if (!current()) return;
                if (!attachment?.path || typeof attachment.path !== 'string')
                  throw new Error('图片上传结果无效，请重新粘贴。');
                paths.push(attachment.path);
              }
              if (current()) {
                const value = [text, ...paths].filter(Boolean).join('\n');
                if (value) term.paste(value);
              }
            })
            .catch(() => {});
        };
        const pasteClipboard = () => {
          if (!ready) return;
          // Start reading during the user's gesture, before asynchronous uploads.
          const reading = (async () => {
            if (root.navigator.clipboard?.read) {
              try {
                const items = await root.navigator.clipboard.read(),
                  files = [];
                let text = '';
                for (const item of items) {
                  const mime = item.types.find((type) =>
                    /^image\/(png|jpeg|gif|webp|bmp)$/.test(type),
                  );
                  if (mime)
                    files.push(
                      new File([await item.getType(mime)], `clipboard.${mime.split('/')[1]}`, {
                        type: mime,
                      }),
                    );
                  else if (item.types.includes('text/plain'))
                    text += await (await item.getType('text/plain')).text();
                }
                return { files, text };
              } catch {
                /* Text clipboard may be allowed independently of image reads. */
              }
            }
            if (!root.navigator.clipboard?.readText)
              throw new Error('无法读取剪贴板，请使用 Ctrl+V。');
            return { text: await root.navigator.clipboard.readText() };
          })();
          // Handle a rejected read even if switching Pane cancels this queued paste.
          reading.catch(() => {});
          enqueuePaste(() => reading);
        };
        const paste = (event) => {
          if (!ready || composition.classList.contains('active')) return;
          const data = event.clipboardData;
          let files = [...(data?.files || [])];
          if (!files.length)
            files = [...(data?.items || [])]
              .filter((item) => item.kind === 'file')
              .map((item) => item.getAsFile())
              .filter(Boolean);
          if (!files.length) return; // Keep xterm's native text paste and bracketed paste.
          event.preventDefault();
          event.stopImmediatePropagation();
          const text = data.getData('text/plain');
          enqueuePaste(() => ({ files, text }));
        };
        const rightPaste = (event) => {
          if (!event.shiftKey || event.button !== 2) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          term.focus();
          pasteClipboard();
        };
        const pasteMenu = (event) => {
          if (event.shiftKey) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        };
        canvas.addEventListener('paste', paste, true);
        canvas.addEventListener('mousedown', rightPaste, true);
        canvas.addEventListener('contextmenu', pasteMenu, true);
        term.onData((data) => {
          if (rendererFormat === 'cells-v1') {
            renderer.toBottom();
            redraw();
          }
          sendInput(data);
        });
        function scroll(command, forceLocal = false) {
          if (
            rendererFormat === 'cells-v1' &&
            renderer.scroll(command.direction, command.lines, command.source, forceLocal)
          ) {
            redraw();
            requestHistory();
            return;
          }
          if (ready) socket.send(command);
        }
        term.attachCustomKeyEventHandler((event) => {
          // The platform owns candidate navigation and confirmation while composing.
          // 229 can carry ordinary English text from a mobile IME. xterm must
          // see it to coordinate input events with its textarea fallback.
          if (event.keyCode === 229) return true;
          if (event.isComposing || composition.classList.contains('active')) return false;
          if (semanticInput && ready && event.type === 'keyup') {
            const release = keyboard.event(event);
            if (release) {
              event.preventDefault();
              socket.send(release);
              return false;
            }
          }
          const remotePageKey =
            semanticInput &&
            !event.shiftKey &&
            (renderer.state?.mouse_tracking || renderer.state?.alternate_screen);
          if (
            ['PageUp', 'PageDown'].includes(event.key) &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !remotePageKey
          ) {
            if (event.type === 'keydown')
              scroll(
                {
                  type: 'terminal.scroll',
                  source: 'page_key',
                  direction: event.key === 'PageUp' ? 'up' : 'down',
                  lines: Math.max(1, term.rows - 1),
                },
                event.shiftKey,
              );
            event.preventDefault();
            return false;
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            event.key.toLowerCase() === 'v'
          ) {
            if (event.shiftKey) {
              event.preventDefault();
              if (event.type === 'keydown') pasteClipboard();
            }
            // Ctrl+V stays a browser paste gesture, including image clipboard data.
            return false;
          }
          if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
            event.preventDefault();
            if (event.type === 'keydown') copySelection();
            return false;
          }
          if (semanticInput && ready) {
            const command = keyboard.event(event);
            if (command) {
              event.preventDefault();
              if (command.kind !== 'release') {
                renderer.toBottom();
                redraw();
              }
              socket.send(command);
              return false;
            }
          }
          return true;
        });
        // Herdr sends rendered ANSI cells, not the application's DEC mouse modes.
        // Send semantic cell events and let Herdr encode them for the actual app.
        // Capture wheel before xterm's inner viewport can consume it.
        const screen = canvas.querySelector('.xterm-screen');
        const modifiers = (event) =>
          (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0);
        const position = (event) => {
          const box = screen.getBoundingClientRect();
          return {
            column: Math.max(
              0,
              Math.min(
                term.cols - 1,
                Math.floor(((event.clientX - box.left) * term.cols) / box.width),
              ),
            ),
            row: Math.max(
              0,
              Math.min(
                term.rows - 1,
                Math.floor(((event.clientY - box.top) * term.rows) / box.height),
              ),
            ),
          };
        };
        const wheel = (event) => {
          if (
            (!ready && rendererFormat !== 'cells-v1') ||
            host.hidden ||
            event.ctrlKey ||
            !event.deltaY ||
            Math.abs(event.deltaX) > Math.abs(event.deltaY)
          )
            return;
          const pixels =
            event.deltaY *
            (event.deltaMode === 1
              ? screen.clientHeight / term.rows
              : event.deltaMode === 2
                ? screen.clientHeight
                : 1);
          scroll(
            {
              type: 'terminal.scroll',
              source: 'wheel',
              direction: pixels < 0 ? 'up' : 'down',
              lines: Math.min(
                100,
                Math.max(1, Math.ceil(Math.abs(pixels) / (screen.clientHeight / term.rows))),
              ),
              ...position(event),
              modifiers: modifiers(event),
            },
            event.shiftKey,
          );
          event.preventDefault();
          event.stopImmediatePropagation();
        };
        canvas.addEventListener('wheel', wheel, { capture: true, passive: false });
        const composition = canvas.querySelector('.composition-view'),
          input = term.textarea;
        // Keep the system IME at the starting cursor while native output moves.
        // Preedit text belongs to the IME; only xterm's finalizer submits it.
        const startComposition = () => {
          const cellWidth = screen.clientWidth / term.cols,
            cellHeight = screen.clientHeight / term.rows;
          canvas.style.setProperty(
            '--terminal-composition-top',
            `${term.buffer.active.cursorY * cellHeight}px`,
          );
          canvas.style.setProperty(
            '--terminal-composition-left',
            `${Math.min(term.cols - 1, term.buffer.active.cursorX) * cellWidth}px`,
          );
          canvas.style.setProperty('--terminal-cell-height', `${cellHeight}px`);
          canvas.classList.add('terminal-composing');
        };
        const endComposition = () => {
          canvas.classList.remove('terminal-composing');
        };
        const beginActivity = () => focusChanged(true, true),
          endActivity = () => focusChanged(true);
        input.addEventListener('compositionstart', beginActivity);
        input.addEventListener('compositionend', endActivity);
        input.addEventListener('compositionstart', startComposition);
        input.addEventListener('compositionend', endComposition);
        // Touch must scroll the native buffer, not xterm's empty local viewport.
        // Lock one axis per gesture; horizontal navigation continues to bubble.
        const touchStart = (event) => {
          gesture =
            ready && event.touches.length === 1 && root.getSelection()?.isCollapsed !== false
              ? {
                  id: event.touches[0].identifier,
                  x: event.touches[0].clientX,
                  y: event.touches[0].clientY,
                  lastY: event.touches[0].clientY,
                  remainder: 0,
                  axis: '',
                }
              : null;
        };
        const touchMove = (event) => {
          if (
            !ready ||
            !gesture ||
            event.touches.length !== 1 ||
            root.getSelection()?.isCollapsed === false
          ) {
            gesture = null;
            return;
          }
          const touch = event.touches[0];
          if (touch.identifier !== gesture.id) {
            gesture = null;
            return;
          }
          const dx = touch.clientX - gesture.x,
            dy = touch.clientY - gesture.y;
          if (!gesture.axis) {
            if (Math.abs(dx) >= 10 && Math.abs(dx) > Math.abs(dy) * 1.5) gesture.axis = 'x';
            else if (Math.abs(dy) >= 10 && Math.abs(dy) > Math.abs(dx) * 1.5) gesture.axis = 'y';
          }
          if (gesture.axis !== 'y') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          gesture.remainder += touch.clientY - gesture.lastY;
          gesture.lastY = touch.clientY;
          const cellHeight = screen.getBoundingClientRect().height / term.rows;
          const lines = Math.min(100, Math.floor(Math.abs(gesture.remainder) / cellHeight));
          if (!lines) return;
          const direction = gesture.remainder > 0 ? 'up' : 'down';
          gesture.remainder %= cellHeight;
          scroll({
            type: 'terminal.scroll',
            source: 'touch',
            direction,
            lines,
            ...position(touch),
            modifiers: 0,
          });
        };
        const touchEnd = () => {
          gesture = null;
        };
        canvas.addEventListener('touchstart', touchStart, { capture: true, passive: true });
        canvas.addEventListener('touchmove', touchMove, { capture: true, passive: false });
        canvas.addEventListener('touchend', touchEnd, { capture: true, passive: true });
        canvas.addEventListener('touchcancel', touchEnd, { capture: true, passive: true });
        let pressed = null,
          lastCell = '',
          selecting,
          selectionGesture = false;
        const mouse = (event) => {
          if (!ready || host.hidden) return;
          if (event.type === 'mousemove' && !document.hasFocus()) return;
          if (event.type === 'mousedown' && event.button === 0) selectionGesture = true;
          if (event.type === 'mousedown' && event.shiftKey && event.button === 0) {
            selecting = position(event);
            term.clearSelection();
            term.focus();
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (selecting) {
            const end = position(event),
              startIndex = selecting.row * term.cols + selecting.column,
              endIndex = end.row * term.cols + end.column;
            const first = Math.min(startIndex, endIndex);
            term.select(
              first % term.cols,
              Math.floor(first / term.cols),
              Math.abs(endIndex - startIndex),
            );
            if (event.type === 'mouseup') selecting = null;
            return;
          }
          if (event.shiftKey && event.type !== 'mouseup') return;
          if (rendererFormat === 'cells-v1' && !renderer.state?.mouse_tracking) return;
          const action =
            event.type === 'mousedown'
              ? 'down'
              : event.type === 'mouseup'
                ? 'up'
                : pressed === null
                  ? 'move'
                  : 'drag';
          if (action === 'down') pressed = event.button;
          const button =
            ['left', 'middle', 'right'][
              action === 'up' ? event.button : (pressed ?? event.button)
            ] || 'left';
          const cell = position(event),
            key = `${cell.column}:${cell.row}:${action}`;
          if ((action === 'move' || action === 'drag') && key === lastCell) return;
          lastCell = key;
          socket.send({
            type: 'terminal.mouse',
            action,
            button,
            ...cell,
            modifiers: modifiers(event),
          });
          if (action === 'up') pressed = null;
        };
        screen.addEventListener('mousedown', mouse);
        screen.addEventListener('mousemove', mouse);
        const release = (event) => {
          if (pressed !== null || selecting) {
            mouse(event);
            pressed = null;
          }
          if (event.button === 0 && selectionGesture) {
            selectionGesture = false;
            copySelection();
          }
        };
        document.addEventListener('mouseup', release);
        deactivate = () => {
          keyboard?.clear();
          gesture = null;
          pressed = null;
          selecting = null;
          selectionGesture = false;
          clearTimeout(historyTimer);
          historyTimer = 0;
          historyPending = null;
          historyAttempts.clear();
          endComposition();
          term.blur();
        };
        cleanup = () => {
          deactivate = () => {};
          clearTimeout(historyTimer);
          canvas.removeEventListener('copy', copy, true);
          canvas.removeEventListener('paste', paste, true);
          canvas.removeEventListener('mousedown', rightPaste, true);
          canvas.removeEventListener('contextmenu', pasteMenu, true);
          gesture = null;
          endComposition();
          renderer?.dispose();
          input.removeEventListener('compositionstart', startComposition);
          input.removeEventListener('compositionend', endComposition);
          input.removeEventListener('compositionstart', beginActivity);
          input.removeEventListener('compositionend', endActivity);
          canvas.removeEventListener('wheel', wheel, true);
          document.removeEventListener('mouseup', release);
          for (const [type, handler] of [
            ['touchstart', touchStart],
            ['touchmove', touchMove],
            ['touchend', touchEnd],
            ['touchcancel', touchEnd],
          ])
            canvas.removeEventListener(type, handler, true);
        };
        socket.connect();
      } catch {
        if (mine === generation) {
          canvas.setAttribute('aria-busy', 'true');
          canvas.setAttribute('aria-label', '会话交互终端，连接不可用');
          syncControls();
        }
      }
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const themeObserver = new MutationObserver(theme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    });
    root.addEventListener('resize', scheduleResize);
    function update(pane, runtimeId, enabled) {
      const key = pane?.terminalId ? JSON.stringify([runtimeId, pane.paneId, pane.terminalId]) : '';
      binding = pane?.terminalId
        ? {
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            runtimeId,
            sessionId: pane.agent?.session?.value || '',
          }
        : null;
      const returning = host.hidden;
      host.hidden = !enabled || !pane?.terminalId;
      if (key === identity) {
        if (returning && !host.hidden) {
          visibilityChanged();
          // The first visit can leave while assets are still loading.
          if (!terminal) {
            void connect();
            return;
          }
          theme();
          resize();
          redraw();
          if (
            ready &&
            matchMedia('(hover: hover) and (pointer: fine)').matches &&
            document.hasFocus() &&
            !document.activeElement?.matches('input, textarea, select')
          )
            terminal.focus();
        }
        return;
      }
      identity = key;
      stop();
      if (key) void connect();
    }
    function suspend() {
      host.hidden = true;
      focusChanged(false);
      visibilityChanged();
      closeCombos();
      deactivate();
    }
    function dispose() {
      identity = '';
      stop();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      root.removeEventListener('blur', onBlur);
      root.removeEventListener('focus', onFocus);
      root.removeEventListener('resize', scheduleResize);
      document.removeEventListener('visibilitychange', onVisibility);
      host.remove();
    }
    return {
      update,
      suspend,
      dispose,
      canSuspend: () => suspendable,
      focus: () => {
        if (ready && !host.hidden) terminal?.focus();
        else if (identity) focusRequested = true;
      },
    };
  }
  root.StudioShellTerminal = { create };
})(window);
