'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { TerminalScreen } = require('../../lib/terminal-screen');
const { WatchStreamParser } = require('../../lib/watch-stream');
const { sourceFingerprint } = require('../lib/source-fingerprint');

async function main() {
  if (process.env.HERDR_ENV !== '1')
    throw new Error('Read-only verification requires a Herdr-managed environment.');
  const terminalId = process.argv
    .find((arg) => arg.startsWith('--terminal='))
    ?.slice('--terminal='.length);
  if (!terminalId || !/^[\w:.-]{1,128}$/.test(terminalId))
    throw new Error('Specify an explicit --terminal=<terminal ID>.');
  const versions = {};
  for (const binary of ['herdr', 'codex', 'claude']) {
    try {
      versions[binary] = execFileSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      versions[binary] = 'unavailable';
    }
  }
  let snapshot,
    frames = 0,
    fullFrames = 0;
  const started = Date.now(),
    screen = new TerminalScreen({
      onScreen: (value) => {
        snapshot = value;
      },
    });
  const child = spawn(
    'herdr',
    ['terminal', 'session', 'observe', terminalId, '--cols', '250', '--rows', '120'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const parser = new WatchStreamParser({
    onFrame: (data, frame) => {
      frames++;
      if (frame?.full) fullFrames++;
      screen.feed(data, frame);
    },
    onEnd: () => {},
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => parser.push(chunk));
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 2000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  parser.finish();
  await screen.pending;
  screen.close();
  if (spawnError) throw spawnError;
  if (!snapshot || !fullFrames) throw new Error('No complete native screen received.');
  const text = snapshot.rows.map((row) => row.map((span) => span.text).join('')).join('\n');
  const proof = {
    at: new Date().toISOString(),
    terminalId,
    installedVersions: versions,
    elapsedMs: Date.now() - started,
    frames,
    fullFrames,
    rows: snapshot.rows.length,
    cols: snapshot.cols,
    recognized: snapshot.projection.recognized,
    screenSha256: createHash('sha256').update(JSON.stringify(snapshot.rows)).digest('hex'),
    observed: {
      completed: /Worked for/.test(text),
      recap: /Recap:/.test(text),
      reconnectError: /connection could not be restored|Reconnect failed/.test(text),
      footerReady: /Ready/.test(text),
      weekly78: /weekly 78% left/.test(text),
    },
    source: sourceFingerprint(path.resolve(__dirname, '../..')),
  };
  const output = path.resolve(__dirname, '../../artifacts/native-terminal-sync/live-proof.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(proof, null, 2) + '\n');
  process.stdout.write(
    JSON.stringify({ ...proof, source: proof.source.treeSha256, output }, null, 2) + '\n',
  );
}
main().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
