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
const SCHEMA_VERSION: i64 = 1;
const ACTIVE_ID_KEY: &str = "active_id";

/// Owns the single SQLite connection. Held behind a `Mutex` because `rusqlite`
/// is synchronous and writes are tiny and rare (create/rename/delete only), so a
/// short critical section never contends with the hot path.
pub struct Store {
    conn: Mutex<Connection>,
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
                 id         TEXT PRIMARY KEY,
                 name       TEXT NOT NULL,
                 repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                 cwd        TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 session_id TEXT
             );",
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }

    /// The full snapshot the UI hydrates from at boot. Repos are ordered by when
    /// they were added, conversations by creation time — the sidebar's order.
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
            "SELECT id, name, repo_id, cwd, created_at, session_id
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
                    session_id: row.get(5)?,
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
            "INSERT INTO conversations (id, name, repo_id, cwd, created_at, session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                 name       = excluded.name,
                 repo_id    = excluded.repo_id,
                 cwd        = excluded.cwd,
                 created_at = excluded.created_at,
                 session_id = excluded.session_id",
            params![c.id, c.name, c.repo_id, c.cwd, c.created_at, c.session_id],
        )?;
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
            session_id: session_id.map(str::to_string),
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
