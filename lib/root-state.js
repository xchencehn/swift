'use strict';
const crypto = require('node:crypto');
const { SessionHistory } = require('./session-history');
const { SessionMetadata } = require('./session-metadata');
const { SessionFiles } = require('./session-files');
const { Database } = require('./store/database');
const { EventLog } = require('./store/events');
const { MessageStore } = require('./store/message-store');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
function stateNames(session) {
  return { messages: `messages-${hash(session)}.json`, database: `studio-${hash(session)}.sqlite` };
}
class RootState {
  constructor(data, { session, onChange = () => {}, onArchiveFailure = () => {} }) {
    this.data = data;
    const names = stateNames(session);
    this.messageFile = data.initialize(`state/${names.messages}`, { version: 1, items: [] });
    // Product state and the sync event log share one database per root, so a
    // change and the event announcing it commit together.
    this.database = new Database(data.file(`state/${names.database}`));
    this.events = new EventLog(this.database);
    this.messageStore = new MessageStore(this.database, this.events);
    // First start after the migration adopts the JSON outbox. The file stays
    // on disk as a backup and is not written again.
    this.importedMessages = this.messageStore.importFrom(this.messageFile);
    this.history = new SessionHistory({
      file: data.initialize('state/session-history.json', {}),
      rootDirectory: data.directory,
      cacheFile: data.initialize('cache/session-index.json', { version: 1, files: [] }),
    });
    this.conversations = new (require('./async-conversation-store').AsyncConversationStore)({
      onFailure: onArchiveFailure,
      indexFile: data.file('cache/conversations-v1.sqlite'),
    });
    this.sessionMetadata = new SessionMetadata();
    this.sessionMetadata.conversations = this.conversations;
    this.sessionMetadata.readBackground = (file, provider) =>
      this.conversations.backgroundRead('metadata', file, provider);
    this.sessionMetadata.onChange = onChange;
    this.sessionFiles = new SessionFiles();
    this.sessionFiles.appearances = (file, provider, cwd) =>
      this.conversations.backgroundRead('files', file, provider, cwd);
    this.sessionFiles.list = (file, provider, cwd) =>
      this.sessionFiles.appearances(file, provider, cwd).then((value) => value.written);
    this.historyResumes = new Map();
    this.messageQueue = null;
  }
}
module.exports = { RootState, stateNames };
