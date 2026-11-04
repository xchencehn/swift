#!/usr/bin/env node
'use strict';
// A high-rate native VT source for the real transport integration test.
let revision = 0;
setInterval(() => {
  const hidden = Array.from(
    { length: 105 },
    (_, i) => `${i}: ${'hidden transcript '.repeat(12)}`,
  ).join('\r\n');
  const ansi = `\x1b[H\x1b[2J${hidden}\x1b[110;1HWorking for ${++revision}s\r\n› Ask Codex\r\nGPT · Working · Context 23%`;
  process.stdout.write(
    JSON.stringify({
      type: 'terminal.frame',
      encoding: 'ansi',
      full: true,
      bytes: Buffer.from(ansi).toString('base64'),
    }) + '\n',
  );
}, 35);
