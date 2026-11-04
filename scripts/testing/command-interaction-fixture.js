'use strict';
const { CommandInteraction } = require('../../lib/command-interaction');
function create(state) {
  const panes = (state.nativeCommandPanes = {});
  const names = [
    'model',
    'compact',
    'status',
    'fast',
    'skills',
    'permissions',
    'review',
    'help',
    'hfork',
    'warnings',
    'ps',
  ];
  const menuRows = (labels, selected) =>
    labels.map((label, i) => `${i === selected ? '›' : ' '} ${i + 1}. ${label}`).join('\n');
  const paneState = (id) =>
    (panes[id] ||= {
      input: '',
      phase: '',
      selected: 0,
      result: '',
      command: '',
      pendingModel: '',
      writes: [],
    });
  const labels = (phase) =>
    phase === 'model'
      ? ['codex 测试模型', 'codex 测试模型二']
      : phase === 'effort'
        ? ['low', 'medium', 'high']
        : phase === 'skills'
          ? ['test-skill']
          : ['Default', 'Full access'];
  const candidates = (p) => names.filter((name) => name.startsWith(p.input.slice(1).split(' ')[0]));
  function raw(id) {
    const p = paneState(id);
    if (p.phase === 'warnings') {
      p.warningVisited ||= [];
      if (!p.warningVisited.includes(p.warningIndex)) p.warningVisited.push(p.warningIndex);
      return `Native history\n\n\x1b[1mWarnings · ${p.warningIndex + 1} of 2 · MCP · fixture\x1b[0m\n\n测试警告 ${p.warningIndex + 1}：保留完整说明。\n滚动位置 ${p.warningScroll || 0}\n\nk keep & next · esc dismiss & close`;
    }
    if (p.phase)
      return (
        'Native history\n\n  ' +
        ({
          model: 'Select Model and Effort',
          effort: 'Select Reasoning Level',
          skills: 'Select Skill',
          permissions: 'Choose permissions',
        }[p.phase] || 'Native input') +
        '\n\n' +
        (p.phase === 'skill-input' ? '› ' + p.input : menuRows(labels(p.phase), p.selected)) +
        '\n\n  enter select · esc back'
      );
    if (p.input)
      return (
        'Native history\n\n' +
        candidates(p)
          .map((name, i) => `${i === p.selected ? '›' : ' '} /${name}      native ${name}`)
          .join('\n') +
        '\n\n› ' +
        p.input +
        '\n\n fixture high · Ready · Context 1%'
      );
    return (
      'Native history\n\n' +
      (p.result ? `${p.command}\n${p.result}\n\n` : '') +
      '› \x1b[2mAsk Codex to do anything\x1b[0m\n\n fixture high · Ready · Context 1%'
    );
  }
  async function press(id, keys) {
    const p = paneState(id),
      session = state.sessions[id];
    p.writes.push({ keys });
    for (const key of keys) {
      if (p.phase === 'warnings') {
        if (key === 'right') p.warningIndex = Math.min(1, p.warningIndex + 1);
        if (key === 'left') p.warningIndex = Math.max(0, p.warningIndex - 1);
        if (key === 'up') p.warningScroll = Math.max(0, (p.warningScroll || 0) - 1);
        if (key === 'down') p.warningScroll = (p.warningScroll || 0) + 1;
        if (key === 'k') {
          if (!p.warningKept.includes(p.warningIndex)) p.warningKept.push(p.warningIndex);
          if (p.warningIndex === 1) {
            p.phase = '';
            p.result = 'Warnings retained';
          } else p.warningIndex++;
        }
        if (key === 'esc') {
          p.warningDismissed = p.warningVisited.filter((index) => !p.warningKept.includes(index));
          p.phase = '';
          p.result = 'Warnings dismissed';
        }
        continue;
      }
      const list = p.phase ? labels(p.phase) : candidates(p);
      if (key === 'ctrl+u') p.input = '';
      if (key === 'down') p.selected = Math.min(list.length - 1, p.selected + 1);
      if (key === 'up') p.selected = Math.max(0, p.selected - 1);
      if (key === 'home') p.selected = 0;
      if (key === 'end') p.selected = list.length - 1;
      if (/^[1-9]$/.test(key)) p.selected = Number(key) - 1;
      if (key === 'esc') {
        if (p.phase === 'effort') {
          p.phase = 'model';
          p.selected = 0;
        } else {
          p.phase = '';
          p.input = '';
        }
      }
      if (key === 'backspace') p.input = p.input.slice(0, -1);
      if (key === 'tab' && !p.phase && list[p.selected]) p.input = '/' + list[p.selected] + ' ';
      if (key === 'enter' || key === 's') {
        if (p.phase === 'model') {
          p.pendingModel =
            p.selected === 1 ? 'codex-fixture-model-alternate' : 'codex-fixture-model';
          p.phase = 'effort';
          p.selected = 2;
        } else if (p.phase === 'effort') {
          session.settings.model = p.pendingModel;
          session.settings.effort = labels('effort')[p.selected];
          p.phase = '';
          p.input = '';
          p.result = 'Model changed for this session only';
        } else if (p.phase === 'skills') {
          p.phase = 'skill-input';
          p.input = '$test-skill ';
        } else if (p.phase === 'skill-input') {
          session.messages.push({
            id: 'native-skill-' + Date.now(),
            role: 'user',
            blocks: [{ kind: 'text', text: p.input }],
          });
          p.phase = '';
          p.input = '';
          p.result = 'Skill input accepted';
        } else if (p.phase) {
          p.phase = '';
          p.input = '';
          p.result = 'Native choice applied';
        } else {
          const name = list[p.selected] || p.input.slice(1).trim();
          p.command = '/' + name;
          p.input = '';
          p.selected = 0;
          if (['model', 'skills', 'permissions'].includes(name)) p.phase = name;
          else if (name === 'warnings') {
            p.phase = 'warnings';
            p.warningIndex = 0;
            p.warningKept = [];
            p.warningVisited = [];
            p.warningDismissed = [];
          } else if (name === 'ps')
            p.result = 'Background terminals\n\n  • fixture-background-command';
          else if (name === 'hfork' && state.nativeFork) {
            p.result = 'Forking into a Herdr pane on the right…';
            void state.nativeFork(id).then(
              (result) => {
                p.result = result;
              },
              (error) => {
                p.result = '■ ' + error.message;
              },
            );
          } else if (name === 'status')
            p.result =
              '  OpenAI Codex (fixture ' +
              (p.statusReads = (p.statusReads || 0) + 1) +
              ')\n  Model: fixture\n  Session: ' +
              session.pane.agent.session.value +
              '\n  Account: connected@example.test (Pro)\n  Context window: 88% left';
          else if (name === 'fast') {
            session.settings.serviceTier = session.settings.serviceTier ? '' : 'priority';
            p.result = 'Service tier set to ' + (session.settings.serviceTier || 'default');
          } else
            p.result = name === 'compact' ? 'Context compacted' : 'Native ' + name + ' executed';
        }
      }
    }
  }
  return new CommandInteraction({
    herdr: {
      dashboard: async () => ({ runtimeId: state.runtimeId || 'fixture-runtime' }),
      readPane: async (id) => raw(id),
    },
    exactPane: async (id) => state.sessions[id].pane,
    settleMs: 0,
    press,
    paste: async (id, text) => {
      const p = paneState(id);
      p.writes.push({ text });
      p.input += text;
      p.selected = 0;
    },
  });
}
module.exports = { create };
