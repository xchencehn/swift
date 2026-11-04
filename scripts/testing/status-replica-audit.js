#!/usr/bin/env node
'use strict';

/**
 * 只读探针：把真实终端底部那块区域，与我们送到网页上的内容逐行对照。
 *
 * 会话页底部（活动行 + 输入框回显 + 状态栏）要求**一比一复刻终端**，只允许两处
 * 改动：换行更好看，以及 Working 那一段加了颜色变化。可这块内容是从终端画面里
 * 按形状认出来的，判据一旦跟不上 Agent 换的写法，丢掉的那一行在网页上不会报错，
 * 只是**静悄悄地不见了** —— 靠看是看不出来的，所以要能随时量一遍。
 *
 * 用法：`node scripts/testing/status-replica-audit.js [pane 数量]`
 * 输出里带 `✗` 的是画面上有、我们没送出去的行。正文（对话内容）本来就不属于这块
 * 区域，带 `✗` 是正常的；要看的是输入框那条分隔线以下、以及活动行位置上的行。
 *
 * 2026-09-22 用它抓到：完成行的动词当时写死成六个词，而 Claude 每次换词，
 * `✻ Brewed for 1m 0s · done 1:35 AM` 整行认不出来。
 */

const { HerdrClient } = require('../../lib/herdr-client');
const { readStatusArea } = require('../../lib/agent-composer');
const { chatStatus } = require('../../lib/chat-status');
const { stripAnsi } = require('../../public/ansi');

// 对照前抹掉两边必然不同的部分：按键提示在网页上按不了，我们故意剥掉。
const normalize = (value) =>
  stripAnsi(String(value ?? ''))
    .replace(/\s*\((?:shift|ctrl|tab)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
// 边框线是装饰，不是内容，不参与对照。
const isRule = (line) => /^[\s─━│┃|]+$/.test(line);

async function main() {
  const limit = Number(process.argv[2]) || 6;
  const herdr = new HerdrClient({});
  const snapshot = await herdr.dashboard();
  const panes = snapshot.panes.filter((pane) => ['claude', 'codex'].includes(pane.agent?.label));
  console.log(`候选 pane ${panes.length} 个，取前 ${Math.min(limit, panes.length)} 个`);
  let missing = 0;
  for (const pane of panes.slice(0, limit)) {
    let raw;
    try {
      raw = await herdr.run([
        'pane',
        'read',
        pane.paneId,
        '--source',
        'recent',
        '--lines',
        '24',
        '--format',
        'ansi',
      ]);
    } catch (error) {
      console.log(`\n=== ${pane.paneId} 读屏失败：${error.message}`);
      continue;
    }
    const area = readStatusArea(raw);
    const result = chatStatus(area, pane, null, [], null);
    const screen = stripAnsi(raw)
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''));
    const shown = [...(result.statusline || []), area.activity, area.tip, area.composer]
      .map(normalize)
      .filter(Boolean);
    console.log(
      `\n=== ${pane.paneId} ${pane.agent.label} tab=${JSON.stringify(pane.tabTitle ?? pane.tab)} ===`,
    );
    for (const line of screen.slice(-12).filter((line) => line.trim() && !isRule(line))) {
      const key = normalize(line);
      // 权限行会被剥掉按键提示，所以两边互相包含都算命中。
      const hit = shown.some((piece) => piece.includes(key) || key.includes(piece));
      if (!hit) missing += 1;
      console.log(`${hit ? '  ' : '✗ '}${line}`);
    }
    console.log(
      `  → activity=${JSON.stringify(area.activity)} tip=${JSON.stringify(area.tip)} composer=${JSON.stringify(area.composer)}`,
    );
    console.log(`  → statusline=${JSON.stringify(result.statusline)}`);
  }
  console.log(`\n画面上有而我们没送出去的行：${missing} 条（正文行计在内，逐条看形状再判断）`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
