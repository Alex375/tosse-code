//! SQLite persistence — the ONE service in the core that speaks SQL.
//!
//! Everything outside this file deals in domain records ([`super::model`]),
//! never in rows or queries. Swapping the storage engine, or reshaping the
//! schema, means rewriting this file and nothing else — callers and the IPC
//! contract are insulated from it.
//!
//! The schema is deliberately allowed to churn during development: there is no
//! data-preserving migration yet, only create-if-absent plus a [`Store::wipe_all`]
//! escape hatch (also wired to the Settings "drop all" button). When the model
//! stabilizes, bump `SCHEMA_VERSION` and add real migrations keyed off the
//! `meta` table.
//!
//! SQLite itself is compiled into the binary (`rusqlite` `bundled` feature), so
//! there is nothing to install and no system dependency.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use super::model::{ConversationRecord, PersistedState, RepoRecord};

/// Bump when the schema changes in a way that needs a migration. Today the dev
/// policy is wipe-and-recreate, so this is informational.
const SCHEMA_VERSION: i64 = 3;
const ACTIVE_ID_KEY: &str = "active_id";

/// Owns the single SQLite connection. Held behind a `Mutex` because `rusqlite`
/// is synchronous and writes are tiny and rare (create/rename/delete only), so a
/// short critical section never contends with the hot path.
pub struct Store {
    conn: Mutex<Connection>,
}

/// Whether `table` already has a column named `column` (via `PRAGMA table_info`).
/// Makes the additive `last_activity_at` migration idempotent across reopens.
fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        // PRAGMA table_info columns: (cid, name, type, notnull, dflt_value, pk).
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Store {
    /// Open (creating if absent) the database at `path` and run migrations.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    /// In-memory database, for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        // WAL: durable + lets a reader run concurrently with the (rare) writer.
        // foreign_keys ON so deleting a repo cascades to its conversations.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS repos (
                 id       TEXT PRIMARY KEY,
                 path     TEXT NOT NULL,
                 added_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS conversations (
                 id               TEXT PRIMARY KEY,
                 name             TEXT NOT NULL,
                 repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                 cwd              TEXT NOT NULL,
                 created_at       INTEGER NOT NULL,
                 last_activity_at INTEGER NOT NULL DEFAULT 0,
                 session_id       TEXT,
                 model            TEXT,
                 effort           TEXT,
                 ultracode        INTEGER NOT NULL DEFAULT 0,
                 permission_mode  TEXT,
                 pending_reminder TEXT
             );",
        )?;
        // Additive migration: a db created before `last_activity_at` keeps its
        // table untouched by CREATE TABLE IF NOT EXISTS, so add the column in
        // place. Existing rows get the sentinel 0 and are backfilled at boot once
        // transcript mtimes can be resolved (see `backfill_last_activity`).
        if !column_exists(&conn, "conversations", "last_activity_at")? {
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // Additive migration (schema v2): per-conversation controls. A db created
        // before these columns keeps its rows; new columns default to NULL/0, which
        // map to the product defaults at spawn (opus / xhigh / default).
        for (col, ddl) in [
            ("model", "ALTER TABLE conversations ADD COLUMN model TEXT"),
            ("effort", "ALTER TABLE conversations ADD COLUMN effort TEXT"),
            (
                "ultracode",
                "ALTER TABLE conversations ADD COLUMN ultracode INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "permission_mode",
                "ALTER TABLE conversations ADD COLUMN permission_mode TEXT",
            ),
            // Schema v3: a persisted, acknowledgeable status reminder (review /
            // error / open-question) so it re-surfaces after a restart even though
            // the live process is gone. Defaults to NULL (nothing pending).
            (
                "pending_reminder",
                "ALTER TABLE conversations ADD COLUMN pending_reminder TEXT",
            ),
        ] {
            if !column_exists(&conn, "conversations", col)? {
                conn.execute(ddl, [])?;
            }
        }
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }

    /// The full snapshot the UI hydrates from at boot. Repos are ordered by when
    /// they were added, conversations by creation time. Display order is the
    /// front's concern: the sidebar re-sorts conversations by `last_activity_at`
    /// (most recent first) — this is just a stable initial array.
    pub fn load_state(&self) -> rusqlite::Result<PersistedState> {
        let conn = self.conn.lock().unwrap();

        let mut repos_stmt =
            conn.prepare("SELECT id, path, added_at FROM repos ORDER BY added_at ASC")?;
        let repos = repos_stmt
            .query_map([], |row| {
                Ok(RepoRecord {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    added_at: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut conv_stmt = conn.prepare(
            "SELECT id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                    model, effort, ultracode, permission_mode, pending_reminder
             FROM conversations ORDER BY created_at ASC",
        )?;
        let conversations = conv_stmt
            .query_map([], |row| {
                Ok(ConversationRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    repo_id: row.get(2)?,
                    cwd: row.get(3)?,
                    created_at: row.get(4)?,
                    last_activity_at: row.get(5)?,
                    session_id: row.get(6)?,
                    model: row.get(7)?,
                    effort: row.get(8)?,
                    ultracode: row.get(9)?,
                    permission_mode: row.get(10)?,
                    pending_reminder: row.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let active_id = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![ACTIVE_ID_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        Ok(PersistedState {
            repos,
            conversations,
            active_id,
        })
    }

    /// Insert or update a repo (idempotent by id).
    pub fn upsert_repo(&self, repo: &RepoRecord) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO repos (id, path, added_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET path = excluded.path, added_at = excluded.added_at",
            params![repo.id, repo.path, repo.added_at],
        )?;
        Ok(())
    }

    /// Delete a repo; its conversations cascade away via the FK.
    pub fn delete_repo(&self, id: &str) -> rusqlite::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM repos WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Insert or update a conversation (idempotent by id).
    pub fn upsert_conversation(&self, c: &ConversationRecord) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO conversations
                 (id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                  model, effort, ultracode, permission_mode, pending_reminder)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                 name             = excluded.name,
                 repo_id          = excluded.repo_id,
                 cwd              = excluded.cwd,
                 created_at       = excluded.created_at,
                 last_activity_at = excluded.last_activity_at,
                 session_id       = excluded.session_id,
                 model            = excluded.model,
                 effort           = excluded.effort,
                 ultracode        = excluded.ultracode,
                 permission_mode  = excluded.permission_mode,
                 pending_reminder = excluded.pending_reminder",
            params![
                c.id,
                c.name,
                c.repo_id,
                c.cwd,
                c.created_at,
                c.last_activity_at,
                c.session_id,
                c.model,
                c.effort,
                c.ultracode,
                c.permission_mode,
                c.pending_reminder
            ],
        )?;
        Ok(())
    }

    /// Give every conversation that predates the `last_activity_at` column
    /// (sentinel value 0) a real timestamp, so historical conversations sort by
    /// true recency on the first run after the migration. `mtime` resolves a
    /// session id to its transcript file's mtime (Unix ms) — the best proxy for
    /// "time of the last message", since Claude rewrites the transcript on every
    /// message. Conversations with no transcript (or that never sent a message)
    /// fall back to `created_at`. A no-op on every later boot: new conversations
    /// always carry a real timestamp, so no row stays at the sentinel.
    ///
    /// The filesystem lookups run WITHOUT the connection lock held (read the
    /// sentinel rows, drop the guard, resolve mtimes, then re-lock to write).
    pub fn backfill_last_activity(
        &self,
        mtime: impl Fn(&str) -> Option<i64>,
    ) -> rusqlite::Result<()> {
        let pending: Vec<(String, Option<String>, i64)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, session_id, created_at FROM conversations WHERE last_activity_at = 0",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        if pending.is_empty() {
            return Ok(());
        }
        let resolved: Vec<(String, i64)> = pending
            .into_iter()
            .map(|(id, session_id, created_at)| {
                let ts = session_id
                    .as_deref()
                    .and_then(|s| mtime(s))
                    .unwrap_or(created_at);
                (id, ts)
            })
            .collect();
        let conn = self.conn.lock().unwrap();
        for (id, ts) in resolved {
            conn.execute(
                "UPDATE conversations SET last_activity_at = ?1 WHERE id = ?2",
                params![ts, id],
            )?;
        }
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> rusqlite::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Persist (or clear) the active conversation's stable id.
    pub fn set_active(&self, id: Option<&str>) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        match id {
            Some(id) => conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![ACTIVE_ID_KEY, id],
            )?,
            None => conn.execute("DELETE FROM meta WHERE key = ?1", params![ACTIVE_ID_KEY])?,
        };
        Ok(())
    }

    /// Wipe all user data: every repo, conversation, and the active selection.
    /// The schema and `schema_version` are kept. Dev escape hatch + the Settings
    /// "drop all" button.
    pub fn wipe_all(&self) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute_batch(
            "DELETE FROM conversations;
             DELETE FROM repos;
             DELETE FROM meta WHERE key = 'active_id';",
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_at(id: &str, added_at: i64) -> RepoRecord {
        RepoRecord {
            id: id.into(),
            path: format!("/tmp/{id}"),
            added_at,
        }
    }

    fn repo(id: &str) -> RepoRecord {
        repo_at(id, 1)
    }

    fn conv_at(
        id: &str,
        repo_id: &str,
        created_at: i64,
        session_id: Option<&str>,
    ) -> ConversationRecord {
        ConversationRecord {
            id: id.into(),
            name: "Nouvelle conversation".into(),
            repo_id: repo_id.into(),
            cwd: format!("/tmp/{repo_id}"),
            created_at,
            // Default to created_at: a freshly created conversation is active "now".
            last_activity_at: created_at,
            session_id: session_id.map(str::to_string),
            model: None,
            effort: None,
            ultracode: false,
            permission_mode: None,
            pending_reminder: None,
        }
    }

    fn conv(id: &str, repo_id: &str, session_id: Option<&str>) -> ConversationRecord {
        conv_at(id, repo_id, 2, session_id)
    }

    /// A throwaway on-disk db dir, removed when dropped. Lets us reopen the db
    /// (a fresh `Store` over the same file) to simulate an app restart — the
    /// in-memory db can't exercise that.
    struct TempDb {
        dir: std::path::PathBuf,
    }
    impl TempDb {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tosse-store-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }
        fn open(&self) -> Store {
            Store::open(&self.dir.join("tosse.db")).unwrap()
        }
    }
    impl Drop for TempDb {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn empty_db_loads_default_state() {
        let state = Store::open_in_memory().unwrap().load_state().unwrap();
        assert!(state.repos.is_empty());
        assert!(state.conversations.is_empty());
        assert_eq!(state.active_id, None);
    }

    #[test]
    fn round_trips_repos_conversations_and_active() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", Some("sess-uuid"))).unwrap();
        store.set_active(Some("c1")).unwrap();

        let state = store.load_state().unwrap();
        assert_eq!(state.repos, vec![repo("r1")]);
        assert_eq!(state.conversations, vec![conv("c1", "r1", Some("sess-uuid"))]);
        assert_eq!(state.active_id.as_deref(), Some("c1"));
    }

    #[test]
    fn session_id_null_round_trips() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].session_id, None);
    }

    #[test]
    fn upsert_updates_in_place_no_duplicate() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        store.upsert_conversation(&c).unwrap();
        // Rename + assign a session id (the two real mutations after creation).
        c.name = "Renamed".into();
        c.session_id = Some("sess".into());
        store.upsert_conversation(&c).unwrap();

        let state = store.load_state().unwrap();
        assert_eq!(state.conversations.len(), 1);
        assert_eq!(state.conversations[0].name, "Renamed");
        assert_eq!(state.conversations[0].session_id.as_deref(), Some("sess"));
    }

    #[test]
    fn per_conversation_controls_round_trip() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        c.model = Some("sonnet".into());
        c.effort = Some("xhigh".into());
        c.ultracode = true;
        c.permission_mode = Some("plan".into());
        store.upsert_conversation(&c).unwrap();

        let got = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(got.model.as_deref(), Some("sonnet"));
        assert_eq!(got.effort.as_deref(), Some("xhigh"));
        assert!(got.ultracode);
        assert_eq!(got.permission_mode.as_deref(), Some("plan"));
    }

    #[test]
    fn controls_default_to_none_when_unset() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        let got = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(got.model, None);
        assert_eq!(got.effort, None);
        assert!(!got.ultracode);
        assert_eq!(got.permission_mode, None);
    }

    #[test]
    fn pending_reminder_round_trips_and_clears() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        c.pending_reminder = Some("review".into());
        store.upsert_conversation(&c).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].pending_reminder.as_deref(),
            Some("review")
        );
        // Acknowledging ("Vu") clears it back to NULL, durably.
        c.pending_reminder = None;
        store.upsert_conversation(&c).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].pending_reminder,
            None
        );
    }

    #[test]
    fn pending_reminder_defaults_to_none() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].pending_reminder,
            None
        );
    }

    #[test]
    fn last_activity_at_round_trips() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        c.last_activity_at = 4242;
        store.upsert_conversation(&c).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].last_activity_at,
            4242
        );
    }

    #[test]
    fn backfill_fills_sentinel_rows_from_resolver_else_created_at() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        // Two rows forced to the sentinel (0), as if they predate the column.
        let mut c1 = conv_at("c1", "r1", 100, Some("sess-c1"));
        c1.last_activity_at = 0;
        let mut c2 = conv_at("c2", "r1", 200, None);
        c2.last_activity_at = 0;
        store.upsert_conversation(&c1).unwrap();
        store.upsert_conversation(&c2).unwrap();

        // Resolver knows a mtime only for c1's session; c2 must fall back to created_at.
        store
            .backfill_last_activity(|sid| if sid == "sess-c1" { Some(999) } else { None })
            .unwrap();

        let convs = store.load_state().unwrap().conversations; // created_at ASC -> [c1, c2]
        assert_eq!(convs[0].last_activity_at, 999, "resolver mtime wins");
        assert_eq!(convs[1].last_activity_at, 200, "no transcript -> created_at");
    }

    #[test]
    fn backfill_leaves_already_filled_rows_untouched() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv_at("c1", "r1", 100, Some("sess"));
        c.last_activity_at = 555; // already has a real timestamp
        store.upsert_conversation(&c).unwrap();

        // A resolver that would overwrite everything must NOT touch a filled row.
        store.backfill_last_activity(|_| Some(1)).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].last_activity_at,
            555
        );
    }

    #[test]
    fn upsert_repo_updates_in_place() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo_at("r1", 1)).unwrap();
        store.upsert_repo(&repo_at("r1", 9)).unwrap();
        let state = store.load_state().unwrap();
        assert_eq!(state.repos.len(), 1);
        assert_eq!(state.repos[0].added_at, 9);
    }

    #[test]
    fn load_orders_repos_and_conversations_by_timestamp() {
        let store = Store::open_in_memory().unwrap();
        // Insert out of order; load must return added_at / created_at ascending.
        store.upsert_repo(&repo_at("r2", 5)).unwrap();
        store.upsert_repo(&repo_at("r1", 1)).unwrap();
        store.upsert_conversation(&conv_at("c2", "r1", 9, None)).unwrap();
        store.upsert_conversation(&conv_at("c1", "r1", 3, None)).unwrap();

        let state = store.load_state().unwrap();
        assert_eq!(
            state.repos.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["r1", "r2"]
        );
        assert_eq!(
            state.conversations.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["c1", "c2"]
        );
    }

    #[test]
    fn set_active_updates_in_place() {
        let store = Store::open_in_memory().unwrap();
        store.set_active(Some("a")).unwrap();
        store.set_active(Some("b")).unwrap();
        assert_eq!(store.load_state().unwrap().active_id.as_deref(), Some("b"));
    }

    #[test]
    fn clearing_active_removes_it() {
        let store = Store::open_in_memory().unwrap();
        store.set_active(Some("c1")).unwrap();
        store.set_active(None).unwrap();
        assert_eq!(store.load_state().unwrap().active_id, None);
    }

    #[test]
    fn delete_conversation_removes_only_its_target() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv_at("c1", "r1", 1, None)).unwrap();
        store.upsert_conversation(&conv_at("c2", "r1", 2, None)).unwrap();

        store.delete_conversation("c1").unwrap();

        let state = store.load_state().unwrap();
        assert_eq!(state.repos.len(), 1, "deleting a conversation keeps its repo");
        assert_eq!(
            state.conversations.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["c2"]
        );
    }

    #[test]
    fn deleting_repo_cascades_conversations() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        store.delete_repo("r1").unwrap();

        let state = store.load_state().unwrap();
        assert!(state.repos.is_empty());
        assert!(
            state.conversations.is_empty(),
            "conversations should cascade with their repo"
        );
    }

    #[test]
    fn conversation_referencing_unknown_repo_is_rejected() {
        // foreign_keys = ON must reject a conversation pointing at a missing repo.
        let store = Store::open_in_memory().unwrap();
        assert!(
            store.upsert_conversation(&conv("c1", "ghost", None)).is_err(),
            "FK should reject an orphan conversation"
        );
    }

    #[test]
    fn wipe_all_empties_everything() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        store.set_active(Some("c1")).unwrap();

        store.wipe_all().unwrap();

        let state = store.load_state().unwrap();
        assert!(state.repos.is_empty());
        assert!(state.conversations.is_empty());
        assert_eq!(state.active_id, None);
    }

    #[test]
    fn data_survives_reopen() {
        // The headline guarantee: metadata persists across a restart. Write with
        // one Store, drop it (closing the connection), then read with a fresh one
        // over the same file.
        let tmp = TempDb::new("reopen");
        {
            let store = tmp.open();
            store.upsert_repo(&repo("r1")).unwrap();
            store.upsert_conversation(&conv("c1", "r1", Some("sess"))).unwrap();
            store.set_active(Some("c1")).unwrap();
        }
        let state = tmp.open().load_state().unwrap();
        assert_eq!(state.repos, vec![repo("r1")]);
        assert_eq!(state.conversations, vec![conv("c1", "r1", Some("sess"))]);
        assert_eq!(state.active_id.as_deref(), Some("c1"));
    }

    #[test]
    fn additive_migration_adds_pending_reminder_to_a_pre_v3_db() {
        // The feature's core promise is the ADDITIVE migration: a DB created before
        // `pending_reminder` (a pre-v3 schema) must gain the column on reopen, with
        // existing rows defaulting to NULL and surviving intact. Every other test
        // starts from the full current CREATE TABLE, so the `ALTER TABLE ... ADD
        // COLUMN pending_reminder` branch never runs there — exercise it for real.
        let tmp = TempDb::new("pre-v3-migration");
        {
            // Hand-build a v2 conversations table (everything EXCEPT pending_reminder)
            // with one row, via a raw connection — bypassing Store so no migration runs.
            let conn = rusqlite::Connection::open(tmp.dir.join("tosse.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE repos (
                     id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL
                 );
                 CREATE TABLE conversations (
                     id               TEXT PRIMARY KEY,
                     name             TEXT NOT NULL,
                     repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                     cwd              TEXT NOT NULL,
                     created_at       INTEGER NOT NULL,
                     last_activity_at INTEGER NOT NULL DEFAULT 0,
                     session_id       TEXT,
                     model            TEXT,
                     effort           TEXT,
                     ultracode        INTEGER NOT NULL DEFAULT 0,
                     permission_mode  TEXT
                 );
                 INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
                 INSERT INTO conversations (id, name, repo_id, cwd, created_at, last_activity_at)
                     VALUES ('c1', 'Legacy', 'r1', '/tmp/r1', 5, 5);",
            )
            .unwrap();
        }

        // Reopen through Store → the additive migration adds the missing column.
        let state = tmp.open().load_state().unwrap();
        assert_eq!(state.conversations.len(), 1, "the pre-v3 row must survive");
        assert_eq!(state.conversations[0].id, "c1");
        assert_eq!(
            state.conversations[0].pending_reminder, None,
            "an upgraded row defaults to NULL (nothing pending)"
        );

        // And the new column is fully usable after the in-place upgrade.
        let store = tmp.open();
        let mut c = state.conversations[0].clone();
        c.pending_reminder = Some("error".into());
        store.upsert_conversation(&c).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].pending_reminder.as_deref(),
            Some("error")
        );
    }

    #[test]
    fn reopening_runs_migrations_idempotently() {
        // Opening an existing db must not error (CREATE TABLE IF NOT EXISTS /
        // INSERT OR IGNORE) and must preserve its rows.
        let tmp = TempDb::new("idempotent");
        tmp.open().upsert_repo(&repo("r1")).unwrap();
        let store = tmp.open(); // second open over a populated db
        assert_eq!(store.load_state().unwrap().repos, vec![repo("r1")]);
    }

    #[test]
    fn wipe_all_then_reopen_stays_empty() {
        let tmp = TempDb::new("wipe-reopen");
        {
            let store = tmp.open();
            store.upsert_repo(&repo("r1")).unwrap();
            store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
            store.wipe_all().unwrap();
        }
        let state = tmp.open().load_state().unwrap();
        assert!(state.repos.is_empty());
        assert!(state.conversations.is_empty());
        assert_eq!(state.active_id, None);
    }
}
