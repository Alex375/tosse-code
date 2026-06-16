use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;

use crate::ipc::events::TauriEmitter;
use crate::supervisor::control::{PermissionDecision, PermissionMode};
use crate::supervisor::session::{self, SessionHandle};
use crate::supervisor::transport::SpawnConfig;

/// Typed return value of `ping`. Proves React -> Rust (typed command).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Pong {
    pub ok: bool,
    pub echo: String,
    pub at_ms: u64,
}

/// Tauri managed state: the registry of live sessions, keyed by our own id.
#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, SessionHandle>>,
    next: AtomicU64,
}

impl Sessions {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&self) -> String {
        format!("session-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// Clone out a handle (never holds the lock across an `.await`).
    fn get(&self, id: &str) -> Option<SessionHandle> {
        self.inner.lock().unwrap().get(id).cloned()
    }

    fn insert(&self, id: String, handle: SessionHandle) {
        self.inner.lock().unwrap().insert(id, handle);
    }

    fn remove(&self, id: &str) -> Option<SessionHandle> {
        self.inner.lock().unwrap().remove(id)
    }

    /// Take every live handle out of the registry (used to tear sessions down on
    /// app exit).
    pub fn drain(&self) -> Vec<SessionHandle> {
        std::mem::take(&mut *self.inner.lock().unwrap())
            .into_values()
            .collect()
    }
}

fn unknown_session() -> String {
    "unknown session".to_string()
}

/// Start a new `claude` session rooted at `repo_path`. Returns our session id;
/// conversation/state/permission events are emitted on the Tauri event bus.
#[tauri::command]
#[specta::specta]
pub async fn spawn_session(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, Sessions>,
    repo_path: String,
    resume: Option<String>,
) -> Result<String, String> {
    let id = sessions.next_id();
    let mut cfg = SpawnConfig::new(PathBuf::from(repo_path));
    cfg.resume = resume;
    let emitter = Arc::new(TauriEmitter { app: app.clone() });
    // When the actor fully exits (process gone / stopped), evict the dead handle
    // from the registry so entries never leak.
    let on_exit = {
        let app = app.clone();
        let id = id.clone();
        Box::new(move || {
            app.state::<Sessions>().remove(&id);
        }) as Box<dyn FnOnce() + Send + 'static>
    };
    let handle = session::spawn_session(id.clone(), cfg, emitter, on_exit).map_err(|e| e.to_string())?;
    sessions.insert(id.clone(), handle);
    Ok(id)
}

/// Send a user turn to a session.
#[tauri::command]
#[specta::specta]
pub async fn send_message(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    text: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.send_user_text(text).await.map_err(|e| e.to_string())
}

/// Answer a pending `can_use_tool` permission prompt (allow / deny).
#[tauri::command]
#[specta::specta]
pub async fn answer_permission(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    request_id: String,
    decision: PermissionDecision,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .answer_permission(request_id, decision)
        .await
        .map_err(|e| e.to_string())
}

/// Switch the session's permission mode at runtime.
#[tauri::command]
#[specta::specta]
pub async fn set_permission_mode(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    mode: PermissionMode,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .set_permission_mode(mode)
        .await
        .map_err(|e| e.to_string())
}

/// Interrupt the current turn (without killing the process).
#[tauri::command]
#[specta::specta]
pub async fn interrupt_session(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.interrupt().await.map_err(|e| e.to_string())
}

/// Tear a session down and remove it from the registry.
#[tauri::command]
#[specta::specta]
pub async fn stop_session(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<(), String> {
    if let Some(handle) = sessions.remove(&session) {
        // Ignore a closed channel: the actor may have already exited on its own,
        // in which case the session is stopped anyway.
        let _ = handle.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn ping(msg: String) -> Pong {
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    // Proof of the inbound leg (React -> Rust) on Rust stdout.
    println!("[ipc] ping received: msg={msg:?} -> replying Pong@{at_ms}");

    Pong {
        ok: true,
        echo: msg,
        at_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_echoes_message_and_marks_ok() {
        let pong = ping("hello".to_string());
        assert!(pong.ok);
        assert_eq!(pong.echo, "hello");
        assert!(pong.at_ms > 0, "timestamp should be populated");
    }
}
