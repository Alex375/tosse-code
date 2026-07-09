//! The **Codex backend** — piloting OpenAI's `codex` CLI via its `app-server`
//! (JSON-RPC newline-delimited over stdio), the sibling of the Claude backend that
//! lives directly under `supervisor/`. Everything Codex-specific (binary
//! resolution, the app-server transport, the protocol wire types, the
//! per-conversation session) lives here, so the shared session contract
//! (`SessionHandle` / `SessionCommand` / `SessionEvent`) stays backend-neutral and
//! the front consumes ONE normalized event model regardless of backend.
//!
//! This is the socle: it establishes the module and the binary detection the
//! backend selector gates on. The transport, protocol types, and the session actor
//! that maps app-server messages to `SessionEvent`s land in the following subtasks.

pub mod accounts;
mod config;
pub mod extensions;
mod history;
pub mod protocol;
mod server;
mod session;
mod transport;

pub use accounts::{CodexAccountStatus, CodexLoginStart};
pub use config::list_extensions;
pub use extensions::{CodexHooksSnapshot, CodexPluginsLive};
pub use history::load_thread_history;
pub use protocol::{CodexControls, CodexForkResult, CodexModel, CodexSkill};
pub use server::{CodexError, CodexServer};
pub use session::spawn_session;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// List the Codex models the installed binary offers (`model/list`), flattened for the
/// composer's picker. Runs against a transient app-server (no thread needed). Hidden
/// models are dropped. Empty vec if the server answers with none.
pub async fn list_models() -> Result<Vec<CodexModel>, CodexError> {
    let value = CodexServer::oneshot("model/list", json!({}), &std::env::temp_dir()).await?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(data.iter().filter_map(parse_model).collect())
}

fn parse_model(m: &Value) -> Option<CodexModel> {
    if m.get("hidden").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let id = m.get("id").and_then(Value::as_str)?.to_string();
    let display_name = m
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let efforts = m
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| e.get("reasoningEffort").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(CodexModel {
        id,
        display_name,
        efforts,
        default_effort: m
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string),
        is_default: m.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// List the Codex skills for the given working directories (`skills/list`), flattened
/// and de-duplicated by name, for the composer's `/` menu. `cwds` empty → the server's
/// current working directory. Runs against a transient app-server.
pub async fn list_skills(cwds: Vec<String>) -> Result<Vec<CodexSkill>, CodexError> {
    let cwd = cwds
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let value = CodexServer::oneshot("skills/list", json!({ "cwds": cwds }), &cwd).await?;
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in &entries {
        let Some(skills) = entry.get("skills").and_then(Value::as_array) else {
            continue;
        };
        for s in skills {
            let Some(name) = s.get("name").and_then(Value::as_str) else {
                continue;
            };
            if !seen.insert(name.to_string()) {
                continue;
            }
            out.push(CodexSkill {
                name: name.to_string(),
                description: s
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    Ok(out)
}

/// Rewind a Codex thread IN PLACE by dropping its last `num_turns` turns (`thread/rollback`
/// — count-based, so the caller computes the count from the timeline). Operates on the
/// thread on disk by id via a transient app-server, so no live conversation session is
/// required (mirrors the Claude backend rewinding the on-disk transcript). ⚠️ Per the wire
/// contract, rollback does NOT revert on-disk file changes the agent made — only the
/// conversation history — exactly like the Claude rewind. `num_turns == 0` is a no-op.
pub async fn rollback_thread(thread_id: &str, num_turns: u32, cwd: &Path) -> Result<(), CodexError> {
    if num_turns == 0 {
        return Ok(());
    }
    CodexServer::oneshot(
        "thread/rollback",
        json!({ "threadId": thread_id, "numTurns": num_turns }),
        cwd,
    )
    .await
    .map(|_| ())
}

/// Fork a Codex thread into a NEW thread (`thread/fork` — a full-thread branch loaded from
/// disk by id), then, when `drop_last_turns > 0`, roll the NEW thread back by that many
/// turns so the branch ends AT the chosen cut point (fork is whole-thread only, so a
/// "fork here" is fork + rollback-of-the-fork). Returns the new thread id + resolved model
/// for the front to materialize as a fresh Codex conversation. Non-destructive: the source
/// thread is untouched. Transient app-server, no live session needed.
pub async fn fork_thread(
    thread_id: &str,
    cwd: &Path,
    model: Option<&str>,
    drop_last_turns: u32,
) -> Result<CodexForkResult, CodexError> {
    let value = CodexServer::oneshot(
        "thread/fork",
        json!({ "threadId": thread_id, "model": model }),
        cwd,
    )
    .await?;
    let new_id = value
        .get("thread")
        .and_then(|t| t.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| CodexError::Rpc("thread/fork n'a pas renvoyé d'identifiant de thread".into()))?
        .to_string();
    if drop_last_turns > 0 {
        // Best-effort branch-at-point: the fork thread already EXISTS and is persisted, so a
        // rollback failure must NOT discard it (a `?` here would return Err, orphaning the
        // freshly-created branch with no id for the caller to reach — the opposite of what we
        // want). Log the failure and return the (un-rolled-back) fork id so the branch stays
        // reachable; the user can rewind the extra turns themselves.
        if let Err(e) = rollback_thread(&new_id, drop_last_turns, cwd).await {
            eprintln!("[codex-fork] rollback-of-branch {new_id} failed, returning un-rolled-back fork: {e}");
        }
    }
    let model = value.get("model").and_then(Value::as_str).map(str::to_string);
    Ok(CodexForkResult { thread_id: new_id, model })
}

/// Archive a Codex thread (`thread/archive` — removes it from the active thread list
/// server-side). Used when a Codex conversation is discarded, the clean backend-native
/// counterpart to the Claude teardown leaving its transcript on disk. Transient app-server.
pub async fn archive_thread(thread_id: &str, cwd: &Path) -> Result<(), CodexError> {
    CodexServer::oneshot("thread/archive", json!({ "threadId": thread_id }), cwd)
        .await
        .map(|_| ())
}

/// Generate a short conversation title via a cheap one-shot Codex MODEL turn — Codex has no
/// free server-side title RPC (its `getConversationSummary.preview` is just the first user
/// message, not a summary), so we ask a small model directly on a `read-only` ephemeral
/// thread. Returns `None` on any failure (unavailable model / timeout / empty answer) so the
/// caller falls back to a truncation. `model` is a cheap id (e.g. `gpt-5.4-mini`); `None`
/// lets the server pick its default.
pub async fn generate_title(description: &str, model: Option<&str>, cwd: &Path) -> Option<String> {
    let prompt = format!(
        "Résume l'intention de l'utilisateur en un titre TRÈS court (3 à 6 mots), sans \
         ponctuation finale et sans guillemets. Réponds UNIQUEMENT par le titre, rien d'autre.\n\n\
         {description}"
    );
    match CodexServer::run_ephemeral_turn(prompt, model, cwd).await {
        Ok(answer) => clean_model_title(&answer),
        Err(e) => {
            // Graceful degradation, NOT a silent error: the caller falls back to a truncation
            // so the conversation always gets a name. Logged for observability rather than
            // surfaced as a user-facing bubble (a title failure is not user-actionable).
            eprintln!("[codex-title] model title generation failed, falling back to truncation: {e}");
            None
        }
    }
}

/// Normalize a model-returned title: first non-empty line, strip wrapping quotes, then run it
/// through the truncation cleaner (drops a stray leading token, caps words/length, trims
/// trailing punctuation). `None` if nothing usable remains.
fn clean_model_title(raw: &str) -> Option<String> {
    let first = raw.lines().find(|l| !l.trim().is_empty())?.trim();
    let unquoted = first
        .trim_matches(|c| c == '"' || c == '\'' || c == '«' || c == '»' || c == '`')
        .trim();
    session::codex_title_from_description(unquoted)
}

/// The `codex` binary this app would spawn: `$TOSSE_CODEX_BIN` when set, else the
/// bare name `codex` (resolved on `PATH`). Kept deliberately parallel to the Claude
/// backend's `transport::default_claude_bin`, and to its `$TOSSE_*_BIN` override so
/// a test build can point at a specific binary without touching PATH.
pub fn default_codex_bin() -> PathBuf {
    std::env::var_os("TOSSE_CODEX_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("codex"))
}

/// A tiny `which`: does `bin` resolve to an existing file? A path with separators is
/// checked as-is; a bare program name is searched across `$PATH`.
fn resolves_on_path(bin: &Path) -> bool {
    if bin.components().count() > 1 {
        return bin.is_file();
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(bin).is_file())
}

/// Well-known install locations for the `codex` binary, most-specific first. Used
/// ONLY as a fallback when a bare `codex` does not resolve on `PATH` — e.g. a
/// Finder-launched bundle whose login-shell PATH probe failed (the same minimal-PATH
/// trap the Claude backend guards against). `codex` ships via the npm package
/// `@openai/codex`, typically symlinked into `/usr/local/bin` or a homebrew/npm bin.
fn known_codex_locations() -> Vec<PathBuf> {
    let mut v = vec![
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        v.push(home.join(".npm-global/bin/codex"));
        v.push(home.join(".local/bin/codex"));
        v.push(home.join(".volta/bin/codex"));
    }
    v
}

/// Resolve the `codex` binary path we would hand to `Command::new`: the configured
/// name if it resolves on `PATH`, else the first existing well-known location, else
/// the bare name unchanged (let the spawn surface the "not found" error). Mirrors the
/// Claude backend's `transport::resolve_bin`. Used by the app-server transport.
pub fn resolved_codex_bin() -> PathBuf {
    let bin = default_codex_bin();
    if resolves_on_path(&bin) {
        return bin;
    }
    if bin.as_os_str() == "codex" {
        if let Some(found) = known_codex_locations().into_iter().find(|p| p.is_file()) {
            return found;
        }
    }
    bin
}

/// Whether a usable `codex` binary is present on this machine. Gates the Codex
/// backend selector in the UI — there is no point offering "new Codex conversation"
/// when the CLI is not installed. Cheap: a `PATH` / well-known-location file check,
/// never a process spawn.
pub fn codex_available() -> bool {
    let bin = default_codex_bin();
    resolves_on_path(&bin)
        || (bin.as_os_str() == "codex" && known_codex_locations().iter().any(|p| p.is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_on_path_finds_real_binaries_and_rejects_fakes() {
        // `sh` exists on every unix PATH; a nonsense name must not resolve.
        assert!(resolves_on_path(Path::new("sh")), "sh should resolve on PATH");
        assert!(
            !resolves_on_path(Path::new("tosse-definitely-not-a-real-binary-xyz")),
            "a nonsense name must not resolve"
        );
    }

    #[test]
    fn resolves_on_path_checks_explicit_paths_as_files() {
        // A path WITH separators is taken literally (not searched on PATH).
        assert!(resolves_on_path(Path::new("/bin/sh")), "/bin/sh is a file");
        assert!(!resolves_on_path(Path::new("/nope/not/here")));
    }

    #[test]
    fn default_bin_is_codex_without_override() {
        // Without the env override the default is the bare name (resolved on PATH).
        // We don't assert the env var here (parallel tests share the process env);
        // the bare-name default is the branch that matters for detection.
        assert_eq!(default_codex_bin().as_os_str(), "codex");
    }

    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth)"]
    async fn live_list_models_returns_a_default_model() {
        let models = list_models().await.expect("model/list should succeed");
        assert!(!models.is_empty(), "the binary should advertise at least one model");
        assert!(models.iter().any(|m| m.is_default), "exactly one model is the default");
        // Efforts are flattened from `supportedReasoningEfforts` (may be empty for some).
        eprintln!("codex models: {:?}", models.iter().map(|m| &m.id).collect::<Vec<_>>());
    }

    /// PROBE (not a regression test): does `remoteControl/status/read` (a safe, read-only
    /// method — it does NOT enable anything) answer with the CURRENT spawn (`codex
    /// app-server`, handshake `experimentalApi:true`)? If it returns a result → the whole
    /// `remoteControl/*` family is reachable with no extra CLI flag. If it returns a JSON-RPC
    /// "method not found" (-32601) → the server must be spawned with `--experimental`.
    /// Decides whether the Remote-control chantier needs a spawn change.
    /// Run: `cargo test --lib -- --ignored --nocapture live_probe_remote_control`.
    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth); probes remoteControl availability"]
    async fn live_probe_remote_control_availability() {
        let r = CodexServer::oneshot(
            "remoteControl/status/read",
            serde_json::Value::Null,
            &std::env::temp_dir(),
        )
        .await;
        match r {
            Ok(v) => eprintln!("REMOTE PROBE: status/read OK (available, NO --experimental needed) → {v}"),
            Err(e) => eprintln!("REMOTE PROBE: status/read FAILED → {e}"),
        }
    }

    /// PROBE (diagnostic, not a regression assertion): pokes the phase-4.3 native history ops
    /// against the real binary to confirm they're REACHABLE and to observe their preconditions.
    /// It starts a throwaway thread (no turns), then calls fork/archive on it. ⚠️ VERIFIED
    /// FINDING: a thread with no turns has NO on-disk ROLLOUT, and `thread/fork`/`rollback`
    /// load the thread FROM DISK by id → they answer `Rpc("no rollout found for thread id …")`.
    /// That is EXPECTED here and still proves the method is reachable (a "method not found"
    /// would be `-32601`). So this probe never asserts success — it prints each outcome and only
    /// flags a genuine "method not found". The real ops need a thread with persisted turns AND
    /// the (missing) thread-resume lifecycle; this is why the rewind/fork UI is gated off for
    /// Codex until that lands. Run: `cargo test --lib -- --ignored --nocapture live_probe_history_ops`.
    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth); diagnostic probe of the history-op wire"]
    async fn live_probe_history_ops() {
        let cwd = std::env::temp_dir();
        let started = CodexServer::oneshot(
            "thread/start",
            json!({ "cwd": cwd.to_string_lossy(), "sandbox": "workspace-write", "approvalPolicy": "on-request" }),
            &cwd,
        )
        .await;
        let thread_id = match &started {
            Ok(v) => v.get("thread").and_then(|t| t.get("id")).and_then(Value::as_str).map(str::to_string),
            Err(e) => {
                eprintln!("HISTORY PROBE: thread/start failed (auth/network?) → {e}");
                return;
            }
        };
        let Some(thread_id) = thread_id else {
            eprintln!("HISTORY PROBE: thread/start returned no thread id → {started:?}");
            return;
        };
        eprintln!("HISTORY PROBE: started thread {thread_id}");

        // "no rollout" / any Rpc error means the method DISPATCHED (reachable); only a JSON-RPC
        // -32601 would be a genuine "method not found". Generic over the ok type (fork vs archive).
        fn reaches<T>(r: &Result<T, CodexError>) -> String {
            match r {
                Ok(_) => "OK".to_string(),
                Err(CodexError::Rpc(m)) => {
                    assert!(
                        !m.contains("-32601") && !m.to_lowercase().contains("method not found"),
                        "method should be REACHABLE, got: {m}"
                    );
                    format!("reachable (Rpc: {m})")
                }
                Err(e) => format!("transport/other: {e}"),
            }
        }

        let fork = fork_thread(&thread_id, &cwd, None, 0).await;
        eprintln!("HISTORY PROBE: thread/fork → {}", reaches(&fork));
        let archive = archive_thread(&thread_id, &cwd).await;
        eprintln!("HISTORY PROBE: thread/archive → {}", reaches(&archive));
        if let Ok(f) = fork {
            let _ = archive_thread(&f.thread_id, &cwd).await; // best-effort cleanup of any real fork
        }
    }

    /// PROBE: does the model-based auto-title work end to end against the real binary?
    /// Runs a cheap `read-only` ephemeral turn (gpt-5.4-mini) over a sample intent and prints
    /// the generated title. A `None` means the model call failed (the actor would then fall
    /// back to a truncation). Run: `cargo test --lib -- --ignored --nocapture live_generate_title`.
    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth + a tiny model turn)"]
    async fn live_generate_title() {
        let desc = "Ajoute un bouton d'export CSV sur la page des factures et écris les tests";
        let title = generate_title(desc, Some("gpt-5.4-mini"), &std::env::temp_dir()).await;
        eprintln!("TITLE PROBE → {title:?}");
        if let Some(t) = &title {
            assert!(!t.is_empty(), "a generated title must not be empty");
            assert!(t.chars().count() <= 48, "title should be capped: {t:?}");
        }
    }

    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth)"]
    async fn live_list_skills_flattens_and_dedups() {
        let skills = list_skills(vec!["/tmp".to_string()]).await.expect("skills/list should succeed");
        let names: Vec<_> = skills.iter().map(|s| s.name.clone()).collect();
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(names.len(), unique.len(), "names must be de-duplicated");
        eprintln!("codex skills: {names:?}");
    }
}
