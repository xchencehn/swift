'use strict';

// Events are appended in the same transaction as the state change they
// describe. `seq` is the root's durable commit order: clients take a snapshot
// with a cursor, then ask for everything after it, so nothing falls into the
// gap between reading and subscribing.
const RETAINED = 5000;

class EventLog {
  constructor(database, { retain = RETAINED } = {}) {
    this.database = database;
    this.retain = retain;
    this.insert = database.prepare(
      'INSERT INTO events(committed_at, type, entity_type, entity_id, payload) VALUES(?, ?, ?, ?, ?)',
    );
    this.readSince = database.prepare(
      'SELECT seq, committed_at, type, entity_type, entity_id, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
    );
    this.readLatest = database.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events');
    this.readOldest = database.prepare('SELECT COALESCE(MIN(seq), 0) AS seq FROM events');
    this.trim = database.prepare('DELETE FROM events WHERE seq <= ?');
  }

  /** Append one event. Must be called inside a transaction with its change. */
  append({ type, entityType = null, entityId = null, payload = {}, now = Date.now() }) {
    const result = this.insert.run(now, type, entityType, entityId, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  latest() {
    return Number(this.readLatest.get().seq);
  }

  oldest() {
    return Number(this.readOldest.get().seq);
  }

  /**
   * Events after `cursor`. `reset` means the cursor fell out of the retained
   * window, so the caller must take a fresh snapshot instead of patching.
   */
  since(cursor, limit = 500) {
    const latest = this.latest();
    const oldest = this.oldest();
    if (cursor < 0 || cursor > latest) return { reset: true, cursor: latest, events: [] };
    if (cursor > 0 && oldest > 0 && cursor < oldest - 1)
      return { reset: true, cursor: latest, events: [] };
    const rows = this.readSince.all(cursor, limit).map((row) => ({
      seq: Number(row.seq),
      committedAt: Number(row.committed_at),
      type: row.type,
      entity: row.entity_type ? { type: row.entity_type, id: row.entity_id } : null,
      payload: JSON.parse(row.payload),
    }));
    return { reset: false, cursor: rows.length ? rows.at(-1).seq : cursor, events: rows };
  }

  /** Drop events older than the retained window. Call inside a transaction. */
  prune() {
    const latest = this.latest();
    if (latest > this.retain) this.trim.run(latest - this.retain);
  }
}

module.exports = { EventLog, RETAINED };
