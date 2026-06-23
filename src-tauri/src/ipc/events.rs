use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::supervisor::model::{
    BackgroundTask, ConversationItem, PermissionRequestPayload, SessionEmitter,
    SessionStatePayload, SlashCommand,
};

/// Emitted periodically by a Rust timer. Proves Rust -> React (typed event).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TickEvent {
    pub seq: u32,
    pub message: String,
}

/// A session's lifecycle / identity changed.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionStateEvent {
    pub session: String,
    pub state: SessionStatePayload,
}

/// A normalized conversation item to render (text delta, assistant message,
/// tool result, turn result, …).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionMessageEvent {
    pub session: String,
    pub item: ConversationItem,
}

/// A `can_use_tool` permission prompt awaiting a decision.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionPermissionEvent {
    pub session: String,
    pub request: PermissionRequestPayload,
}

/// The session's available slash commands (one-shot, at `initialize`). Drives the
/// composer's `/` autocomplete menu.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionCommandsEvent {
    pub session: String,
    pub commands: Vec<SlashCommand>,
}

/// A background task (sub-agent / workflow / Monitor / background Bash) was created
/// or changed state. Emitted on every `task_*` transition, keyed (inside the
/// payload) by `task_id`, so the UI tracks the live fleet of background tasks.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionTaskEvent {
    pub session: String,
    pub task: BackgroundTask,
}

/// A model-generated conversation title arrived (from a `generate_session_title`
/// control response). The UI maps `session` (handle) → conversation and applies the
/// title as the name UNLESS the user set a custom title in the meantime. `seq` is the
/// monotonic per-conversation tag the UI sent: it applies a title only if `seq` is
/// newer than the last applied, so an out-of-order (stale) response can't overwrite a
/// fresher title.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionTitleEvent {
    pub session: String,
    pub title: String,
    pub seq: u32,
}

/// Coalesced filesystem change notification for the editor panel: the (de-noised,
/// debounced) set of paths that changed under the watched working directory. The
/// UI reloads any open file in this set and refreshes any expanded tree dirs it
/// touches. Not session-keyed: there is a single active watch (the shown cwd).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct FsChangeEvent {
    pub paths: Vec<String>,
}

/// Bridges a session's [`SessionEmitter`] sink onto the Tauri event bus: each
/// session event becomes the matching tauri-specta event on the `AppHandle`.
pub struct TauriEmitter {
    pub app: tauri::AppHandle,
}

impl SessionEmitter for TauriEmitter {
    fn emit_state(&self, session: &str, state: &SessionStatePayload) {
        let ev = SessionStateEvent {
            session: session.to_string(),
            state: state.clone(),
        };
        let _ = ev.emit(&self.app);
    }

    fn emit_item(&self, session: &str, item: &ConversationItem) {
        let ev = SessionMessageEvent {
            session: session.to_string(),
            item: item.clone(),
        };
        let _ = ev.emit(&self.app);
    }

    fn emit_permission(&self, session: &str, request: &PermissionRequestPayload) {
        let ev = SessionPermissionEvent {
            session: session.to_string(),
            request: request.clone(),
        };
        let _ = ev.emit(&self.app);
    }

    fn emit_commands(&self, session: &str, commands: &[SlashCommand]) {
        let ev = SessionCommandsEvent {
            session: session.to_string(),
            commands: commands.to_vec(),
        };
        let _ = ev.emit(&self.app);
    }

    fn emit_task(&self, session: &str, task: &BackgroundTask) {
        let ev = SessionTaskEvent {
            session: session.to_string(),
            task: task.clone(),
        };
        let _ = ev.emit(&self.app);
    }

    fn emit_title(&self, session: &str, title: &str, seq: u32) {
        let ev = SessionTitleEvent {
            session: session.to_string(),
            title: title.to_string(),
            seq,
        };
        let _ = ev.emit(&self.app);
    }
}
