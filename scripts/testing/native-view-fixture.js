'use strict';
// Real Herdr and Codex, only synthetic archives in the harness's empty HOME.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { viewPane, codexBrowsing } = require('../../lib/herdr-view');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, accept, message, timeoutMs = 0) {
  const deadline = timeoutMs ? performance.now() + timeoutMs : 0;
  for (let i = 0; deadline ? performance.now() < deadline : i < 120; i++) {
    const result = await read();
    if (accept(result)) return result;
    await delay(100);
  }
  throw new Error(message);
}
async function run(herdr, paneId, temporary) {
  const home = path.join(temporary, 'codex-fixture'),
    directory = path.join(home, 'sessions', '2026', '10', '14'),
    id = randomUUID();
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(home, 'config.toml'),
    `model_provider = "fixture"\nmodel = "gpt-5"\ncheck_for_update_on_startup = false\n[features]\nplugins = false\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[tui]\nalternate_screen = "always"\n[projects."${temporary}"]\ntrust_level = "trusted"\n`,
  );
  const timestamp = '2026-10-14T00:00:00.000Z';
  const records = [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id,
        timestamp,
        cwd: temporary,
        originator: 'codex_cli_rs',
        cli_version: '0.162.1',
        source: 'cli',
        model_provider: 'fixture',
      },
    },
  ];
  for (let i = 0; i < 35; i++) {
    records.push({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `SCROLL FIXTURE QUESTION ${i}`,
        images: [],
        local_images: [],
        text_elements: [],
      },
    });
    records.push({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: `SCROLL FIXTURE ANSWER ${i}\n` + 'Deterministic transcript line.\n'.repeat(5),
        phase: 'final_answer',
      },
    });
  }
  const archive = path.join(directory, `rollout-2026-10-14T00-00-00-${id}.jsonl`);
  await fs.writeFile(archive, records.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const read = () => herdr.readPane(paneId, { source: 'recent', lines: 120, ansi: true });
  await herdr.request('pane.send_input', {
    pane_id: paneId,
    text: 'for i in $(seq 1 100); do echo SCROLLBUFFER-$i; done',
    keys: ['enter'],
  });
  await until(read, (text) => text.includes('SCROLLBUFFER-100'), 'isolated shell output missing');
  await herdr.request('pane.scroll', { pane_id: paneId, offset_from_bottom: 10 });
  let view = await herdr.dashboard(),
    pane = view.panes.find((p) => p.paneId === paneId);
  assert(pane.scroll.offset_from_bottom > 0, 'native scrollback must first be scrolled');
  await viewPane(herdr, paneId, {
    runtimeId: view.runtimeId,
    terminalId: pane.terminalId,
    sessionId: pane.agent?.session?.value || '',
  });
  view = await herdr.dashboard();
  assert.equal(view.focusedPaneId, paneId);
  assert.equal(view.panes.find((p) => p.paneId === paneId).scroll.offset_from_bottom, 0);
  // Paths and UUID belong to this empty, isolated fixture. No real credentials,
  // model requests, prompt submission, shell fallback or production panes.
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const restoreStarted = performance.now();
  await herdr.request('pane.send_input', {
    pane_id: paneId,
    text: `env -u CODEX_MANAGED_PACKAGE_ROOT -u CODEX_SESSION_ID -u CODEX_THREAD_ID CODEX_HOME=${quote(home)} codex --sandbox read-only --ask-for-approval never resume ${quote(id)}`,
    keys: ['enter'],
  });
  await until(
    read,
    (text) => text.includes('SCROLL FIXTURE ANSWER 34'),
    'isolated Codex did not restore the synthetic archive',
    30000,
  );
  const restoreMs = Math.round(performance.now() - restoreStarted);
  await herdr.request('pane.send_keys', { pane_id: paneId, keys: ['alt+<'] });
  const before = await until(
    read,
    codexBrowsing,
    'Codex native Back to bottom control did not appear',
  );
  view = await until(
    () => herdr.dashboard(),
    (v) => v.panes.find((p) => p.paneId === paneId)?.agent?.label?.toLowerCase() === 'codex',
    'Herdr did not detect isolated Codex',
  );
  pane = view.panes.find((p) => p.paneId === paneId);
  const result = await viewPane(herdr, paneId, {
    runtimeId: view.runtimeId,
    terminalId: pane.terminalId,
    sessionId: pane.agent?.session?.value || '',
  });
  assert(result.agentScrolled, 'the actual native Codex navigation must run');
  const after = await until(
    read,
    (text) => !codexBrowsing(text) && text.includes('SCROLL FIXTURE ANSWER 34'),
    'native latest view was not restored',
  );
  const saved = (await fs.readFile(archive, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(
    saved.filter((r) => r.type === 'event_msg' && r.payload.type === 'user_message').length,
    35,
    'navigation must not submit a prompt',
  );
  return {
    herdrScrollReset: true,
    codexBrowsingBefore: codexBrowsing(before),
    codexBrowsingAfter: codexBrowsing(after),
    nativeLatestVisible: true,
    noPromptSubmitted: true,
    restoreMs,
  };
}
async function cleanup(temporary) {
  // Codex can leave its isolated app-server daemon alive after TUI exit. Match
  // the exact fixture CODEX_HOME before terminating; never inspect live content.
  const wanted = Buffer.from('CODEX_HOME=' + path.join(temporary, 'codex-fixture'));
  const pids = [];
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const values = (await fs.readFile(`/proc/${name}/environ`)).toString().split('\0');
      if (values.includes(wanted.toString())) pids.push(Number(name));
    } catch {}
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  if (pids.length) await delay(150);
  for (const pid of pids) {
    try {
      const values = (await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');
      if (values.includes(wanted.toString())) process.kill(pid, 'SIGKILL');
    } catch {}
  }
}
module.exports = { run, cleanup };
