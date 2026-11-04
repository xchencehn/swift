#!/usr/bin/env node
'use strict';

// 这个 fixture 平时扮演 herdr 的交互终端;但服务端也会拿它当 CLI 用
// (`herdr api snapshot` 之类)。聊天视图一开就会问快照 —— 不认这条命令的话
// 那个接口 500,而 500 会被 harness 当成页面错误。给一个最小的空快照即可:
// harness 测的是终端,聊天视图只要不报错。
const argv = process.argv.slice(2);
if (argv.includes('snapshot') || argv.includes('api')) {
  process.stdout.write(
    JSON.stringify({
      snapshot: {
        workspaces: [],
        tabs: [],
        panes: [],
        focused_pane_id: '',
        focused_workspace_id: '',
      },
    }),
  );
  process.exit(0);
}

process.stdout.write('\u001b[2J\u001b[HRAW_PTY_READY\r\n');
for (let index = 1; index <= 240; index += 1)
  process.stdout.write(`RAW_SCROLL_${String(index).padStart(3, '0')}\r\n`);
process.stdout.write('RAW_PROMPT> ');
process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
let alternateMouse = false;
process.stdin.on('data', (data) => {
  if (data.includes('ENTER_ALT_MOUSE')) {
    alternateMouse = true;
    process.stdout.write('\u001b[?1049h\u001b[?1000h\u001b[?1006h\u001b[2J\u001b[HALT_MOUSE_READY');
    return;
  }
  if (alternateMouse && /\u001b\[<6[45];\d+;\d+M/.test(data)) {
    alternateMouse = false;
    process.stdout.write(
      '\u001b[?1000l\u001b[?1006l\u001b[?1049l\r\nRAW_ALT_MOUSE_OK\r\nRAW_PROMPT> ',
    );
    return;
  }
  process.stdout.write(
    `\r\nRAW_ECHO:${data
      .replace(/\r/g, '<CR>')
      .replace(/\n/g, '<LF>')
      .replace(/\u007f/g, '<DEL>')}\r\nRAW_PROMPT> `,
  );
});
process.on('SIGWINCH', () => process.stdout.write('\r\nRAW_RESIZED\r\nRAW_PROMPT> '));
