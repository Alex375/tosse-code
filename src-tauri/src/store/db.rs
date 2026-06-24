//! SQLite persistence — the ONE service in the core that speaks SQL.
//!
//! Everything outside this file deals in domain records ([`super::model`]),
//! never in rows or queries. Swapping the storage engine, or reshaping the
//! schema, means rewriting this file and nothing else — callers and the IPC
//! contract are insulated from it.
//!
//! Schema changes go through a versioned migration runner ([`Store::migrate`]):
//! each entry in [`MIGRATIONS`] is applied once, in order, inside a transaction,
//! and bumps the database's `user_version`. Migrations preserve data — additive
//! `ALTER TABLE` / backfill, never a `DROP` that loses user rows on a schema
//! change. [`Store::wipe_all`] stays a MANUAL escape hatch only (the Settings
//! "drop all" button); it is never triggered by a schema change.
//!
//! SQLite itself is compiled into the binary (`rusqlite` `bundled` feature), so
//! there is nothing to install and no system dependency.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use super::model::{ConversationRecord, PersistedState, RepoRecord};

/// The current schema version. Drives the versioned migration runner: on open, a
/// database is brought up to this version by applying every migration in
/// [`MIGRATIONS`] whose target exceeds its stored `user_version`. Always equal to
/// `MIGRATIONS.len()` (checked at compile time below).
const SCHEMA_VERSION: i64 = 3;
const ACTIVE_ID_KEY: &str = "active_id";

/// A single schema migration: a forward, data-preserving step. It receives the
/// open connection (already inside the runner's per-migration transaction) and
/// applies its DDL.
type Migration = fn(&Connection) -> rusqlite::Result<()>;

/// Ordered, APPEND-ONLY list of migrations. Index `i` migrates the schema from
/// version `i` to version `i + 1`; the runner ([`Store::migrate`]) applies every
/// migration whose target version exceeds the database's `user_version`, each in
/// its own transaction. NEVER reorder, delete, or edit a shipped entry — only
/// append. Editing the past would desync databases already migrated in the field.
///
/// Migration bodies must be ADDITIVE and idempotent: `CREATE TABLE IF NOT EXISTS`
/// and `add_column_if_absent` (guarded `ALTER TABLE ... ADD COLUMN`) / backfill —
/// never a `DROP` that loses user rows. A non-additive change (rename / retype /
/// drop) needs SQLite's table-rebuild dance, which requires `PRAGMA foreign_keys`
/// OFF — and that pragma is a NO-OP inside a transaction. Since the runner wraps
/// each migration in one, such a migration must toggle foreign-key enforcement
/// outside it; do not assume you can flip it from inside a `migrate_vN` body.
const MIGRATIONS: &[Migration] = &[migrate_v1, migrate_v2, migrate_v3];

// SCHEMA_VERSION and the migration list must agree, or version bookkeeping drifts.
const _: () = assert!(MIGRATIONS.len() == SCHEMA_VERSION as usize);

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

/// Run `ddl` (an `ALTER TABLE ... ADD COLUMN`) only when `column` is absent. Keeps
/// each additive migration idempotent across reopens, and tolerant of the
/// pre-versioned-runner history where some columns shipped without a version bump
/// (so a database may already carry a column its recorded version predates).
fn add_column_if_absent(
    conn: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> rusqlite::Result<()> {
    if !column_exists(conn, table, column)? {
        conn.execute(ddl, [])?;
    }
    Ok(())
}

/// v1 — the initial schema: a key/value `meta` table, `repos`, and the
/// `conversations` metadata. `IF NOT EXISTS` so it stays safe even if a legacy
/// database already has these tables but reports `user_version < 1`.
fn migrate_v1(conn: &Connection) -> rusqlite::Result<()> {
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
             id         TEXT PRIMARY KEY,
             name       TEXT NOT NULL,
             repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
             cwd        TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             session_id TEXT
         );",
    )
}

/// v2 — sidebar recency (`last_activity_at`) plus per-conversation controls
/// (`model` / `effort` / `ultracode` / `permission_mode`). Every `ADD COLUMN` is
/// guarded because `last_activity_at` originally shipped under v1 WITHOUT a version
/// bump, so a database marked v1 may already carry it.
fn migrate_v2(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "conversations",
        "last_activity_at",
        "ALTER TABLE conversations ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "model",
        "ALTER TABLE conversations ADD COLUMN model TEXT",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "effort",
        "ALTER TABLE conversations ADD COLUMN effort TEXT",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "ultracode",
        "ALTER TABLE conversations ADD COLUMN ultracode INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "permission_mode",
        "ALTER TABLE conversations ADD COLUMN permission_mode TEXT",
    )?;
    Ok(())
}

/// v3 — a persisted, acknowledgeable status reminder (review / error /
/// open-question) so it re-surfaces after a restart even though the live process
/// is gone. Defaults to NULL (nothing pending).
fn migrate_v3(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "conversations",
        "pending_reminder",
        "ALTER TABLE conversations ADD COLUMN pending_reminder TEXT",
    )
}

/// Bridge databases created before the versioned runner. They tracked the schema
/// in `meta.schema_version` and left `user_version` at 0; seed `user_version` from
/// that marker ONCE so already-applied migrations are not re-run. A brand-new
/// database (no `meta` table yet) and a database already on the runner
/// (`user_version != 0`) are both left untouched. Safe even if the seed is wrong:
/// every migration body is idempotent.
fn bridge_legacy_version(conn: &Connection) -> rusqlite::Result<()> {
    let user_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version != 0 {
        return Ok(());
    }
    let has_meta = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !has_meta {
        return Ok(());
    }
    let legacy: Option<i64> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse().ok());
    if let Some(version) = legacy {
        conn.execute_batch(&format!("PRAGMA user_version = {version};"))?;
    }
    Ok(())
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

    /// Bring the database up to [`SCHEMA_VERSION`] by applying every migration in
    /// [`MIGRATIONS`] whose target version exceeds the stored `user_version`. Each
    /// migration runs in its own transaction and bumps `user_version` atomically
    /// with its DDL, so a crash mid-migration rolls back BOTH (no half-applied
    /// schema). Re-running on an up-to-date database is a no-op.
    fn migrate(&self) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();

        // Seed `user_version` from the legacy `meta.schema_version` marker once, so
        // databases created before the versioned runner skip already-applied steps.
        bridge_legacy_version(&conn)?;

        let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        for (i, migration) in MIGRATIONS.iter().enumerate() {
            let target = i as i64 + 1;
            if current >= target {
                continue;
            }
            let tx = conn.transaction()?;
            migration(&tx)?;
            // `user_version` lives in the db header and commits with the DDL.
            // `target` is a trusted i64, so the format! interpolation is injection-safe
            // (pragma values cannot be bound parameters).
            tx.execute_batch(&format!("PRAGMA user_version = {target};"))?;
            tx.commit()?;
        }
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

    /// The database's on-disk schema version (`PRAGMA user_version`). The runner
    /// leaves it equal to [`SCHEMA_VERSION`] after a successful open.
    #[cfg(test)]
    fn schema_version(&self) -> i64 {
        self.conn
            .lock()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
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
        /// Hand-build a legacy on-disk schema on a bare connection (no `Store`, so
        /// no migration runs and `user_version` stays 0), then close it — exactly
        /// the state a database left behind by an older app version is in.
        fn seed_raw(&self, sql: &str) {
            let conn = rusqlite::Connection::open(self.dir.join("tosse.db")).unwrap();
            conn.execute_batch(sql).unwrap();
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

    // ---- Versioned migration runner ----------------------------------------

    #[test]
    fn migration_count_matches_schema_version() {
        // The compile-time `const _: () = assert!(...)` guards this too; the runtime
        // mirror makes the invariant visible in the test suite when one is bumped
        // without the other.
        assert_eq!(MIGRATIONS.len() as i64, SCHEMA_VERSION);
    }

    #[test]
    fn fresh_db_ends_at_current_schema_version() {
        // A brand-new database (no meta table) runs every migration in order and
        // lands exactly on SCHEMA_VERSION.
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
    }

    #[test]
    fn reopen_does_not_re_run_or_regress_version() {
        // Second open over a migrated db: version stays put, data intact, no error.
        let tmp = TempDb::new("reopen-version");
        tmp.open().upsert_repo(&repo("r1")).unwrap();
        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        assert_eq!(store.load_state().unwrap().repos, vec![repo("r1")]);
    }

    /// The original v1 schema (commit 9316e0b): base columns only — no
    /// `last_activity_at`, no controls, no `pending_reminder`. The legacy marker
    /// lived in `meta.schema_version`, with `user_version` left at 0.
    const LEGACY_V1_BASE: &str = "
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
        CREATE TABLE conversations (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
            cwd        TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            session_id TEXT
        );
        INSERT INTO meta (key, value) VALUES ('schema_version', '1');
        INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
        INSERT INTO conversations (id, name, repo_id, cwd, created_at, session_id)
            VALUES ('c1', 'Legacy v1', 'r1', '/tmp/r1', 5, 'sess-1');
    ";

    #[test]
    fn legacy_v1_base_db_migrates_preserving_data() {
        let tmp = TempDb::new("legacy-v1-base");
        tmp.seed_raw(LEGACY_V1_BASE);

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION, "bridged then migrated to v3");

        let convs = store.load_state().unwrap().conversations;
        assert_eq!(convs.len(), 1, "the pre-versioned row must survive");
        let c = &convs[0];
        assert_eq!(c.id, "c1");
        assert_eq!(c.name, "Legacy v1");
        assert_eq!(c.session_id.as_deref(), Some("sess-1"));
        // Columns added by the migrations default cleanly on the upgraded row.
        assert_eq!(c.last_activity_at, 0, "added by v2, backfillable at boot");
        assert_eq!(c.model, None);
        assert_eq!(c.effort, None);
        assert!(!c.ultracode);
        assert_eq!(c.permission_mode, None);
        assert_eq!(c.pending_reminder, None);

        // And every new column is fully usable after the in-place upgrade.
        let mut c = c.clone();
        c.pending_reminder = Some("error".into());
        c.model = Some("sonnet".into());
        store.upsert_conversation(&c).unwrap();
        let got = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(got.pending_reminder.as_deref(), Some("error"));
        assert_eq!(got.model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn legacy_v1_with_last_activity_preserves_its_value() {
        // Commit 6e388d1 added `last_activity_at` WITHOUT bumping SCHEMA_VERSION, so a
        // db still marked v1 may already carry it with a real value. The guarded v2
        // migration must NOT clobber that value back to the default.
        let tmp = TempDb::new("legacy-v1-activity");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
            CREATE TABLE conversations (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                cwd              TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL DEFAULT 0,
                session_id       TEXT
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '1');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations (id, name, repo_id, cwd, created_at, last_activity_at, session_id)
                VALUES ('c1', 'Legacy v1.5', 'r1', '/tmp/r1', 5, 777, 'sess-1');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        let c = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(c.last_activity_at, 777, "guarded ADD COLUMN must not reset it");
        assert_eq!(c.model, None, "controls were still added");
        assert_eq!(c.pending_reminder, None, "pending_reminder was still added");
    }

    #[test]
    fn legacy_v2_db_gains_pending_reminder_only() {
        // Commit d921d8f (v2): controls present, no `pending_reminder`. Only the v3
        // migration should run; controls and rows must be preserved untouched.
        let tmp = TempDb::new("legacy-v2");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
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
            INSERT INTO meta (key, value) VALUES ('schema_version', '2');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations
                (id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                 model, effort, ultracode, permission_mode)
                VALUES ('c1', 'Legacy v2', 'r1', '/tmp/r1', 5, 42, 'sess-1',
                        'sonnet', 'xhigh', 1, 'plan');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        let c = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(c.model.as_deref(), Some("sonnet"), "controls preserved");
        assert_eq!(c.effort.as_deref(), Some("xhigh"));
        assert!(c.ultracode);
        assert_eq!(c.permission_mode.as_deref(), Some("plan"));
        assert_eq!(c.last_activity_at, 42);
        assert_eq!(c.pending_reminder, None, "the only newly added column");
    }

    #[test]
    fn legacy_v3_db_runs_no_migration() {
        // A db left by the current shipped code (full schema, marker '3', but
        // user_version still 0): the bridge seeds user_version=3, no migration runs,
        // and every value — including pending_reminder — survives untouched.
        let tmp = TempDb::new("legacy-v3");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
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
                permission_mode  TEXT,
                pending_reminder TEXT
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '3');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations
                (id, name, repo_id, cwd, created_at, last_activity_at, session_id, pending_reminder)
                VALUES ('c1', 'Legacy v3', 'r1', '/tmp/r1', 5, 9, 'sess-1', 'review');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        let c = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(c.name, "Legacy v3");
        assert_eq!(c.pending_reminder.as_deref(), Some("review"), "untouched");
        assert_eq!(c.last_activity_at, 9);
    }

    #[test]
    fn frozen_marker_with_full_schema_preserves_real_values_and_active_id() {
        // The DOMINANT real-world legacy shape. The pre-runner builds wrote
        // `meta.schema_version` with INSERT OR IGNORE, so the marker FROZE at the
        // value first written and never advanced — yet every later app version kept
        // adding columns to the on-disk schema. So a database can sit at marker '1'
        // while already carrying the FULL v3 schema WITH real user values. The
        // bridge seeds user_version=1 and the runner re-runs the guarded v2/v3
        // migrations — which must be exact no-ops that DO NOT reset those values,
        // and must not disturb the active selection.
        let tmp = TempDb::new("frozen-marker-full");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
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
                permission_mode  TEXT,
                pending_reminder TEXT
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '1');
            INSERT INTO meta (key, value) VALUES ('active_id', 'c1');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations
                (id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                 model, effort, ultracode, permission_mode, pending_reminder)
                VALUES ('c1', 'Frozen', 'r1', '/tmp/r1', 5, 1234, 'sess-1',
                        'opus', 'xhigh', 1, 'plan', 'review');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION, "marker '1' bridged, runner advanced to v3");
        let state = store.load_state().unwrap();
        assert_eq!(state.active_id.as_deref(), Some("c1"), "active selection survives migration");
        let c = &state.conversations[0];
        // Every real value must survive the re-run of the guarded v2/v3 migrations.
        assert_eq!(c.last_activity_at, 1234, "guarded ADD must not reset to DEFAULT 0");
        assert_eq!(c.model.as_deref(), Some("opus"));
        assert_eq!(c.effort.as_deref(), Some("xhigh"));
        assert!(c.ultracode);
        assert_eq!(c.permission_mode.as_deref(), Some("plan"));
        assert_eq!(c.pending_reminder.as_deref(), Some("review"), "guarded ADD must not reset to NULL");
    }
}
