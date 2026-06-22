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
    /// Unix ms timestamp of the conversation's last activity — the last message
    /// sent OR received. Drives the sidebar's most-recent-first ordering. Bumped
    /// by the UI on each user send and turn result; pre-existing rows (created
    /// before this column) are backfilled from the transcript mtime at boot (see
    /// [`super::db::Store::backfill_last_activity`]).
    pub last_activity_at: i64,
    /// Claude's own session UUID (from system/init) — used for `--resume`.
    pub session_id: Option<String>,
    /// Per-conversation controls, persisted so they survive a restart and are
    /// re-applied at the next (lazy) spawn. While a session is LIVE its own state
    /// (get_settings / system/init) is the source of truth; these hold the
    /// last-known values to restore from. `None`/`false` fall back to the product
    /// defaults at spawn (opus / xhigh / default).
    ///
    /// `model` is the CLI alias chosen in the UI (e.g. "opus"); `effort` is one of
    /// low/medium/high/xhigh; `ultracode` is the separate xhigh+orchestration tier;
    /// `permission_mode` is one of the CLI modes (default/plan/acceptEdits/auto/…).
    pub model: Option<String>,
    pub effort: Option<String>,
    pub ultracode: bool,
    pub permission_mode: Option<String>,
}

/// The full persisted snapshot the UI hydrates from at boot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PersistedState {
    pub repos: Vec<RepoRecord>,
    pub conversations: Vec<ConversationRecord>,
    /// Stable id of the conversation that was active when last persisted.
    pub active_id: Option<String>,
}
