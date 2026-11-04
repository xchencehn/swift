'use strict';
const fs = require('node:fs/promises'),
  net = require('node:net');
const { StringDecoder } = require('node:string_decoder');
const { processStart } = require('./codex-restart');
const { apiError } = require('./message-queue');
const pending = new Map();
const fail = (message) => apiError(409, 'SIDE_NATIVE_UNAVAILABLE', message);
async function request(pane, operation = 'state', sideId, text, turnId) {
  const pid = Number(pane.runtimeId?.split(':')[0]);
  if (!pid || (await processStart(pid).catch(() => '')) !== pane.runtimeId) return null;
  const socketPath = `/tmp/swift-codex-${pane.runtimeId.replace(':', '-')}.sock`;
  const stat = await fs.lstat(socketPath).catch(() => null);
  if (!stat?.isSocket() || stat.mode & 0o077) return null;
  const mainId = pane.agent?.session?.value;
  const key = `${pane.runtimeId}:${mainId}:${operation}:${sideId || ''}`;
  if (!['fork', 'send', 'interrupt'].includes(operation) && pending.has(key))
    return pending.get(key);
  const work = new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8'),
      socket = net.createConnection(socketPath);
    let data = '',
      size = 0,
      done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(operation === 'fork' ? 30000 : 5000, () =>
      finish(fail('原生临时会话读取超时，请稍后重试。')),
    );
    socket.on('error', () => finish(fail('原生临时会话连接已中断。')));
    socket.on('connect', () =>
      socket.end(JSON.stringify({ operation, mainId, sideId, text, turnId }) + '\n'),
    );
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) return finish(fail('原生临时会话响应超过读取上限。'));
      data += decoder.write(chunk);
      if (!data.includes('\n')) return;
      try {
        const value = JSON.parse(data);
        if (
          value.error ||
          value.version !== 1 ||
          (operation !== 'identity' && value.mainId !== mainId) ||
          (sideId && value.sideId !== sideId)
        )
          return finish(fail('临时会话身份或原生状态已改变，请重新确认。'));
        finish(null, value);
      } catch {
        finish(fail('原生临时会话响应无效。'));
      }
    });
    socket.on('end', () => {
      if (!done) finish(fail('原生临时会话结果尚未确认。'));
    });
  })
    .then(async (value) => {
      if ((await processStart(pid).catch(() => '')) !== pane.runtimeId)
        throw fail('Codex 进程已改变，请重新选择会话。');
      return value;
    })
    .finally(() => pending.delete(key));
  if (!['fork', 'send', 'interrupt'].includes(operation)) pending.set(key, work);
  return work;
}
function messages(thread, options) {
  if (Array.isArray(thread?.extra?.swiftSideItems)) {
    const { parseCodexTranscript } = require('./agent-transcript');
    return parseCodexTranscript(
      thread.extra.swiftSideItems.map((payload) =>
        JSON.stringify({ type: 'response_item', payload }),
      ),
      options,
    ).map((message) => ({ ...message, id: `${thread.id}:${message.id}` }));
  }
  const result = [];
  let boundary = -1;
  // Side turns contain no inherited parent transcript, matching native /side.
  for (const turn of thread?.turns || [])
    for (const item of turn.items || []) {
      const blocks = [];
      let role = 'assistant';
      if (item.type === 'userMessage') {
        role = 'user';
        for (const input of item.content || []) {
          if (input.type === 'text' && input.text) blocks.push({ kind: 'text', text: input.text });
          else if (input.type === 'image' || input.type === 'localImage')
            blocks.push({ kind: 'text', text: input.path || input.url || '[图片]' });
        }
      } else if (['agentMessage', 'plan'].includes(item.type))
        blocks.push({ kind: 'text', text: item.text || '' });
      else if (item.type === 'reasoning')
        blocks.push({
          kind: 'thinking',
          text: [...(item.summary || []), ...(item.content || [])].join('\n'),
        });
      else if (
        [
          'commandExecution',
          'fileChange',
          'mcpToolCall',
          'dynamicToolCall',
          'webSearch',
          'imageView',
          'functionCall',
        ].includes(item.type)
      ) {
        const name =
          item.type === 'commandExecution' ? 'exec_command' : item.tool || item.name || item.type;
        blocks.push({
          kind: 'tool',
          id: item.id,
          name,
          input: {
            text: JSON.stringify(
              item.command
                ? { cmd: item.command, cwd: item.cwd }
                : item.arguments || item.changes || item.action || {},
            ),
          },
          result:
            item.status === 'inProgress'
              ? null
              : {
                  text:
                    typeof (item.aggregatedOutput || item.result || item.output) === 'string'
                      ? item.aggregatedOutput || item.result || item.output
                      : JSON.stringify(item.result || item.output || ''),
                  isError: item.status === 'failed',
                },
          status: item.status,
          running: item.status === 'inProgress',
          exitCode: item.exitCode,
        });
      } else if (item.type === 'functionCallOutput')
        blocks.push({
          kind: 'tool',
          id: item.id,
          name: item.name,
          input: null,
          result: {
            text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
          },
          status: 'completed',
        });
      if (
        role === 'user' &&
        blocks.some((block) => block.text?.startsWith('Side conversation boundary.'))
      ) {
        boundary = result.length;
        continue;
      }
      if (blocks.some((block) => block.text || block.kind === 'tool'))
        result.push({
          id: `${thread.id}:${turn.id}:${item.id}`,
          role,
          ts: item.startedAtMs ? new Date(item.startedAtMs).toISOString() : null,
          blocks,
        });
    }
  return boundary >= 0 ? result.slice(boundary) : result;
}
module.exports = { request, messages };
