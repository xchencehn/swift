'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { ConversationIndex } = require('./conversation-index');
const index = new ConversationIndex({ file: workerData?.file });
parentPort.on('message', async ({ id, file, provider, options }) => {
  try {
    parentPort.postMessage({ id, result: await index.page(file, provider, options) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { message: error.message, code: error.code, status: error.status },
    });
  }
});
