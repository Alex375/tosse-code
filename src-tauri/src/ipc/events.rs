use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::supervisor::model::{
    ConversationItem, PermissionRequestPayload, SessionEmitter, SessionStatePayload, SlashCommand,
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
}
