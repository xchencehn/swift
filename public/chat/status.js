/** Read-only native observation. Visible state belongs to the Swift status bar. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('./status-model'));
  else root.StudioChatStatus = factory(root.StudioSessionStatusModel);
})(typeof globalThis === 'undefined' ? this : globalThis, function (Model) {
  'use strict';
  const reasons = {
    'composer-not-visible': '当前画面未显示原生输入区，正在重新检查。',
    'footer-not-visible': '当前原生底栏未显示完整，正在重新检查。',
    'model-not-visible': '当前底栏缺少输入状态信息，正在重新检查。',
    'input-context-unconfirmed': '当前原生输入位置尚未确认，正在重新检查。',
  };
  function create({
    nodes: els,
    context,
    renderGoal,
    onInteraction = () => {},
    now = () => performance.now(),
  }) {
    let observerId = '',
      nativeScreen = null,
      nativeAvailable = false,
      activityPaneId = '',
      nativeBinding = '';
    let lastStatus = {},
      statusBinding = '',
      lastKey = '',
      decodedLines = null,
      streamActivity = '',
      streamAt = 0;
    let clockAt = null,
      timer = 0;
    const pane = () =>
      (context().chatAgents || []).find((item) => item.paneId === context().chatPaneId);
    const binding = () => {
      const p = pane(),
        state = context();
      return JSON.stringify([
        state.config?.rootDirectory,
        state.herdrRuntimeId,
        state.chatPaneId,
        p?.terminalId,
        p?.agent?.session?.value,
        p?.runtimeId,
      ]);
    };
    function summary() {
      const state = context(),
        current = pane();
      const valid =
        nativeScreen &&
        nativeBinding === binding() &&
        nativeScreen.terminalId === current?.terminalId &&
        nativeScreen.binding === `${state.chatPaneId}:${current?.agent?.session?.value || ''}`;
      const status = statusBinding === binding() ? lastStatus : {};
      const projected = valid ? nativeScreen.projection : undefined;
      const parsed = Model.parse({
        projection: projected,
        status:
          !projected && streamActivity && now() - streamAt < 6000
            ? { ...status, activity: streamActivity }
            : status,
      });
      const stale = Boolean(valid && !nativeAvailable) || !state.connected;
      const reason = projected?.interaction?.reason || '';
      return {
        ...parsed,
        stale,
        networkOffline: !state.connected,
        source: projected ? 'native' : 'status',
        observationToken: valid ? `${nativeScreen.observerId}:${nativeScreen.revision}` : '',
        observation: valid && projected.interaction ? { ...projected.interaction, stale } : null,
        notice: !state.connected
          ? '连接已断开，草稿保留在本机。'
          : valid && !nativeAvailable
            ? '原生状态更新已中断，详情保留最后一次观测。'
            : projected && !projected.recognized
              ? reasons[reason] || '当前原生界面尚未识别，聊天记录可继续查看。'
              : parsed.nativeDraft
                ? 'herdr终端输入有内容未发送'
                : parsed.alert,
        diagnosticId: valid ? nativeScreen.diagnosticId || '' : '',
        elapsedSeconds:
          parsed.elapsedSeconds == null
            ? null
            : parsed.elapsedSeconds +
              (parsed.running && !stale && clockAt != null
                ? Math.max(0, Math.floor((now() - clockAt) / 1000))
                : 0),
      };
    }
    function changed({ calibrate = false } = {}) {
      if (calibrate) clockAt = now();
      const value = summary();
      notify();
      if (value.running && !value.stale && value.elapsedSeconds != null) {
        if (!timer)
          timer = setInterval(() => {
            if (!document.hidden && !els.chatView?.hidden) notify();
          }, 1000);
      } else if (timer) {
        clearInterval(timer);
        timer = 0;
      }
    }
    function notify() {
      // Transport revisions and ANSI brightness can change on every spinner
      // frame. Only semantic changes invalidate the Swift controls.
      const { observationToken, ...visible } = summary();
      const key = JSON.stringify(visible);
      if (key === lastKey) return;
      lastKey = key;
      onInteraction();
    }
    function beginScreen(id) {
      if (id && id === observerId) return;
      observerId = id || '';
      nativeScreen = null;
      nativeBinding = '';
      nativeAvailable = false;
      clockAt = null;
      changed();
    }
    function screenUnavailable(message = {}) {
      if (message.observerId && message.observerId !== observerId) return false;
      nativeAvailable = false;
      changed();
      return true;
    }
    function screen(message) {
      const current = pane(),
        state = context();
      if (
        !observerId ||
        message.observerId !== observerId ||
        activityPaneId !== state.chatPaneId ||
        message.binding !== `${state.chatPaneId}:${current?.agent?.session?.value || ''}` ||
        message.terminalId !== current?.terminalId ||
        !Number.isSafeInteger(message.revision) ||
        message.revision <= (nativeScreen?.revision || 0) ||
        !Array.isArray(message.rows) ||
        message.rows.length > 120 ||
        !message.projection
      )
        return;
      nativeScreen = message;
      nativeBinding = binding();
      nativeAvailable = true;
      changed({ calibrate: true });
    }
    function render(status = {}) {
      const working = (pane()?.agent?.status || pane()?.status) === 'working';
      if (
        statusBinding === binding() &&
        working &&
        !status.activity &&
        Model.parse({ status: lastStatus }).running
      )
        status = { ...status, activity: lastStatus.activity };
      if (!working) status = { ...status, forceIdle: true };
      const activityChanged =
        statusBinding !== binding() || status.activity !== lastStatus.activity;
      lastStatus = status;
      statusBinding = binding();
      renderGoal(status);
      // Transcript notices remain; native composer, activity, tips, footer and
      // modal rows are never painted into the conversation.
      if (els.chatStatus)
        els.chatStatus.hidden = !document.getElementById('chatArchivedNotice')?.textContent;
      changed({ calibrate: !nativeScreen && (activityChanged || clockAt == null) });
    }
    const decoder = new TextDecoder('utf-8', { fatal: false });
    function sniff(bytes) {
      if (
        observerId ||
        els.chatView?.hidden ||
        !context().chatPaneId ||
        activityPaneId !== context().chatPaneId ||
        !window.StudioAnsi ||
        !window.StudioTerminalLines
      )
        return;
      decodedLines ||= new window.StudioTerminalLines();
      const toColor = (codes) =>
        window.StudioAnsi.parseAnsiLine(`\u001b[${codes.join(';')}m#`)[0]?.color || null;
      let touched;
      try {
        touched = decodedLines.feed(decoder.decode(bytes, { stream: true }), toColor);
      } catch {
        return;
      }
      for (const row of touched) {
        const text = decodedLines.text(row),
          hit = window.StudioAnsi.matchActivityLine(text);
        if (!hit?.running || (pane()?.agent?.status || pane()?.status) !== 'working') continue;
        streamActivity = text;
        streamAt = now();
        changed({ calibrate: true });
        break;
      }
    }
    function reset({ forgetPane = false } = {}) {
      nativeScreen = null;
      nativeBinding = '';
      nativeAvailable = false;
      observerId = '';
      lastStatus = {};
      statusBinding = '';
      streamActivity = '';
      streamAt = 0;
      decodedLines = null;
      clockAt = null;
      lastKey = '';
      if (timer) {
        clearInterval(timer);
        timer = 0;
      }
      if (forgetPane) activityPaneId = '';
    }
    function invalidateStream() {
      decodedLines = null;
      streamActivity = '';
      streamAt = 0;
      beginScreen('');
    }
    return {
      render,
      sniff,
      reset,
      invalidateStream,
      claim: (id) => {
        activityPaneId = id || '';
      },
      owner: () => activityPaneId,
      forgetScreen: () => {
        decodedLines = null;
      },
      beginScreen,
      screen,
      screenUnavailable,
      interaction: () => summary().observation,
      summary,
    };
  }
  return { create };
});
