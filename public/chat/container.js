/**
 * 聊天流的公共容器：原生消息列表、工具行与欢迎页。
 *
 * 各家 Harness 的消息长什么样由 `public/renderers/` 决定，这里只管**容器**的事 ——
 * 顺序、增量复用、滚动锚点、节点身份、复制，以及把操作分发下去。所以这里不该出现
 * `provider === 'codex'` 这类分支。
 *
 * ⚠️ 内容相同就不重建：段签名算一遍，整体签名由它们拼成，两层共用同一份。此前
 * 变更检测与逐段复用各自 `JSON.stringify` 一遍，同一份正文要序列化三次。
 *
 * 它读写 `state` 的这些字段（都是按 pane 分组的随身状态，回收走 app.js 的
 * `forgetPane`）：chatMessages、chatPaneId、chatAgents、chatContentReady、chatCache、
 * drafts、outbox、sessionIds、lastChatStatus、sidebarMode、
 * toolOpen、toolDetails、toolRunning。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioChatContainer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @param {object} deps
   *   `state` / `els`  与 app.js 共用的那份状态和那三个节点。
   *   `request`        发一次请求，路径已带基前缀。
   *   `identity()`     当前会话的缓存身份（pane + terminal + session）。
   *   其余是容器要触发、但不属于它的动作。
   */
  function create({
    state,
    els,
    UI,
    chatImages,
    scroll,
    paneOf,
    request,
    identity,
    capMap,
    reportError,
    legacyCopyText,
    saveDraft,
    refreshChat,
    renderChatPicker,
    renderSessionStatus,
    welcomeStatus = () => ({}),
    setAtBottom,
    openToolFile,
    navigation = null,
    canEditMessage = () => false,
    canBeginEditMessage = () => true,
    onEditMessage = () => {},
  }) {
    const chatCacheKey = identity;
    const messageNodes = new WeakMap();
    const messageOwnerKey = () =>
      JSON.stringify([state.config?.rootDirectory, state.herdrRuntimeId, identity()]);
    function messageFor(element) {
      const entry = messageNodes.get(element);
      return element?.isConnected &&
        els.chatLog.contains(element) &&
        entry?.identity === messageOwnerKey() &&
        entry.message.role === 'user'
        ? entry.message
        : null;
    }

    function chatText(node, value) {
      // 会话内容是任意文本,一律走 textContent,不给 innerHTML 任何机会。
      node.textContent = value;
      return node;
    }

    // 内容相同不重建；历史阅读保持位置；工具的手动展开状态按会话和调用 id 保存。
    //
    // 变更检测和逐段复用共用**同一遍**序列化：段签名算一次，整体签名由它们拼成。
    // 此前这里各自 JSON.stringify 整个列表，加上渲染时逐段再来一遍，一次刷新要把
    // 全部正文序列化三遍 —— 600 条消息（1.1MB）上实测约 19ms，全在主线程。
    const SEGMENT_GAP = '\u0000';
    const segmentCache = new WeakMap();
    function chatSegments(messages) {
      const segments = [],
        owners = [],
        signatures = [];
      for (const message of messages) {
        let parts = segmentCache.get(message);
        if (!parts) {
          const segments = UI.messageSegments(message);
          parts = { segments, signatures: segments.map((segment) => JSON.stringify(segment)) };
          segmentCache.set(message, parts);
        }
        for (let index = 0; index < parts.segments.length; index++) {
          segments.push(parts.segments[index]);
          signatures.push(parts.signatures[index]);
          owners.push(message);
        }
      }
      return { segments, signatures, owners, signature: signatures.join(SEGMENT_GAP) };
    }

    function applyOutboxUpdate(message, incoming) {
      const previousTime = new Date(message.updatedAt || 0).getTime();
      const nextTime = new Date(incoming.updatedAt || 0).getTime();
      const terminal = ['consumed', 'dispatched', 'cancelled', 'discarded'];
      if (message.status === 'discarded' && incoming.status !== 'discarded') return message;
      // A native acceptance receipt is irreversible. Wall-clock correction can
      // date an explicit retry earlier than its failure; it still confirms the
      // first write. An older unaccepted poll must never undo that fact.
      const firstAcceptance =
        message.transportAcceptedAt == null &&
        incoming.transportAcceptedAt != null &&
        ['dispatched', 'consumed'].includes(incoming.status) &&
        !terminal.includes(message.status);
      // Attempts establish request order even when the server clock moves back.
      const numbered =
        Number.isSafeInteger(message.attempts) && Number.isSafeInteger(incoming.attempts);
      if (!firstAcceptance && numbered && incoming.attempts < message.attempts) return message;
      const newerAttempt =
        numbered && incoming.attempts > message.attempts && !terminal.includes(message.status);
      if (
        message.transportAcceptedAt != null &&
        incoming.transportAcceptedAt == null &&
        ['queued', 'sending', 'failed'].includes(incoming.status)
      )
        return message;
      if (
        (!firstAcceptance && !newerAttempt && nextTime < previousTime) ||
        (nextTime === previousTime &&
          ((terminal.includes(message.status) && !terminal.includes(incoming.status)) ||
            (message.transportAcceptedAt != null && incoming.status === 'queued')))
      )
        return message;
      return Object.assign(message, incoming, { serverKnown: true });
    }

    function setChatContentReady(ready) {
      state.chatContentReady = ready;
      els.chatLog.dataset.loading = String(!ready);
      els.chatLog.setAttribute('aria-busy', String(!ready));
    }

    const rendered = { signature: '', token: '', count: 0 };
    function renderChatMessages(messages, options = {}) {
      navigation?.update(state.chatContentReady ? messages : []);
      // Commands and queue events can arrive before the initial transcript. Never
      // render that partial stream as a standalone conversation in the meantime.
      if (!state.chatContentReady) {
        els.chatLog.replaceChildren(els.chatStatus);
        return;
      }
      const pane = (state.chatAgents || []).find((p) => p.paneId === state.chatPaneId);
      const log = els.chatLog;
      if (pane) {
        renderSessionStatus(pane);
        renderChatPicker();
      }
      const parts = chatSegments(messages);
      const signature = `${messageOwnerKey()}|${state.chatContentReady}|${parts.signature}`;
      // 完整签名含全部正文，只留在这里；DOM 属性上放一个短序号。外面把属性清空就等于要求重画。
      if (
        log.dataset.signature &&
        log.dataset.signature === rendered.token &&
        rendered.signature === signature
      )
        return;
      const first = !log.dataset.rendered;
      // Enter at the latest message before the first paint. Later refreshes
      // preserve reading performed after entry, including an in-flight gesture.
      const viewport = first ? options.viewport : null;
      const stuckToBottom = first ? viewport?.bottom !== false : scroll.atBottom();
      const before = scroll.capture();
      const focusedKey = document.activeElement?.closest('[data-tool-key]')?.dataset.toolKey;
      rendered.signature = signature;
      rendered.token = String(++rendered.count);
      log.dataset.signature = rendered.token;
      log.dataset.rendered = '1';
      renderChatBody(messages, parts);
      if (state.sidebarMode === 'recent') renderChatPicker();
      if (focusedKey)
        [...log.querySelectorAll('[data-tool-key]')]
          .find((n) => n.dataset.toolKey === focusedKey)
          ?.querySelector('summary')
          ?.focus({ preventScroll: true });
      if (options.keepScroll) return;
      if (first && viewport) scroll.restorePosition(viewport);
      else if (first) scroll.enterLatest();
      else scroll.restore(before);
      // 渲染完告诉外壳现在贴没贴底：滚动那一侧还要据此决定新消息要不要跟着走。
      setAtBottom(stuckToBottom);
    }

    // Keep status and unchanged messages attached so animations, selection and
    // browser scroll anchors survive queue acknowledgements.
    function reconcileChildren(parent, nodes) {
      const keep = new Set(nodes);
      for (const node of [...parent.childNodes]) if (!keep.has(node)) node.remove();
      let cursor = parent.firstChild;
      for (const node of nodes) {
        if (node === cursor) cursor = cursor.nextSibling;
        else parent.insertBefore(node, cursor);
      }
    }
    function reconcileChatChildren(nodes) {
      reconcileChildren(els.chatLog, nodes);
      scroll.observe();
      window.StudioDiagrams?.render(els.chatLog, scroll);
    }
    function toolRow(item, key) {
      const ownerKey = messageOwnerKey(),
        paneId = state.chatPaneId;
      const current = () => row.isConnected && messageOwnerKey() === ownerKey;
      const previewSignature = JSON.stringify([
        item.input,
        item.result,
        item.running,
        item.statusUnknown,
        item.failed,
      ]);
      const cached = state.toolDetails.get(key);
      let fullDetails = cached?.signature === previewSignature && cached.loaded === true;
      if (cached?.signature === previewSignature) item = { ...item, ...cached.value };
      const row = document.createElement('details');
      row.className = `chat-tool-row${item.running ? ' running' : ''}${item.failed ? ' failed' : ''}`;
      row.dataset.toolKey = key;
      row.dataset.status = item.running
        ? 'running'
        : item.failed
          ? 'failed'
          : item.statusUnknown
            ? 'unknown'
            : 'completed';
      if (state.toolRunning.get(key) && !item.running) state.toolOpen.delete(key);
      state.toolRunning.set(key, Boolean(item.running));
      // 这两张只存布尔值，条目小；封顶是为了长开不涨，上限给得比正文缓存宽。
      capMap(state.toolRunning, 2000);
      capMap(state.toolOpen, 2000);
      row.open = state.toolOpen.has(key) ? state.toolOpen.get(key) : false;
      const summary = document.createElement('summary');
      const mark = chatText(
        document.createElement('span'),
        item.running ? '…' : item.failed ? '!' : item.statusUnknown ? '·' : '✓',
      );
      mark.className = 'chat-tools-mark';
      const name = chatText(document.createElement('span'), item.name);
      name.className = 'chat-tool-name';
      const detail = chatText(
        document.createElement('span'),
        item.detail || (item.running ? '' : '查看执行结果'),
      );
      detail.className = 'chat-tool-detail';
      mark.setAttribute('role', 'img');
      mark.setAttribute(
        'aria-label',
        item.running
          ? '正在执行'
          : item.failed
            ? '执行失败'
            : item.statusUnknown
              ? '状态未确认'
              : '已完成',
      );
      summary.append(mark, name, detail);
      row.append(summary);
      window.StudioToolView?.summary(row, item);
      const body = document.createElement('div');
      body.className = 'tool-body';
      let built = false;
      function buildBody() {
        if (built) return;
        built = true;
        const structured = window.StudioToolView?.render(body, item, {
          copyText,
          isCurrent: current,
          rawOpen: state.toolOpen.get(key + ':raw'),
          saveRawOpen: (open) => {
            if (current()) state.toolOpen.set(key + ':raw', open);
          },
          openFile: (path) => {
            if (current()) openToolFile?.(path);
          },
        });
        if (!structured) {
          body.dataset.contentPreview = 'true';
          for (const [label, value] of window.StudioToolPresentation.detailSections(
            item,
            fullDetails,
          )) {
            const head = document.createElement('div');
            head.className = 'tool-section-head';
            head.append(chatText(document.createElement('span'), label));
            const copy = chatText(document.createElement('button'), '复制');
            copy.type = 'button';
            copy.classList.add('copy-action');
            copy.addEventListener('click', () => copyText(value, copy));
            head.append(copy);
            const pre = chatText(document.createElement('pre'), value);
            window.StudioAnsi.renderAnsi(pre, value);
            if (label === '命令') pre.classList.add('tool-command');
            body.append(head, pre);
          }
        }
        if (!structured && !item.running && !item.input && !item.result)
          body.append(chatText(document.createElement('p'), '此记录未提供执行详情。'));
        if (
          !item.live &&
          (item.input?.truncated ||
            item.result?.truncated ||
            (!structured && !fullDetails && item.id && (item.input || item.result)))
        ) {
          const more = chatText(document.createElement('button'), '加载完整详情');
          more.type = 'button';
          more.className = 'tool-load';
          more.addEventListener('click', async () => {
            more.disabled = true;
            more.textContent = '正在加载…';
            try {
              const data = await request(
                `/api/tool?pane=${encodeURIComponent(paneId)}&id=${encodeURIComponent(item.id)}`,
              );
              if (!current()) return;
              const full = data.tool || data;
              state.toolDetails.set(key, {
                signature: previewSignature,
                value: full,
                loaded: true,
              });
              capMap(state.toolDetails, 64);
              item = { ...item, ...full };
              fullDetails = true;
              body.replaceChildren();
              built = false;
              window.StudioToolView?.summary(row, item);
              buildBody();
            } catch (error) {
              if (current()) {
                more.disabled = false;
                more.textContent = '重试加载';
                let note = body.querySelector('.tool-load-error');
                if (!note) {
                  note = document.createElement('p');
                  note.className = 'tool-load-error';
                  body.append(note);
                }
                note.textContent = error.message || '详情加载失败，请重试。';
              }
            }
          });
          body.append(more);
        }
      }
      if (row.open) buildBody();
      row.addEventListener('toggle', () => {
        if (row.open) buildBody();
      });
      summary.addEventListener('click', () => state.toolOpen.set(key, !row.open));
      row.append(body);
      return row;
    }

    function copyText(text, button) {
      if (button?.getAttribute('aria-busy') === 'true') return;
      const fallback = () => {
        if (legacyCopyText(text) !== true) throw new Error('复制失败，请选取文字后手动复制。');
      };
      // Keep the fallback synchronous inside the click when Clipboard API is absent.
      let result;
      try {
        result = navigator.clipboard?.writeText
          ? navigator.clipboard.writeText(text).catch(fallback)
          : fallback();
      } catch (error) {
        result = Promise.reject(error);
      }
      if (!button) return Promise.resolve(result).catch(() => {});
      const label = (button.dataset.copyLabel ||=
        button.getAttribute('aria-label') || button.textContent || '复制');
      button.classList.add('copy-action');
      let note = button.nextElementSibling;
      if (!note?.classList.contains('copy-feedback')) {
        note = document.createElement('span');
        note.className = 'copy-feedback visually-hidden';
        note.setAttribute('role', 'status');
        button.after(note);
      }
      clearTimeout(button._copyTimer);
      button.setAttribute('aria-busy', 'true');
      button.dataset.copyState = 'pending';
      note.textContent = '';
      return Promise.resolve(result)
        .then(
          () => {
            button.dataset.copyState = 'done';
            button.setAttribute('aria-label', `${label}，已复制`);
            note.className = 'copy-feedback visually-hidden';
            note.textContent = '已复制';
            button._copyTimer = setTimeout(() => {
              delete button.dataset.copyState;
              button.setAttribute('aria-label', label);
            }, 1800);
          },
          () => {
            button.dataset.copyState = 'error';
            button.setAttribute('aria-label', `${label}，复制失败，可重试`);
            note.className = 'copy-feedback';
            note.textContent = '复制失败，请选取文字后手动复制。';
          },
        )
        .finally(() => button.removeAttribute('aria-busy'));
    }

    /**
     * 每条消息底下那一行元信息,照 dsh 的排法:时间 + 一颗复制钮。
     *
     * 它那行还有赞/踩/重试和 token 用量 —— **这四样在 herdr 里没有对应的东西**:
     * 消息是写进 PTY 的字节,没有「重新生成」这回事,也没有评分;用量则根本不在
     * 会话存档里(`lib/agent-transcript.js` 只解析出 `ts` 和正文)。摆一个点不动的
     * 按钮比不放更糟,所以只做这两样。
     */
    // 共用一个格式化器：toLocaleTimeString 带选项时每次调用都新建一个，几百条消息的会话里
    // 切一次会话光这一项就占一百毫秒（手机档 4 倍降速实测，2026-09-24）。
    const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    });
    function buildMessageMeta(message) {
      const source = message.harness || UI.providerId(paneOf()) || '';
      const renderer = window.StudioRenderers.for(source, message.schemaVersion).renderer;
      const text = renderer.messageText
        ? renderer.messageText(message)
        : (message.blocks || [])
            .filter((block) => typeof block.text === 'string' && block.text)
            .map((block) => block.text)
            .join('\n\n');
      if (!text && !message.blocks?.some((block) => block.kind === 'image')) return null;
      const meta = document.createElement('div');
      meta.className = 'chat-meta';
      if (message.ts) {
        const when = new Date(message.ts);
        // 存档里偶尔有解析不出的时间戳:那就不显示 —— 一个 Invalid Date 比没有更糟。
        if (!Number.isNaN(when.getTime())) {
          const stamp = document.createElement('button'),
            time = document.createElement('time');
          stamp.type = 'button';
          stamp.className = 'chat-meta-time';
          time.dateTime = when.toISOString();
          time.textContent = TIME_FORMAT.format(when);
          stamp.title = DATE_FORMAT.format(when);
          stamp.setAttribute('aria-label', stamp.title);
          stamp.setAttribute('aria-expanded', 'false');
          stamp.append(time);
          const detail = document.createElement('span');
          detail.className = 'chat-meta-date';
          detail.hidden = true;
          detail.textContent = stamp.title;
          stamp.onclick = () => {
            detail.hidden = !detail.hidden;
            stamp.setAttribute('aria-expanded', String(!detail.hidden));
          };
          meta.append(stamp, detail);
        }
      }
      if (text) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'chat-meta-button';
        copy.title = '复制这条消息';
        copy.setAttribute('aria-label', '复制这条消息');
        copy.innerHTML =
          '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
          '<rect x="5.4" y="2.2" width="8.4" height="9.6" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
          '<path d="M10.6 13.8H4.2a1.9 1.9 0 0 1-1.9-1.9V5.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
        copy.addEventListener('click', () => copyText(text, copy));
        meta.append(copy);
      }
      if (canEditMessage(message)) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'chat-meta-button chat-message-edit-action';
        edit.disabled = !canBeginEditMessage();
        edit.title = '编辑并重新发送这条消息';
        edit.setAttribute('aria-label', edit.title);
        edit.innerHTML =
          '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="m10 3 3 3M3 10l7-7a2.1 2.1 0 0 1 3 3l-7 7-4 1Z"/></svg>';
        edit.onclick = () => onEditMessage(message.id);
        meta.append(edit);
      }
      return meta.childElementCount ? meta : null;
    }

    /** 区分尚无消息、等待身份关联和等待原生存档读取。 */
    function welcomeCaption() {
      if (!state.chatPaneId) return '';
      if (state.lastChatStatus?.associationPending) return '正在关联原生会话，消息会自动同步';
      if (state.lastChatStatus?.archivePending) return '正在读取原生会话记录，消息会自动同步';
      return '';
    }

    function welcomeInfo() {
      const pane = paneOf(),
        status = welcomeStatus();
      return {
        label: state.archived ? '' : pane?.agent?.label || pane?.agent?.id || '',
        directory: state.archived?.cwd || status.directory || pane?.cwd || pane?.baseCwd || '',
        permissions:
          !state.archived && !status.stale
            ? (status.metadata || [])
                .filter((item) => item.label === 'Permissions')
                .map((item) => item.value)
                .join(' · ')
            : '',
      };
    }

    function updateChatWelcome(empty) {
      const info = welcomeInfo();
      for (const [name, value] of Object.entries({ ...info, caption: welcomeCaption() })) {
        const node = empty.querySelector(`.chat-welcome-${name}`);
        if (node.textContent !== value) node.textContent = value;
        node.hidden = !value;
        if (name === 'directory') node.title = value;
      }
      const brand =
        !state.archived && state.chatPaneId
          ? window.StudioRenderers.for(paneOf()?.agent?.id).renderer.welcomeBrand
          : null;
      const mark = empty.querySelector('.chat-welcome-brand');
      mark.hidden = !brand;
      mark.dataset.provider = brand?.icon || '';
      mark.setAttribute('aria-label', brand?.label || '');
      empty.querySelector('.chat-welcome-info').hidden = !info.label && !info.directory;
    }

    function createChatWelcome() {
      const empty = document.createElement('section');
      empty.className = 'chat-empty chat-welcome';
      empty.setAttribute('aria-label', '会话首页');
      const info = document.createElement('header');
      info.className = 'chat-welcome-info';
      for (const name of ['label', 'directory', 'permissions']) {
        const node = document.createElement(name === 'label' ? 'h2' : 'p');
        node.className = `chat-welcome-${name}`;
        info.append(node);
      }
      const center = document.createElement('div');
      center.className = 'chat-welcome-center';
      const brand = document.createElement('span');
      brand.className = 'chat-welcome-brand';
      brand.setAttribute('role', 'img');
      const caption = document.createElement('p');
      caption.className = 'chat-welcome-caption';
      center.append(brand, caption);
      empty.append(info, center);
      updateChatWelcome(empty);
      return empty;
    }

    /** Update observed facts without replacing the welcome page or moving focus. */
    function tickWelcomeCaption() {
      const empty = els.chatLog.querySelector('.chat-welcome');
      if (empty) updateChatWelcome(empty);
    }

    let bodyNodes = new Map(),
      bodyRenderSignature = '';
    const codeWrap = new Map();
    // 正文按组装进 `.chat-chunk`，组上开 content-visibility: auto，屏幕外的组整组跳过排版。
    // 不分组时，#chatLog 是纵向 flex，改动任何一条气泡都要把整列重排一遍：3000 条时
    // 每次强制排版约 47ms，一次更新要排六次；分组后同样的改动约 0.4ms
    // （scripts/testing/long-session-browser-harness.js）。组界按「这一组第一段的键」记住，下次渲染沿用，
    // 所以往回翻页只在前面新添组、追加只往最后一组里放，已有的组成员不动 ——
    // 成员一变，浏览器记住的那组高度就作废，滚到那里会跳。
    const CHUNK_SIZE = 60;
    let chunkNodes = new Map();
    // 渲染器不直接取全局状态、不发请求：它要的能力从这里注入。
    function rendererHost(message) {
      let codeIndex = 0;
      return {
        renderMarkdown: window.StudioMarkdown
          ? (text) => {
              const pane = paneOf(),
                id = state.archived
                  ? `archived:${state.archived.provider}:${state.archived.sessionId}`
                  : state.chatPaneId;
              return window.StudioMarkdown.renderMarkdownWithLinks(text, (raw) => {
                const local = window.StudioDocView.localHref(raw.replace(/^sandbox:/, ''));
                if (!local) return null;
                let path;
                try {
                  path = decodeURIComponent(local);
                } catch {
                  return null;
                }
                path = window.StudioDocView.resolvePath(
                  `${state.archived?.cwd || pane?.baseCwd || pane?.cwd || state.config?.rootDirectory || ''}/reference`,
                  path,
                );
                const query = id.startsWith('archived:')
                  ? { archived: id.slice(9) }
                  : { pane: id, sessionId: pane?.agent?.session?.value || '' };
                const url = `/api/doc-files/download?${new URLSearchParams({ ...query, path })}`;
                const go = () =>
                  window.dispatchEvent(
                    new CustomEvent('swift.file.open', { detail: { paneId: id, path } }),
                  );
                go.path = path;
                go.downloadUrl =
                  (document.querySelector('meta[name="agent-studio-base-path"]')?.content || '') +
                  url;
                // A regular tap opens the existing read-only file panel.
                return go;
              });
            }
          : null,
        plainText: (element, text) => chatText(element, text),
        renderImage: (block, owner) => {
          const pane = paneOf();
          return chatImages.render(block, {
            paneId: state.chatPaneId,
            sessionId: pane?.agent?.session?.value || state.sessionIds[state.chatPaneId] || '',
            slot: `${owner.id}:${owner.blocks.indexOf(block)}`,
          });
        },
        renderTool: (item, owner, block, index) =>
          toolRow(
            item,
            `${state.chatPaneId}:${item.nativeId || item.id || `${owner.id}:${owner.blocks.indexOf(block)}:${index}`}`,
          ),
        copyText: (text, button) => copyText(text, button),
        onCopyCode: (pre) => {
          const key = JSON.stringify([messageOwnerKey(), message.id, codeIndex++]);
          const text = pre.textContent;
          const actions = document.createElement('div');
          actions.className = 'code-actions';
          const wrap = document.createElement('button');
          wrap.type = 'button';
          wrap.className = 'code-wrap';
          const paintWrap = (enabled) => {
            pre.dataset.wrap = enabled ? 'on' : 'off';
            wrap.textContent = enabled ? '自动换行' : '不换行';
            wrap.setAttribute('aria-pressed', String(enabled));
            wrap.title = enabled ? '关闭自动换行' : '开启自动换行';
          };
          paintWrap(codeWrap.get(key) !== false);
          wrap.onclick = () => {
            const enabled = pre.dataset.wrap !== 'on';
            if (enabled) codeWrap.delete(key);
            else codeWrap.set(key, false);
            capMap(codeWrap, 512);
            paintWrap(enabled);
          };
          const copy = chatText(document.createElement('button'), '复制代码');
          copy.type = 'button';
          copy.className = 'code-copy';
          copy.addEventListener('click', () => copyText(text, copy));
          actions.append(wrap, copy);
          pre.prepend(actions);
        },
      };
    }

    /** `parts` 是 `chatSegments` 的结果：段、段签名与拼好的整体签名，由调用方算一次。 */
    function renderChatBody(messages, parts = chatSegments(messages)) {
      const identity = chatCacheKey();
      const signature = `${messageOwnerKey()}:${parts.signature}:${welcomeCaption()}`;
      if (
        bodyRenderSignature === signature &&
        [...bodyNodes.values()].every((value) => value.nodes.every((node) => node.isConnected))
      )
        return;
      bodyRenderSignature = signature;
      const nodes = [],
        nextNodes = new Map();
      chatImages.reset(`${state.chatPaneId}:${state.sessionIds[state.chatPaneId] || ''}`);
      const commit = () => {
        bodyNodes = nextNodes;
        reconcileChatChildren([...nodes, els.chatStatus]);
      };
      if (!messages.length) {
        if (!state.chatContentReady) {
          commit();
          return;
        }
        const empty = createChatWelcome();
        nodes.push(empty);
        nextNodes.set(`${identity}:empty`, { nodes: [empty] });
        commit();
        return;
      }
      let index = 0;
      const seen = new Map(),
        groups = [];
      for (const message of parts.segments) {
        const originalMessage = parts.owners[index] || message;
        // 键里不放下标：往回翻页会让全部下标后移，每一段都被当成新段整片重建。
        const occurrence = seen.get(message.id) || 0;
        seen.set(message.id, occurrence + 1);
        const key = `${identity}:${message.id}:${occurrence}`,
          signature = parts.signatures[index++];
        const tools = message.blocks[0]?.kind === 'tools';
        const last = groups[groups.length - 1];
        // Bound groups even during hours of consecutive tools. The chunk's
        // boundary attributes preserve the same compact spacing across groups.
        if (!last || chunkNodes.has(key) || last.count >= CHUNK_SIZE)
          groups.push({ key, nodes: [], count: 0 });
        const group = groups[groups.length - 1];
        group.count++;
        group.tools = tools;
        const start = nodes.length;
        const cached = bodyNodes.get(key);
        const cacheable = !message.blocks.some((block) => block.kind === 'image');
        if (cacheable && cached?.signature === signature) {
          for (const node of cached.nodes)
            if (node.classList.contains('chat-msg'))
              messageNodes.set(node, { identity: messageOwnerKey(), message: originalMessage });
          nodes.push(...cached.nodes);
          group.nodes.push(...cached.nodes);
          nextNodes.set(key, cached);
          continue;
        }
        const bubble = document.createElement('div');
        bubble.className = 'chat-msg';
        bubble.dataset.role = message.role;
        bubble.dataset.messageId = message.id || '';
        bubble.dataset.scrollKey = key;
        bubble.dataset.content = message.blocks[0]?.kind === 'tools' ? 'tools' : 'text';
        messageNodes.set(bubble, { identity: messageOwnerKey(), message: originalMessage });
        if (message.kind) bubble.dataset.kind = message.kind;
        // 气泡内部交给该来源自己的渲染器：顺序、分页、滚动锚点、节点身份和
        // 操作分发仍归这里，渲染器只管标记、块和语义配色。
        // 按消息的实际来源选，不按会话的默认 Harness —— 跨来源并列时各段要
        // 保留自己的渲染方式。
        const source = message.harness || UI.providerId(paneOf()) || '';
        const picked = window.StudioRenderers.for(source, message.schemaVersion);
        bubble.dataset.harness = picked.renderer.harnessId;
        if (picked.degraded) {
          // 功能定义要求：缺失或未知版本不能冒充已完整适配。内容照常渲染，
          // 但要有一句明确的兼容状态，否则"显示得朴素"会被当成"内容就这么简单"。
          bubble.dataset.degraded = 'true';
          const mark = document.createElement('span');
          mark.className = 'chat-degraded-mark';
          mark.textContent =
            picked.reason === 'no-renderer'
              ? `${source} 还没有专用渲染器，按通用方式显示`
              : '数据版本高于当前渲染器，可能有内容未显示';
          bubble.append(mark);
        }
        const draw = () => {
          try {
            picked.renderer.renderMessage(message, bubble, rendererHost(message));
          } catch (error) {
            bubble.replaceChildren();
            bubble.dataset.degraded = 'true';
            const text = document.createElement('pre');
            text.textContent = (message.blocks || [])
              .map((block) => block.text || block.summary || '')
              .join('\n');
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = '重新显示';
            retry.addEventListener('click', () => {
              bubble.replaceChildren();
              draw();
            });
            bubble.append(text, retry);
            console.error('[message-render]', message.id, error);
          }
        };
        draw();
        const rendered = [bubble];
        nodes.push(bubble);
        // 元信息挂在气泡**外面**(dsh 上也是):放进气泡里会把那行字圈进底色,
        // 而且会跟着气泡的 `fit-content` 宽度走 —— 一个 19:34 就能把气泡撑宽。
        const meta = buildMessageMeta(message);
        if (meta) {
          meta.dataset.role = message.role;
          nodes.push(meta);
          rendered.push(meta);
        }
        nextNodes.set(key, { signature, nodes: rendered });
        group.nodes.push(...nodes.slice(start));
      }
      const nextChunks = new Map();
      nodes.length = 0;
      // Keep the latest window and its adjacent group measurable. A short last
      // group can expose the previous group's estimated height during entry.
      for (const [index, group] of groups.entries()) {
        const chunk = chunkNodes.get(group.key) || document.createElement('div');
        chunk.className =
          index >= groups.length - 2 ? 'chat-chunk chat-chunk-latest' : 'chat-chunk';
        chunk.dataset.startsTools = String(group.nodes[0]?.dataset.content === 'tools');
        chunk.dataset.endsTools = String(Boolean(group.tools));
        reconcileChildren(chunk, group.nodes);
        nextChunks.set(group.key, chunk);
        nodes.push(chunk);
      }
      chunkNodes = nextChunks;
      commit();
    }

    return {
      chatText,
      chatSegments,
      messageFor,
      applyOutboxUpdate,
      setChatContentReady,
      renderChatMessages,
      reconcileChatChildren,
      renderChatBody,
      tickWelcomeCaption,
      createChatWelcome,
      toolRow,
      rendererHost,
      copyText,
    };
  }

  return { create };
});
