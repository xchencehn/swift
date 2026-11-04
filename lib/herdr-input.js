'use strict';

const net = require('net');
const { socketPath } = require('./herdr-events');
const { readStatusArea } = require('./agent-composer');

// A socket receipt confirms transport acceptance, never archive consumption.
function sendPaneInput(method, params, { socketFile = socketPath(), timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketFile);
    let buffer = '';
    let settled = false;
    let written = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        if (['EPIPE', 'ECONNRESET'].includes(error.code))
          error.message = written
            ? 'Swift 与 Herdr 的本机连接在确认前中断，投递结果尚未确认。请先查看聊天记录，避免重复发送。'
            : 'Swift 暂时无法连接本机 Herdr，本次没有投递，请稍后重试。';
        error.deliveryUncertain = written;
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(new Error('Herdr 输入请求超时，投递结果不确定。'), {
            code: 'SEND_TIMEOUT',
          }),
        ),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    // Queue the request before connect, as the read client does, so Herdr
    // never accepts an empty connection and waits for another polling cycle.
    socket.on('connect', () => {
      written = true;
    });
    socket.write(`${JSON.stringify({ id: 'swift-message', method, params })}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish(new Error('Herdr 输入响应过大。'));
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, index));
        if (response.id !== 'swift-message') throw new Error('Herdr 输入响应 id 不匹配。');
        if (response.error) {
          const error = Object.assign(new Error(response.error.message), {
            code: response.error.code,
          });
          // These protocol errors are documented to reject before input. No retry
          // or raw-pane fallback is allowed after an ambiguous write.
          if (
            [
              'agent_blocked',
              'agent_not_found',
              'agent_not_ready',
              'method_not_found',
              'unknown_method',
              'invalid_params',
            ].includes(error.code)
          )
            written = false;
          throw error;
        }
        if (!response.result) throw new Error('Herdr 输入响应缺少 result。');
        finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('Herdr 连接在确认输入前关闭，投递结果不确定。')));
  });
}

/** Submit to a recognized agent. Herdr owns paste mode and delayed Enter. */
async function sendPaneMessage(paneId, text, options) {
  if (typeof paneId !== 'string' || !paneId || typeof text !== 'string') {
    throw Object.assign(new Error('paneId 和 text 必须明确指定。'), { deliveryUncertain: false });
  }
  return sendPaneInput('agent.prompt', { target: paneId, text }, options);
}

// A deliberately answered interactive question is not a new prompt:
// agent.prompt correctly rejects blocked agents. Keep the targeted paste path
// for these already validated dialogs, and submit Enter only once.
async function sendPaneAnswer(paneId, text, options) {
  if (typeof paneId !== 'string' || !paneId || typeof text !== 'string')
    throw Object.assign(new Error('paneId 和 text 必须明确指定。'), { deliveryUncertain: false });
  let accepted = false;
  try {
    const result = await sendPaneInput(
      'pane.send_input',
      { pane_id: paneId, text, keys: [] },
      options,
    );
    accepted = true;
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt ? 120 : 80));
      const response = await sendPaneInput(
        'pane.read',
        { pane_id: paneId, source: 'recent', lines: 40, format: 'ansi' },
        options,
      );
      const status = readStatusArea(response?.read?.text || '');
      if (status.composer && !status.composerHint) break;
    }
    await options?.beforeSubmit?.();
    await sendPaneInput('agent.send_keys', { target: paneId, keys: ['enter'] }, options);
    return result;
  } catch (error) {
    if (accepted) error.deliveryUncertain = true;
    throw error;
  }
}

function interruptPane(paneId, options) {
  if (typeof paneId !== 'string' || !paneId) return Promise.reject(new Error('缺少 paneId。'));
  // Agent keys validate the current occupant and do not depend on focus.
  return sendPaneInput('agent.send_keys', { target: paneId, keys: ['esc'] }, options);
}

function sendPaneKeys(paneId, keys, options) {
  return sendPaneInput('pane.send_keys', { pane_id: paneId, keys }, options);
}

function pastePaneText(paneId, text, options) {
  return sendPaneInput('pane.send_input', { pane_id: paneId, text, keys: [] }, options);
}

module.exports = {
  sendPaneMessage,
  sendPaneAnswer,
  interruptPane,
  sendPaneKeys,
  pastePaneText,
  herdrRequest: sendPaneInput,
};
