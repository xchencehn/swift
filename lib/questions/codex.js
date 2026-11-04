'use strict';
/**
 * Codex 的提问（docs/PRODUCT_SPEC.md 2.6）。与 Claude Code 完全不同，所以单独一个模块。
 *
 * 实测于 Codex v0.156.1（2026-09-25，探针会话里逐帧记录）：
 *
 *   提问    request_user_input_async({ questions: [{ title, options?: ["纯文字", …] }] })，不给 options
 *           就是只能填文字的一问。调用立刻返回 {"accepted":true} —— 那不是答案，Agent 继续干活。
 *   收起    问完面板收在「• Queued follow-up inputs」下面，只剩
 *               ? 2 questions            （过一会儿会追加计时：「? 1 question · 15s」）
 *                 alt+↑ to answer
 *   展开    按 alt+↑。带选项的：「1 of 2」、问题、「› 1. Python」这样的选项行（选中行反白）、
 *           最后一项「Other」；只能填文字的：问题加「Type your answer」（打了字就显示打的字）。
 *           底部是「enter submit   ctrl+] skip   alt+↓ main prompt[   alt+↑ next question]」。
 *   作答    每一问单独提交：选项用 ↑↓ 移动、回车；文字粘贴后回车。答完一问界面自动切到下一问。
 *   存档    每答一问写一条用户消息：
 *           <send_user_message_question_reply>[{"answer","question","questionItemId":"[\"request_user_input_async\",\"<调用 id>\",<第几问>]"}]
 *           questionItemId 精确指向「哪次调用的第几问」，据此判断还有哪些没答。
 *
 * 还兼容：同步的 request_user_input 与旧版对话框（「Question 1/1 (1 unanswered)」，结果写在
 * function_call_output 里），以及目标替换/恢复的确认（不是提问工具，是 TUI 自己的对话框）。
 */
const crypto = require('node:crypto');
const { parseLine } = require('../json-lines');
const { fail, compact, validateAnswer, moves } = require('./common');

const QUESTION_TOOL = /(?:^|\.)request_user_input(?:_async)?$/;
const QuestionReply = require('../../public/codex-question-reply');
// 收起的提问。计数行后面可能跟着「· 15s」这类计时 —— 原来要求行尾紧跟 question，计时一出现就认不出，
// 页面上的提问卡片跟着时有时无，输入框被反复重建，打字打不进去（2026-09-25 用户指出）。
const COLLAPSED =
  /^\s*\?\s*(\d+) questions?\b[^\n]*\n\s*(?:alt\+(?:↑|up)|shift\+(?:←|left)) to answer/m;

/**
 * 存档里还没答完的提问调用：最近一次还有没答的那一个。
 * @returns {{ id, async, questions: [{ index, question, header, options, answered }] } | null}
 */
function questionState(lines) {
  const receipts = [];
  const calls = new Map();
  for (const raw of lines) {
    let entry;
    try {
      entry = parseLine(raw);
    } catch {
      continue;
    }
    if (entry.type !== 'response_item') continue;
    const block = entry.payload || {};
    if (block.type === 'function_call' && QUESTION_TOOL.test(block.name || '')) {
      try {
        const questions = JSON.parse(block.arguments).questions.map((q, index) => ({
          ...q,
          index,
          id: q.id || `question-${index}`,
          question: q.question || q.title,
          options: (q.options || []).map((option) =>
            typeof option === 'string' ? { label: option, description: '' } : option,
          ),
          answered: false,
        }));
        calls.set(block.call_id, {
          id: block.call_id,
          async: block.name.endsWith('_async'),
          questions,
        });
      } catch {
        /* 写到一半的存档行 */
      }
    } else if (block.type === 'function_call_output' && calls.has(block.call_id)) {
      let output;
      try {
        output = typeof block.output === 'string' ? JSON.parse(block.output) : block.output;
      } catch {
        /* 不是 JSON */
      }
      // 异步调用立刻返回的 accepted 不是答案；同步调用的输出就是全部答案。
      if (!(calls.get(block.call_id).async && output?.accepted === true)) {
        receipts.push({ callId: block.call_id, sync: true });
        calls.delete(block.call_id);
      }
    } else if (block.type === 'message' && block.role === 'user') {
      const text = (block.content || []).map((part) => part?.text || '').join('\n');
      for (const item of QuestionReply.parts(text).filter(
        (part) => part.kind === 'question_reply',
      )) {
        let ref;
        try {
          ref = JSON.parse(item.questionItemId);
        } catch {
          continue;
        }
        const question = calls.get(ref?.[1])?.questions[ref[2]];
        if (question) {
          question.answered = true;
          receipts.push({ callId: ref[1], index: ref[2], answerHash: answerDigest(item.answer) });
        }
      }
    }
  }
  const open = [...calls.values()].filter((call) => call.questions.some((q) => !q.answered));
  return { pending: open.length ? { ...open.at(-1), calls: open } : null, receipts };
}
function pendingQuestion(lines) {
  return questionState(lines).pending;
}
function answerDigest(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}
function hasReceipt(snapshot, prompt) {
  return (snapshot?.receipts || []).some(
    (item) =>
      item.callId === prompt.toolId &&
      (item.sync || item.index === prompt.index) &&
      (!prompt.answerHash || item.answerHash === prompt.answerHash),
  );
}
function navigation(screen) {
  const footer = screen
    .split('\n')
    .findLast((line) => /enter submit/.test(line) && /skip/.test(line));
  const shift = /shift\+(?:←|→|left|right)/.test(footer || screen);
  return {
    expanded: Boolean(footer && screen.trimEnd().endsWith(footer.trimEnd())),
    open: shift ? 'shift+left' : 'alt+up',
    next: shift ? 'shift+left' : 'alt+up',
    previous: shift ? 'shift+right' : 'alt+down',
    canNext: /next question/.test(footer || ''),
    canPrevious: /prev question/.test(footer || ''),
    canMain: /main prompt/.test(footer || ''),
    canSkip: /(?:\^\]|ctrl\+\]) skip/.test(footer || ''),
  };
}

/** 旧版（同步提问）对话框：「Question 1/2 (1 unanswered)」…「enter to submit answer」。 */
function codexDialog(screen, pending) {
  if (!pending?.questions?.length) return null;
  const headers = [...screen.matchAll(/^\s*Question (\d+)\/(\d+) \(\d+ unanswered\)/gm)];
  const header = headers.at(-1);
  if (!header) return null;
  const body = screen.slice(header.index).trim();
  if (!compact(body).includes('entertosubmitanswer')) return null;
  const index = Number(header[1]) - 1;
  const question = pending.questions[index];
  if (
    !question ||
    Number(header[2]) !== pending.questions.length ||
    !compact(body).includes(compact(question.question))
  )
    return null;
  const rows = [...body.matchAll(/^\s*([› ]?)\s*(\d+)\.\s+(.+)$/gmu)];
  const options = question.options || [];
  if (
    !options.every((option, i) =>
      rows.some(
        (row) =>
          Number(row[2]) === i + 1 &&
          (row[3] === option.label || row[3].startsWith(option.label + '  ')),
      ),
    )
  )
    return null;
  const selected = rows.find((row) => row[1] === '›');
  if (
    !selected ||
    !rows.some(
      (row) => Number(row[2]) === options.length + 1 && row[3].startsWith('None of the above'),
    )
  )
    return null;
  return {
    stage: 'question',
    index,
    total: pending.questions.length,
    question: question.question,
    header: question.header,
    multiSelect: false,
    options,
    selected: Number(selected[2]) - 1,
    checked: [],
    editing: compact(body).includes('taboresctoclearnotes'),
    fingerprint: body,
    legacy: true,
  };
}

/**
 * 展开的异步提问（v0.156.1）：「• Queued follow-up inputs」到「enter submit … alt+↓ main prompt」之间。
 * 问的是哪一问靠存档里还没答的那些问题去对：画面上的题面可能折行，打进去的字也可能多行。
 */
function queuedDialog(screen, pending) {
  if (!pending?.questions?.length) return null;
  const lines = screen.split('\n');
  const footer = lines.findLastIndex(
    (line) =>
      /\benter submit\b/.test(line) &&
      /(?:alt\+(?:↓|down)|shift\+(?:→|right)) (?:main prompt|prev question)/.test(line),
  );
  if (footer < 0 || footer !== lines.findLastIndex((line) => line.trim())) return null;
  const start = lines.findLastIndex((line) => /^\s*[•·]\s*Queued follow-up inputs\s*$/.test(line));
  if (start < 0 || start >= footer) return null;
  let body = lines
    .slice(start + 1, footer)
    .map((line) => line.trim())
    .filter(Boolean);
  const ordinal = /^(\d+) of (\d+)$/.exec(body[0] || '');
  if (ordinal) body = body.slice(1);
  const questionText = compact(body.join(''));
  // 题面是画面开头那一段：选最长的、能对上开头的那一问（避免短题面误配长题面的前缀）。
  const question = pending.questions
    .filter((q) => !q.answered && questionText.startsWith(compact(q.question)))
    .sort((a, b) => compact(b.question).length - compact(a.question).length)[0];
  if (!question) return null;
  const base = {
    stage: 'question',
    index: question.index,
    total: pending.questions.length,
    question: question.question,
    header: question.header,
    multiSelect: false,
    checked: [],
    expanded: true,
    queued: true,
    position: ordinal ? Number(ordinal[1]) : 1,
    remaining: ordinal ? Number(ordinal[2]) : 1,
    navigation: navigation(screen),
  };
  const joined = body.join('\n'),
    need = compact(question.question).length;
  let cut = 0;
  for (let seen = 0; cut < joined.length && seen < need; cut += 1)
    if (!/\s/.test(joined[cut])) seen += 1;
  const answerBody = joined.slice(cut).trim().split('\n').filter(Boolean);
  const rowAt = answerBody.findIndex((line) => /^(?:›\s*)?1\.\s+\S/.test(line));
  if (!(question.options || []).length) {
    // 只能填文字：题面之后剩下的就是答题位 ——「Type your answer」占位，或者已经打进去的字。
    const text = answerBody.join('\n').trim();
    return {
      ...base,
      options: [],
      selected: -1,
      text: text === 'Type your answer' ? '' : text,
      textOnly: true,
      fingerprint: joined,
    };
  }
  if (rowAt < 0) return null;
  const rows = [];
  for (const line of answerBody.slice(rowAt)) {
    const row = /^(›\s*)?(\d+)\.\s+(.+)$/.exec(line);
    if (row) rows.push(row);
    else if (rows.length) rows.at(-1)[3] += '\n' + line;
  }
  const options = question.options || [];
  if (
    !options.every((option, i) =>
      rows.some(
        (row) => Number(row[2]) === i + 1 && compact(row[3]).startsWith(compact(option.label)),
      ),
    )
  )
    return null;
  const selected = rows.find((row) => row[1]);
  // 最后一行是自填行：空着时写「Other」，打了字就显示打的字（实测：移到这一行粘贴「MySQL」，它变成「› 3. MySQL」）。
  const other = rows.find((row) => Number(row[2]) === options.length + 1);
  if (!selected) return null;
  return {
    ...base,
    options,
    selected: Number(selected[2]) - 1,
    otherIndex: other ? options.length : -1,
    text: other && !/^Other$/.test(other[3].trim()) ? other[3].trim() : '',
    fingerprint: body.join('\n'),
  };
}

// 目标替换/恢复的确认：TUI 自己的对话框，不是 request_user_input；Agent 可能还在跑。
function codexGoalDialog(screen) {
  const lines = screen.split('\n');
  const start = lines.findLastIndex((line) =>
    /^\s*(Replace goal\?|Resume paused goal\?)\s*$/.test(line),
  );
  if (start < 0) return null;
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      /^\s*(?:Press enter to confirm or esc to go back|enter select · esc back)\s*$/.test(line),
  );
  if (end < 0) return null;
  const body = lines.slice(start + 1, end);
  const replace = lines[start].trim() === 'Replace goal?';
  const expected = replace
    ? [
        ['Replace current goal', 'Set the new objective and start it now'],
        ['Cancel', 'Keep the current goal'],
      ]
    : [
        ['Resume goal', 'Mark it active and continue when idle'],
        ['Leave paused', 'Keep it paused; use /goal resume later'],
      ];
  const rows = body
    .map((line, index) => ({ index, match: line.match(/^\s*([›❯>]?)\s*(\d+)\.\s+(.+?)\s*$/) }))
    .filter((row) => row.match);
  // Native options wrap, or omit both descriptions when the pane is too narrow.
  // Accept only those complete known forms, never partially changed copy.
  const compact = (value) => value.replace(/\s+/g, '');
  const optionText = rows.map((row, i) =>
    compact(
      [row.match[3], ...body.slice(row.index + 1, rows[i + 1]?.index ?? body.length)].join(' '),
    ),
  );
  if (
    rows.length !== 2 ||
    rows.some((row, i) => Number(row.match[2]) !== i + 1) ||
    ![true, false].some((descriptions) =>
      optionText.every(
        (text, i) => text === compact(descriptions ? expected[i].join(' ') : expected[i][0]),
      ),
    ) ||
    rows.filter((row) => row.match[1]).length !== 1
  )
    return null;
  const objective = body
    .slice(0, rows[0].index)
    .map((line) => line.trim().replace(/^›\s+(?=Goal:)/, ''))
    .filter(Boolean)
    .join(' ');
  if (!(replace ? /^New objective:\s+\S/ : /^Goal:\s+\S/).test(objective)) return null;
  return {
    stage: 'question',
    index: 0,
    total: 1,
    question: `${lines[start].trim()} ${objective}`,
    options: expected.map(([label, description]) => ({ label, description })),
    selected: rows.findIndex((row) => row.match[1]),
    checked: [],
    multiSelect: false,
    allowText: false,
  };
}

function nativeSelection(panel) {
  if (!panel || panel.kind.startsWith('goal-')) return null;
  const footer = panel.lines.findIndex(
    (line, i) =>
      i > 0 &&
      /(?:enter.*(?:select|confirm|submit|continue|default)|esc.*(?:cancel|close|back)|No action is required)/i.test(
        line,
      ),
  );
  const body = panel.lines.slice(1, footer < 0 ? undefined : footer),
    rows = [];
  if (panel.action === 'hooks')
    return {
      stage: 'question',
      index: 0,
      total: 1,
      question: [panel.title, ...body].join('\n'),
      options: panel.actions.map(({ label }) => ({ label })),
      selected: 0,
      checked: [],
      multiSelect: false,
      allowText: false,
    };
  if (panel.action || !panel.numbered) {
    const form = panel.action === 'form' && panel.submitKeys?.length;
    const cancel = panel.action !== 'continue';
    if (
      !form &&
      cancel &&
      panel.action !== 'customize' &&
      !/esc.*(?:cancel|close|back|skip|quit|continue)/i.test(panel.lines.join(' '))
    )
      return null;
    return {
      stage: 'question',
      index: 0,
      total: 1,
      question: [panel.title, ...body].join('\n'),
      options: [
        {
          label: cancel
            ? /esc.*quit/.test(panel.lines.at(-1))
              ? '退出 Codex'
              : '取消／返回'
            : '继续',
        },
      ],
      selected: 0,
      checked: [],
      multiSelect: false,
      allowText: Boolean(form),
      confirmKey: panel.action === 'customize' ? 'b' : cancel ? 'esc' : 'enter',
    };
  }
  for (const line of body) {
    const match = /^\s*([›❯»>]?)\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (match) {
      const [label, ...description] =
        panel.kind === 'rate-limit' ? match[3].split(/\s{2,}/) : [match[3]];
      rows.push({
        number: Number(match[2]),
        selected: Boolean(match[1]),
        label,
        description: description.join(' '),
      });
    } else if (rows.length && line.trim())
      rows.at(-1).description += (rows.at(-1).description ? ' ' : '') + line.trim();
  }
  if (
    !rows.length ||
    rows.some((row, i) => row.number !== i + (panel.scrollable ? rows[0].number : 1)) ||
    rows.filter((row) => row.selected).length !== 1
  )
    return null;
  const hint = panel.lines.at(-1),
    sessionOnly = /\bs session\b/.test(hint);
  // Model pickers distinguish the current session from durable defaults.
  // Never translate an existing session setting into a default-setting Enter.
  if (/\benter default\b/.test(hint) && !sessionOnly) return null;
  const first = body.findIndex((line) => /^\s*[›❯»>]?\s*\d+\.\s+\S/.test(line));
  const context = body
    .slice(0, first)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  return {
    stage: 'question',
    index: 0,
    total: 1,
    question: [panel.title, context].filter(Boolean).join('\n'),
    options: rows.map(({ label, description }) => ({ label, description })),
    selected: rows.findIndex((row) => row.selected),
    checked: [],
    multiSelect: false,
    allowText: false,
    confirmKey: sessionOnly ? 's' : 'enter',
  };
}

/**
 * 当前屏幕上有没有要回答的东西。返回统一的提问（不含 challenge，由调度层按会话身份加上）；
 * `identity` 是这道题稳定的标识，`fingerprint` 是此刻画面的指纹（没有就表示画面怎么变都算同一张卡）。
 * state.goalPrompts：同一个目标确认对话框在一段时间里保持同一个标识。
 */
function inspect({ pane, lines, screen, rawScreen, state, pending: archivedPending }) {
  const panel = rawScreen ? require('../codex-footer').codexInteraction(rawScreen).modal : null;
  const foreground = panel ? panel.lines.join('\n') : screen;
  const goal = codexGoalDialog(foreground);
  if (goal) {
    state.nativePrompts?.delete(pane.paneId);
    const occupant = JSON.stringify([
      pane.terminalId,
      pane.runtimeId,
      pane.agent.session?.value || '',
      goal.question,
    ]);
    if (state.goalPrompts.get(pane.paneId)?.occupant !== occupant) {
      state.goalPrompts.set(pane.paneId, { occupant, id: crypto.randomUUID() });
      if (state.goalPrompts.size > 256)
        state.goalPrompts.delete(state.goalPrompts.keys().next().value);
    }
    const { selected, ...content } = goal;
    return {
      ...goal,
      blocking: true,
      toolId: 'goal-confirmation',
      ...(panel ? { nativeModal: { kind: panel.kind, key: panel.key } } : {}),
      identity: ['goal-confirmation', content, state.goalPrompts.get(pane.paneId).id],
    };
  }
  state.goalPrompts.delete(pane.paneId);
  const selection = nativeSelection(panel);
  if (selection) {
    state.nativePrompts ||= new Map();
    const occupant = JSON.stringify([
      pane.terminalId,
      pane.runtimeId,
      pane.agent.session?.value || '',
      panel.key,
    ]);
    if (state.nativePrompts.get(pane.paneId)?.occupant !== occupant) {
      state.nativePrompts.set(pane.paneId, { occupant, id: crypto.randomUUID() });
      if (state.nativePrompts.size > 256)
        state.nativePrompts.delete(state.nativePrompts.keys().next().value);
    }
    return {
      ...selection,
      toolId: 'native-selection',
      blocking: true,
      nativeModal: {
        kind: panel.kind,
        key: panel.key,
        title: panel.title,
        scrollable: panel.scrollable,
        action: panel.action,
        actions: panel.actions,
        toggle: panel.toggle,
        input: panel.input,
        submitKeys: panel.submitKeys,
      },
      identity: ['native-selection', panel.key, state.nativePrompts.get(pane.paneId).id],
    };
  }
  state.nativePrompts?.delete(pane.paneId);
  const pending = archivedPending === undefined ? pendingQuestion(lines) : archivedPending;
  if (!pending) return null;
  const calls = pending.calls || [pending];
  for (const call of calls) {
    const legacy = codexDialog(screen, call);
    if (legacy) {
      const { fingerprint, ...visible } = legacy;
      return { ...visible, toolId: call.id, identity: [call.id], fingerprint };
    }
  }
  const expanded = calls
    .map((call) => ({ call, visible: queuedDialog(screen, call) }))
    .filter((item) => item.visible);
  if (expanded.length === 1) {
    const { call, visible } = expanded[0];
    const { fingerprint, ...value } = visible;
    return { ...value, toolId: call.id, blocking: false, identity: [call.id, value.index] };
  }
  // A collapsed summary gives the native count, not evidence that an archived
  // unanswered question is still active. Opening it resolves the actual item.
  const collapsed = COLLAPSED.exec(screen.slice(screen.lastIndexOf('Queued follow-up inputs')));
  if (!collapsed) return null;
  const call = calls.find((item) => item.questions.some((q) => !q.answered));
  const question = call?.questions.find((q) => !q.answered);
  if (!question?.question) return null;
  return {
    toolId: call.id,
    collapsed: true,
    queued: true,
    blocking: false,
    stage: 'question',
    index: question.index,
    total: call.questions.length,
    remaining: Number(collapsed[1]),
    position: 0,
    navigation: navigation(screen),
    question: question.question,
    header: question.header,
    options: question.options || [],
    multiSelect: false,
    selected: -1,
    checked: [],
    identity: [call.id, question.index],
  };
}

/**
 * 作答。io：keys(按键)、paste(只粘贴，不带回车)、text(旧版编辑框用的粘贴并提交)、
 * reread(判定) —— 重读当前提问直到满足判定，读不到返回 null；until(判定) —— 判定可收到 null。
 */
async function answer({ prompt, payload, io }) {
  const { choices, custom } = validateAnswer(prompt, payload);
  if (prompt.toolId === 'goal-confirmation' || !(prompt.collapsed || prompt.expanded))
    return answerDialog({ prompt, choices, custom, io });
  return answerQueued({ prompt, choices, custom, io });
}

// 旧版对话框与目标确认：一屏里就是完整的对话框，光标位置可见。
async function answerDialog({ prompt, choices, custom, io }) {
  if (prompt.editing) throw fail('终端正在编辑答案，请先完成当前编辑。');
  if (prompt.nativeModal) {
    if (custom) {
      if (prompt.nativeModal.action !== 'form' || !prompt.nativeModal.submitKeys?.length)
        throw fail('这个原生确认只能选择当前选项。', 400);
      if (prompt.nativeModal.input) throw fail('终端表单已有内容，请先在终端完成当前输入。');
      await io.paste(custom);
      const filled = await io.reread(
        (q) => q.nativeModal?.key === prompt.nativeModal.key && q.nativeModal.input === custom,
      );
      if (!filled) throw fail('尚未确认表单内容，未提交回答。');
      await io.keys(prompt.nativeModal.submitKeys);
      return (await io.until((q) => q?.nativeModal?.key !== prompt.nativeModal.key))
        ? 'sent'
        : 'uncertain';
    }
    let selected = prompt.selected;
    const same = (q) => q?.nativeModal?.key === prompt.nativeModal.key;
    if (prompt.nativeModal.action === 'hooks') {
      if (!(await io.reread(same))) throw fail('Hooks 审查已变化，未提交操作。');
      await io.keys([prompt.nativeModal.actions[choices[0]].key]);
      return (await io.until((q) => !same(q))) ? 'sent' : 'uncertain';
    }
    for (const key of moves(selected, choices[0])) {
      await io.keys([key]);
      selected += key === 'down' ? 1 : -1;
      if (!(await io.reread((q) => same(q) && q.selected === selected)))
        throw fail('原生确认界面已变化，未提交选项。');
    }
    if (!(await io.reread((q) => same(q) && q.selected === choices[0])))
      throw fail('尚未确认原生选项，未继续提交。');
    await io.keys([prompt.confirmKey || 'enter']);
    // A key transport acknowledgement does not prove that the native dialog
    // accepted the choice. Confirm a new foreground view or a closed dialog.
    return (await io.until((q) => !same(q))) ? 'sent' : 'uncertain';
  }
  if (!custom) {
    await io.keys([...moves(prompt.selected, choices[0]), 'enter']);
    return 'sent';
  }
  // 自填：移到「None of the above」，tab 进入备注编辑，确认进了同一题的编辑状态再粘贴。
  await io.keys([...moves(prompt.selected, prompt.options.length), 'tab']);
  const editing = await io.reread(
    (q) =>
      q.toolId === prompt.toolId &&
      q.index === prompt.index &&
      q.editing &&
      q.selected === prompt.options.length,
  );
  if (!editing) throw fail('终端提问已变化，请查看当前问题。');
  await io.text(custom);
  return 'sent';
}

// 异步提问：先展开，切到要答的那一问，再答；以存档里出现这一问的回答为准。
async function navigateQueued({ prompt, io }) {
  const exact = (q) => q?.toolId === prompt.toolId && q.index === prompt.index;
  let view = prompt.expanded ? prompt : null;
  if (!view) {
    await io.keys([prompt.navigation?.open || 'alt+up']);
    view = await io.reread((q) => q.queued && q.expanded);
    if (!view) throw fail('终端没有展开这个提问，请在终端里回答。');
  }
  // 展开后停在的不一定是这一问：alt+↑ 在展开状态下是「下一问」。
  const visited = new Set();
  for (
    let turn = 0;
    !exact(view) &&
    turn < Math.min(128, prompt.browseCount || prompt.remaining || prompt.total || 1);
    turn += 1
  ) {
    const from = `${view.toolId}:${view.index}`;
    if (visited.has(from) || !view.navigation?.canNext) break;
    visited.add(from);
    await io.keys([view.navigation?.next || 'alt+up']);
    view = await io.reread((q) => q.queued && q.expanded && `${q.toolId}:${q.index}` !== from);
    if (!view) throw fail('终端里切不到这一问，请在终端里回答。');
  }
  if (!exact(view)) throw fail('终端里找不到这一问，请在终端里回答。');
  return view;
}
async function answerQueued({ prompt, choices, custom, io }) {
  const same = (q) => q && q.toolId === prompt.toolId;
  let view = await navigateQueued({ prompt, io });
  if (custom) {
    if (!view.textOnly) {
      if (view.otherIndex < 0) throw fail('这一问只能从选项里选。', 400);
      await io.keys(moves(view.selected, view.otherIndex));
      view = await io.reread(
        (q) =>
          same(q) &&
          q.expanded &&
          q.index === prompt.index &&
          (q.textOnly || q.selected === q.otherIndex),
      );
      if (!view) throw fail('终端里没有选中「Other」，请在终端里回答。');
    }
    // 只粘贴，确认字确实进了答题位，再按一次回车。不用主输入框那套「补按回车」：
    // 这一问提交后界面会切到下一问，补按的回车会把下一问的默认选项也提交掉。
    // 答题位里已经是这些字（比如上一次粘贴了却没来得及回车）就不再粘贴，否则会叠成两份；
    // 里面是别的字就停下，不去猜怎么清空。
    if (view.text && compact(view.text) !== compact(custom))
      throw fail('终端的答题位里已经有别的内容，请在终端里确认。');
    if (!view.text) await io.paste(custom);
    const typed = await io.reread(
      (q) => same(q) && q.index === prompt.index && compact(q.text) === compact(custom),
    );
    if (!typed) throw fail('答案没有进到终端的答题位，请在终端里确认。');
  } else {
    await io.keys(moves(view.selected, choices[0]));
    const moved = await io.reread(
      (q) => same(q) && q.index === prompt.index && q.selected === choices[0],
    );
    if (!moved) throw fail('终端里的选项没有移到位，请在终端里确认。');
  }
  await io.keys(['enter']);
  // 以存档为准：这一问的回答写进存档（或提问整个没了）才算提交成功。
  const done = io.confirm
    ? await io.confirm({
        ...prompt,
        answerHash: answerDigest(custom || prompt.options[choices[0]].label),
      })
    : await io.until((q) => !same(q) || q.index !== prompt.index, 40);
  return done ? 'sent' : 'uncertain';
}

module.exports = {
  inspect,
  answer,
  navigateQueued,
  pendingQuestion,
  questionState,
  hasReceipt,
  answerDigest,
  navigation,
  COLLAPSED,
  codexDialog,
  queuedDialog,
  codexGoalDialog,
};
