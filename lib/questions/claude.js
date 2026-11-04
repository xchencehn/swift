'use strict';
/**
 * Claude Code 的提问（docs/PRODUCT_SPEC.md 2.6）：
 *
 *   - AskUserQuestion：分步对话框「Question n/m」，逐题回答，多选用空格勾选，最后有一个确认汇总页；
 *     自填走列表最后的「Type something」。它是阻塞的：Agent 停下来等回答。
 *   - 工具审批（permission）与遗留的模型缓存确认：不是 AskUserQuestion，形状也不同
 *     （claude-control.js 的 permissionPrompt / cacheSwitchConfirmation）。
 *
 * 存档说有没有待答的提问，终端画面说它此刻长什么样、光标在哪。Codex 的提问机制完全不同，见 codex.js。
 */
const { parseLine } = require('../json-lines');
const { cacheSwitchConfirmation, permissionPrompt } = require('../claude-control');
const { fail, compact, digest, validateAnswer, moves } = require('./common');

/** 存档里还没有结果的 AskUserQuestion。 */
function pendingQuestion(lines) {
  const pending = new Map();
  for (const raw of lines) {
    let entry;
    try {
      entry = parseLine(raw);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion')
        pending.set(block.id, { id: block.id, questions: block.input?.questions });
      if (block.type === 'tool_result') pending.delete(block.tool_use_id);
    }
  }
  return [...pending.values()].at(-1) || null;
}

function claudeDialog(screen, pending) {
  if (!pending?.questions?.length) return null;
  const header = [...screen.matchAll(/^.*[☐☒] .+$/gm)].at(-1);
  const body = screen.slice(header ? header.index : screen.length).trim();
  if (
    /Review your answers/.test(body) &&
    /Ready to submit your answers\?/.test(body) &&
    /❯\s*1\. Submit answers/.test(body)
  ) {
    return {
      stage: 'review',
      question: '确认答案',
      review: body
        .slice(body.indexOf('Review your answers') + 19, body.indexOf('Ready to submit'))
        .trim(),
      options: [],
      selected: 0,
      fingerprint: body,
    };
  }
  if (!compact(body).includes('Entertoselect') || !compact(body).includes('Esctocancel'))
    return null;
  const rows = [...body.matchAll(/^\s*([❯ ]?)\s*(\d+)\.\s*(?:\[([ ✔xX])\]\s*)?(.+)$/gmu)];
  const selected = rows.find((row) => row[1] === '❯');
  if (!selected) return null;
  const index = pending.questions.findIndex(
    (q) =>
      compact(body).includes(compact(q.question)) &&
      q.options?.every((option, i) =>
        rows.some((row) => Number(row[2]) === i + 1 && row[4] === option.label),
      ),
  );
  if (index < 0) return null;
  const question = pending.questions[index];
  const editing = compact(body).includes('ctrl+gtoedit');
  const other = rows.find(
    (row) =>
      Number(row[2]) === question.options.length + 1 &&
      (editing || /^Type something\.?$/.test(row[4])),
  );
  if (!other) return null;
  return {
    stage: 'question',
    index,
    total: pending.questions.length,
    question: question.question,
    header: question.header,
    multiSelect: Boolean(question.multiSelect),
    options: question.options,
    selected: Number(selected[2]) - 1,
    checked: rows.slice(0, question.options.length).map((row) => /[✔xX]/.test(row[3] || '')),
    editing,
    otherText: /^Type something\.?$/.test(other[4]) ? '' : other[4],
    otherChecked: /[✔xX]/.test(other[3] || ''),
    fingerprint: body,
  };
}

// Claude can display AskUserQuestion before flushing its tool_use to disk.
// Accept only its dedicated question widget, never a generic numbered menu.
function visibleClaudeQuestion(screen, lines) {
  const headers = [...screen.matchAll(/^.*[☐☒] .+$/gm)];
  const header = headers.at(-1);
  if (!header) return null;
  const body = screen.slice(header.index).trim();
  const review = /Review your answers/.test(body) && /Ready to submit your answers\?/.test(body);
  if (
    !review &&
    (!compact(body).includes('Entertoselect') ||
      !compact(body).includes('Esctocancel') ||
      !/\d+\. Chat about this/.test(body))
  )
    return null;
  let lastUser = '';
  for (const raw of lines) {
    let entry;
    try {
      entry = parseLine(raw);
    } catch {
      continue;
    }
    if (
      entry.type === 'user' &&
      (typeof entry.message?.content === 'string' ||
        entry.message?.content?.some?.((b) => b.type === 'text'))
    )
      lastUser = entry.uuid || digest(entry);
  }
  if (!lastUser) return null;
  const id = `native-${lastUser}`;
  if (review) return { id, questions: [{ question: '', options: [] }] };
  const firstOption = body.search(/^\s*❯?\s*1\./m);
  if (firstOption < 0) return null;
  const question = body.slice(body.indexOf('\n') + 1, firstOption).trim();
  const rows = [...body.matchAll(/^\s*([❯ ]?)\s*(\d+)\.\s*(?:\[([ ✔xX])\]\s*)?(.+)$/gmu)];
  const otherIndex = rows.findIndex((row) => /^Type something\.?$/.test(row[4]));
  if (
    otherIndex < 1 ||
    otherIndex > 4 ||
    rows.slice(0, otherIndex + 1).some((row, i) => Number(row[2]) !== i + 1)
  )
    return null;
  const options = rows.slice(0, otherIndex).map((row, i) => ({
    label: row[4],
    description: body.slice(row.index + row[0].length, rows[i + 1].index).trim(),
  }));
  return {
    id,
    questions: [{ question, options, multiSelect: rows[0][3] !== undefined }],
    visible: true,
  };
}

/**
 * 当前屏幕上有没有要回答的东西。返回统一的提问（不含 challenge，由调度层按会话身份加上），
 * `identity` 是这道题稳定的标识，`fingerprint` 是此刻画面的指纹（画面一变 challenge 就变）。
 */
function inspect({ pane, lines, screen }) {
  // 工具审批挡住了一切后续操作，所以排在其它判定之前。
  const permission = permissionPrompt(screen);
  if (permission) {
    return {
      toolId: 'permission',
      header: permission.title,
      stage: 'question',
      index: 0,
      total: 1,
      blocking: true,
      question: permission.detail
        ? `${permission.question}\n\n${permission.detail}`
        : permission.question,
      options: permission.rows.map((row) => ({ label: row.label, description: '' })),
      selected: permission.selected,
      checked: [],
      multiSelect: false,
      allowText: false,
      identity: ['permission'],
      fingerprint: permission.fingerprint,
    };
  }
  let pending = pendingQuestion(lines);
  const confirmation = cacheSwitchConfirmation(screen);
  if (confirmation) {
    return {
      toolId: 'model-confirmation',
      stage: 'question',
      index: 0,
      total: 1,
      question: `${confirmation.title} ${confirmation.target}`,
      options: confirmation.rows.map((row) => ({ label: row.label, description: '' })),
      selected: confirmation.selected,
      checked: [],
      multiSelect: false,
      allowText: false,
      identity: ['model-confirmation'],
      fingerprint: confirmation.fingerprint,
    };
  }
  if (!pending && (pane.agent.status || pane.status) !== 'blocked') return null;
  if (!pending) pending = visibleClaudeQuestion(screen, lines);
  if (!pending) return null;
  const dialog = claudeDialog(screen, pending);
  if (!dialog) return null;
  const { fingerprint, ...visible } = dialog;
  return { ...visible, toolId: pending.id, identity: [pending.id], fingerprint };
}

/**
 * 作答。io：keys(按键)、text(粘贴)、reread(判定, 说明) —— 重读当前提问直到满足判定，读不到返回 null。
 * 返回 'sent'；写入之后出错由调用方记成「待确认」。
 */
async function answer({ prompt, payload, io }) {
  if (prompt.stage === 'review') {
    if (payload.confirm !== true) throw fail('请确认答案。', 400);
    await io.keys(['enter']);
    return 'sent';
  }
  const { choices, custom } = validateAnswer(prompt, payload);
  if (prompt.editing) throw fail('终端正在编辑答案，请先完成当前编辑。');
  const keys = [];
  let cursor = prompt.selected;
  const move = (target) => {
    keys.push(...moves(cursor, target));
    cursor = target;
  };
  if (custom) {
    if (prompt.multiSelect)
      for (let i = 0; i < prompt.options.length; i++)
        if (prompt.checked[i]) {
          move(i);
          keys.push('space');
        }
    move(prompt.options.length);
    keys.push('enter');
  } else if (prompt.multiSelect) {
    for (let i = 0; i < prompt.options.length; i++)
      if (prompt.checked[i] !== choices.includes(i)) {
        move(i);
        keys.push('space');
      }
    move(prompt.options.length + 1);
    keys.push('enter');
  } else {
    move(choices[0]);
    keys.push('enter');
  }
  await io.keys(keys);
  if (!custom) return 'sent';
  // 回车打开原生的「Type something」编辑框。粘贴之前重读一次，确认真的进了同一题的编辑状态 ——
  // 否则文字会悄悄变成一条新的会话消息。
  const editing = await io.reread(
    (q) =>
      q.toolId === prompt.toolId &&
      q.index === prompt.index &&
      q.editing &&
      q.selected === prompt.options.length,
  );
  if (!editing) throw fail('终端提问已变化，请查看当前问题。');
  await io.text(custom);
  if (prompt.multiSelect) {
    // 多选的编辑框粘贴加回车不算提交：核对自定义那一项的内容，没勾上就勾上，再前进到确认页（仍需确认）。
    const matches = (checked) => (q) =>
      q.toolId === prompt.toolId &&
      q.index === prompt.index &&
      q.selected === prompt.options.length &&
      compact(q.otherText) === compact(custom) &&
      (!checked || q.otherChecked);
    let q = await io.reread(matches(false));
    if (!q) throw fail('请查看当前问题，确认自定义答案。');
    if (!q.otherChecked) {
      await io.keys(['enter']);
      q = await io.reread(matches(true));
      if (!q?.otherChecked) throw fail('请查看当前问题，确认自定义答案。');
    }
    await io.keys(['down', 'enter']);
  }
  return 'sent';
}

module.exports = { inspect, answer, pendingQuestion, claudeDialog, visibleClaudeQuestion };
