'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { create } = require('../public/chat/terminal-renderer');
const bytes = (text) => new TextEncoder().encode(text);
test('同一解析帧的绘制与历史检查复用投影，新输出立即失效', async (t) => {
  let reads = 0;
  class MeasuredTerminal extends Terminal {
    get buffer() {
      const namespace = super.buffer;
      return {
        active: new Proxy(namespace.active, {
          get(buffer, key) {
            if (key === 'getLine')
              return (index) => {
                reads++;
                return buffer.getLine(index);
              };
            return Reflect.get(buffer, key);
          },
        }),
      };
    }
  }
  const renderer = create({ Terminal: MeasuredTerminal, cols: 40, rows: 12 });
  t.after(() => renderer.dispose());
  await renderer.write(bytes('\x1b[HHEADER\x1b[3;1HPROMPT>'), {
    cols: 40,
    rows: 200,
    viewportRows: 12,
  });
  const before = reads;
  renderer.historyKey();
  renderer.historyKey();
  assert.equal(renderer.render({ cols: 40, rows: 12 }), '');
  assert.equal(reads, before, 'Unchanged frame consumers must not rescan its rows');
  assert.match(
    await renderer.write(bytes('new input'), { cols: 40, rows: 200, viewportRows: 12 }),
    /new input/,
  );
  assert(reads > before, 'Native output invalidates the projection');
});
test('后台历史解析期间当前回显仍能绘制，迟到历史不能覆盖新正文', async (t) => {
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const preparing = new Promise((resolve) => {
    started = resolve;
  });
  class SlowHistoryTerminal extends Terminal {
    write(data, callback) {
      if (this.cols === 402) {
        started();
        void gate.then(() => super.write(data, callback));
      } else super.write(data, callback);
    }
  }
  const renderer = create({ Terminal: SlowHistoryTerminal, cols: 40, rows: 12 });
  t.after(() => {
    release();
    renderer.dispose();
  });
  const options = { cols: 40, rows: 200, viewportRows: 12 };
  await renderer.write(bytes('\x1b[HHEADER\x1b[3;1HPROMPT>'), options);
  const pending = renderer.history('OLDER\nHEADER\n\nPROMPT>', renderer.historyKey(), undefined, {
    render: false,
  });
  await preparing;
  const echo = await renderer.write(bytes('new input'), options);
  assert.match(echo, /new input/);
  release();
  assert.equal(await pending, '');
  assert.equal(
    renderer.render({ cols: 40, rows: 12 }),
    '',
    'Stale history must not alter an already rendered echo',
  );
});
test('隐藏期间完整解析输出，恢复显示时一次补齐最新正文和光标', async (t) => {
  const renderer = create({ Terminal, cols: 30, rows: 8 });
  t.after(() => renderer.dispose());
  await renderer.write(bytes('\x1b[HSTABLE\x1b[3;1Hold'));
  assert.equal(await renderer.write(bytes('\x1b[3;1Hintermediate'), { render: false }), '');
  assert.equal(
    await renderer.write(bytes('\x1b[3;1Hlatest\x1b[K\x1b[5;7H'), { render: false }),
    '',
  );
  const delta = renderer.render({ cols: 30, rows: 8 });
  assert(delta.includes('latest'));
  assert(!delta.includes('intermediate'));
  assert(!delta.includes('STABLE'));
  assert(delta.includes('\x1b[5;7H'));
  assert.equal(renderer.render({ cols: 30, rows: 8 }), '');
});
const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));
function screen(terminal) {
  const b = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, y) =>
    b.getLine(b.viewportY + y).translateToString(false),
  );
}
test('分块接收同步输出时保持完整画面，结束标记到达后才绘制', async (t) => {
  const renderer = create({ Terminal, cols: 100, rows: 200 }),
    display = new Terminal({ cols: 100, rows: 35, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const frame = (revision) =>
    bytes(
      '\x1b[?2026h\x1b[?7l' +
        Array.from(
          { length: 180 },
          (_, y) =>
            `\x1b[${y + 1};1HROW_${String(y).padStart(3, '0')} ` +
            '中文'.repeat(12) +
            'a'.repeat(40),
        ).join('') +
        `\x1b[178;1HLATEST_${revision}\x1b[K\x1b[179;5H\x1b[?25h\x1b[?2026l`,
    );
  const options = {
    cols: 100,
    rows: 200,
    viewportCols: 100,
    viewportRows: 35,
  };
  await write(display, await renderer.write(frame(0), { ...options, full: true }));
  for (const revision of [0, 1, 2]) {
    const before = screen(display),
      data = frame(revision);
    assert(data.length > 16384, 'The native repaint must span transport chunks');
    // Split the final CSI too: neither a transport chunk nor an incomplete
    // end marker is a completed synchronized screen update.
    const cuts = [0, 16384, data.length - 3, data.length];
    for (let i = 0; i < cuts.length - 1; i++) {
      const delta = await renderer.write(data.subarray(cuts[i], cuts[i + 1]), {
        ...options,
        full: i === 0,
      });
      if (i < cuts.length - 2) {
        assert.equal(delta, '', 'Partial native repaints must not reach the visible terminal');
        assert.equal(renderer.render({ cols: 100, rows: 35 }), '');
        assert.equal(renderer.historyKey(), '', 'Partial frames must not request history');
        assert.deepEqual(screen(display), before);
      }
      await write(display, delta);
    }
    assert(screen(display).join('\n').includes(`LATEST_${revision}`));
    assert.equal(screen(display)[0], before[0], 'A completed update keeps native rows anchored');
  }
});
test('完整重绘在独立缓冲区还原，只向显示终端更新变化行', async (t) => {
  const renderer = create({ Terminal, cols: 50, rows: 10 }),
    display = new Terminal({ cols: 50, rows: 10, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const frame = (i) => `\x1b[2J\x1b[HSTABLE HEADER 中文\x1b[4;1HThinking ${i}\x1b[8;2H`;
  await write(display, await renderer.write(bytes(frame(0)), { full: true }));
  const delta = await renderer.write(bytes(frame(1)), { full: true });
  assert(!delta.includes('\x1b[2J'));
  assert(!delta.includes('STABLE HEADER'));
  assert(delta.includes('Thinking 1'));
  await write(display, delta);
  assert(screen(display)[0].includes('STABLE HEADER 中文'));
  assert(screen(display)[3].includes('Thinking 1'));
  assert.equal(
    await renderer.write(bytes(frame(1)), { full: true }),
    '',
    'Identical screen and cursor produce no visible writes',
  );
});
test('增量输出、擦除、颜色、宽字符、组合字符和尺寸变化均与原生 VT 结果一致', async (t) => {
  const renderer = create({ Terminal, cols: 28, rows: 8 });
  const source = new Terminal({ cols: 28, rows: 8, allowProposedApi: true }),
    display = new Terminal({ cols: 28, rows: 8, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    source.dispose();
    display.dispose();
  });
  for (const data of [
    '\x1b[2J\x1b[H中文 e\u0301 🐈‍⬛',
    '\x1b[3;2H\x1b[1;2;3;4;7;9;53;38;2;20;180;60;48;5;17m样式 colored',
    '\x1b[0m\x1b[5;1Hold trailing content',
    '\x1b[5;1Hshort\x1b[K',
    '\x1b[2;1Hprogress\rupdated',
    '\x1b[3;1H\x1b[2K',
  ]) {
    await write(source, data);
    await write(display, await renderer.write(bytes(data)));
    assert.deepEqual(screen(display), screen(source));
    for (let y = 0; y < source.rows; y++)
      for (let x = 0; x < source.cols; x++) {
        const a = source.buffer.active.getLine(y).getCell(x),
          b = display.buffer.active.getLine(y).getCell(x);
        assert.equal(b.getChars() || ' ', a.getChars() || ' ');
        for (const method of [
          'getWidth',
          'getFgColor',
          'getBgColor',
          'isBold',
          'isDim',
          'isItalic',
          'isUnderline',
          'isInverse',
          'isStrikethrough',
          'isOverline',
        ])
          assert.equal(b[method](), a[method](), method);
      }
  }
  source.resize(20, 6);
  display.resize(20, 6);
  const data = '\x1b[2J\x1b[Hsmaller 中文\x1b[6;3H';
  await write(source, data);
  await write(display, await renderer.write(bytes(data), { cols: 20, rows: 6, full: true }));
  assert.deepEqual(screen(display), screen(source));
});
test('光标显隐、位置和样式更新不重写静态正文，解析查询不会产生原生输入', async (t) => {
  const renderer = create({ Terminal, cols: 30, rows: 8 });
  t.after(() => renderer.dispose());
  await renderer.write(bytes('\x1b[HSTABLE\x1b[?25l'));
  const cursor = await renderer.write(bytes('\x1b[5;7H\x1b[?25h\x1b[6 q'));
  assert(!cursor.includes('STABLE'));
  assert(
    cursor.includes('\x1b[5;7H') && cursor.includes('\x1b[?25h') && cursor.includes('\x1b[6 q'),
  );
  assert.equal(
    await renderer.write(bytes('\x1b[6n')),
    '',
    'Terminal queries are consumed locally without forwarding responses',
  );
});
test('真实流的 RGB 前景色随 Swift 调色板变化，保留自定义 RGB、背景和文字属性', async (t) => {
  const renderer = create({ Terminal, cols: 40, rows: 4, adaptNativeColors: true });
  const display = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const frame =
    '\x1b[H\x1b[38;2;205;214;244m文\x1b[1;3;38;2;137;180;250mB' +
    '\x1b[0;38;2;147;153;178mM\x1b[38;2;20;180;60;48;2;31;32;33mC\x1b[0m';
  await write(display, await renderer.write(bytes(frame), { full: true }));
  const line = display.buffer.active.getLine(0),
    text = line.getCell(0),
    blue = line.getCell(2),
    muted = line.getCell(3),
    custom = line.getCell(4);
  assert.equal(text.getChars(), '文');
  assert(text.isFgDefault());
  assert(blue.isFgPalette());
  assert.equal(blue.getFgColor(), 4);
  assert(blue.isBold());
  assert(blue.isItalic());
  assert(muted.isFgPalette());
  assert.equal(muted.getFgColor(), 8);
  assert(custom.isFgRGB());
  assert.equal(custom.getFgColor(), 0x14b43c);
  assert(custom.isBgRGB());
  assert.equal(custom.getBgColor(), 0x1f2021);
  assert.equal(
    await renderer.write(bytes(frame), { full: true }),
    '',
    'Theme adaptation keeps identical frames unchanged',
  );
});
test('短可视区域保留完整原生画面底部和光标，键盘收缩时无需新的原生帧', async (t) => {
  const renderer = create({ Terminal, cols: 70, rows: 15 });
  const display = new Terminal({ cols: 70, rows: 15, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const frame =
    '\x1b[2J\x1b[H' +
    Array.from({ length: 42 }, (_, i) => `\x1b[${i + 1};1HROW ${i + 1}`).join('') +
    '\x1b[43;1HKEYBOARD_PROMPT>\x1b[44;1HSTATUS_BOTTOM\x1b[43;17H\x1b[?25h';
  await write(
    display,
    await renderer.write(bytes(frame), {
      full: true,
      cols: 70,
      rows: 200,
      viewportCols: 70,
      viewportRows: 15,
    }),
  );
  assert(screen(display)[13].includes('KEYBOARD_PROMPT>'));
  assert(screen(display)[14].includes('STATUS_BOTTOM'));
  assert.equal(display.buffer.active.cursorY, 13);
  display.resize(70, 6);
  await write(display, renderer.render({ cols: 70, rows: 6 }));
  assert(screen(display)[4].includes('KEYBOARD_PROMPT>'));
  assert(screen(display)[5].includes('STATUS_BOTTOM'));
  assert.equal(display.buffer.active.cursorY, 4);
  display.resize(70, 50);
  await write(display, renderer.render({ cols: 70, rows: 50 }));
  assert(screen(display)[48].includes('KEYBOARD_PROMPT>'));
  assert(screen(display)[49].includes('STATUS_BOTTOM'));
  assert.equal(
    renderer.render({ cols: 70, rows: 50 }),
    '',
    'Unchanged viewport preserves stable rows',
  );
});
test('原生活动行增减时，提示符和状态始终贴住终端底部', async (t) => {
  const renderer = create({ Terminal, cols: 60, rows: 20 });
  const display = new Terminal({ cols: 60, rows: 20, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  for (const end of [20, 16, 20]) {
    const frame =
      '\x1b[2J\x1b[H' +
      Array.from({ length: end - 2 }, (_, y) => `\x1b[${y + 1};1HActivity ${y + 1}`).join('') +
      `\x1b[${end - 1};1HPROMPT>\x1b[${end};1HSTATUS\x1b[${end - 1};8H`;
    await write(
      display,
      await renderer.write(bytes(frame), {
        full: true,
        cols: 60,
        rows: 200,
        viewportCols: 60,
        viewportRows: 20,
      }),
    );
    assert(
      screen(display)[18].includes('PROMPT>'),
      `Prompt moved when activity ended at row ${end}`,
    );
    assert(
      screen(display)[19].includes('STATUS'),
      `Status moved when activity ended at row ${end}`,
    );
    assert.equal(display.buffer.active.cursorY, 18);
  }
});
test('隐藏光标不把底部状态拉回顶部，可见光标所在区域保持可操作', async (t) => {
  const renderer = create({ Terminal, cols: 30, rows: 6 });
  const display = new Terminal({ cols: 30, rows: 6, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  await write(
    display,
    await renderer.write(bytes('\x1b[2J\x1b[40;1HSTATUS_BOTTOM\x1b[1;1H\x1b[?25l'), {
      full: true,
      cols: 30,
      rows: 200,
      viewportCols: 30,
      viewportRows: 6,
    }),
  );
  assert(screen(display)[5].includes('STATUS_BOTTOM'));
  await write(
    display,
    await renderer.write(bytes('\x1b[20;1HQUESTION>\x1b[20;10H\x1b[?25h'), {
      cols: 30,
      rows: 200,
      viewportCols: 30,
      viewportRows: 6,
    }),
  );
  assert(screen(display)[5].includes('QUESTION>'));
  assert.equal(display.buffer.active.cursorY, 5);
});
test('较长手机视口只用尾部完全匹配的真实历史填充上方空行，保留原生光标与底部', async (t) => {
  const renderer = create({ Terminal, cols: 40, rows: 12 });
  const display = new Terminal({ cols: 40, rows: 12, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const native = ['CURRENT HEADER', 'Working', 'PROMPT>', 'STATUS'];
  const frame = native.map((line, i) => `\x1b[${i + 1};1H${line}`).join('') + '\x1b[3;8H';
  await write(
    display,
    await renderer.write(bytes(frame), {
      full: true,
      cols: 40,
      rows: 200,
      viewportCols: 40,
      viewportRows: 12,
    }),
  );
  assert.equal(screen(display)[0].trim(), '');
  const key = renderer.historyKey();
  assert(key);
  await write(
    display,
    await renderer.history(
      [...Array.from({ length: 8 }, (_, i) => 'EARLIER ' + i), ...native].join('\n'),
      key,
    ),
  );
  assert.equal(screen(display)[0].trim(), 'EARLIER 0');
  assert.equal(screen(display)[7].trim(), 'EARLIER 7');
  assert.equal(screen(display)[11].trim(), 'STATUS');
  assert.equal(display.buffer.active.cursorY, 10);
  assert.equal(renderer.historyKey(), '', 'A matching read is cached without periodic requests');
});
test('原生标题和状态的小幅更新不清空已核对的手机终端历史', async (t) => {
  const renderer = create({ Terminal, cols: 60, rows: 80 });
  const display = new Terminal({ cols: 60, rows: 80, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const body = Array.from({ length: 17 }, (_, i) => `BODY ${i}`);
  const frame = (header, status, content = body) =>
    '\x1b[2J\x1b[H' +
    [header, ...content, 'PROMPT>', status]
      .map((line, index) => `\x1b[${index + 1};1H${line}`)
      .join('') +
    '\x1b[19;8H\x1b[?25h';
  const options = { full: true, cols: 60, rows: 200, viewportCols: 60, viewportRows: 80 };
  await write(display, await renderer.write(bytes(frame('HEADER 0', 'STATUS 0')), options));
  const key = renderer.historyKey();
  await write(
    display,
    await renderer.history(
      [
        ...Array.from({ length: 60 }, (_, i) => `HISTORY ${i}`),
        'HEADER 0',
        ...body,
        'PROMPT>',
        'STATUS 0',
      ].join('\n'),
      key,
    ),
  );
  assert.equal(screen(display)[0].trim(), 'HISTORY 0');
  await write(display, await renderer.write(bytes(frame('HEADER 1', 'STATUS 1')), options));
  assert.equal(screen(display)[0].trim(), 'HISTORY 0');
  assert.equal(
    renderer.historyKey(),
    '',
    'Minor native updates must not trigger another history read',
  );
  await write(
    display,
    await renderer.write(
      bytes(
        frame(
          'NEW SESSION',
          'NEW STATUS',
          body.map((_, i) => `NEW ${i}`),
        ),
      ),
      options,
    ),
  );
  assert.equal(screen(display)[0].trim(), '');
  assert(renderer.historyKey(), 'A different screen must discard old history');
});
test('稀疏原生画面更新标题和状态时，上方历史保持稳定', async (t) => {
  const renderer = create({ Terminal, cols: 40, rows: 30 });
  const display = new Terminal({ cols: 40, rows: 30, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const frame = (header, status) =>
    `\x1b[2J\x1b[H${header}\x1b[2;1HBODY\x1b[3;1HPROMPT>\x1b[4;1H${status}\x1b[3;8H`;
  const options = { full: true, cols: 40, rows: 200, viewportCols: 40, viewportRows: 30 };
  await write(display, await renderer.write(bytes(frame('HEADER 0', 'STATUS 0')), options));
  await write(
    display,
    await renderer.history(
      [
        ...Array.from({ length: 26 }, (_, i) => `HISTORY ${i}`),
        'HEADER 0',
        'BODY',
        'PROMPT>',
        'STATUS 0',
      ].join('\n'),
      renderer.historyKey(),
    ),
  );
  assert.equal(screen(display)[0].trim(), 'HISTORY 0');
  await write(display, await renderer.write(bytes(frame('HEADER 1', 'STATUS 1')), options));
  assert.equal(screen(display)[0].trim(), 'HISTORY 0');
  assert.equal(renderer.historyKey(), '');
});
test('短会话不虚构历史，迟到或尾部不匹配的读取不混入当前画面', async (t) => {
  const renderer = create({ Terminal, cols: 30, rows: 10 }),
    display = new Terminal({ cols: 30, rows: 10, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const draw = async (header) =>
    write(
      display,
      await renderer.write(bytes(`\x1b[H${header}\x1b[2;1HPROMPT>\x1b[2;8H`), {
        full: true,
        cols: 30,
        rows: 200,
        viewportCols: 30,
        viewportRows: 10,
      }),
    );
  await draw('FIRST');
  const firstKey = renderer.historyKey();
  assert.equal(await renderer.history('UNVERIFIED\nFIRST\nOTHER PROMPT', firstKey), '');
  assert(!screen(display).some((line) => line.includes('UNVERIFIED')));
  await draw('SECOND');
  assert.equal(await renderer.history('OLD\nFIRST\nPROMPT>', firstKey), '');
  const currentKey = renderer.historyKey();
  await write(display, await renderer.history('SECOND\nPROMPT>', currentKey));
  assert.equal(renderer.historyKey(), '');
  assert.equal(screen(display).filter((line) => line.trim()).length, 2);
  assert.equal(screen(display)[8].trim(), 'SECOND');
  assert.equal(screen(display)[9].trim(), 'PROMPT>');
});
test('宽原生ANSI、ASCII及CJK历史按物理单元裁剪，不折行或覆盖右边缘', async (t) => {
  const renderer = create({ Terminal, cols: 70, rows: 12 }),
    display = new Terminal({ cols: 70, rows: 12, allowProposedApi: true });
  const original = new Terminal({ cols: 105, rows: 10, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
    original.dispose();
  });
  const native = [
    'A'.repeat(105),
    'B'.repeat(69) + '中文长行'.repeat(9),
    '彩色CJK '.repeat(12),
    'PROMPT>',
    'STATUS',
  ];
  await write(original, '\x1b[?7l' + native.map((line, i) => `\x1b[${i + 1};1H${line}`).join(''));
  const physical = native.map((_, y) => original.buffer.active.getLine(y).translateToString(false));
  const clipped = native.map((_, y) => {
    const line = original.buffer.active.getLine(y);
    let result = '';
    for (let x = 0; x < 70; x++) {
      const cell = line.getCell(x),
        width = cell.getWidth();
      if (!width) continue;
      result += x + width > 70 ? ' ' : cell.getChars() || ' ';
    }
    return result;
  });
  const frame =
    '\x1b[?7l' + clipped.map((line, i) => `\x1b[${i + 1};1H${line}`).join('') + '\x1b[4;8H';
  await write(
    display,
    await renderer.write(bytes(frame), {
      full: true,
      cols: 70,
      rows: 200,
      viewportCols: 70,
      viewportRows: 12,
    }),
  );
  await write(
    display,
    await renderer.history(
      ['\x1b[38;2;20;180;60mOLDER ASCII '.repeat(40) + '\x1b[0m', ...physical].join('\n'),
      renderer.historyKey(),
    ),
  );
  assert.equal(screen(display)[6].slice(0, 12), 'OLDER ASCII ');
  assert.equal(screen(display)[7].trimEnd(), 'A'.repeat(70));
  assert.equal(screen(display)[8].trimEnd(), 'B'.repeat(69));
  assert.equal(display.buffer.active.getLine(6).getCell(0).getFgColor(), 0x14b43c);
  assert.equal(display.buffer.active.cursorY, 10);
});
test('仅兼容已证实的宽字裁剪边界；相同页脚不能掩盖不同正文或光标', async (t) => {
  const renderer = create({ Terminal, cols: 70, rows: 8 }),
    display = new Terminal({ cols: 70, rows: 8, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const visible = ['B'.repeat(69) + '中文', '彩abc', 'PROMPT>', 'STATUS'];
  const observed = ['B'.repeat(69), '  abc', 'PROMPT>', 'STATUS'];
  const frame =
    '\x1b[?7l' + observed.map((line, y) => `\x1b[${y + 1};1H${line}`).join('') + '\x1b[3;8H';
  await write(
    display,
    await renderer.write(bytes(frame), {
      full: true,
      cols: 70,
      rows: 200,
      viewportCols: 70,
      viewportRows: 8,
    }),
  );
  const key = renderer.historyKey();
  const changed = [...visible];
  changed[1] = '彩different';
  assert.equal(
    await renderer.history(['WRONG BODY', ...changed].join('\n'), key, changed.join('\n')),
    '',
  );
  assert(!screen(display).some((line) => line.includes('WRONG BODY')));
  await write(
    display,
    await renderer.write(bytes('\x1b[3;10H'), {
      cols: 70,
      rows: 200,
      viewportCols: 70,
      viewportRows: 8,
    }),
  );
  assert.equal(
    await renderer.history(['OLD CURSOR', ...visible].join('\n'), key, visible.join('\n')),
    '',
  );
  await write(
    display,
    await renderer.history(
      ['VERIFIED OLDER', ...visible].join('\n'),
      renderer.historyKey(),
      visible.join('\n'),
    ),
  );
  assert.equal(screen(display)[3].trim(), 'VERIFIED OLDER');
  assert.equal(screen(display)[5].trim(), 'abc');
  assert.equal(display.buffer.active.cursorX, 9);
});
test('连续输出的唯一正文重叠延续已验证历史，不重新出现顶部空行', async (t) => {
  const renderer = create({ Terminal, cols: 40, rows: 20 }),
    display = new Terminal({ cols: 40, rows: 20, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  let body = Array.from({ length: 12 }, (_, i) => 'BODY ' + i);
  const native = () => [...body, 'PROMPT>', 'STATUS'];
  const draw = async () =>
    write(
      display,
      await renderer.write(
        bytes(
          native()
            .map((line, y) => `\x1b[${y + 1};1H${line}`)
            .join('') + '\x1b[13;8H',
        ),
        { full: true, cols: 40, rows: 200, viewportCols: 40, viewportRows: 20 },
      ),
    );
  await draw();
  await write(
    display,
    await renderer.history(
      [...Array.from({ length: 10 }, (_, i) => 'OLDER ' + i), ...native()].join('\n'),
      renderer.historyKey(),
    ),
  );
  for (let step = 1; step <= 8; step++) {
    body = [...body.slice(1), 'NEW ' + step];
    await draw();
    assert(screen(display)[0].trim());
    assert.equal(screen(display)[19].trim(), 'STATUS');
    assert.equal(renderer.historyKey(), '', 'Matching body overlap uses verified local rows');
  }
});

test('Codex 提示行显隐及带草稿初次观察均保留原生空行和光标坐标', async (t) => {
  for (const initialDraft of [false, true]) {
    const renderer = create({ Terminal, cols: 80, rows: 12 }),
      display = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
    t.after(() => {
      renderer.dispose();
      display.dispose();
    });
    for (const draft of [initialDraft, !initialDraft, initialDraft]) {
      const frame =
        '\x1b[2J\x1b[HStable transcript\x1b[8;1H› ' +
        (draft ? '水电费' : 'Ask Codex to do anything') +
        '\x1b[10;1HGPT-6-Astra high · ~/workdir/swift' +
        (draft ? '' : '\x1b[11;1H? for shortcuts') +
        '\x1b[8;3H';
      await write(
        display,
        await renderer.write(bytes(frame), {
          full: true,
          cols: 80,
          rows: 200,
          viewportCols: 80,
          viewportRows: 12,
        }),
      );
      assert(screen(display)[1].includes('Stable transcript'));
      assert(screen(display)[10].includes('GPT-6-Astra'));
      assert.equal(screen(display)[11].trim(), draft ? '' : '? for shortcuts');
      assert.equal(display.buffer.active.cursorY, 8);
    }
  }
});

test('Codex 空提示行不参与历史匹配，补齐历史后仍保持正文对应关系', async (t) => {
  const renderer = create({ Terminal, cols: 80, rows: 12 }),
    display = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
  t.after(() => {
    renderer.dispose();
    display.dispose();
  });
  const visible = 'body\r\n\r\n› 草稿\r\n\r\nGPT-6-Astra high · ~/workdir/swift';
  await write(
    display,
    await renderer.write(bytes(visible + '\x1b[3;3H'), {
      full: true,
      cols: 80,
      rows: 200,
      viewportCols: 80,
      viewportRows: 12,
    }),
  );
  await write(display, await renderer.history('history\r\n' + visible, renderer.historyKey()));
  assert.equal(screen(display)[5].trim(), 'history');
  assert.equal(screen(display)[6].trim(), 'body');
  assert.equal(screen(display)[11].trim(), '');
  await write(
    display,
    await renderer.write(bytes('\x1b[6;1H? for shortcuts\x1b[3;3H'), {
      cols: 80,
      rows: 200,
      viewportCols: 80,
      viewportRows: 12,
    }),
  );
  assert.equal(screen(display)[5].trim(), 'history');
  assert.equal(screen(display)[6].trim(), 'body');
  assert.equal(screen(display)[11].trim(), '? for shortcuts');
});
test('replacing a disconnected parser preserves visible cells and ignores writes to the retired instance', async (t) => {
  const original = create({ Terminal, cols: 40, rows: 12 });
  const options = { cols: 40, rows: 12, full: true };
  await original.write(bytes('\x1b[2J\x1b[HCURRENT'), options);
  const replacement = original.restart();
  t.after(() => replacement.dispose());
  assert.equal(await original.write(bytes('LATE_OLD'), options), '');
  const unchanged = await replacement.write(bytes('\x1b[2J\x1b[HCURRENT'), options);
  assert.equal(unchanged, '', 'Identical recovery does not clear or rewrite the visible grid');
  assert.match(await replacement.write(bytes('\rLATEST'), { cols: 40, rows: 12 }), /LATEST/);
});
