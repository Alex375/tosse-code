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
use tokio::sync::{mpsc, Mutex};

use super::protocol::Incoming;
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
    /// Set by [`cancel_current`] so the watcher ends silently instead of reporting a
    /// spurious failure when the teardown closes its channel.
    cancelled: Arc<AtomicBool>,
}

static ACTIVE_LOGIN: Mutex<Option<ActiveLogin>> = Mutex::const_new(None);

/// Serializes login lifecycle transitions (start/cancel). `login_start`'s sequence —
/// cancel the previous flow → spawn a dedicated server → `account/login/start` →
/// register in [`ACTIVE_LOGIN`] — spans several awaits; without this lock two
/// near-simultaneous starts both pass the cancel, race on the OAuth callback port, and
/// the second registration clobbers the first server without teardown (its watcher then
/// reports a phantom failure while the surviving login is legitimately in flight).
/// The watcher task itself never takes this lock (no deadlock with its cleanup).
static LOGIN_FLOW: Mutex<()> = Mutex::const_new(());

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
    // Hold the flow lock across the WHOLE sequence (see LOGIN_FLOW): a second start
    // arriving mid-sequence waits here, then cleanly cancels this one once registered.
    let _flow = LOGIN_FLOW.lock().await;
    cancel_current().await;

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
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);
        let outcome = await_login_completed(&mut rx, &watch_id, deadline).await;
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

/// Wait (bounded) for THIS login's `account/login/completed` on the dedicated server's
/// global notification stream. Returns the wire outcome `(success, error)`, a
/// synthesized timeout failure when the deadline passes, or `None` when the channel
/// closes without a completion (server died / torn down).
async fn await_login_completed(
    rx: &mut mpsc::UnboundedReceiver<Incoming>,
    login_id: &str,
    deadline: tokio::time::Instant,
) -> Option<(bool, Option<String>)> {
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(Incoming::Notification { method, params })) => {
                if method == "account/login/completed" {
                    // A completion for ANOTHER loginId (stale flow) is ignored; an
                    // absent loginId is trusted (this server only runs OUR login).
                    let for_us = params
                        .get("loginId")
                        .and_then(Value::as_str)
                        .map(|id| id == login_id)
                        .unwrap_or(true);
                    if for_us {
                        let success =
                            params.get("success").and_then(Value::as_bool).unwrap_or(false);
                        let error =
                            params.get("error").and_then(Value::as_str).map(str::to_string);
                        return Some((success, error));
                    }
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => return None, // server died / torn down
            Err(_) => return Some((false, Some("délai d'autorisation dépassé (10 min)".into()))),
        }
    }
}

/// Cancel the in-flight login, if any. Safe to call when none is running. Waits for a
/// concurrently starting login to finish registering (LOGIN_FLOW) before cancelling it.
pub async fn login_cancel() {
    let _flow = LOGIN_FLOW.lock().await;
    cancel_current().await;
}

/// Take and tear down the active login, marking it cancelled so its watcher ends
/// silently (the caller initiated the cancel and already knows) instead of reporting
/// the closed channel as a spurious failure.
async fn cancel_current() {
    let active = ACTIVE_LOGIN.lock().await.take();
    if let Some(active) = active {
        active.cancelled.store(true, Ordering::SeqCst);
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

    /// Far-future deadline so only the channel drives the outcome in these tests.
    fn far_deadline() -> tokio::time::Instant {
        tokio::time::Instant::now() + std::time::Duration::from_secs(3600)
    }

    fn completed(params: Value) -> Incoming {
        Incoming::Notification { method: "account/login/completed".into(), params }
    }

    /// The watcher skips unrelated notifications and completions for a STALE loginId,
    /// then settles on OUR completion — forwarding the wire's success + error verbatim.
    #[tokio::test]
    async fn login_watch_ignores_stale_login_ids_and_settles_on_ours() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(Incoming::Notification {
            method: "account/rateLimits/updated".into(),
            params: json!({}),
        })
        .unwrap();
        tx.send(completed(json!({ "loginId": "stale", "success": true }))).unwrap();
        tx.send(completed(json!({ "loginId": "ours", "success": false, "error": "boom" })))
            .unwrap();

        let outcome = await_login_completed(&mut rx, "ours", far_deadline()).await;
        assert_eq!(outcome, Some((false, Some("boom".into()))));
    }

    /// A completion WITHOUT a loginId is trusted (the dedicated server only runs our
    /// login) — the flow must not hang on a wire that omits the field.
    #[tokio::test]
    async fn login_watch_accepts_a_completion_without_login_id() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(completed(json!({ "success": true }))).unwrap();

        let outcome = await_login_completed(&mut rx, "ours", far_deadline()).await;
        assert_eq!(outcome, Some((true, None)));
    }

    /// Past the deadline with no completion, the watcher reports an explicit timeout
    /// failure — never a silent hang. (Already-elapsed deadline: fires on first poll.)
    #[tokio::test]
    async fn login_watch_times_out_with_an_explicit_failure() {
        let (_tx, mut rx) = mpsc::unbounded_channel::<Incoming>(); // sender alive: recv pends
        let deadline = tokio::time::Instant::now();

        let outcome = await_login_completed(&mut rx, "ours", deadline).await;
        let (success, error) = outcome.expect("timeout must produce an outcome");
        assert!(!success);
        assert!(error.as_deref().is_some_and(|e| e.contains("délai")), "{error:?}");
    }

    /// A channel that closes with no completion (server died / torn down) yields `None`
    /// — the caller distinguishes an explicit cancel from a mid-flow death there.
    #[tokio::test]
    async fn login_watch_reports_a_closed_channel_as_none() {
        let (tx, mut rx) = mpsc::unbounded_channel::<Incoming>();
        drop(tx);

        let outcome = await_login_completed(&mut rx, "ours", far_deadline()).await;
        assert_eq!(outcome, None);
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
