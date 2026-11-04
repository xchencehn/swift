#!/usr/bin/env node
'use strict';

/**
 * 量「新建一个会话」的耗时都花在哪里。
 *
 * 这条路径上有好几段，每一段都可能是瓶颈，**靠看代码猜不出来**：
 *
 *   tab create            开一个标签页
 *   agent start           在标签页里拉起 agent（内部还在轮询等它就绪）
 *   dashboard             取快照（resolveTarget 每次都要一次）
 *   pane read             读屏（等待就绪时每轮都要）
 *   /api/snapshot         前端在建完之后紧接着拉的那一次
 *
 * ⚠️ 这是**写操作**：它会真的建一个会话，量完立刻关掉并核对 pane 数复原
 * （AGENTS.md「写操作要当场验证」）。失败路径也要清理，否则会留下建好却没人管的
 * 标签页。
 *
 * 用法：`node scripts/testing/new-session-latency.js [--provider codex|claude]`
 */

const { HerdrClient } = require('../../lib/herdr-client');

const ms = (value) => `${Math.round(value)}ms`;
async function timed(label, work) {
  const at = process.hrtime.bigint();
  try {
    const value = await work();
    const took = Number(process.hrtime.bigint() - at) / 1e6;
    console.log(`  ${label.padEnd(28)} ${ms(took).padStart(8)}`);
    return { value, took };
  } catch (error) {
    const took = Number(process.hrtime.bigint() - at) / 1e6;
    console.log(`  ${label.padEnd(28)} ${ms(took).padStart(8)}  失败：${error.message}`);
    throw error;
  }
}

function env(name) {
  const line = require('node:fs')
    .readFileSync(`${process.env.HOME}/.config/agent-studio/agent-studio.env`, 'utf8')
    .split('\n')
    .find((row) => row.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : '';
}

async function callApi(pathname, init) {
  const base = `http://127.0.0.1:${env('PORT') || 8791}${env('AGENT_STUDIO_BASE_PATH') || ''}`;
  const response = await fetch(base + pathname, {
    ...init,
    headers: {
      'x-agent-studio-token': env('AGENT_STUDIO_TOKEN'),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  const provider = process.argv.includes('--provider')
    ? process.argv[process.argv.indexOf('--provider') + 1]
    : 'codex';
  const herdr = new HerdrClient({});

  console.log('== 基本操作的单次耗时 ==');
  const { value: before } = await timed('dashboard（快照）', () => herdr.dashboard());
  const panesBefore = before.panes.length;
  const sample = before.panes.find((pane) => pane.agent) || before.panes[0];
  await timed('pane read 60 行', () =>
    herdr.run(['pane', 'read', sample.paneId, '--source', 'visible', '--lines', '60']),
  );
  await timed('/api/snapshot（整条）', () => callApi('/api/snapshot'));

  console.log(`\n== 新建一个 ${provider} 会话（写操作，量完立刻关掉）==`);
  let created = null;
  try {
    const cwd = before.panes.find((pane) => pane.cwd)?.cwd || process.env.HOME;
    const workspaceId = before.panes.find((pane) => pane.workspaceId)?.workspaceId || '';
    // 先单独量开标签页那一步，它和拉起 agent 是两件事。
    const tab = await timed('tab create', () => herdr.createTab({ workspaceId, cwd }));
    const paneId = tab.value?.root_pane?.pane_id || tab.value?.pane?.pane_id || tab.value?.pane_id;
    created = paneId;
    await timed('agent start（含等就绪）', () => herdr.startAgentInPane(paneId, provider));
    await timed('建完后的 /api/snapshot', () => callApi('/api/snapshot'));
  } finally {
    if (created) {
      await timed('关闭（清理）', () => herdr.closeSession(created)).catch(() => {});
    }
    // ⚠️ 只认探针自己那个 pane，不比全局计数：量的这几秒里用户可能正好也建了会话，
    // 拿总数对比会误报「没复原」（2026-09-22 实测踩过）。
    const after = await herdr.dashboard();
    const gone = !created || !after.panes.some((pane) => pane.paneId === created);
    console.log(
      `\n探针 pane ${created || '(未建)'}  ${gone ? '✅ 已清理' : '❌ 还在，需要手工关掉'}`,
    );
    console.log(
      `（全局 pane 数 ${panesBefore} -> ${after.panes.length}，期间用户自己的操作也会变动，仅供参考）`,
    );
    if (!gone) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('失败：', error.message);
  process.exit(1);
});
