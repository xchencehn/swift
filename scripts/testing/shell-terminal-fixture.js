#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const args = process.argv.slice(2);
if (
  args[0] !== 'terminal' ||
  args[1] !== 'session' ||
  !['control', 'observe'].includes(args[2]) ||
  args[3] !== 'terminal-shell'
)
  process.exit(2);
function frame(text, full = false) {
  console.log(
    JSON.stringify({
      type: 'terminal.frame',
      full,
      encoding: 'ansi',
      bytes: Buffer.from(text).toString('base64'),
    }),
  );
}
frame('\x1b[2J\x1b[HSHELL_FIXTURE_READY\r\n$ ', true);
frame(`MODE:${args[2]}\r\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (process.env.SWIFT_SHELL_FIXTURE_LOG)
    require('node:fs').appendFileSync(process.env.SWIFT_SHELL_FIXTURE_LOG, line + '\n');
  if (message.type === 'terminal.release') process.exit(0);
  if (message.type === 'terminal.input' && message.text === 'FULL_BURST') {
    process.stdout.write(
      ['BURST_A', 'BURST_B']
        .map(
          (text) =>
            JSON.stringify({
              type: 'terminal.frame',
              full: true,
              encoding: 'ansi',
              bytes: Buffer.from(text).toString('base64'),
            }) + '\n',
        )
        .join(''),
    );
    return;
  }
  if (message.type === 'terminal.input') frame('\r\nINPUT:' + message.text + '\r\n');
  if (message.type === 'terminal.resize') frame(`\r\nSIZE:${message.cols}x${message.rows}\r\n`);
  if (message.type === 'terminal.scroll')
    frame(`\r\nSCROLL:${message.direction}:${message.lines}\r\n`);
  if (['terminal.mouse', 'terminal.scroll'].includes(message.type))
    frame('CONTROL:' + JSON.stringify(message) + '\r\n');
});
