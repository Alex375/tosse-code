use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// Emitted periodically by a Rust timer. Proves Rust -> React (typed event).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TickEvent {
    pub seq: u32,
    pub message: String,
}
