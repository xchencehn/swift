'use strict';
const { SessionInterrupt } = require('../../lib/session-interrupt');
const { ConversationStore } = require('../../lib/conversation-store');
function create(state, changed = () => {}) {
  const operations = new ConversationStore();
  return new SessionInterrupt({
    herdr: {
      dashboard: async () => ({ runtimeId: state.runtimeId || 'fixture-runtime' }),
      readPane: async (id) => {
        if (state.interruptScreens?.[id] != null) return state.interruptScreens[id];
        return (
          (state.sessions[id].pane.agent?.status === 'working'
            ? '• Working (2s • esc to interrupt)\n\n'
            : 'Worked for 2s\n\n') +
          (state.sessions[id].pane.agent?.id === 'claude'
            ? '❯ Ask Claude to do anything\n'
            : '› Ask Codex to do anything\n\n  gpt-6 high · /fixture/project · Ready · Context 1%')
        );
      },
    },
    exactPane: async (id) => ({
      ...state.sessions[id]?.pane,
      runtimeId: state.sessions[id]?.pane.runtimeId || 'fixture-process-' + id,
    }),
    readTurn: async (pane) => state.sessions[pane.paneId].interruptTurn || 'fixture-turn',
    operate: (id, work) => operations.operate(id, work),
    interrupt: async (id) => {
      (state.interruptCalls ||= []).push(id);
      if (state.interruptGate) await state.interruptGate;
      state.sessions[id].pane.agent.status = 'idle';
    },
    onInterrupted: changed,
  });
}
module.exports = { create };
