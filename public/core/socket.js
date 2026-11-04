'use strict';

/**
 * The live connection to the service: binary terminal bytes, JSON notifications
 * and reconnection.
 *
 * It owns the generation counter that makes a superseded socket harmless. A
 * reconnect increments it, and every callback from an older socket is dropped,
 * so a slow close cannot deliver state that belongs to a connection the page
 * has already abandoned. Callers receive already-filtered events.
 *
 */
window.StudioSocket = {
  create({
    url,
    onBinary = () => {},
    onMessage = () => {},
    onState = () => {},
    onStreamError,
    onReceive = () => {},
    reconnectDelayMs = 1400,
    handshakeTimeoutMs = 15000,
    SocketImpl = globalThis.WebSocket,
  }) {
    let socket = null;
    let generation = 0;
    let reconnectTimer = null,
      handshakeTimer = null;
    let closedByUs = false,
      failures = 0,
      retryAllowed = false;
    const consumers = new Map();
    const dropStream = (id) => consumers.delete(id);
    const wake = () => {
      if (retryAllowed && !socket && !globalThis.document?.hidden) {
        failures = 0;
        open();
      }
    };
    const listen = (method) => {
      globalThis[method]?.('online', wake);
      globalThis.document?.[method]?.('visibilitychange', wake);
    };

    const isOpen = () => socket?.readyState === SocketImpl.OPEN;

    function disconnect(reason = 'reconnect') {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      retryAllowed = false;
      listen('removeEventListener');
      generation += 1;
      consumers.clear();
      const previous = socket;
      socket = null;
      closedByUs = true;
      if (previous) {
        previous.onclose = null;
        previous.close(1000, reason);
      }
    }

    function connect() {
      failures = 0;
      return open();
    }

    function open() {
      disconnect('new raw PTY');
      closedByUs = false;
      listen('addEventListener');
      let connectedAt = 0;
      const mine = generation;
      globalThis.StudioConnectionTrace?.('socket-connecting', { retries: failures });
      onState('connecting', '正在连接会话服务…', { retries: failures });
      const next = new SocketImpl(typeof url === 'function' ? url() : url);
      next.binaryType = 'arraybuffer';
      socket = next;
      handshakeTimer = setTimeout(() => {
        if (mine !== generation || socket !== next) return;
        globalThis.StudioConnectionTrace?.('handshake-timeout', { retries: failures });
        next.close(4000, 'service handshake timeout');
      }, handshakeTimeoutMs);

      let flow = null,
        consumption = Promise.resolve(),
        consumptionStream = null;
      next.onmessage = (event) => {
        if (mine !== generation || socket !== next) return;
        onReceive();
        if (event.data instanceof ArrayBuffer) {
          const credit = flow;
          flow = null;
          const consumer = credit && consumers.get(credit.streamId);
          const current = () =>
            mine === generation &&
            socket === next &&
            (!credit || consumers.get(credit.streamId) === consumer);
          const parserFailed = () => {
            if (!current()) return;
            if (credit?.subscriptionId != null && onStreamError) {
              dropStream(credit.streamId);
              onStreamError(credit.subscriptionId);
            } else next.close(1011, 'terminal parser failed');
          };
          try {
            const consumed = Promise.resolve(onBinary(new Uint8Array(event.data))).then(
              () => true,
              () => false,
            );
            const pending = (consumer?.pending || consumption)
              .then(async () => {
                if (!(await consumed)) {
                  parserFailed();
                  return;
                }
                if (credit && current() && next.readyState === SocketImpl.OPEN)
                  next.send(
                    JSON.stringify({
                      type: 'terminal.ack',
                      streamId: credit.streamId,
                      offset: credit.offset,
                    }),
                  );
              })
              .catch(parserFailed);
            if (consumer) consumer.pending = pending;
            else consumption = pending;
          } catch {
            parserFailed();
          }
          return;
        }
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        if (message.type === 'terminal.ready') {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        if (message.type === 'terminal.flow') {
          // Multiplexed subscriptions retain independent, ordered credit.
          // Legacy selections retire the previous stream when they switch.
          if (message.subscriptionId == null && message.streamId !== consumptionStream) {
            consumers.delete(consumptionStream);
            consumptionStream = message.streamId;
          }
          if (!consumers.has(message.streamId))
            consumers.set(message.streamId, { pending: Promise.resolve() });
          if (message.subscriptionId != null) onMessage(message);
          flow = message;
          return;
        }
        if (message.type === 'terminal.screen' && message.flow === 'snapshot') {
          consumption = consumption
            .then(() => onMessage(message))
            .then(() => {
              if (mine === generation && socket === next && next.readyState === SocketImpl.OPEN)
                next.send(
                  JSON.stringify({
                    type: 'terminal.screen.ack',
                    observerId: message.observerId,
                    revision: message.revision,
                  }),
                );
            })
            .catch(() => next.close(1011, 'status consumer failed'));
          return;
        }
        onMessage(message);
      };
      next.onopen = () => {
        if (mine === generation && socket === next) {
          globalThis.StudioConnectionTrace?.('socket-open');
          connectedAt = Date.now();
          onState('connected');
        }
      };
      next.onerror = () => {
        if (mine === generation && socket === next) {
          globalThis.StudioConnectionTrace?.('socket-error');
          onState('offline', '无法连接会话服务', { deliberate: false });
        }
      };
      next.onclose = (event) => {
        if (mine !== generation || socket !== next) return;
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
        globalThis.StudioConnectionTrace?.('socket-close', { code: event.code, retries: failures });
        socket = null;
        // 文案由调用方决定：这里只报告状态和是否为主动关闭。
        onState(
          'offline',
          [1008, 4001, 4003].includes(event.code) ? '连接被拒绝，请在设置中重新验证连接。' : '',
          {
            deliberate: closedByUs,
            code: event.code,
            retries: failures,
            blocked: [1008, 4001, 4003].includes(event.code),
          },
        );
        // Only local disconnect is deliberate. Peer normal close can follow a service or gateway restart.
        // Identity/authentication rejection still needs an explicit new selection.
        if (event.code === 4008)
          onState('offline', '数据同步暂时中断，正在恢复…', { deliberate: false });
        retryAllowed = !closedByUs && ![1008, 4001, 4003].includes(event.code);
        if (retryAllowed) {
          // A handshake that immediately closes must not reset a failing connection's backoff.
          if (connectedAt && Date.now() - connectedAt >= 10000) failures = 0;
          const ceiling = globalThis.document?.hidden ? 30000 : 5000;
          const delay =
            failures === 0
              ? reconnectDelayMs
              : Math.min(ceiling, reconnectDelayMs * 2 ** Math.min(failures, 6)) *
                (0.75 + Math.random() * 0.25);
          failures++;
          globalThis.StudioConnectionTrace?.('socket-retry', { retries: failures });
          reconnectTimer = setTimeout(open, delay);
        } else listen('removeEventListener');
      };
      return next;
    }

    /** Send a JSON message, dropping it when the socket is not open. */
    function send(value) {
      if (!isOpen()) return false;
      socket.send(JSON.stringify(value));
      return true;
    }

    function sendBinary(bytes) {
      if (!isOpen()) return false;
      socket.send(bytes);
      return true;
    }

    return {
      connect,
      disconnect,
      send,
      sendBinary,
      isOpen,
      dropStream,
      get generation() {
        return generation;
      },
    };
  },
};
