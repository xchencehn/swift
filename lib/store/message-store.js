'use strict';

const fs = require('node:fs');

/**
 * Durable storage for the outbox, replacing the whole-file JSON rewrite.
 *
 * The queue keeps its items in memory and calls `save` after every change, so
 * this mirrors that contract: one transaction updates changed records and
 * appends the event describing which panes moved. The full set remains identical
 * to the durable queue, while settled historical receipts are neither deleted nor rewritten for an unrelated state change.
 */
class MessageStore {
  constructor(database, events) {
    this.database = database;
    this.events = events;
    this.remove = database.prepare('DELETE FROM messages WHERE id = ?');
    this.insert = database.prepare(
      'INSERT INTO messages(id, pane_id, updated_at, position, item) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET pane_id=excluded.pane_id, updated_at=excluded.updated_at, position=excluded.position, item=excluded.item',
    );
    this.readAll = database.prepare('SELECT item FROM messages ORDER BY position');
    this.saved = MessageStore.snapshot(this.load());
  }

  load() {
    return this.readAll.all().map((row) => JSON.parse(row.item));
  }

  /** Commit only changed records. A supplied change set avoids serializing historical receipts. */
  save(items, { now = Date.now(), type = 'messages.changed', changedIds = null } = {}) {
    const before = this.database.inTransaction ? this.staged || this.saved : this.saved;
    const hints = changedIds && new Set(changedIds);
    const next = new Map(),
      changed = [],
      panes = new Set();
    items.forEach((item, position) => {
      const previous = before.get(item.id);
      if (hints && previous && previous.position === position && !hints.has(item.id)) {
        next.set(item.id, previous);
        return;
      }
      const value = {
        paneId: item.paneId,
        updatedAt: item.updatedAt ?? now,
        position,
        json: JSON.stringify(item),
      };
      next.set(item.id, value);
      if (!previous || value.json !== previous.json || position !== previous.position) {
        changed.push([item.id, value]);
        panes.add(item.paneId);
        if (previous) panes.add(previous.paneId);
      }
    });
    const removed = [...before.keys()].filter((id) => !next.has(id));
    for (const id of removed) panes.add(before.get(id).paneId);
    panes.delete(null);
    panes.delete(undefined);
    const paneIds = [...panes];
    const result = this.database.transaction(() => {
      for (const id of removed) this.remove.run(id);
      for (const [id, value] of changed)
        this.insert.run(id, value.paneId, value.updatedAt, value.position, value.json);
      const seq = this.events.append({ type, entityType: 'outbox', payload: { paneIds }, now });
      this.events.prune();
      return { seq, paneIds, upserted: changed.length, removed: removed.length };
    });
    if (this.database.inTransaction) {
      this.staged = next;
      this.database.afterRollback(() => {
        this.staged = null;
      });
    }
    this.database.afterCommit(() => {
      this.staged = null;
      this.saved = next;
      this.writeStats = { upserted: changed.length, removed: removed.length };
    });
    return result;
  }

  static snapshot(items) {
    return new Map(
      items.map((item, position) => [
        item.id,
        {
          paneId: item.paneId,
          updatedAt: item.updatedAt ?? null,
          position,
          json: JSON.stringify(item),
        },
      ]),
    );
  }

  changedPanes(items) {
    const next = MessageStore.snapshot(items),
      panes = new Set();
    for (const [id, value] of next) {
      const before = this.saved.get(id);
      if (!before || value.json !== before.json || value.position !== before.position) {
        panes.add(value.paneId);
        if (before) panes.add(before.paneId);
      }
    }
    for (const [id, before] of this.saved) if (!next.has(id)) panes.add(before.paneId);
    panes.delete(null);
    panes.delete(undefined);
    return [...panes];
  }

  /**
   * One-time import of the JSON outbox. Returns the number of imported items.
   * The JSON file is kept as a backup; it is never deleted by this code.
   */
  importFrom(file, { now = Date.now() } = {}) {
    if (!file || !fs.existsSync(file)) return 0;
    if (this.readAll.all().length) return 0;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.items))
      throw new Error('消息队列文件格式不正确。');
    if (!data.items.length) return 0;
    this.save(data.items, { now, type: 'messages.imported' });
    return data.items.length;
  }
}

module.exports = { MessageStore };
