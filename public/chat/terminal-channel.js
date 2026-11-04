(function (root) {
  'use strict';
  function create({ socketUrl, getChannelVersion }) {
    if (getChannelVersion?.() >= 2) return createMultiplexer({ socketUrl });
    const views = new Set();
    let active = null,
      serial = 0,
      socket,
      started = false,
      offline = false,
      negotiated = false;
    function select(view) {
      if (!negotiated || !socket.isOpen()) return;
      const id = ++serial;
      if (id > 0xffffffff) {
        socket.disconnect();
        started = false;
        serial = 0;
        connect();
        return;
      }
      if (view) {
        view.selectionId = id;
        view.generation++;
        view.callbacks.onState('connecting');
      }
      const url = view && new URL(view.callbacks.url());
      const target = url && {
        paneId: url.searchParams.get('pane'),
        terminalId: url.searchParams.get('terminalId'),
        runtimeId: url.searchParams.get('runtimeId'),
        stateFormat: url.searchParams.get('stateFormat'),
        cols: Number(url.searchParams.get('cols')),
        rows: Number(url.searchParams.get('rows')),
      };
      socket.send({ type: 'terminal.select', selectionId: id, target });
    }
    function connect() {
      if (started && !offline) return;
      started = true;
      offline = false;
      socket ||= root.StudioSocket.create({
        url: () => {
          const url = socketUrl();
          for (const key of ['observe', 'screen', 'pane', 'terminalId', 'runtimeId'])
            url.searchParams.delete(key);
          url.searchParams.set('shell', '1');
          url.searchParams.set('channel', '1');
          url.searchParams.set('flow', 'ack');
          return url;
        },
        onState: (kind) => {
          offline = kind === 'offline';
          if (kind !== 'connected') {
            negotiated = false;
            for (const view of views) {
              view.generation++;
              view.callbacks.onState(kind);
            }
          }
        },
        onMessage: (message) => {
          if (message.type === 'terminal.channel.ready' && message.version === 1) {
            negotiated = true;
            select(active);
            return;
          }
          if (active && message.selectionId === active.selectionId)
            active.callbacks.onMessage(message);
        },
        onBinary: (bytes) => {
          if (bytes.length < 4) throw new Error('Invalid terminal channel frame');
          const id = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
          if (active && id === active.selectionId)
            return active.callbacks.onBinary(bytes.subarray(4));
        },
      });
      socket.connect();
    }
    function visible(view, value) {
      if (value && active !== view) {
        if (active) {
          active.generation++;
          active.callbacks.onState('suspended');
        }
        active = view;
        connect();
        select(view);
      } else if (!value && active === view) {
        active = null;
        view.generation++;
        view.callbacks.onState('suspended');
        select(null);
      }
    }
    return {
      createSocket(callbacks) {
        const view = { callbacks, generation: 0, selectionId: 0 };
        views.add(view);
        return {
          connect() {
            visible(view, true);
          },
          disconnect() {
            visible(view, false);
            views.delete(view);
          },
          setVisible(value) {
            visible(view, value);
          },
          isOpen: () => active === view && negotiated && Boolean(socket?.isOpen()),
          send(message) {
            if (message.type === 'terminal.visibility') {
              visible(view, message.visible);
              return true;
            }
            if (active !== view || !negotiated) return false;
            return socket.send({ ...message, selectionId: view.selectionId });
          },
          get generation() {
            return view.generation;
          },
        };
      },
      dispose() {
        active = null;
        views.clear();
        socket?.disconnect('leave terminal channel');
      },
    };
  }
  function createMultiplexer({ socketUrl }) {
    const views = new Set(),
      subscriptions = new Map();
    let socket,
      active = null,
      negotiated = false,
      serial = 0,
      selection = 0,
      started = false,
      offline = false,
      disposed = false;
    function retire(view) {
      clearTimeout(view.retry);
      view.retry = null;
      subscriptions.delete(view.id);
      for (const id of view.streams) socket?.dropStream(id);
      view.streams.clear();
      view.id = 0;
      view.generation++;
    }
    function activate() {
      if (negotiated)
        socket.send({
          type: 'terminal.activate',
          selectionId: ++selection,
          subscriptionId: active?.id || null,
        });
    }
    function subscribe(view) {
      if (!negotiated || view.id || !views.has(view)) return;
      view.id = ++serial;
      subscriptions.set(view.id, view);
      const url = new URL(view.callbacks.url());
      socket.send({
        type: 'terminal.subscribe',
        subscriptionId: view.id,
        target: {
          paneId: url.searchParams.get('pane'),
          terminalId: url.searchParams.get('terminalId'),
          runtimeId: url.searchParams.get('runtimeId'),
          stateFormat: url.searchParams.get('stateFormat'),
          cols: Number(url.searchParams.get('cols')),
          rows: Number(url.searchParams.get('rows')),
        },
      });
    }
    function connect() {
      if ((started && !offline) || disposed) return;
      started = true;
      offline = false;
      if (socket) {
        socket.connect();
        return;
      }
      socket = root.StudioSocket.create({
        onStreamError: (id) => {
          const view = subscriptions.get(id);
          if (!view) return;
          socket.send({ type: 'terminal.unsubscribe', subscriptionId: id });
          retire(view);
          view.callbacks.onState('offline');
          if (active === view)
            view.retry = setTimeout(() => {
              view.retry = null;
              subscribe(view);
              activate();
            }, 1400);
        },
        url: () => {
          const url = socketUrl();
          for (const key of ['observe', 'screen', 'pane', 'terminalId', 'runtimeId'])
            url.searchParams.delete(key);
          url.searchParams.set('shell', '1');
          url.searchParams.set('channel', '2');
          url.searchParams.set('flow', 'ack');
          return url;
        },
        onState: (kind) => {
          offline = kind === 'offline';
          if (kind === 'connected') return;
          negotiated = false;
          for (const view of views) {
            retire(view);
            view.callbacks.onState(kind);
          }
        },
        onMessage: (message) => {
          if (message.type === 'terminal.channel.ready' && message.version === 2) {
            negotiated = true;
            serial = 0;
            selection = 0;
            if (active) subscribe(active);
            for (const view of views) subscribe(view);
            activate();
            return;
          }
          const view = subscriptions.get(message.subscriptionId);
          if (!view) return;
          if (message.type === 'terminal.flow') {
            view.streams.add(message.streamId);
            return;
          }
          if (message.type === 'terminal.subscription.closed') {
            retire(view);
            view.callbacks.onState('offline');
            if (![1000, 1008, 4001, 4003].includes(message.code)) {
              // A stalled background parser retires only its own subscription.
              // Resume it when selected instead of repeatedly flooding the link.
              if (active === view)
                view.retry = setTimeout(() => {
                  view.retry = null;
                  subscribe(view);
                  activate();
                }, 1400);
            } else view.rejected = true;
            return;
          }
          view.callbacks.onMessage(message);
        },
        onBinary: (bytes) => {
          if (bytes.length < 4) throw new Error('Invalid terminal channel frame');
          const id = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
          return subscriptions.get(id)?.callbacks.onBinary(bytes.subarray(4));
        },
      });
      socket.connect();
    }
    function visible(view, value) {
      if (value && (active !== view || !view.id)) {
        active = view;
        connect();
        if (!view.rejected) {
          clearTimeout(view.retry);
          view.retry = null;
          subscribe(view);
        }
        activate();
      } else if (!value && active === view) {
        active = null;
        activate();
      }
    }
    return {
      createSocket(callbacks) {
        const view = {
          callbacks,
          generation: 0,
          id: 0,
          streams: new Set(),
          retry: null,
          rejected: false,
        };
        views.add(view);
        return {
          connect() {
            visible(view, true);
          },
          disconnect() {
            visible(view, false);
            if (view.id && negotiated)
              socket.send({ type: 'terminal.unsubscribe', subscriptionId: view.id });
            retire(view);
            views.delete(view);
          },
          setVisible(value) {
            visible(view, value);
          },
          isOpen: () => Boolean(view.id && negotiated && socket?.isOpen()),
          send(message) {
            if (message.type === 'terminal.visibility') {
              visible(view, message.visible);
              return true;
            }
            if (!view.id || !negotiated) return false;
            if (
              active !== view &&
              !['terminal.resize', 'terminal.history.request'].includes(message.type) &&
              !(message.type === 'terminal.focus' && message.focused === false)
            )
              return false;
            return socket.send({ ...message, subscriptionId: view.id, selectionId: selection });
          },
          get generation() {
            return view.generation;
          },
        };
      },
      dispose() {
        disposed = true;
        active = null;
        for (const view of views) retire(view);
        views.clear();
        socket?.disconnect('leave terminal channel');
      },
    };
  }
  root.StudioTerminalChannel = { create };
})(typeof window === 'undefined' ? globalThis : window);
