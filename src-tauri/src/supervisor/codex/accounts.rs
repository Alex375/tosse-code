//! Codex ACCOUNT operations — status / login / logout, through the app-server's
//! official `account/*` RPCs (verified live against codex-cli 0.142.5). The binary owns
//! `~/.codex/auth.json` end to end: we NEVER read, parse, or write it (the socle's
//! standing security constraint) — login hands the user a browser URL and the BINARY
//! completes the OAuth exchange on its own localhost callback server.
//!
//! ## Login lifecycle
//! `account/login/start {type:"chatgpt"}` → `{loginId, authUrl}`. The callback server
//! lives INSIDE the spawned app-server process, so that process must STAY ALIVE until
//! the `account/login/completed {loginId, success, error}` notification. A login
//! therefore runs on a DEDICATED transient server held in [`ACTIVE_LOGIN`] (never the
//! shared conversation server: a conversation teardown must not kill a login in
//! flight), watched by a task that reports completion through a callback and always
//! tears the server down. One login at a time; starting a new one cancels the old.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::server::{CodexError, CodexServer};

/// The signed-in Codex account, whitelisted from `account/read` (no tokens — the wire
/// response carries none, and we forward only these fields).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountStatus {
    pub logged_in: bool,
    /// `chatgpt` | `apiKey` — how the account is authenticated.
    pub auth_method: Option<String>,
    pub email: Option<String>,
    /// ChatGPT plan (`plus`, `pro`, …) when known.
    pub plan_type: Option<String>,
}

/// What the front needs to drive a started login: the URL to open + the id to cancel.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginStart {
    pub login_id: String,
    pub auth_url: String,
}

/// The one in-flight Codex login (dedicated server + cancel bookkeeping).
struct ActiveLogin {
    login_id: String,
    server: Arc<CodexServer>,
    /// Set by an explicit cancel so the watcher ends silently instead of reporting a
    /// spurious failure when the teardown closes its channel.
    cancelled: Arc<AtomicBool>,
}

static ACTIVE_LOGIN: Mutex<Option<ActiveLogin>> = Mutex::const_new(None);

/// Read the signed-in account (`account/read`) off a transient server. Logged out is a
/// normal answer (`account: null`), not an error.
pub async fn account_status() -> Result<CodexAccountStatus, CodexError> {
    let value = CodexServer::oneshot("account/read", json!({}), &std::env::temp_dir()).await?;
    Ok(parse_account_status(&value))
}

/// Map an `account/read` result onto the whitelisted status.
fn parse_account_status(value: &Value) -> CodexAccountStatus {
    let account = value.get("account").filter(|a| !a.is_null());
    CodexAccountStatus {
        logged_in: account.is_some(),
        auth_method: account
            .and_then(|a| a.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string),
        email: account
            .and_then(|a| a.get("email"))
            .and_then(Value::as_str)
            .map(str::to_string),
        plan_type: account
            .and_then(|a| a.get("planType"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Start a ChatGPT login. Returns the browser URL immediately; `on_done` fires exactly
/// once when the flow completes (success or failure) — but NOT after an explicit
/// [`login_cancel`], which the caller initiated and already knows about. Any previous
/// in-flight login is cancelled first (one at a time — they'd race on the callback port).
pub async fn login_start<F>(on_done: F) -> Result<CodexLoginStart, CodexError>
where
    F: FnOnce(bool, Option<String>) + Send + 'static,
{
    cancel_current(true).await;

    let server = Arc::new(CodexServer::new());
    if let Err(e) = server.ensure_started(&std::env::temp_dir()).await {
        server.shutdown_all().await;
        return Err(e);
    }
    // Subscribe to the server's GLOBAL notifications BEFORE starting the login, so an
    // instant completion can't slip past the watcher.
    let mut rx = match server.subscribe_global("account-login-watch").await {
        Ok(rx) => rx,
        Err(e) => {
            server.shutdown_all().await;
            return Err(e);
        }
    };
    let started = match server
        .request("account/login/start", json!({ "type": "chatgpt" }))
        .await
    {
        Ok(v) => v,
        Err(e) => {
            server.shutdown_all().await;
            return Err(e);
        }
    };
    let (Some(login_id), Some(auth_url)) = (
        started.get("loginId").and_then(Value::as_str).map(str::to_string),
        started.get("authUrl").and_then(Value::as_str).map(str::to_string),
    ) else {
        server.shutdown_all().await;
        return Err(CodexError::Rpc(
            "account/login/start n'a pas renvoyé d'URL d'autorisation".into(),
        ));
    };

    let cancelled = Arc::new(AtomicBool::new(false));
    *ACTIVE_LOGIN.lock().await = Some(ActiveLogin {
        login_id: login_id.clone(),
        server: server.clone(),
        cancelled: cancelled.clone(),
    });

    // Watcher: wait for `account/login/completed` (bounded — OAuth flows die quietly when
    // the user just closes the browser tab; 10 min is generous), then report + tear down.
    let watch_id = login_id.clone();
    tokio::spawn(async move {
        use super::protocol::Incoming;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);
        let outcome: Option<(bool, Option<String>)> = loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(Incoming::Notification { method, params })) => {
                    if method == "account/login/completed" {
                        // A completion for ANOTHER loginId (stale flow) is ignored.
                        let for_us = params
                            .get("loginId")
                            .and_then(Value::as_str)
                            .map(|id| id == watch_id)
                            .unwrap_or(true);
                        if for_us {
                            let success =
                                params.get("success").and_then(Value::as_bool).unwrap_or(false);
                            let error = params
                                .get("error")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            break Some((success, error));
                        }
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => break None, // server died / torn down
                Err(_) => {
                    break Some((false, Some("délai d'autorisation dépassé (10 min)".into())))
                }
            }
        };
        // Clear the registry (if it still points at THIS login) and tear the server down.
        {
            let mut guard = ACTIVE_LOGIN.lock().await;
            if guard.as_ref().is_some_and(|a| a.login_id == watch_id) {
                let active = guard.take().unwrap();
                active.server.shutdown_all().await;
            }
        }
        match outcome {
            Some((success, error)) => on_done(success, error),
            // Channel closed with no completion: an explicit cancel ends silently (the
            // caller initiated it); anything else is the server dying mid-flow → surface.
            None => {
                if !cancelled.load(Ordering::SeqCst) {
                    on_done(
                        false,
                        Some("le processus codex s'est terminé avant la fin de la connexion".into()),
                    );
                }
            }
        }
    });

    Ok(CodexLoginStart { login_id, auth_url })
}

/// Cancel the in-flight login, if any. Safe to call when none is running.
pub async fn login_cancel() {
    cancel_current(true).await;
}

/// Take and tear down the active login. `explicit` marks it user-initiated so the
/// watcher stays silent instead of reporting a failure.
async fn cancel_current(explicit: bool) {
    let active = ACTIVE_LOGIN.lock().await.take();
    if let Some(active) = active {
        if explicit {
            active.cancelled.store(true, Ordering::SeqCst);
        }
        // Best-effort polite cancel (frees the callback port server-side), then teardown.
        let _ = active
            .server
            .request("account/login/cancel", json!({ "loginId": active.login_id }))
            .await;
        active.server.shutdown_all().await;
    }
}

/// Log out of the Codex account (`account/logout` on a transient server). The binary
/// clears its own credentials; we touch nothing.
pub async fn logout() -> Result<(), CodexError> {
    CodexServer::oneshot("account/logout", json!({}), &std::env::temp_dir())
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_account_status_handles_logged_in_and_out() {
        let logged = json!({
            "account": { "type": "chatgpt", "email": "x@y.z", "planType": "plus" },
            "requiresOpenaiAuth": true
        });
        let s = parse_account_status(&logged);
        assert!(s.logged_in);
        assert_eq!(s.email.as_deref(), Some("x@y.z"));
        assert_eq!(s.plan_type.as_deref(), Some("plus"));
        assert_eq!(s.auth_method.as_deref(), Some("chatgpt"));

        let out = json!({ "account": null, "requiresOpenaiAuth": true });
        let s = parse_account_status(&out);
        assert!(!s.logged_in);
        assert!(s.email.is_none() && s.plan_type.is_none() && s.auth_method.is_none());
    }

    /// PROBE (read-only): `account/read` against the real binary — prints the redacted
    /// status. Run: `cargo test --lib -- --ignored --nocapture live_codex_account_status`.
    #[tokio::test]
    #[ignore = "spawns the real codex app-server"]
    async fn live_codex_account_status() {
        let s = account_status().await.expect("account/read should succeed");
        eprintln!("codex account: logged_in={} plan={:?}", s.logged_in, s.plan_type);
    }
}
