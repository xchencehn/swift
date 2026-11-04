'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Schema versions are applied in order and never edited once shipped. Each
// entry runs inside its own transaction; a failed step leaves the previous
// version intact rather than a half-applied schema.
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE messages (
        id          TEXT PRIMARY KEY,
        pane_id     TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        position    INTEGER NOT NULL,
        item        TEXT NOT NULL
      );
      CREATE INDEX messages_pane ON messages(pane_id);
      CREATE INDEX messages_position ON messages(position);

      CREATE TABLE events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        committed_at INTEGER NOT NULL,
        type         TEXT NOT NULL,
        entity_type  TEXT,
        entity_id    TEXT,
        payload      TEXT NOT NULL
      );
      CREATE INDEX events_committed ON events(committed_at);
    `,
  },
  {
    version: 2,
    sql: `
      -- Claude sessions driven through the structured stream-json channel.
      -- The id is assigned by us before anything runs; the row survives the
      -- worker process, which is what makes a session resumable.
      CREATE TABLE claude_sessions (
        session_id TEXT PRIMARY KEY,
        cwd        TEXT NOT NULL,
        title      TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        closed_at  INTEGER
      );
      CREATE INDEX claude_sessions_open ON claude_sessions(closed_at);
    `,
  },
  {
    version: 3,
    sql: `
      -- 任务层。工作区就是工作根目录下的一个项目目录，所以工作区标识用目录的
      -- 绝对路径：Herdr 的 workspace_id 随运行时重建而变，拿它当外键会在重启
      -- 之后指向空集，而空集看着像「没有任务」而不是「查错了」。
      --
      -- task_id 形如 0001-spmm-backward，同时是任务目录的目录名。编号在工作区
      -- 内自增，但这里按全局主键存：task_sessions 与 task_runs 只带 task_id，
      -- 单列外键才能把「引用的是哪个任务」表达完整。编号对用户不可见，所以另一
      -- 个工作区已经占用同名同号时跳号，而不是改目录名。
      CREATE TABLE tasks (
        task_id       TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        title         TEXT NOT NULL,
        goal          TEXT NOT NULL DEFAULT '',
        state         TEXT NOT NULL,
        -- waiting 必须说明在等什么，否则恢复时无法判断该不该继续调度。
        wait_reason   TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        closed_at     INTEGER,
        version       INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX tasks_workspace ON tasks(workspace_key);
      CREATE INDEX tasks_open ON tasks(closed_at);

      -- 任务与会话多对多。主键是 link_id 而不是 (task_id, session_id)：同一对
      -- 解除之后可以重建，每一次关联的建立与解除时间都要留下来。活跃关联的唯一
      -- 性交给部分唯一索引，它只约束 removed_at 为空的行。
      --
      -- session_id 故意没有外键：会话可能是 Herdr 里的原生 Codex/Claude 会话，
      -- 它们不在这个库里有行，加外键会让关联原生会话直接失败。
      CREATE TABLE task_sessions (
        link_id    TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        removed_at INTEGER,
        created_by TEXT
      );
      CREATE UNIQUE INDEX task_sessions_active ON task_sessions(task_id, session_id) WHERE removed_at IS NULL;
      CREATE INDEX task_sessions_session ON task_sessions(session_id);

      -- 执行记录。task_id 可空且不进主键，将来扩成「一次执行关联零到多个任务」
      -- 时只需另建关联表，这张表的身份不用改。删除任务不回收已产生的执行记录，
      -- 所以外键是 SET NULL 而不是 CASCADE。
      CREATE TABLE task_runs (
        run_id       TEXT PRIMARY KEY,
        task_id      TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
        session_id   TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        outcome      TEXT,
        code_version TEXT,
        notes        TEXT
      );
      CREATE INDEX task_runs_task ON task_runs(task_id);
      CREATE INDEX task_runs_session ON task_runs(session_id);
    `,
  },
  {
    version: 4,
    sql: `
      -- 一次执行可以关联零到多个任务。一个会话在一轮里常常同时推进几个任务
      -- （docs/ARCHITECTURE.md 第 3 节），task_runs 的单列 task_id 表达不了，
      -- 按 migration 3 里预留的办法另建关联表，task_runs 的身份不变。
      --
      -- 删除任务不回收已产生的执行记录：这里的 CASCADE 删掉的是「归属」这条关联，
      -- 执行记录本身留在 task_runs 里，只是不再属于任何任务。
      CREATE TABLE task_run_tasks (
        run_id     TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE CASCADE,
        task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, task_id)
      );
      CREATE INDEX task_run_tasks_task ON task_run_tasks(task_id);

      -- 结果未知要与失败分得开：outcome='unknown' 表示工作进程在确认前消失，命令
      -- 可能已经生效，既不能当成功也不能当失败，必须留着等对账，不得自动重放有
      -- 副作用的操作（docs/ARCHITECTURE.md 8.5）。原因单独一列而不是混进 notes：
      -- notes 是写给人看的说明，对账要能只看这一列就知道该去核对什么。
      ALTER TABLE task_runs ADD COLUMN unknown_reason TEXT;

      -- migration 4 之前按单列 task_id 写下的执行记录一次性搬进关联表，此后读取
      -- 只认关联表。同一件事留两个来路，早晚会「有时对有时不对」。
      INSERT INTO task_run_tasks(run_id, task_id, created_at)
        SELECT run_id, task_id, started_at FROM task_runs WHERE task_id IS NOT NULL;

      CREATE INDEX task_runs_outcome ON task_runs(outcome);
    `,
  },
  {
    version: 5,
    sql: `
      -- 会话命名。会话只有一级名字：一句短语（docs/PRODUCT_SPEC.md 2.5）。
      -- 短语本身不必存 —— 它每次都能从存档里的自动命名重新算出来；这里存的是
      -- 「上一次自动写进终端标签页的是什么」，用来区分标签页现在这个名字是我们
      -- 写的还是用户自己改的。不存这一条就只能靠名字的形状猜，而猜错的方向是
      -- 把用户改的名字覆盖掉。
      CREATE TABLE session_names (
        session_key TEXT PRIMARY KEY,
        auto_name   TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `,
  },
  // Version 6 is retired; do not reuse a previously allocated schema version.
  { version: 6, sql: '' },
];

/**
 * One SQLite database per work root, holding product state and the event log
 * that drives multi-client sync. Business changes and their events commit in
 * the same transaction, so a crash after commit can still replay them.
 */
class Database {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    // FULL keeps the durability the JSON outbox had through fsync. The queue
    // fails closed on storage errors, so a lost last commit is not acceptable.
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=FULL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.migrate();
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort on platforms without chmod */
    }
  }

  migrate() {
    const current = this.db.prepare('PRAGMA user_version').get().user_version;
    for (const { version, sql } of MIGRATIONS) {
      if (version <= current) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version=${version}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  /** Run `body` in one transaction. Nested calls join the outer transaction. */
  transaction(body) {
    if (this.inTransaction) return body();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    this.commitCallbacks = [];
    this.rollbackCallbacks = [];
    try {
      const result = body();
      this.db.exec('COMMIT');
      const callbacks = this.commitCallbacks;
      this.inTransaction = false;
      this.commitCallbacks = [];
      for (const callback of callbacks) callback();
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the failed statement may have rolled back already */
      }
      for (const callback of this.rollbackCallbacks || []) callback();
      throw error;
    } finally {
      this.inTransaction = false;
      this.commitCallbacks = [];
      this.rollbackCallbacks = [];
    }
  }

  afterRollback(callback) {
    if (this.inTransaction) this.rollbackCallbacks.push(callback);
  }

  afterCommit(callback) {
    if (this.inTransaction) this.commitCallbacks.push(callback);
    else callback();
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }
  exec(sql) {
    return this.db.exec(sql);
  }
  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

module.exports = { Database, MIGRATIONS };
