'use strict';

// Native archives are read-only. Parsing them must never occupy the event loop
// that owns HTTP, WebSocket heartbeats and Herdr input sockets.
const { parentPort } = require('node:worker_threads');
const { ConversationStore } = require('./conversation-store');
const store = new ConversationStore();
parentPort.on('message', async ({ id, file, provider, fields }) => {
  try {
    const value = await store.read(file, provider),
      result = {};
    for (const field of fields) {
      if (field.startsWith('tool:')) {
        const id = field.slice(5);
        const messages = require('./agent-transcript').parseTranscript(provider, value.lines, {
          toolTextLimit: Infinity,
        });
        const tool = messages
          .flatMap((message) => message.blocks)
          .find((block) => block.kind === 'tool' && block.id === id);
        result.tool = tool ? require('./agent-transcript').describeTool(tool) : null;
        continue;
      }
      result[field] =
        field === 'archivedSettings'
          ? require('./agent-settings').archivedSettings(provider, value.lines)
          : field === 'questionState'
            ? require('./questions/codex').questionState(value.lines)
            : field === 'pendingQuestion'
              ? require('./agent-questions').pendingQuestion(provider, value.lines)
              : value[field];
      // structuredClone omits non-enumerable properties. Native user text is
      // needed to reconcile attachments and must survive the worker boundary.
      if (field === 'messages' || field === 'conversation')
        result[field] = value[field].map((message) =>
          Object.hasOwn(message, 'source') ? { ...message, source: message.source } : message,
        );
    }
    const bytes = require('node:v8').serialize(result).byteLength;
    parentPort.postMessage({ id, result, bytes, version: store.readVersions.get(value) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { message: error.message, code: error.code, status: error.status },
    });
  }
});
