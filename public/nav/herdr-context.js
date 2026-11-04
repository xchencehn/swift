(function (root) {
  'use strict';
  function create({ state, api, basePath, renderSidebar }) {
    const machineBase = basePath.replace(/\/herdr-sessions\/[^/]+$/, '');
    const rootBase = machineBase.replace(/\/machines\/[a-f0-9-]{36}$/, '');
    const currentMachine = /\/machines\/([a-f0-9-]{36})$/.exec(machineBase)?.[1] || '';
    let stopped = false,
      pending = false;
    const completionTrackers = new Map();
    async function refreshAgents() {
      if (stopped || pending || document.hidden) return;
      pending = true;
      try {
        const result = await api(`${rootBase}/api/machines`);
        const machines = [
          { id: '', name: '本机', connected: true },
          ...(result.machines || []),
        ].filter((m) => m.id !== currentMachine);
        const previous = state.remoteAgents || [];
        const rows = [];
        const failures = [];
        await Promise.all(
          machines.map(async (machine) => {
            const prefix = `${rootBase}${machine.id ? `/machines/${machine.id}` : ''}`;
            if (!machine.connected) {
              rows.push(
                ...previous
                  .filter((p) => p.machineId === machine.id)
                  .map((p) => ({ ...p, online: false })),
              );
              return;
            }
            try {
              const snapshot = await api(`${prefix}/api/snapshot`, {
                signal: AbortSignal.timeout(5000),
              });
              if (!completionTrackers.has(prefix))
                completionTrackers.set(prefix, root.StudioUi.createCompletionTracker());
              const tracker = completionTrackers.get(prefix);
              tracker.observe(snapshot.panes || []);
              const seenKey =
                prefix.includes('/machines/') || prefix.startsWith('/e/')
                  ? `studioSeenDoneLocal:${prefix}`
                  : 'studioSeenDoneLocal';
              let seen = {};
              try {
                seen = JSON.parse(localStorage.getItem(seenKey) || '{}');
              } catch {}
              for (const pane of snapshot.panes || [])
                if (pane.agent)
                  rows.push({
                    machineId: machine.id,
                    machine: machine.name,
                    pane,
                    completionUnread: tracker.unread(pane, seen),
                    online: true,
                    href: `${prefix}/?pane=${encodeURIComponent(pane.paneId)}`,
                  });
            } catch {
              rows.push(
                ...previous
                  .filter((p) => p.machineId === machine.id)
                  .map((p) => ({ ...p, online: false })),
              );
              failures.push(`${machine.name} 状态读取失败`);
            }
          }),
        );
        if (stopped) return;
        state.remoteAgents = rows.sort((a, b) => a.machine.localeCompare(b.machine));
        state.remoteAgentError = failures.join('；');
        // Remote reads never overwrite the selected local snapshot or draft.
        const list = document.querySelector('#chatPickerList');
        list.dataset.signature = '';
        renderSidebar();
      } catch {
        /* Existing connection UI owns machine catalog errors. */
      } finally {
        pending = false;
      }
    }
    void refreshAgents();
    const timer = setInterval(() => {
      void refreshAgents();
    }, 15000);
    root.addEventListener(
      'pagehide',
      () => {
        stopped = true;
        clearInterval(timer);
      },
      { once: true },
    );
    return { refreshAgents };
  }
  root.StudioHerdrContext = { create };
})(globalThis);
