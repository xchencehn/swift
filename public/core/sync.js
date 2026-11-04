/**
 * 同步的客户端一侧：连上后发 hello 追平，之后把服务端推来的变化写进本地副本（docs/LOCAL_FIRST.md）。
 *
 * 连接由 core/socket.js 管理，这里只处理 `sync.*` 消息。变化接不上时丢掉那个会话的版本号、
 * 重新 hello，服务端对没有版本号的会话给最近一段整体替换。
 *
 * `active()` 为真时，界面可以相信副本是最新的：不再拉快照与正文，只取状态部分。
 * 连接断开、或服务端不支持同步（一直等不到 welcome）时为假，界面退回原来的拉取路径。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioSync = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const decodeGzip =
    typeof globalThis.DecompressionStream === 'function'
      ? async (message) => {
          if (
            message.encoding !== 'gzip' ||
            typeof message.data !== 'string' ||
            !Number.isSafeInteger(message.bytes) ||
            message.bytes < 0 ||
            message.bytes > 4 * 1024 * 1024 ||
            message.data.length > 6 * 1024 * 1024
          )
            throw Error('Invalid compressed sync message');
          const bytes = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
          const reader = new Blob([bytes])
            .stream()
            .pipeThrough(new DecompressionStream('gzip'))
            .getReader();
          const chunks = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > message.bytes) throw Error('Compressed sync size mismatch');
              chunks.push(value);
            }
            if (size !== message.bytes) throw Error('Incomplete compressed sync message');
            return JSON.parse(await new Blob(chunks).text());
          } finally {
            await reader.cancel();
          }
        }
      : null;

  function create({
    replica,
    send,
    onSnapshot = () => {},
    onSession = () => {},
    onFiles = () => {},
    onHistory = () => {},
    onReady = () => {},
    onReset = () => {},
    onState = () => {},
    interest = null,
    decode = decodeGzip,
  }) {
    let welcomed = false,
      ready = false,
      helloTimer = null,
      handshakeTimer = null,
      lastInterest = '';
    let receive = {},
      compression = Boolean(decode);

    function hello() {
      receive = {};
      clearTimeout(helloTimer);
      helloTimer = null;
      ready = false;
      welcomed = false;
      clearTimeout(handshakeTimer);
      onState('hello');
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        if (!ready) onState('fallback');
      }, 10000);
      handshakeTimer.unref?.();
      const keys = interest?.();
      lastInterest = keys ? JSON.stringify(keys) : '';
      return send({
        type: 'sync.hello',
        sessions: replica.revisions(),
        snapshot: replica.snapshotHash(),
        files: replica.fileHashes(),
        history: replica.history()?.hash || '',
        ...(keys ? { interest: keys } : {}),
        ...(compression ? { compression: 'gzip' } : {}),
      });
    }
    function watch() {
      if (!interest || !ready) return;
      const keys = interest(),
        signature = JSON.stringify(keys);
      if (signature === lastInterest) return;
      if (send({ type: 'sync.watch', interest: keys }) !== false) lastInterest = signature;
    }
    /** 某个会话接不上：丢掉它的版本号，稍后重新追平（合并同一时刻的多个）。 */
    function resync(key) {
      replica.drop(key);
      if (!helloTimer) helloTimer = setTimeout(hello, 200);
    }

    /** 处理一条消息；不是同步消息返回 false。 */
    function handle(message) {
      if (
        message?.type === 'sync.compressed' ||
        (receive.pending && message?.type?.startsWith('sync.'))
      ) {
        const current = receive;
        const pending = (current.pending || Promise.resolve())
          .then(async () => {
            if (current !== receive) return;
            const value = message.type === 'sync.compressed' ? await decode(message) : message;
            if (current !== receive) return;
            if (value?.type === 'sync.compressed' || !value?.type?.startsWith('sync.'))
              throw Error('Invalid compressed sync event');
            deliver(value);
          })
          .catch(() => {
            if (current !== receive) return;
            // A read-only replica can recover without replaying native input.
            // Disable this optional encoding before requesting ordinary JSON.
            compression = false;
            reset();
            hello();
          });
        current.pending = pending;
        void pending.then(() => {
          if (current.pending === pending) current.pending = null;
        });
        return true;
      }
      return deliver(message);
    }

    function deliver(message) {
      switch (message?.type) {
        case 'sync.welcome':
          welcomed = true;
          onState('welcome');
          return true;
        case 'sync.snapshot':
          onSnapshot(replica.setSnapshot(message), message);
          return true;
        case 'sync.session': {
          const record = replica.apply(message);
          if (!record) {
            resync(message.key);
            return true;
          }
          onSession(message.key, message, record);
          return true;
        }
        case 'sync.files':
          onFiles(message.key, replica.setFiles(message.key, message).files, message);
          return true;
        case 'sync.history':
          onHistory(replica.setHistory(message));
          return true;
        case 'sync.ready':
          ready = true;
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
          onState('ready');
          onReady();
          return true;
        // 服务端换了同步中心（切换根目录）：之前的追平作废，重新 hello。
        case 'sync.reset':
          reset();
          hello();
          return true;
        default:
          return false;
      }
    }

    /** 连接断开：之前推来的仍然有效（它们已经在副本里），只是不再保证最新。 */
    function reset() {
      receive = {};
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      onState('offline');
      welcomed = false;
      ready = false;
      lastInterest = '';
      clearTimeout(helloTimer);
      helloTimer = null;
      onReset();
    }

    return {
      hello,
      watch,
      handle,
      reset,
      resync,
      active: () => welcomed && ready,
      welcomed: () => welcomed,
    };
  }

  return { create };
});
