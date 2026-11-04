(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioDrafts = factory();
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  function identity(pane) {
    const label = String(pane?.agent?.label || '').toLowerCase();
    const provider = label.includes('claude') ? 'claude' : label;
    const native = pane?.agent?.session?.value;
    if (!provider) return '';
    if (native) return `${provider}:session:${native}`;
    const runtime = pane.runtimeId || pane.terminalId;
    return runtime ? `${provider}:runtime:${runtime}:${pane.paneId}` : '';
  }
  function create({ storage, namespace = '', onError = () => {}, onSaved = () => {} } = {}) {
    const roots = new Map();
    const legacy = new Set();
    let memory = new Map();
    let rootDirectory = '',
      key = '',
      lastError = '';
    const dirty = new Map();
    const draftKey = (id) => `${key}:draft:${encodeURIComponent(id)}`;
    function load(root) {
      if (root === rootDirectory && key) return;
      rootDirectory = root || '';
      key = `agentStudioDrafts:${namespace}:${rootDirectory}`;
      if (roots.has(rootDirectory)) {
        memory = roots.get(rootDirectory);
        return;
      }
      memory = new Map();
      roots.set(rootDirectory, memory);
      try {
        const value = JSON.parse(storage?.getItem(key) || 'null');
        if (value?.version === 1 && Array.isArray(value.drafts)) {
          for (const item of value.drafts)
            if (typeof item?.identity === 'string' && typeof item?.text === 'string') {
              memory.set(item.identity, item.text);
              if (item.text) legacy.add(draftKey(item.identity));
            }
        }
      } catch (error) {
        report(error, 'read');
      }
    }
    function report(error, operation = 'write') {
      const name = error?.name || 'StorageUnavailable';
      lastError = name;
      onError(name, operation);
    }
    function discardBootCache() {
      // Only disposable startup snapshots compete with drafts for this quota.
      // Never delete drafts, preferences, connection data or IndexedDB replicas.
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name === 'agentStudioBoot' || name?.startsWith('agentStudioBoot:')) keys.push(name);
      }
      for (const name of keys) storage.removeItem(name);
      return keys.length > 0;
    }
    function write(name, value) {
      // Old aggregate records need a tombstone until they have been migrated.
      if (!value && !legacy.has(name)) storage.removeItem(name);
      else {
        const encoded = JSON.stringify(value);
        if (storage.getItem(name) !== encoded) storage.setItem(name, encoded);
      }
    }
    function save() {
      if (!rootDirectory) return false;
      if (!storage) {
        report();
        return false;
      }
      try {
        // Each native session owns one value. Parallel pane pages must not
        // overwrite other sessions with an older copy of the whole draft map.
        for (const [name, value] of dirty) {
          try {
            write(name, value);
          } catch (error) {
            if (error?.name !== 'QuotaExceededError' || !discardBootCache()) throw error;
            write(name, value);
          }
          dirty.delete(name);
        }
        lastError = '';
        onSaved();
        return true;
      } catch (error) {
        report(error);
        return false;
      }
    }
    function set(pane, text) {
      const id = identity(pane);
      if (!id || !rootDirectory) return false;
      if (text) memory.set(id, text);
      else memory.delete(id);
      dirty.set(draftKey(id), text || '');
      return save();
    }
    function get(pane) {
      const id = identity(pane),
        name = draftKey(id);
      if (dirty.has(name)) return dirty.get(name);
      try {
        const value = storage?.getItem(name);
        if (value != null) {
          const text = JSON.parse(value);
          if (typeof text === 'string') return text;
        }
        // Another window may have deleted this record. Only the old aggregate
        // format can legitimately supply text when no per-session item exists.
        return legacy.has(name) ? memory.get(id) || '' : '';
      } catch (error) {
        report(error, 'read');
      }
      return memory.get(id) || '';
    }
    return { load, set, get, error: () => lastError, flush: save };
  }
  return { create, identity };
});
