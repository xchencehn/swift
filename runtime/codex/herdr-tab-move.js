#!/usr/bin/env node
'use strict';

// Herdr 0.9.3 exposes tab.move on its socket, but not in its CLI.
const net = require('node:net'), path = require('node:path'), os = require('node:os');
const [tabId, index] = process.argv.slice(2);
if (!tabId || !Number.isSafeInteger(Number(index)) || Number(index) < 0) throw new Error('Tab 排列参数无效。');
const socketPath = process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), '.config', 'herdr', 'sessions', process.env.HERDR_SESSION || 'default', 'herdr.sock');
const socket = net.createConnection(socketPath);
let buffer = '', settled = false;
const timer = setTimeout(() => finish(new Error('Tab 排列请求超时。')), 10000);
function finish(error, response) {
  if (settled) return;
  settled = true; clearTimeout(timer); socket.destroy();
  if (error) { console.error('Tab 排列结果未确认，请查看实际顺序。'); process.exitCode = 1; }
  else console.log(JSON.stringify(response));
}
socket.setEncoding('utf8');
socket.write(JSON.stringify({ id: 'hfork:tab.move', method: 'tab.move', params: { tab_id: tabId, insert_index: Number(index) } }) + '\n');
socket.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) return finish(new Error('Invalid response'));
  const end = buffer.indexOf('\n'); if (end < 0) return;
  try { const response = JSON.parse(buffer.slice(0, end)); finish(response.error ? new Error('Tab move failed') : null, response); }
  catch (error) { finish(error); }
});
socket.on('error', finish);
socket.on('close', () => finish(new Error('Connection closed')));
