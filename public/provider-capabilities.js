// Generated from shared/provider-capabilities.ts; do not edit.
(function (root) {
  const exports = {};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseProviders = exports.jsonlProviders = exports.providers = void 0;
exports.get = get;
exports.all = all;
exports.sessionKey = sessionKey;
const unsupported = Object.freeze({
    id: '',
    archive: null,
    history: false,
    pagination: false,
    sync: false,
    send: false,
    stop: false,
    settings: false,
    questions: false,
    create: false,
    resume: false,
    terminalObserve: false,
    sessionFiles: false,
});
const readable = { history: true, pagination: true, sync: true, terminalObserve: true };
const controllable = {
    send: true,
    stop: true,
    settings: true,
    questions: true,
    create: true,
    resume: true,
    sessionFiles: true,
};
const definitions = [
    { ...unsupported, ...readable, ...controllable, id: 'codex', archive: 'jsonl' },
    { ...unsupported, ...readable, ...controllable, id: 'claude', archive: 'jsonl' },
    ...['pi', 'omp', 'omo', 'gjc'].map((id) => ({
        ...unsupported,
        ...readable,
        id,
        archive: 'jsonl',
    })),
    ...['opencode', 'devin'].map((id) => ({
        ...unsupported,
        ...readable,
        id,
        archive: 'sqlite',
    })),
];
const registry = new Map(definitions.map((value) => [value.id, Object.freeze(value)]));
exports.providers = Object.freeze(definitions.map((value) => value.id));
exports.jsonlProviders = Object.freeze(definitions.filter((value) => value.archive === 'jsonl').map((value) => value.id));
exports.databaseProviders = Object.freeze(definitions.filter((value) => value.archive === 'sqlite').map((value) => value.id));
function get(provider) {
    return registry.get(typeof provider === 'string' ? provider.toLowerCase() : '') || unsupported;
}
function all() {
    return [...registry.values()];
}
function sessionKey(provider, sessionId) {
    const capabilities = get(provider);
    return capabilities.sync && typeof sessionId === 'string' && sessionId
        ? `${capabilities.id}:${sessionId}`
        : '';
}

  if (typeof module === 'object' && module.exports) module.exports = exports;
  else root.StudioProviders = exports;
})(typeof globalThis === 'undefined' ? this : globalThis);
