#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const baseUrl = (process.env.SMOKE_URL || 'http://127.0.0.1:8791/swift').replace(/\/$/, '');
const token = process.env.SMOKE_TOKEN || process.env.AGENT_STUDIO_TOKEN;
if (!token) throw new Error('SMOKE_TOKEN or AGENT_STUDIO_TOKEN is required');

function waitFor(check, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const result = check();
      if (result) {
        clearInterval(timer);
        resolve(result);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('raw PTY websocket timed out'));
      }
    }, 20);
  });
}

async function run() {
  const url = new URL(`${baseUrl.replace(/^http/, 'ws')}/api/terminal`);
  url.search = new URLSearchParams({ token, cols: '96', rows: '28' });
  const ws = new WebSocket(url);
  const metadata = [];
  const output = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) output.push(raw);
    else metadata.push(JSON.parse(String(raw)));
  });
  const ready = await waitFor(() => metadata.find((message) => message.type === 'terminal.ready'));
  await waitFor(() => Buffer.concat(output).length > 0);
  ws.send(JSON.stringify({ type: 'terminal.resize', cols: 100, rows: 30 }));
  const bytes = Buffer.concat(output);
  if (!bytes.includes(Buffer.from('\u001b')))
    throw new Error('raw PTY output did not contain terminal control sequences');
  ws.close();
  console.log(
    JSON.stringify({
      ok: true,
      transport: ready.transport,
      session: ready.session,
      binaryOutput: true,
      bytes: bytes.length,
      resize: true,
    }),
  );
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
