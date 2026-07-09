//! The Codex conversation actor — the Codex sibling of `session::run_actor`.
//!
//! One `run_codex_actor` per Codex conversation: it opens a thread on the shared
//! [`CodexServer`], then drives a `select!` loop over the conversation's inbound
//! app-server messages (routed to it by threadId) and the UI's [`SessionCommand`]s,
//! translating BOTH into the SAME normalized [`SessionEvent`]s the Claude backend
//! emits — so the entire front (rendering, status, clean-output) is reused verbatim.
//!
//! The teardown order mirrors `session::run_actor` byte-for-byte in SHAPE (invariant
//! #4): explain a spontaneous death → announce the end → close the thread → evict from
//! the registry → fire the shutdown ack LAST (the synchronous-stop contract a rewind
//! relies on). The SOCLE emits enough to "answer text"; rich item rendering is 4.1.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::supervisor::control::PermissionDecision;
use crate::supervisor::model::{
    ConversationItem, McpAuthResult, McpServerLive, NormalizedBlock, PermissionRequestPayload,
    RemoteControlState, SessionEmitter, SessionStatePayload,
};
use crate::supervisor::session::{InitialControls, SessionCommand, SessionError, SessionHandle};
use crate::supervisor::transport::{ImageAttachment, SpawnConfig};

use super::protocol::{
    reply_result, CodexControls, CommandApprovalParams, ErrorNotification, FileChangeApprovalParams,
    Incoming, ItemDelta, ItemEnvelope, RateLimitSnapshot, RateLimitWindow, ThreadItem,
    TurnCompleted, TurnStartParams, TurnStartResult, UserInput,
};
use super::server::CodexServer;

/// Spawn a Codex session: start the actor task and return a handle to drive it. The
/// signature MIRRORS [`crate::supervisor::session::spawn_session`] (same `SpawnConfig`
/// / `InitialControls` / emitter / `on_exit`) plus the shared [`CodexServer`], so the
/// IPC dispatch is a clean `match` at the single spawn point. `initial` is unused at
/// the socle (model/effort/permission mapping lands in 4.1).
pub fn spawn_session(
    id: String,
    cfg: SpawnConfig,
    _initial: InitialControls,
    emitter: Arc<dyn SessionEmitter>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    server: Arc<CodexServer>,
) -> Result<SessionHandle, SessionError> {
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    tokio::spawn(run_codex_actor(id.clone(), cfg, emitter, cmd_rx, on_exit, server));
    Ok(SessionHandle::from_channel(id, cmd_tx))
}

async fn run_codex_actor(
    id: String,
    cfg: SpawnConfig,
    emitter: Arc<dyn SessionEmitter>,
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    server: Arc<CodexServer>,
) {
    let mut core = CodexCore::new(id, emitter);

    // Handshake + open this conversation's thread. When the conversation carries a
    // persisted thread id (`cfg.resume`, the analogue of Claude's `--resume`), RESUME it
    // by id so continuing a cold-loaded conversation keeps its full prior context and a
    // STABLE id; otherwise open a fresh thread. A failure here (server won't spawn, cwd
    // vanished, handshake rejected) is surfaced as a visible notice and a clean end —
    // never a silent dead session (invariant #6).
    let model = codex_model(&cfg);
    let resuming = cfg.resume.as_deref().filter(|s| !s.is_empty());
    let open = match resuming {
        Some(resume_id) => server.resume_thread(&cfg.cwd, resume_id, model.as_deref()).await,
        None => server.start_thread(&cfg.cwd, model.as_deref()).await,
    };
    let (thread_id, mut inbound) = match open {
        Ok(pair) => pair,
        Err(e) => {
            // A fresh-start OR a resume failure both end the session cleanly with a surfaced
            // notice (invariant #6). ⚠️ On a RESUME failure we deliberately DO NOT fall back to
            // a fresh `start_thread`: that would mint a NEW thread id, which the front persists
            // over the conversation's real id (`noteSessionId`), ORPHANING the on-disk rollout
            // and permanently hiding its cold history — a silent data loss. Ending here keeps
            // the id (and thus the history) intact; a transient failure (RPC timeout on the
            // shared server) is recoverable by simply resending.
            let msg = if resuming.is_some() {
                format!("Reprise de la conversation Codex impossible : {e}. L'historique est conservé — réessayez d'envoyer.")
            } else {
                e.to_string()
            };
            core.emit_notice("process_exited", &msg);
            core.emit_ended();
            on_exit();
            return;
        }
    };
    core.on_thread_started(&thread_id, &cfg);

    // Seed the forfait ring with a full snapshot right away: the `account/rateLimits/updated`
    // push is SPARSE (may carry only a changed window) and may not arrive until the first
    // turn, so pull the current picture once. DETACHED (spawned) so it never delays the
    // actor's first command; best-effort — a failure just leaves the ring to fill from the
    // first push (a pure optimisation with a guaranteed fallback, so the swallow is safe).
    {
        let server = Arc::clone(&server);
        let emitter = Arc::clone(&core.emitter);
        let id = core.id.clone();
        tokio::spawn(async move {
            if let Ok(v) = server.request("account/rateLimits/read", Value::Null).await {
                let snap = v.get("rateLimits").cloned().unwrap_or(Value::Null);
                if let Ok(parsed) = serde_json::from_value::<RateLimitSnapshot>(snap) {
                    if let Some(usage) = rate_limits_to_plan_usage(&parsed) {
                        emitter.emit_codex_plan_usage(&id, &usage);
                    }
                }
            }
        });
    }

    let mut shutdown_ack: Option<oneshot::Sender<()>> = None;
    let server_gone = loop {
        tokio::select! {
            maybe_in = inbound.recv() => match maybe_in {
                Some(inc) => core.on_incoming(inc),
                None => break true, // route/server closed: the app-server died
            },
            maybe_cmd = cmd_rx.recv() => match maybe_cmd {
                Some(SessionCommand::Shutdown { ack }) => { shutdown_ack = ack; break false; }
                None => break false, // command channel closed: requested stop
                Some(cmd) => core.on_command(cmd, &thread_id, &server).await,
            },
        }
    };

    // Same teardown ORDER as the Claude actor (session.rs:400-424):
    if server_gone {
        core.emit_notice(
            "process_exited",
            "le serveur codex app-server s'est arrêté de façon inattendue",
        );
    } else {
        // An approval the demux ROUTED to us may still be sitting UNPROCESSED in `inbound`
        // when the loop broke (`select!` can take the command branch over a ready inbound).
        // It never entered `pending_approvals`, so drain and `cancel` it here too — else it
        // leaks unanswered and wedges the shared server's turn forever (M1).
        while let Ok(inc) = inbound.try_recv() {
            if let Incoming::ServerRequest { id, .. } = inc {
                server
                    .reply(reply_result(&id, json!({ "decision": "cancel" })))
                    .await;
            }
        }
        // Release any approval already surfaced (in `pending_approvals`) FIRST — an
        // unanswered server-request wedges the shared process — THEN stop the turn itself.
        // Turning the stream OFF (or a rewind) must actually STOP an in-flight turn on the
        // SHARED app-server, not just detach from it — otherwise it keeps running (burning
        // quota, writing the rollout) even though the conversation reads as off. The Claude
        // backend gets this for free by killing its own process; the shared Codex server
        // can't be killed (it serves the OTHER conversations), so we cancel + interrupt.
        core.decline_pending_approvals(&server).await;
        core.interrupt_if_active(&thread_id, &server).await;
    }
    core.emit_ended();
    // Drop this thread's route; if it was the last, the server tears down gracefully.
    server.close_thread(&thread_id).await;
    // Evict the dead session from the IPC registry.
    on_exit();
    // Release a `shutdown_and_wait` caller LAST — after we've stopped consuming this
    // conversation's inbound and dropped its route. ⚠️ At the socle this does NOT yet
    // interrupt an in-flight turn on the shared server (`close_thread` only drops the
    // route). Wiring the Codex rewind (phase 4.x) will additionally need a `turn/interrupt`
    // + ack HERE before truncating the rollout, or it could race a still-live writer.
    if let Some(ack) = shutdown_ack {
        let _ = ack.send(());
    }
}

/// Per-conversation protocol state + the mapping app-server ⇄ [`SessionEvent`]. Holds
/// its OWN small [`SessionStatePayload`]; it never reuses the Claude `Assembler`
/// (which parses stream-json), per invariant #8.
struct CodexCore {
    id: String,
    emitter: Arc<dyn SessionEmitter>,
    state: SessionStatePayload,
    /// Message ids we have already opened a `MessageStarted` for. A `TextDelta` /
    /// `ThinkingDelta` is dropped by the front unless its turn already exists and is
    /// streaming, so we emit `MessageStarted` once per item id before its first delta.
    /// Reasoning and assistant-message items each get their own id → their own bubble.
    streaming_ids: HashSet<String>,
    /// Tool item ids that have been carded THIS turn. Gates card emission so a card is
    /// synthesized at most once even across a duplicate/late `item/*` — distinct from
    /// `open_tools`, which is emptied on completion (so it can't double as the card key).
    carded: HashSet<String>,
    /// Tool item ids with a synthesized `ToolUse` but not yet a `ToolResult`. Gates result
    /// emission (no duplicate result) and lets us close any card still open when the turn
    /// ends (interrupted mid-command) — a `ToolUse` with no `ToolResult` renders "running"
    /// forever, so the clean-output round would never fold.
    open_tools: HashSet<String>,
    /// ServerRequest ids of approvals awaiting the user's yes/no (a shell command or file
    /// patch under `approvalPolicy:"on-request"`). We MUST reply to each — on answer, or a
    /// `cancel` at teardown — or the shared app-server blocks that turn forever.
    pending_approvals: HashSet<String>,
    /// The live turn's id, captured from the `turn/start` response and refreshed from
    /// turn-scoped notifications. `turn/interrupt` REQUIRES it alongside the threadId, so
    /// without it the stream-control button can't stop a Codex turn. `None` between turns.
    current_turn_id: Option<String>,
    /// The conversation's latest composer controls (model / effort / approval / sandbox
    /// / …), refreshed from each `SendUser` and re-asserted as per-turn overrides on
    /// every `turn/start` — the app-server has no separate settings channel.
    controls: CodexControls,
}

impl CodexCore {
    fn new(id: String, emitter: Arc<dyn SessionEmitter>) -> Self {
        Self {
            id,
            emitter,
            state: SessionStatePayload::default(),
            streaming_ids: HashSet::new(),
            carded: HashSet::new(),
            open_tools: HashSet::new(),
            pending_approvals: HashSet::new(),
            current_turn_id: None,
            controls: CodexControls::default(),
        }
    }

    fn push_state(&self) {
        self.emitter.emit_state(&self.id, &self.state);
    }

    fn push_item(&self, item: ConversationItem) {
        self.emitter.emit_item(&self.id, &item);
    }

    /// Normalize a `rateLimits` snapshot (from the `account/rateLimits/updated` push or
    /// the `account/rateLimits/read` response) into the shared [`crate::usage::PlanUsage`]
    /// and emit it. A snapshot with no usable window (both absent) is dropped — never a
    /// spurious empty forfait. Decode failures are ignored (tolerance rule 3).
    fn ingest_rate_limits(&self, snapshot: Value) {
        let Ok(snap) = serde_json::from_value::<RateLimitSnapshot>(snapshot) else {
            return;
        };
        if let Some(usage) = rate_limits_to_plan_usage(&snap) {
            self.emitter.emit_codex_plan_usage(&self.id, &usage);
        }
    }

    /// A visible timeline notice (the single "zero silent error" channel, shared with
    /// the Claude backend). `subtype` ∈ `process_exited` / `send_failed` /
    /// `protocol_error` / `error`.
    fn emit_notice(&self, subtype: &str, message: &str) {
        self.push_item(ConversationItem::Notice {
            subtype: subtype.to_string(),
            detail: json!({ "message": message }),
        });
    }

    fn emit_ended(&mut self) {
        // A spontaneous death (or any teardown) must not leave tool cards "running".
        self.close_dangling_tools();
        self.state.ended = true;
        self.state.busy = false;
        self.push_state();
    }

    /// Seed the live state the moment the thread opens: the thread id (Codex's resume
    /// key, the analogue of Claude's `session_id`) and the cwd.
    fn on_thread_started(&mut self, thread_id: &str, cfg: &SpawnConfig) {
        self.state.session_id = Some(thread_id.to_string());
        self.state.cwd = Some(cfg.cwd.to_string_lossy().to_string());
        self.push_state();
    }

    async fn on_command(&mut self, cmd: SessionCommand, thread_id: &str, server: &Arc<CodexServer>) {
        match cmd {
            SessionCommand::SendUser { text, images, controls } => {
                // Refresh the live controls from this send (they ride each user message,
                // the wire being per-turn). Images become `localImage` inputs pointing at
                // temp files the app-server reads from disk (Codex takes a path, not base64).
                if let Some(c) = controls {
                    self.controls = c;
                }
                let input = user_inputs(text, &images);

                // A message sent WHILE a turn is in flight STEERS the active turn (Codex's
                // analogue of the CLI's mid-turn queue-injection), rather than starting a
                // second turn. `turn/steer` requires the exact active turn id.
                //
                // ⚠️ `busy` LAGS the server: it clears only when the actor DEQUEUES
                // `turn/completed`, not when the server actually finishes. So a message
                // sent just as a turn ends can find `busy` still true with a turn id that
                // has already completed → the steer is rejected. On ANY steer failure we
                // FALL THROUGH to `turn/start` rather than drop the message: a rejected
                // steer is atomic (nothing was injected), so it can't duplicate, and the
                // message is really a fresh turn. Only a SUCCESSFUL steer returns early.
                if self.state.busy {
                    if let Some(turn_id) = self.current_turn_id.clone() {
                        let params = json!({
                            "threadId": thread_id,
                            "input": &input,
                            "expectedTurnId": turn_id,
                        });
                        if server.request("turn/steer", params).await.is_ok() {
                            return; // steered into the live turn
                        }
                        // Steer rejected (turn already completed / not steerable) → fall
                        // through and start a fresh turn below; never a silent drop.
                    }
                }

                self.state.busy = true;
                self.push_state();
                let mut params = TurnStartParams::new(thread_id.to_string(), input);
                self.controls.apply_to(&mut params);
                let params = serde_json::to_value(params).unwrap_or(Value::Null);
                match server.request("turn/start", params).await {
                    Ok(result) => {
                        // Capture the live turn id so an Interrupt can target THIS turn
                        // (turn/interrupt requires it) — even before the first notification.
                        self.current_turn_id = serde_json::from_value::<TurnStartResult>(result)
                            .ok()
                            .and_then(|r| r.turn.id);
                    }
                    Err(e) => {
                        self.state.busy = false;
                        self.push_state();
                        self.emit_notice("send_failed", &e.to_string());
                    }
                }
            }
            SessionCommand::Interrupt => {
                // `turn/interrupt` REQUIRES the live turnId alongside the threadId — the
                // stream-control button is a no-op without it.
                if let Some(turn_id) = self.current_turn_id.clone() {
                    let _ = server
                        .request(
                            "turn/interrupt",
                            json!({ "threadId": thread_id, "turnId": turn_id }),
                        )
                        .await;
                }
                // No live turn → nothing to interrupt; `turn/completed` settles `busy`.
            }
            SessionCommand::AnswerPermission { request_id, decision } => {
                // Reply to the routed approval server-request. Codex approvals can't rewrite
                // the tool input, so Allow → "accept" (this once); Deny → "decline".
                if self.pending_approvals.remove(&request_id) {
                    let decision = match decision {
                        PermissionDecision::Allow { .. } => "accept",
                        PermissionDecision::Deny { .. } => "decline",
                    };
                    server
                        .reply(reply_result(&request_id, json!({ "decision": decision })))
                        .await;
                    self.state.awaiting_permission = false;
                    self.push_state();
                }
                // Unknown / already-answered request id → ignore.
            }
            // Commands carrying a oneshot reply MUST be resolved, never dropped, or the
            // IPC caller blocks until its 15-30s timeout (invariant #3).
            //
            // Live MCP status for the conversation-lens Extensions view: query
            // `mcpServerStatus/list` scoped to this thread and map to the shared
            // `McpServerLive` rows. An RPC rejection is surfaced as `Err` (never a fake
            // empty — distinct from a genuinely server-less conversation).
            //
            // DETACHED (spawned): this is a STATELESS side-channel query, so we run it off
            // the actor's critical path — otherwise awaiting it inline would stop the
            // single-task actor from draining its inbound app-server stream, freezing a live
            // turn's rendering on screen until the RPC returns. The `Arc<CodexServer>` clone
            // keeps the server alive for the request; the oneshot always resolves.
            SessionCommand::McpStatus(tx) => {
                let server = Arc::clone(server);
                let thread_id = thread_id.to_string();
                tokio::spawn(async move {
                    let _ = tx.send(fetch_mcp_status(&server, &thread_id).await);
                });
            }
            SessionCommand::McpAuthenticate { reply, .. } => {
                let _ = reply.send(McpAuthResult {
                    error: Some("authentification MCP non gérée pour Codex".into()),
                    ..McpAuthResult::default()
                });
            }
            // Native Codex remote control (`remoteControl/enable|disable`). Unlike Claude's
            // bridge (which returns a claude.ai/code URL), Codex's enable returns no URL —
            // a device is linked via a separate pairing flow, so on enable we also fetch a
            // pairing CODE (shown in the chip for the user to enter in the Codex mobile app).
            // Reachable with the plain spawn (the `experimentalApi:true` handshake enables
            // the family — verified live, no CLI flag). Per-conv reply; the app-server-global
            // `remoteControl/status/changed` push is ignored in v1 (no cross-conv coupling).
            // DETACHED (spawned): stateless remote-control RPCs off the actor's critical
            // path (same reason as McpStatus). The oneshot always resolves.
            SessionCommand::SetRemoteControl { enabled, reply, .. } => {
                let server = Arc::clone(server);
                tokio::spawn(async move {
                    let state = if enabled {
                        codex_remote_enable(&server).await
                    } else {
                        codex_remote_disable(&server).await
                    };
                    let _ = reply.send(state);
                });
            }
            // Compact the context — the native RPC (Codex has no `/compact` text command).
            // Fire-and-forget: a failure surfaces as a notice, never silent. The server
            // then emits `thread/compacted` + the next `thread/tokenUsage/updated` drops
            // the ring — no optimistic state needed here. DETACHED (spawned): stateless RPC
            // off the actor's critical path; the failure notice is emitted via a cloned
            // emitter + id (the actor keeps draining inbound meanwhile).
            SessionCommand::Compact => {
                let server = Arc::clone(server);
                let thread_id = thread_id.to_string();
                let emitter = Arc::clone(&self.emitter);
                let id = self.id.clone();
                tokio::spawn(async move {
                    if let Err(e) = server
                        .request("thread/compact/start", json!({ "threadId": thread_id }))
                        .await
                    {
                        emitter.emit_item(
                            &id,
                            &ConversationItem::Notice {
                                subtype: "send_failed".to_string(),
                                detail: json!({
                                    "message": format!("compactage du contexte impossible : {e}")
                                }),
                            },
                        );
                    }
                });
            }
            // Auto-title. Claude asks the binary (a free Haiku call over
            // `generate_session_title`); Codex has NO free server-side title RPC, so we ask a
            // cheap model directly on a one-shot ephemeral `read-only` turn, and fall back to a
            // truncation if that fails. Emitted on the SAME `SessionTitleEvent` wire the front
            // applies. DETACHED (spawned): the model turn must NOT block the actor draining its
            // live app-server stream (a title takes seconds); the ephemeral turn uses its OWN
            // server, so it's fully decoupled from this conversation's thread. Emit via a cloned
            // emitter + id; `seq` rides through so the front drops a stale/out-of-order apply.
            SessionCommand::GenerateTitle { description, seq } => {
                let emitter = Arc::clone(&self.emitter);
                let id = self.id.clone();
                let cwd = self
                    .state
                    .cwd
                    .clone()
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir);
                tokio::spawn(async move {
                    // Cheap title model; on failure (unavailable / timeout / empty) fall back to
                    // a truncation so the conversation still gets a name.
                    let title = super::generate_title(&description, Some("gpt-5.4-mini"), &cwd)
                        .await
                        .or_else(|| codex_title_from_description(&description));
                    if let Some(title) = title {
                        emitter.emit_title(&id, &title, seq);
                    }
                });
            }
            // Everything else has no socle equivalent on Codex → a clean no-op. (Summary /
            // remaining MCP mutations / plugins / stop-task land across phases 4.4-4.5.)
            // ⚠️ Any FUTURE `SessionCommand` variant carrying a `oneshot` reply MUST be matched
            // explicitly ABOVE this arm and resolve its reply — falling into this no-op would
            // hang the IPC caller for its timeout.
            _ => {}
        }
    }

    /// Interrupt an in-flight turn on the shared server (if any). Used at teardown so
    /// turning the stream off actually STOPS the turn (the Claude backend gets this by
    /// killing its process; the shared Codex server can't be killed).
    async fn interrupt_if_active(&self, thread_id: &str, server: &CodexServer) {
        if let Some(turn_id) = self.current_turn_id.clone() {
            let _ = server
                .request(
                    "turn/interrupt",
                    json!({ "threadId": thread_id, "turnId": turn_id }),
                )
                .await;
        }
    }

    /// Inbound routed to this conversation: NOTIFICATIONS drive the whole rendering, and
    /// the shared server routes an APPROVAL server-request here (a command/patch the model
    /// wants to run under `on-request`). Responses are correlated by the server, never here.
    fn on_incoming(&mut self, inc: Incoming) {
        match inc {
            Incoming::Notification { method, params } => self.on_notification(&method, params),
            Incoming::ServerRequest { id, method, params } => {
                self.on_approval_request(id, &method, params)
            }
            _ => {}
        }
    }

    /// Surface an approval server-request as a permission prompt reusing Claude's UI
    /// verbatim (`PermissionRequestPayload` → the composer prompt → `answer_permission`).
    /// The `request_id` IS the ServerRequest id we must reply to; `tool_use_id == itemId`
    /// ties the prompt to the tool card already on the timeline (which shows the command /
    /// diff). We record it as pending so it is always answered (on reply, or `cancel` at
    /// teardown) — the shared server blocks the turn until then, exactly like `can_use_tool`.
    fn on_approval_request(&mut self, id: String, method: &str, params: Value) {
        let payload = match method {
            "item/commandExecution/requestApproval" => {
                let p: CommandApprovalParams = serde_json::from_value(params).unwrap_or_default();
                PermissionRequestPayload {
                    request_id: id.clone(),
                    tool_name: "Bash".into(),
                    tool_use_id: p.item_id.unwrap_or_default(),
                    input: json!({ "command": p.command, "cwd": p.cwd }),
                    title: Some("Exécuter une commande".into()),
                    description: p.reason,
                    suggestions: Value::Null,
                }
            }
            "item/fileChange/requestApproval" => {
                let p: FileChangeApprovalParams = serde_json::from_value(params).unwrap_or_default();
                PermissionRequestPayload {
                    request_id: id.clone(),
                    tool_name: "ApplyPatch".into(),
                    tool_use_id: p.item_id.unwrap_or_default(),
                    input: json!({ "reason": p.reason }),
                    title: Some("Modifier des fichiers".into()),
                    description: p.reason,
                    suggestions: Value::Null,
                }
            }
            // The demux only routes the two approval kinds above; anything else here would
            // be a routing/coupling bug. Don't surface a broken prompt — but STILL record it
            // as pending so the teardown `cancel` releases the server, never leaking a
            // server-request unanswered (which would wedge the turn).
            _ => {
                self.pending_approvals.insert(id);
                return;
            }
        };
        self.pending_approvals.insert(id);
        self.state.awaiting_permission = true;
        self.emitter.emit_permission(&self.id, &payload);
        self.push_state();
    }

    /// Reply "cancel" to every still-pending approval — the turn is ending, so the shared
    /// server must be released or it blocks forever waiting on us.
    async fn decline_pending_approvals(&mut self, server: &CodexServer) {
        if self.pending_approvals.is_empty() {
            return;
        }
        for id in self.pending_approvals.drain() {
            server.reply(reply_result(&id, json!({ "decision": "cancel" }))).await;
        }
        self.state.awaiting_permission = false;
    }

    fn on_notification(&mut self, method: &str, params: Value) {
        // Backstop: recover the live turn id from a turn-scoped notification IF the
        // turn/start response parse missed it. FILL-ONLY — it must NEVER overwrite a
        // freshly-started turn's id with a stale/completed turn's buffered notification:
        // after a steer-race fallthrough (SendUser starts turn B), the just-ended turn A's
        // deltas (each carrying turnId=A) are still queued; overwriting current_turn_id back
        // to A would defeat the stale-completion guard in on_turn_completed and settle B's
        // busy early. Once set (by turn/start or a fill), only on_turn_completed clears it.
        if self.current_turn_id.is_none() {
            if let Some(tid) = params.get("turnId").and_then(Value::as_str) {
                self.current_turn_id = Some(tid.to_string());
            }
        }
        match method {
            // ── Streaming text: assistant answer vs reasoning — the ONLY difference is the
            // block kind (Text vs Thinking). Reasoning must NEVER become Text (it would leak
            // the raw chain into the visible answer).
            "item/agentMessage/delta" => self.stream_delta(params, false),
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                self.stream_delta(params, true)
            }

            // ── Item lifecycle. `item/started` synthesizes the tool card the moment a tool
            // begins; `item/completed` closes it (ToolResult) or emits the authoritative
            // assistant/reasoning message. Same envelope, told apart by the flag.
            "item/started" => self.on_item(params, false),
            "item/completed" => self.on_item(params, true),

            "turn/completed" => self.on_turn_completed(params),

            // ── Subscription rate-limit % (5h + weekly) — the forfait ring. A GLOBAL
            // (thread-less) push the shared server broadcasts to every conversation actor
            // (see `server::demux_loop`). Account-global, so any Codex conversation
            // surfacing it feeds the ONE front Codex plan store. Sparse: a push may carry
            // only the window that moved (the front merges onto its last snapshot).
            "account/rateLimits/updated" => {
                self.ingest_rate_limits(params.get("rateLimits").cloned().unwrap_or(Value::Null));
            }

            // ── Extension-inventory invalidation pushes (Extensions v2). All three are
            // GLOBAL notifications the shared server broadcasts to every actor; the front
            // dedupes/coalesces the invalidation, so multiple actors re-emitting the same
            // push is harmless. No payload is forwarded — the front refetches through the
            // normal read commands (whitelisted shapes), never from the raw wire.
            "skills/changed" => self.emitter.emit_extensions_changed(&self.id, "skills"),
            "mcpServer/startupStatus/updated" => {
                self.emitter.emit_extensions_changed(&self.id, "mcp")
            }
            "account/updated" => self.emitter.emit_extensions_changed(&self.id, "accounts"),

            "thread/tokenUsage/updated" => {
                let usage = params.get("tokenUsage");
                if let Some(win) = usage
                    .and_then(|u| u.get("modelContextWindow"))
                    .and_then(Value::as_u64)
                {
                    // Direct + authoritative — no model-name heuristic (unlike Claude).
                    self.state.context_window = Some(win);
                }
                if let Some(total) = usage
                    .and_then(|u| u.get("total"))
                    .and_then(|t| t.get("totalTokens"))
                    .and_then(Value::as_u64)
                {
                    self.state.context_tokens = Some(total);
                }
                self.push_state();
            }
            "error" => {
                // ⚠️ Surface AND settle even if the payload does NOT decode into
                // `ErrorNotification` (a bare string / array / null — its fields are optional so
                // any OBJECT parses, but a non-object does not). Otherwise the error is DROPPED
                // and, with `busy` still true and tool cards still open, the turn renders
                // "running" FOREVER with nothing shown — the exact silent-error the no-silent-
                // failure rule forbids. An undecodable payload is treated as terminal (settle)
                // rather than risk a permanent hang.
                let parsed = serde_json::from_value::<ErrorNotification>(params).ok();
                let msg = parsed
                    .as_ref()
                    .and_then(|e| e.message.clone())
                    .unwrap_or_else(|| "erreur codex app-server".into());
                self.emit_notice("protocol_error", &msg);
                // A transient (will-retry) error keeps the turn going; a terminal one — or an
                // undecodable one — ends it, and a terminal `error` may NOT be followed by
                // `turn/completed`, so it runs the same close-out: settle `busy`, reset the turn
                // id, and close any open tool card (M2).
                let will_retry = parsed.and_then(|e| e.will_retry) == Some(true);
                if !will_retry {
                    self.close_dangling_tools();
                    self.current_turn_id = None;
                    self.state.busy = false;
                    self.push_state();
                }
            }
            // Every other notification (thread/status, turn/diff, plan steps, mcpServer
            // status, …) is additive — ignored here, never fatal. Rich turn-diff view and
            // fleet status land in phases 4.3/4.4.
            _ => {}
        }
    }

    /// Emit a streaming token. `thinking` picks the block kind (reasoning → `ThinkingDelta`,
    /// answer → `TextDelta`). Opens the item's turn (`MessageStarted`) on first sight, since
    /// the front drops a delta whose turn isn't open.
    fn stream_delta(&mut self, params: Value, thinking: bool) {
        let Ok(d) = serde_json::from_value::<ItemDelta>(params) else {
            return;
        };
        let Some(item_id) = d.item_id.filter(|s| !s.is_empty()) else {
            return;
        };
        if self.streaming_ids.insert(item_id.clone()) {
            self.push_item(ConversationItem::MessageStarted {
                id: item_id.clone(),
                role: "assistant".into(),
                parent_tool_use_id: None,
            });
        }
        let item = if thinking {
            ConversationItem::ThinkingDelta {
                message_id: Some(item_id),
                text: d.delta,
            }
        } else {
            ConversationItem::TextDelta {
                message_id: Some(item_id),
                text: d.delta,
            }
        };
        self.push_item(item);
    }

    /// Map one `item/started` (`completed=false`) or `item/completed` (`completed=true`) to
    /// the normalized timeline. Tool items reuse `item.id` as BOTH the synthesized
    /// `tool_use` id and its `tool_result`'s `tool_use_id`, so the front's id-keyed store
    /// pairs them and clean-output folds the round.
    fn on_item(&mut self, params: Value, completed: bool) {
        let Ok(env) = serde_json::from_value::<ItemEnvelope>(params) else {
            return;
        };
        match env.item {
            // Assistant answer & reasoning: only the authoritative (completed) message is
            // emitted here; the live text arrived via deltas and the front reconciles by id.
            ThreadItem::AgentMessage { id, text } => {
                if completed && !text.is_empty() {
                    self.emit_message(id, NormalizedBlock::Text { text });
                }
            }
            ThreadItem::Plan { id, text } => {
                if completed && !text.is_empty() {
                    self.emit_message(id, NormalizedBlock::Text { text });
                }
            }
            ThreadItem::Reasoning {
                id,
                summary,
                content,
            } => {
                if completed {
                    let text = join_reasoning(&summary, &content);
                    if !text.is_empty() {
                        self.emit_message(id, NormalizedBlock::Thinking { text });
                    }
                }
            }

            // Tool items → a ToolUse card on start, a ToolResult on completion.
            ThreadItem::CommandExecution {
                id,
                command,
                cwd,
                aggregated_output,
                exit_code,
                status,
            } => {
                self.ensure_tool_use(&id, "Bash", json!({ "command": command, "cwd": cwd }));
                if completed {
                    let is_error =
                        status_is_error(status.as_deref()) || exit_code.is_some_and(|c| c != 0);
                    self.emit_tool_result(&id, json!(aggregated_output.unwrap_or_default()), is_error);
                }
            }
            ThreadItem::FileChange {
                id,
                changes,
                status,
            } => {
                let changes_json = serde_json::to_value(&changes).unwrap_or(Value::Null);
                self.ensure_tool_use(&id, "ApplyPatch", json!({ "changes": changes_json }));
                if completed {
                    let is_error = status_is_error(status.as_deref());
                    // The per-file diffs ride on the result too, so they're visible even if
                    // the started item carried an empty change list.
                    self.emit_tool_result(
                        &id,
                        json!({ "status": status, "changes": changes_json }),
                        is_error,
                    );
                }
            }
            ThreadItem::McpToolCall {
                id,
                server,
                tool,
                status,
                arguments,
                result,
                error,
            } => {
                let name = format!(
                    "mcp__{}__{}",
                    server.as_deref().unwrap_or("server"),
                    tool.as_deref().unwrap_or("tool")
                );
                self.ensure_tool_use(&id, &name, json!({ "arguments": arguments }));
                if completed {
                    let is_error = error.is_some() || status_is_error(status.as_deref());
                    let content = error.or(result).unwrap_or(Value::Null);
                    self.emit_tool_result(&id, content, is_error);
                }
            }
            ThreadItem::WebSearch { id, query } => {
                self.ensure_tool_use(&id, "WebSearch", json!({ "query": query }));
                if completed {
                    self.emit_tool_result(&id, json!({ "query": query }), false);
                }
            }

            // Unmodelled item types (dynamicToolCall, collabAgentToolCall, imageView, review
            // modes, …) render generically or not at all in phase 4.1 — never a hard error.
            ThreadItem::Unknown => {}
        }
    }

    /// Terminal turn handling: emit the timeline `TurnResult`, close any tool card still
    /// open (interrupted mid-command), and — ALWAYS, even on an undecodable payload —
    /// clear `busy` so the UI spinner can never wedge (invariant #7).
    fn on_turn_completed(&mut self, params: Value) {
        let parsed = serde_json::from_value::<TurnCompleted>(params).ok();
        // Stale-completion guard: a `turn/completed` whose id is NOT the current turn
        // arrives after the steer-race fallthrough (SendUser) already started a fresh
        // turn. Ignore it — settling here would clear the LIVE turn's `busy`/`current_turn_id`
        // (breaking its interrupt + flashing the UI to idle). The live turn's own
        // completion settles it. When either id is unknown, fall through and settle (safe
        // default: the common case where the completion IS the current turn).
        if let (Some(done), Some(cur)) = (
            parsed.as_ref().and_then(|t| t.turn.id.as_deref()),
            self.current_turn_id.as_deref(),
        ) {
            if done != cur {
                return;
            }
        }
        let (is_error, message) = match &parsed {
            Some(t) => {
                let is_error = t.turn.error.is_some()
                    || t.turn.status.eq_ignore_ascii_case("failed")
                    || t.turn.status.eq_ignore_ascii_case("error");
                let message = t
                    .turn
                    .error
                    .as_ref()
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                (is_error, message)
            }
            None => (false, None),
        };
        // Close any card that never received its own completion (e.g. an interrupted
        // command), so the round is foldable instead of stuck "running".
        self.close_dangling_tools();
        if let Some(msg) = &message {
            self.emit_notice("error", msg);
        }
        self.push_item(ConversationItem::TurnResult {
            subtype: if is_error { "error" } else { "success" }.into(),
            is_error,
            result: None,
            api_error_status: None,
            total_cost_usd: None,
            num_turns: None,
            duration_ms: None,
            // Codex's turn/completed carries no cost/timing breakdown (like the other fields
            // above) — the "N s de modèle" + TTFT are Claude-only; None keeps the UI honest.
            duration_api_ms: None,
            ttft_ms: None,
        });
        self.streaming_ids.clear();
        self.carded.clear();
        self.current_turn_id = None;
        self.state.busy = false;
        self.push_state();
    }

    /// Emit an authoritative assistant/reasoning message keyed by `item.id` (one block).
    /// The front reconciles it against the streamed deltas of the same id.
    fn emit_message(&mut self, id: String, block: NormalizedBlock) {
        self.streaming_ids.remove(&id);
        self.push_item(ConversationItem::AssistantMessage {
            id,
            blocks: vec![block],
            parent_tool_use_id: None,
        });
    }

    /// Synthesize a tool card the first time we see a tool item id THIS turn (idempotent
    /// on `carded`, which — unlike `open_tools` — is not emptied on completion, so a
    /// duplicate/late `item/*` can't re-card). Called on BOTH `item/started` and
    /// `item/completed` (from the completed item's fields) so a dropped `item/started`
    /// still yields a card to hang the result on.
    fn ensure_tool_use(&mut self, id: &str, name: &str, input: Value) {
        if self.carded.insert(id.to_string()) {
            self.open_tools.insert(id.to_string());
            self.push_item(ConversationItem::AssistantMessage {
                id: id.to_string(),
                blocks: vec![NormalizedBlock::ToolUse {
                    id: id.to_string(),
                    name: name.to_string(),
                    input,
                }],
                parent_tool_use_id: None,
            });
        }
    }

    /// Close a tool card with its result (joined by `tool_use_id == item.id`). Gated on
    /// `open_tools` so a duplicate/late `item/completed` for an already-closed card is a
    /// no-op (no duplicate result).
    fn emit_tool_result(&mut self, id: &str, content: Value, is_error: bool) {
        if self.open_tools.remove(id) {
            self.push_item(ConversationItem::ToolResult {
                tool_use_id: id.to_string(),
                content,
                is_error,
                parent_tool_use_id: None,
            });
        }
    }

    /// Close every tool card still open with an error result, so a round that ended without
    /// each item's own `item/completed` (interrupted, a terminal `error`, a spontaneous
    /// server death) can still fold in clean-output instead of showing "running" forever.
    fn close_dangling_tools(&mut self) {
        for id in self.open_tools.drain().collect::<Vec<_>>() {
            self.push_item(ConversationItem::ToolResult {
                tool_use_id: id,
                content: json!("(interrompu)"),
                is_error: true,
                parent_tool_use_id: None,
            });
        }
    }
}

/// A Codex status/exit is an error when it FAILED or was DECLINED (`PatchApplyStatus` /
/// `CommandExecutionStatus` share these strings). `inProgress`/`completed` are not errors.
fn status_is_error(status: Option<&str>) -> bool {
    matches!(status, Some(s) if s.eq_ignore_ascii_case("failed") || s.eq_ignore_ascii_case("declined") || s.eq_ignore_ascii_case("error"))
}

/// Derive a concise conversation title from the accumulated user intent — the Codex
/// backend's auto-title (it has no server-side "generate a title" RPC in our client, so we
/// truncate rather than round-trip). Takes the first non-empty line, drops a leading
/// `/slash-command` token (noise as a title), and caps to a few words / ~48 chars, trimming
/// trailing punctuation. Returns `None` when nothing usable remains, so the caller leaves the
/// placeholder name rather than applying a blank title.
pub(super) fn codex_title_from_description(description: &str) -> Option<String> {
    const MAX_WORDS: usize = 8;
    const MAX_CHARS: usize = 48;

    let first = description.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut words: Vec<&str> = first.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    // Drop a leading "/command" token when there's more after it (a bare "/foo" keeps it).
    if words[0].starts_with('/') && words.len() > 1 {
        words.remove(0);
    }

    let mut title = String::new();
    for w in words.iter().take(MAX_WORDS) {
        let extra = if title.is_empty() { w.chars().count() } else { w.chars().count() + 1 };
        if title.chars().count() + extra > MAX_CHARS {
            break;
        }
        if !title.is_empty() {
            title.push(' ');
        }
        title.push_str(w);
    }
    // A single first word longer than the cap: hard-truncate it by chars so we still show
    // something rather than nothing.
    if title.is_empty() {
        title = words[0].chars().take(MAX_CHARS).collect();
    }

    let title = title
        .trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '.' | ',' | ':' | ';' | '!' | '?'))
        .to_string();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

/// The Codex model to open the thread with, derived from the shared `SpawnConfig`.
/// The config's `model` is set for every conversation (defaults to a Claude alias),
/// but a Claude alias would be REJECTED by the Codex binary — so a Claude-family value
/// yields `None` (the server falls back to its own default model) rather than failing
/// the thread start. A blank/empty value is likewise `None`. The front seeds a Codex
/// conversation with a real Codex id (see `DEFAULT_CODEX_MODEL`), so in practice this
/// passes that id through; the filter is the safety net for a stale/mismatched record.
fn codex_model(cfg: &SpawnConfig) -> Option<String> {
    let m = cfg.model.as_deref()?.trim();
    if m.is_empty() {
        return None;
    }
    let lower = m.to_ascii_lowercase();
    const CLAUDE_FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "claude"];
    if CLAUDE_FAMILIES.iter().any(|c| lower.contains(c)) {
        return None;
    }
    Some(m.to_string())
}

/// Enable Codex remote control: bring the bridge up (`remoteControl/enable`), then fetch a
/// device-pairing code (`remoteControl/pairing/start`) so the user can link a device — the
/// enable response carries NO URL (unlike Claude). The pairing fetch is best-effort: the
/// bridge is up even if it fails (the chip just won't show a code). An enable RPC failure
/// surfaces as an `error` state.
async fn codex_remote_enable(server: &CodexServer) -> RemoteControlState {
    let status = match server.request("remoteControl/enable", json!({})).await {
        Ok(v) => codex_remote_status(&v),
        Err(e) => {
            return RemoteControlState {
                status: "error".into(),
                error: Some(e.to_string()),
                ..RemoteControlState::default()
            }
        }
    };
    // Fetch a device-pairing code. A FAILURE here is NOT swallowed (the no-silent-error
    // rule): the bridge is up but unusable without a code, so carry the reason in `error`
    // — the front surfaces it AND still lets the user disable the bridge. Prefer the
    // human-typeable manual code (`manualCode:true`), falling back to the long QR payload.
    let (pairing_code, error) = match server
        .request("remoteControl/pairing/start", json!({ "manualCode": true }))
        .await
    {
        Ok(v) => {
            let code = v
                .get("manualPairingCode")
                .and_then(Value::as_str)
                .or_else(|| v.get("pairingCode").and_then(Value::as_str))
                .map(str::to_string);
            match code {
                Some(_) => (code, None),
                // Enable succeeded but the server minted no code — say so, don't show OFF.
                None => (None, Some("aucun code d'appairage renvoyé".to_string())),
            }
        }
        Err(e) => (None, Some(format!("code d'appairage indisponible : {e}"))),
    };
    RemoteControlState {
        status,
        pairing_code,
        error,
        ..RemoteControlState::default()
    }
}

/// Disable Codex remote control (`remoteControl/disable`). A failure surfaces as `error`.
async fn codex_remote_disable(server: &CodexServer) -> RemoteControlState {
    match server.request("remoteControl/disable", json!({})).await {
        Ok(_) => RemoteControlState {
            status: "disconnected".into(),
            ..RemoteControlState::default()
        },
        Err(e) => RemoteControlState {
            status: "error".into(),
            error: Some(e.to_string()),
            ..RemoteControlState::default()
        },
    }
}

/// Map a Codex `RemoteControlConnectionStatus` (`disabled`|`connecting`|`connected`|
/// `errored`) to the shared front status (`disconnected`|`connecting`|`connected`|`error`).
fn codex_remote_status(v: &Value) -> String {
    match v.get("status").and_then(Value::as_str) {
        Some("connected") => "connected",
        Some("connecting") => "connecting",
        Some("errored") => "error",
        _ => "disconnected",
    }
    .to_string()
}

/// Query the live MCP server status for a Codex conversation (`mcpServerStatus/list`,
/// thread-scoped) and map each entry to the shared [`McpServerLive`] the conversation-lens
/// Extensions view renders. An RPC rejection is surfaced as `Err` (never a fake empty —
/// distinct from a genuinely server-less conversation, `Ok(vec![])`).
async fn fetch_mcp_status(
    server: &CodexServer,
    thread_id: &str,
) -> Result<Vec<McpServerLive>, String> {
    let params = json!({ "threadId": thread_id, "detail": "toolsAndAuthOnly" });
    let value = server
        .request("mcpServerStatus/list", params)
        .await
        .map_err(|e| e.to_string())?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(data.iter().map(mcp_server_live).collect())
}

/// Map one `mcpServerStatus/list` entry to a [`McpServerLive`] row. Codex's list has no
/// top-level status field, so status is INFERRED: a not-logged-in auth status → needs-auth,
/// a present `serverInfo` (the server answered `initialize`) → connected, else disconnected.
/// Codex MCP servers are user-global (`~/.codex/config.toml`), hence scope `user`; the
/// launch command/url live in the config, not this live entry, so they stay `None` here.
fn mcp_server_live(v: &Value) -> McpServerLive {
    let name = v.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let auth = v.get("authStatus").and_then(Value::as_str);
    let has_info = v.get("serverInfo").map(|s| !s.is_null()).unwrap_or(false);
    let tools: Vec<String> = v
        .get("tools")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let status = if auth == Some("notLoggedIn") {
        "needs-auth"
    } else if has_info {
        "connected"
    } else {
        "disconnected"
    };
    McpServerLive {
        name,
        status: status.to_string(),
        scope: Some("user".to_string()),
        transport: None,
        command: None,
        url: None,
        tool_count: tools.len() as u32,
        tools,
    }
}

/// Map a Codex `RateLimitSnapshot` to the shared [`crate::usage::PlanUsage`] the forfait
/// popover renders. The two windows are told apart by `windowDurationMins` (300 → 5h,
/// 10080 → weekly); a window with any other/absent duration is skipped rather than
/// mislabeled. `None` when neither window is usable (the actor then emits nothing).
fn rate_limits_to_plan_usage(snap: &RateLimitSnapshot) -> Option<crate::usage::PlanUsage> {
    let mut five_hour = None;
    let mut seven_day = None;
    for w in [snap.primary.as_ref(), snap.secondary.as_ref()]
        .into_iter()
        .flatten()
    {
        match w.window_duration_mins {
            Some(300) => five_hour = Some(rate_limit_window(w)),
            Some(10080) => seven_day = Some(rate_limit_window(w)),
            _ => {}
        }
    }
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(crate::usage::PlanUsage {
        five_hour,
        seven_day,
    })
}

/// One Codex rate-limit window → the shared UI window shape. `usedPercent` is already
/// 0–100 (used verbatim, the UI clamps). `resetsAt` is normalized to an epoch-SECONDS
/// digit string — the exact form the front's `resetToEpochSeconds` reads (it treats a
/// digits-only value as seconds), so the unit can never be misread.
fn rate_limit_window(w: &RateLimitWindow) -> crate::usage::UsageWindow {
    crate::usage::UsageWindow {
        used_percentage: w.used_percent,
        resets_at: w.resets_at.map(epoch_to_seconds_string),
    }
}

/// Normalize an epoch reset time to a Unix-SECONDS digit string. Codex may send seconds
/// or milliseconds; we disambiguate by magnitude (any plausible date is < 1e11 s but
/// > 1e11 ms), so a ms value is divided down. Matches the "epoch-seconds digits" shape
/// the front already parses.
fn epoch_to_seconds_string(n: f64) -> String {
    let secs = if n >= 1e11 {
        (n / 1000.0).round() as i64
    } else {
        n.round() as i64
    };
    secs.to_string()
}

/// Build the `turn/start` input blocks from a message: the text (if any) then one
/// `localImage` per joined image. Codex reads images from a file PATH (unlike Claude's
/// inline base64), so each attachment is materialized to a temp file. Guarantees at
/// least one block (an empty text) so an image-only turn still has valid input.
fn user_inputs(text: String, images: &[ImageAttachment]) -> Vec<UserInput> {
    let mut inputs = Vec::new();
    if !text.trim().is_empty() {
        inputs.push(UserInput::text(text));
    }
    for img in images {
        if let Some(path) = materialize_image(img) {
            inputs.push(UserInput::local_image(path));
        }
    }
    if inputs.is_empty() {
        inputs.push(UserInput::text(String::new()));
    }
    inputs
}

/// Write a base64 image attachment to a temp file and return its path, so it can be
/// referenced as a Codex `localImage`. `None` if the base64 is undecodable or the write
/// fails (the attachment is then simply dropped — never a failed turn). Files live under
/// a dedicated temp dir; the OS reaps them (they must outlive the turn the model reads).
fn materialize_image(img: &ImageAttachment) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(img.data.trim())
        .ok()?;
    let ext = match img.media_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    let dir = std::env::temp_dir().join("flightdeck-codex-attachments");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&path, &bytes).ok()?;
    Some(path.to_string_lossy().to_string())
}

/// Join a reasoning item's `summary` (human-facing) then `content` (raw chain, often
/// redacted/empty) into one Thinking blob, dropping empties.
fn join_reasoning(summary: &[String], content: &[String]) -> String {
    summary
        .iter()
        .chain(content.iter())
        .map(String::as_str)
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::model::{BackgroundTask, SlashCommand};
    use std::sync::Mutex;

    /// A synchronous sink that records everything the actor emits, for assertions.
    #[derive(Default)]
    struct Sink {
        items: Mutex<Vec<ConversationItem>>,
        perms: Mutex<Vec<PermissionRequestPayload>>,
        states: Mutex<Vec<SessionStatePayload>>,
        plan_usages: Mutex<Vec<crate::usage::PlanUsage>>,
    }
    impl SessionEmitter for Sink {
        fn emit_state(&self, _s: &str, state: &SessionStatePayload) {
            self.states.lock().unwrap().push(state.clone());
        }
        fn emit_item(&self, _s: &str, item: &ConversationItem) {
            self.items.lock().unwrap().push(item.clone());
        }
        fn emit_permission(&self, _s: &str, r: &PermissionRequestPayload) {
            self.perms.lock().unwrap().push(r.clone());
        }
        fn emit_commands(&self, _s: &str, _c: &[SlashCommand]) {}
        fn emit_task(&self, _s: &str, _t: &BackgroundTask) {}
        fn emit_title(&self, _s: &str, _t: &str, _q: u32) {}
        fn emit_summary(&self, _s: &str, _t: &str, _q: u32) {}
        fn emit_remote_control(&self, _s: &str, _st: &RemoteControlState) {}
        fn emit_codex_plan_usage(&self, _s: &str, usage: &crate::usage::PlanUsage) {
            self.plan_usages.lock().unwrap().push(usage.clone());
        }
    }

    fn core() -> (CodexCore, Arc<Sink>) {
        let sink = Arc::new(Sink::default());
        let emitter: Arc<dyn SessionEmitter> = sink.clone();
        (CodexCore::new("c".into(), emitter), sink)
    }

    fn items(sink: &Sink) -> Vec<ConversationItem> {
        sink.items.lock().unwrap().clone()
    }

    /// Does any emitted item carry a ToolUse block with this name + id?
    fn has_tool_use(items: &[ConversationItem], name: &str, id: &str) -> bool {
        items.iter().any(|i| {
            matches!(i, ConversationItem::AssistantMessage { blocks, .. }
                if blocks.iter().any(|b| matches!(b, NormalizedBlock::ToolUse { name: n, id: i, .. } if n == name && i == id)))
        })
    }
    fn tool_result<'a>(items: &'a [ConversationItem], id: &str) -> Option<&'a ConversationItem> {
        items
            .iter()
            .find(|i| matches!(i, ConversationItem::ToolResult { tool_use_id, .. } if tool_use_id == id))
    }

    #[test]
    fn codex_title_truncates_to_a_few_words_from_the_first_line() {
        // Multi-message intent (joined with newlines): the title comes from the FIRST line.
        let t = codex_title_from_description("ajoute un bouton de export\nfais aussi les tests");
        assert_eq!(t.as_deref(), Some("ajoute un bouton de export"));
    }

    #[test]
    fn codex_title_drops_a_leading_slash_command() {
        assert_eq!(
            codex_title_from_description("/pickup refonte de la page login").as_deref(),
            Some("refonte de la page login"),
        );
        // A bare slash-command with nothing after it keeps the token (better than nothing).
        assert_eq!(codex_title_from_description("/done").as_deref(), Some("/done"));
    }

    #[test]
    fn codex_title_caps_length_and_trims_trailing_punctuation() {
        let long = "un deux trois quatre cinq six sept huit neuf dix onze douze";
        let t = codex_title_from_description(long).unwrap();
        assert!(t.chars().count() <= 48, "title too long: {t:?}");
        assert!(long.starts_with(&t));
        // Trailing punctuation is stripped.
        assert_eq!(codex_title_from_description("corrige le bug !").as_deref(), Some("corrige le bug"));
    }

    #[test]
    fn codex_title_is_none_for_blank_input() {
        assert_eq!(codex_title_from_description(""), None);
        assert_eq!(codex_title_from_description("   \n  \n"), None);
    }

    #[test]
    fn user_inputs_builds_text_then_images_and_never_empty() {
        // Plain text → a single text block.
        let inputs = user_inputs("hello".into(), &[]);
        let v = serde_json::to_value(&inputs).unwrap();
        assert_eq!(v, serde_json::json!([{"type":"text","text":"hello"}]));
        // Empty text, no image → still one (empty) text block so the turn has valid input.
        let inputs = user_inputs("   ".into(), &[]);
        assert_eq!(inputs.len(), 1);
        // A real image materializes to a localImage pointing at a temp file on disk.
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, 0x50, 0x4e, 0x47]);
        let img = ImageAttachment { media_type: "image/png".into(), data: png };
        let inputs = user_inputs("look".into(), std::slice::from_ref(&img));
        let v = serde_json::to_value(&inputs).unwrap();
        assert_eq!(v[0]["type"], "text");
        assert_eq!(v[1]["type"], "localImage");
        let path = v[1]["path"].as_str().unwrap();
        assert!(std::path::Path::new(path).is_file(), "the image must be written to disk");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn codex_model_passes_codex_ids_and_drops_claude_aliases() {
        let mut cfg = SpawnConfig::new(std::env::temp_dir());
        // A real Codex id (what the front seeds a Codex conversation with) passes through.
        cfg.model = Some("gpt-5.5".into());
        assert_eq!(codex_model(&cfg).as_deref(), Some("gpt-5.5"));
        // A Claude alias / resolved id would be rejected by Codex → fall back to default.
        for alias in ["opus", "sonnet", "haiku", "fable", "claude-opus-4-8"] {
            cfg.model = Some(alias.into());
            assert_eq!(codex_model(&cfg), None, "claude alias {alias} must yield None");
        }
        // Blank / unset → None (server default).
        cfg.model = Some("   ".into());
        assert_eq!(codex_model(&cfg), None);
        cfg.model = None;
        assert_eq!(codex_model(&cfg), None);
    }

    #[test]
    fn agent_message_streams_then_finalizes_as_text() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/agentMessage/delta",
            json!({"threadId":"t","turnId":"u","itemId":"m1","delta":"Hel"}),
        );
        c.on_notification(
            "item/agentMessage/delta",
            json!({"threadId":"t","turnId":"u","itemId":"m1","delta":"lo"}),
        );
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"agentMessage","id":"m1","text":"Hello"},"threadId":"t","turnId":"u","completedAtMs":0}),
        );
        let items = items(&sink);
        // One MessageStarted (only on the first delta), two TextDeltas, one authoritative message.
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::MessageStarted { .. })).count(),
            1
        );
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::TextDelta { .. })).count(),
            2
        );
        assert!(items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { id, blocks, .. }
            if id == "m1" && matches!(blocks.as_slice(), [NormalizedBlock::Text { text }] if text == "Hello"))));
    }

    #[test]
    fn reasoning_maps_to_thinking_never_text() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/reasoning/textDelta",
            json!({"threadId":"t","turnId":"u","itemId":"r1","delta":"think","contentIndex":0}),
        );
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"reasoning","id":"r1","summary":["planning the fix"],"content":[]}}),
        );
        let items = items(&sink);
        // The streamed token is a ThinkingDelta, and the final block is Thinking — NEVER Text
        // (a Text block would leak the raw reasoning into the visible answer).
        assert!(items.iter().any(|i| matches!(i, ConversationItem::ThinkingDelta { .. })));
        assert!(items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if matches!(blocks.as_slice(), [NormalizedBlock::Thinking { text }] if text == "planning the fix"))));
        assert!(!items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::Text { .. })))));
        assert!(!items.iter().any(|i| matches!(i, ConversationItem::TextDelta { .. })));
    }

    #[test]
    fn command_synthesizes_tool_use_result_pair() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"ls -la","cwd":"/tmp","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"commandExecution","id":"c1","command":"ls -la","cwd":"/tmp","aggregatedOutput":"a\nb","exitCode":0,"status":"completed"}}),
        );
        let items = items(&sink);
        // A Bash tool card keyed by item.id, then a ToolResult with the same id — the pair
        // that lets clean-output fold. The card is emitted ONCE (only on start).
        assert!(has_tool_use(&items, "Bash", "c1"));
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::AssistantMessage { id, .. } if id == "c1")).count(),
            1,
            "the ToolUse card must not be duplicated on completion"
        );
        match tool_result(&items, "c1") {
            Some(ConversationItem::ToolResult { is_error, content, .. }) => {
                assert!(!is_error);
                assert_eq!(content, &json!("a\nb"));
            }
            _ => panic!("expected a ToolResult for c1"),
        }
    }

    #[test]
    fn command_nonzero_exit_is_an_error() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"commandExecution","id":"c9","command":"false","exitCode":1,"status":"completed"}}),
        );
        let items = items(&sink);
        // Even with no item/started, the pair is synthesized (dropped-start robustness).
        assert!(has_tool_use(&items, "Bash", "c9"));
        assert!(matches!(tool_result(&items, "c9"), Some(ConversationItem::ToolResult { is_error: true, .. })));
    }

    #[test]
    fn file_change_maps_to_apply_patch_with_diffs() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"fileChange","id":"f1","status":"completed","changes":[{"path":"src/a.rs","kind":"modify","diff":"@@ -1 +1 @@"}]}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "ApplyPatch", "f1"));
        // The diffs are on the result too, so they're visible regardless of the started item.
        match tool_result(&items, "f1") {
            Some(ConversationItem::ToolResult { content, is_error, .. }) => {
                assert!(!is_error);
                assert!(content.to_string().contains("src/a.rs"));
            }
            _ => panic!("expected a ToolResult for f1"),
        }
    }

    #[test]
    fn mcp_tool_call_maps_to_namespaced_tool() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"mcpToolCall","id":"x1","server":"tosse","tool":"get_tasks","status":"completed","arguments":{"a":1},"result":{"ok":true}}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "mcp__tosse__get_tasks", "x1"));
        assert!(matches!(tool_result(&items, "x1"), Some(ConversationItem::ToolResult { is_error: false, .. })));
    }

    #[test]
    fn stale_turn_completed_does_not_settle_the_live_turn() {
        let (mut c, _sink) = core();
        c.current_turn_id = Some("T_new".into());
        c.state.busy = true;
        // A late completion for a DIFFERENT (already-superseded) turn — as produced by
        // the steer-race fallthrough — must NOT clear the live turn's busy/id.
        c.on_notification(
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"T_old","status":"completed"}}),
        );
        assert!(c.state.busy, "a stale completion must not clear the live turn's busy");
        assert_eq!(c.current_turn_id.as_deref(), Some("T_new"), "live turn id preserved");
        // The live turn's own completion settles it.
        c.on_notification(
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"T_new","status":"completed"}}),
        );
        assert!(!c.state.busy, "the current turn's completion settles busy");
        assert!(c.current_turn_id.is_none(), "current turn id cleared on its own completion");
    }

    #[test]
    fn turn_completed_closes_dangling_tools_and_clears_busy() {
        let (mut c, sink) = core();
        c.state.busy = true;
        // A command that started but never completes (interrupted).
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"sleep 99","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification("turn/completed", json!({"threadId":"t","turn":{"id":"u","status":"interrupted"}}));
        let items = items(&sink);
        // The open card is closed with an error result so the round can fold.
        assert!(matches!(tool_result(&items, "c1"), Some(ConversationItem::ToolResult { is_error: true, .. })));
        assert!(items.iter().any(|i| matches!(i, ConversationItem::TurnResult { .. })));
        assert!(!c.state.busy, "busy must clear on turn/completed");
    }

    #[test]
    fn busy_clears_even_on_undecodable_turn_payload() {
        let (mut c, _sink) = core();
        c.state.busy = true;
        // A turn payload that fails to decode must STILL clear busy (invariant #7).
        c.on_notification("turn/completed", json!({"turn": 12345}));
        assert!(!c.state.busy);
    }

    #[test]
    fn approval_request_surfaces_a_permission_and_tracks_pending() {
        let (mut c, sink) = core();
        c.on_incoming(Incoming::ServerRequest {
            id: "req-7".into(),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"threadId":"t","turnId":"u","itemId":"c1","command":"rm -rf x","cwd":"/tmp","reason":"cleanup"}),
        });
        let perms = sink.perms.lock().unwrap().clone();
        assert_eq!(perms.len(), 1);
        let p = &perms[0];
        assert_eq!(p.request_id, "req-7");
        assert_eq!(p.tool_name, "Bash");
        assert_eq!(p.tool_use_id, "c1"); // ties the prompt to the already-rendered card
        assert_eq!(p.input["command"], json!("rm -rf x"));
        assert!(c.pending_approvals.contains("req-7"));
        assert!(c.state.awaiting_permission);
    }

    /// Replay a REAL captured turn (reasoning + a shell command + a file creation) through
    /// the actor and assert it renders. Guards against wire drift AND regressions like the
    /// `fileChange.kind` object-vs-string trap (a plain-string `kind` would drop the card).
    /// Refresh via the ignored `capture_live_turn_to_fixture` after a `codex` upgrade.
    #[test]
    fn replay_captured_turn_renders_text_command_and_file() {
        let fixture = include_str!("../fixtures/capture_codex_turn.jsonl");
        let (mut c, sink) = core();
        for line in fixture.lines().filter(|l| !l.trim().is_empty()) {
            let v: Value = serde_json::from_str(line).expect("fixture line is JSON");
            if let Some(method) = v.get("method").and_then(Value::as_str) {
                c.on_notification(method, v.get("params").cloned().unwrap_or(Value::Null));
            }
            // `serverRequest` lines (approvals) aren't part of the rendering replay.
        }
        let items = items(&sink);
        let has_text = items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::Text { .. }))));
        let has_bash = items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::ToolUse { name, .. } if name == "Bash"))));
        let has_patch = items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::ToolUse { name, .. } if name == "ApplyPatch"))));
        let results = items.iter().filter(|i| matches!(i, ConversationItem::ToolResult { .. })).count();
        assert!(has_text, "the assistant's answer must render as Text");
        assert!(has_bash, "the shell command must render as a Bash card");
        assert!(has_patch, "the file creation must render as an ApplyPatch card (kind-object decode)");
        assert!(results >= 2, "each tool card must be closed by a ToolResult (got {results})");
        assert!(items.iter().any(|i| matches!(i, ConversationItem::TurnResult { is_error: false, .. })));
        assert!(!c.state.busy, "the turn settled → busy cleared");
    }

    #[test]
    fn terminal_error_closes_open_tool_cards() {
        // A terminal `error` (not will_retry) may arrive WITHOUT a following turn/completed;
        // it must still close any open card, or clean-output shows it "running" forever (M2).
        let (mut c, sink) = core();
        c.state.busy = true;
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"x","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification("error", json!({"message":"boom","willRetry":false}));
        let items = items(&sink);
        assert!(matches!(tool_result(&items, "c1"), Some(ConversationItem::ToolResult { is_error: true, .. })));
        assert!(!c.state.busy);
    }

    #[test]
    fn transient_error_keeps_the_turn_and_its_cards() {
        // A retryable error must NOT close cards or clear busy (the turn continues).
        let (mut c, sink) = core();
        c.state.busy = true;
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"x","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification("error", json!({"message":"retrying","willRetry":true}));
        assert!(c.state.busy, "a retryable error keeps the turn busy");
        assert!(tool_result(&items(&sink), "c1").is_none(), "the open card stays open");
    }

    #[test]
    fn undecodable_error_payload_still_surfaces_and_settles() {
        // ⚠️ Silent-error guard: an `error` notification whose payload is NOT an object (a bare
        // string / array / null) must STILL emit a protocol_error notice AND settle the turn —
        // otherwise it is dropped and the turn renders "running" forever with nothing shown.
        let (mut c, sink) = core();
        c.state.busy = true;
        c.current_turn_id = Some("u".into());
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"x","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification("error", json!("boom, not an object"));
        assert!(!c.state.busy, "an undecodable error must still clear busy");
        assert!(c.current_turn_id.is_none(), "an undecodable error must reset the turn id");
        let items = items(&sink);
        assert!(
            items.iter().any(|i| matches!(i, ConversationItem::Notice { subtype, .. } if subtype == "protocol_error")),
            "an undecodable error must still surface a protocol_error notice"
        );
        assert!(
            matches!(tool_result(&items, "c1"), Some(ConversationItem::ToolResult { is_error: true, .. })),
            "an undecodable error must still close the open tool card"
        );
    }

    #[test]
    fn duplicate_item_completed_does_not_double_the_card_or_result() {
        // A duplicate/late item/completed for the same id must be a no-op (idempotent on
        // `carded` for the card, on `open_tools` for the result) — m3.
        let (mut c, sink) = core();
        let done = json!({"item":{"type":"commandExecution","id":"c1","command":"ls","aggregatedOutput":"o","exitCode":0,"status":"completed"}});
        c.on_notification("item/completed", done.clone());
        c.on_notification("item/completed", done);
        let items = items(&sink);
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::AssistantMessage { id, .. } if id == "c1")).count(),
            1,
            "exactly one Bash card despite the duplicate completion"
        );
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::ToolResult { tool_use_id, .. } if tool_use_id == "c1")).count(),
            1,
            "exactly one ToolResult despite the duplicate completion"
        );
    }

    #[test]
    fn codex_remote_status_maps_to_shared_vocabulary() {
        assert_eq!(codex_remote_status(&json!({"status":"connected"})), "connected");
        assert_eq!(codex_remote_status(&json!({"status":"connecting"})), "connecting");
        assert_eq!(codex_remote_status(&json!({"status":"errored"})), "error");
        assert_eq!(codex_remote_status(&json!({"status":"disabled"})), "disconnected");
        // Unknown / missing → disconnected (safe default, never a fake "connected").
        assert_eq!(codex_remote_status(&json!({"status":"weird"})), "disconnected");
        assert_eq!(codex_remote_status(&json!({})), "disconnected");
    }

    #[test]
    fn mcp_server_live_infers_status_and_counts_tools() {
        // A connected server: serverInfo present, two tools, auth ok → connected + tools.
        let connected = mcp_server_live(&json!({
            "name":"tosse","authStatus":"oAuth","serverInfo":{"name":"tosse"},
            "tools":{"get_tasks":{},"create_task":{}}
        }));
        assert_eq!(connected.status, "connected");
        assert_eq!(connected.tool_count, 2);
        assert_eq!(connected.scope.as_deref(), Some("user"));
        assert!(connected.tools.contains(&"get_tasks".to_string()));
        // Not logged in → needs-auth (takes precedence over serverInfo).
        let unauth = mcp_server_live(&json!({"name":"x","authStatus":"notLoggedIn","serverInfo":{"name":"x"}}));
        assert_eq!(unauth.status, "needs-auth");
        // No serverInfo → disconnected.
        let down = mcp_server_live(&json!({"name":"y","authStatus":"unsupported","serverInfo":null}));
        assert_eq!(down.status, "disconnected");
        assert_eq!(down.tool_count, 0);
    }

    #[test]
    fn rate_limits_push_emits_normalized_plan_usage() {
        let (mut c, sink) = core();
        // A full snapshot: primary = 5h window (300 min), secondary = weekly (10080).
        c.on_notification(
            "account/rateLimits/updated",
            json!({"rateLimits":{
                "primary":{"usedPercent":29.0,"windowDurationMins":300,"resetsAt":1750000000},
                "secondary":{"usedPercent":27.0,"windowDurationMins":10080,"resetsAt":1750500000}
            }}),
        );
        let usages = sink.plan_usages.lock().unwrap().clone();
        assert_eq!(usages.len(), 1, "one plan-usage emitted");
        let u = &usages[0];
        let fh = u.five_hour.as_ref().expect("five_hour from the 300-min window");
        assert_eq!(fh.used_percentage, 29.0);
        assert_eq!(fh.resets_at.as_deref(), Some("1750000000"));
        let sd = u.seven_day.as_ref().expect("seven_day from the 10080-min window");
        assert_eq!(sd.used_percentage, 27.0);
        assert_eq!(sd.resets_at.as_deref(), Some("1750500000"));
    }

    #[test]
    fn rate_limits_map_windows_by_duration_and_normalize_ms_resets() {
        // Windows are told apart by windowDurationMins, not slot order: even if the
        // 5h window is `secondary`, it lands in five_hour. A millisecond reset is
        // normalized to seconds (magnitude heuristic).
        let snap: RateLimitSnapshot = serde_json::from_value(json!({
            "secondary":{"usedPercent":50.0,"windowDurationMins":300,"resetsAt":1750000000000i64},
            "primary":{"usedPercent":10.0,"windowDurationMins":10080,"resetsAt":1750500000i64}
        }))
        .unwrap();
        let u = rate_limits_to_plan_usage(&snap).expect("a usable snapshot");
        // The 300-min window (in `secondary`) → five_hour, its ms reset → seconds.
        assert_eq!(u.five_hour.as_ref().unwrap().used_percentage, 50.0);
        assert_eq!(u.five_hour.as_ref().unwrap().resets_at.as_deref(), Some("1750000000"));
        assert_eq!(u.seven_day.as_ref().unwrap().used_percentage, 10.0);
        // An unknown-duration window is skipped (never mislabeled) → None overall.
        let unknown: RateLimitSnapshot =
            serde_json::from_value(json!({"primary":{"usedPercent":5.0,"windowDurationMins":42}})).unwrap();
        assert!(rate_limits_to_plan_usage(&unknown).is_none());
        // An empty snapshot yields no usage (no spurious empty forfait).
        assert!(rate_limits_to_plan_usage(&RateLimitSnapshot::default()).is_none());
    }

    #[test]
    fn distinct_items_get_distinct_bubbles() {
        // Reasoning (r1) then the answer (m1): two ids → two turns, thinking then text.
        let (mut c, sink) = core();
        c.on_notification("item/completed", json!({"item":{"type":"reasoning","id":"r1","summary":["s"],"content":[]}}));
        c.on_notification("item/completed", json!({"item":{"type":"agentMessage","id":"m1","text":"done"}}));
        let ids: Vec<String> = items(&sink)
            .into_iter()
            .filter_map(|i| match i {
                ConversationItem::AssistantMessage { id, .. } => Some(id),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["r1", "m1"]);
    }
}
