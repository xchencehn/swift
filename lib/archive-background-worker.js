'use strict';
const { parentPort } = require('node:worker_threads');
const metadata = new (require('./session-metadata').SessionMetadata)();
metadata.conversations = new (require('./conversation-store').ConversationStore)();
const files = new (require('./session-files').SessionFiles)();
parentPort.on('message', async ({ id, kind, file, provider, cwd }) => {
  try {
    let result;
    if (kind === 'metadata') {
      const state = await metadata.scan(file, provider);
      result = Object.fromEntries(
        ['customTitle', 'aiTitle', 'contentTitle', 'lastMessageAt'].map((key) => [key, state[key]]),
      );
    } else result = await files.appearances(file, provider, cwd);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { message: error.message, code: error.code, status: error.status },
    });
  }
});
