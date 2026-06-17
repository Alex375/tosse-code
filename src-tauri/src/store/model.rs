//! Domain records for persisted conversation metadata.
//!
//! These are the types the rest of the core and the IPC layer speak — plain
//! data, no SQL. [`super::db::Store`] is the ONLY place that maps them to and
//! from SQLite rows, so the storage schema can change (or the engine be swapped)
//! without touching a single caller. Field names are snake_case so they mirror
//! the SQL columns and the existing IPC payloads (`SessionStatePayload`); the
//! front maps them to its camelCase domain model at the one persistence boundary.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A working folder a conversation can be opened in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RepoRecord {
    pub id: String,
    pub path: String,
    /// Unix ms timestamp the repo was first added.
    pub added_at: i64,
}

/// A conversation's persisted metadata.
///
/// The stable `id` is the identity the whole app keys off. It is deliberately
/// distinct from the ephemeral live session handle (`session-N`), which is
/// in-memory only and never persisted — so other services can reference a
/// conversation by an id that survives restarts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ConversationRecord {
    pub id: String,
    pub name: String,
    /// FK to [`RepoRecord::id`].
    pub repo_id: String,
    /// Absolute path the session was spawned in.
    pub cwd: String,
    /// Unix ms timestamp the conversation was created.
    pub created_at: i64,
    /// Claude's own session UUID (from system/init) — used for `--resume`.
    pub session_id: Option<String>,
}

/// The full persisted snapshot the UI hydrates from at boot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PersistedState {
    pub repos: Vec<RepoRecord>,
    pub conversations: Vec<ConversationRecord>,
    /// Stable id of the conversation that was active when last persisted.
    pub active_id: Option<String>,
}
