'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless'),
  { fixture } = require('./message-rewind-fixture');
const { openTerminalSession } = require('../../lib/herdr-terminal-session'),
  { create } = require('../../public/chat/terminal-renderer');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const baseline = process.argv.includes('--baseline'),
  out = path.resolve(
    'artifacts/testing/terminal-footer-stability',
    baseline ? 'native-baseline' : 'native',
  );
const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));
const lines = (terminal) => {
  const b = terminal.buffer.active;
  return Array.from(
    { length: terminal.rows },
    (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) || '',
  );
};
(async () => {
  const before = sourceFingerprint(process.cwd());
  const result = await fixture(
    out,
    async (f) => {
      await f.send('Footer stability fixture');
      const requestCount = f.requests.length;
      const pane = await f.exactPane();
      await f.press(pane, ['f2']);
      await f.delay(250);
      await f.capture('warnings');
      await f.press(pane, ['esc']);
      await f.delay(250);
      const source = new Terminal({ cols: 160, rows: 200, allowProposedApi: true, scrollback: 0 }),
        display = new Terminal({ cols: 160, rows: 20, allowProposedApi: true, scrollback: 0 });
      const renderer = create({ Terminal, cols: 160, rows: 20 });
      let painting = Promise.resolve(),
        frames = 0;
      const session = openTerminalSession({
        socketPath: f.herdr.socketPath,
        terminalId: pane.terminalId,
        mode: 'observe',
        cols: 160,
        rows: 200,
      });
      session.on('frame', (data, frame) => {
        frames++;
        painting = painting.then(async () => {
          source.resize(frame.cols, frame.rows);
          await write(source, (frame.full ? '\x1b[!p\x1b[2J\x1b[H' : '') + data.toString());
          const delta = await renderer.write(data, {
            ...frame,
            viewportCols: 160,
            viewportRows: 20,
          });
          if (delta) await write(display, delta);
        });
      });
      const measure = () => ({
        nativeStatus: lines(source).findIndex((s) => /GPT-6/i.test(s)),
        nativePrompt: source.buffer.active.cursorY,
        status: lines(display).findIndex((s) => /GPT-6/i.test(s)),
        prompt: display.buffer.active.cursorY,
        hint: lines(display).findIndex((s) => s.includes('? for shortcuts')),
      });
      try {
        await session.ready;
        await f.wait(async () => {
          await painting;
          return lines(display).some((s) => s.includes('? for shortcuts'));
        }, 'observed empty composer');
        const states = [measure()];
        await fs.writeFile(path.join(out, 'empty.txt'), lines(source).join('\n'));
        for (let i = 0; i < 3; i++) {
          await f.paste(pane, '水电费');
          await f.wait(async () => {
            await painting;
            return (
              lines(display).some((s) => s.includes('水电费')) &&
              !lines(display).some((s) => s.includes('? for shortcuts'))
            );
          }, 'native draft');
          states.push(measure());
          if (i === 0) await fs.writeFile(path.join(out, 'draft.txt'), lines(source).join('\n'));
          await f.press(pane, ['ctrl+u']);
          await f.wait(async () => {
            await painting;
            return lines(display).some((s) => s.includes('? for shortcuts'));
          }, 'cleared native draft');
          states.push(measure());
        }
        await fs.writeFile(path.join(out, 'states.json'), JSON.stringify(states, null, 2));
        assert(
          states.every(
            (s) =>
              s.nativeStatus === states[0].nativeStatus &&
              s.nativePrompt === states[0].nativePrompt,
          ),
          'Native terminal row coordinates must remain fixed',
        );
        const shifts = states.map((s) => s.status - states[0].status);
        assert.deepEqual(shifts, baseline ? [0, 1, 0, 1, 0, 1, 0] : [0, 0, 0, 0, 0, 0, 0]);
        assert.equal(f.requests.length, requestCount);
        return {
          states,
          shifts,
          frames,
          productionInput: false,
          externalInference: false,
          modelRequests: requestCount,
        };
      } finally {
        await session.close();
        await painting;
        renderer.dispose();
        source.dispose();
        display.dispose();
      }
    },
    {
      cols: 160,
      rows: 45,
      noAltScreen: false,
      codexConfig: ['tui.status_line=["model-with-reasoning", "current-dir"]'],
    },
  );
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify({ ok: true, baseline, before, after, ...result }, null, 2),
  );
  console.log(
    'PASS real Herdr/Codex ' +
      (baseline ? 'one-row shift reproduced' : 'footer and cursor remain fixed'),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
