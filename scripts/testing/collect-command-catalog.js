'use strict';
// Explicit, isolated native-menu collection. It never executes a menu item.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./message-rewind-fixture');
const { stripAnsi } = require('../../public/ansi');
const { herdrRequest } = require('../../lib/herdr-input');
async function collect(executable, output) {
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).match(
    /\b\d+\.\d+\.\d+\b/,
  )[0];
  return fixture(
    path.join(output, version),
    async (f) => {
      const read = () => f.herdr.readPane(f.paneId, { lines: 120, ansi: true, exact: true });
      await f.paste(await f.exactPane(), '/');
      const commands = new Map();
      let stable = 0;
      for (let i = 0; i < 180 && stable < 70; i++) {
        const raw = await read(),
          before = commands.size;
        for (const line of stripAnsi(raw).replace(/\r/g, '').split('\n')) {
          const hit = /^\s*(?:[›»❯]\s*)?\/([\w:.-]+)(?:\s{2,}(\S.*))?\s*$/.exec(line);
          if (hit && hit[1])
            commands.set(hit[1], { name: hit[1], description: hit[2]?.trim() || '' });
        }
        stable = commands.size === before ? stable + 1 : 0;
        await herdrRequest(
          'pane.send_keys',
          { pane_id: f.paneId, keys: ['down'] },
          { socketFile: f.herdr.socketPath },
        );
        await f.delay(35);
      }
      assert(commands.size > 40, 'the real native slash menu must be collected');
      assert(commands.has('goal'));
      assert.equal(f.requests.length, 0, 'collection never creates a model request');
      const data = {
        provider: 'codex',
        version,
        source: 'isolated-native-slash-menu',
        commands: [...commands.values()],
      };
      await fs.writeFile(
        path.join(output, version + '.json'),
        JSON.stringify(data, null, 2) + '\n',
      );
      return { version, commands: commands.size, modelRequests: 0 };
    },
    {
      cols: 160,
      rows: 45,
      noAltScreen: false,
      noDaemon: true,
      codexExecutable: executable,
      codexConfig: ['tui.status_line=["model-with-reasoning","current-dir"]'],
    },
  );
}
(async () => {
  const output = path.resolve('artifacts/testing/goal-command/catalog');
  await fs.mkdir(output, { recursive: true });
  for (const arg of process.argv.slice(2)) {
    assert(path.isAbsolute(arg));
    console.log(JSON.stringify(await collect(arg, output)));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
