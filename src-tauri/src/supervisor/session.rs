//! Session — the actor that ties a [`Transport`] together with the control
//! channel, the [`Assembler`], and an event sink (subtask 2 + 3).
//!
//! It runs as a single-task actor: one `tokio::select!` loop owns all per-session
//! state (no shared locks), processing two inputs:
//!   - inbound [`CliMessage`]s from the transport, and
//!   - [`SessionCommand`]s from the UI (via [`SessionHandle`]).
//!
//! The protocol logic lives in [`SessionCore`], which writes outbound lines to a
//! plain channel rather than directly to the process. That decoupling makes the
//! whole control round-trip (a `can_use_tool` prompt → our `control_response`)
//! unit-testable with no live `claude` process — see the tests below.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use super::assembler::Assembler;
use super::control::{self, InboundControl, PermissionDecision, PermissionMode};
use super::model::{ConversationItem, PermissionRequestPayload, SessionEmitter, SessionEvent};
use super::protocol::CliMessage;
use super::transport::{self, SpawnConfig, Transport, TransportError};

/// A command sent from the UI to a running session.
pub enum SessionCommand {
    SendUserText(String),
    AnswerPermission {
        request_id: String,
        decision: PermissionDecision,
    },
    SetPermissionMode(PermissionMode),
    SetModel(String),
    /// Set a plain reasoning-effort level (low/medium/high/xhigh). Also clears the
    /// ultracode flag — selecting a plain level always turns ultracode off.
    SetEffortLevel(String),
    /// Enable "ultracode" (xhigh effort + standing dynamic-workflow orchestration).
    /// Disabling is done by selecting a plain [`SessionCommand::SetEffortLevel`].
    EnableUltracode,
    Interrupt,
    Shutdown,
}

/// The controls a session starts with, threaded from the spawn config so the core
/// can (1) seed its live state immediately (the UI shows the right values before
/// the first `get_settings` round-trip) and (2) restore ultracode after init (the
/// `--effort` flag sets the effort LEVEL but not the separate ultracode flag).
#[derive(Debug, Clone, Default)]
pub struct InitialControls {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub ultracode: bool,
}

/// What an outbound control_request was, so its ack can be routed (spec §4.1). We
/// correlate by `request_id` and act on the response — never fire-and-forget — so a
/// CLI rejection surfaces instead of silently failing.
#[derive(Debug, Clone, Copy)]
enum PendingControl {
    GetSettings,
    SetPermissionMode,
    SetModel,
    SetEffort,
    SetUltracode,
    Interrupt,
}

impl PendingControl {
    /// Human label for a surfaced control error.
    fn label(self) -> &'static str {
        match self {
            PendingControl::GetSettings => "lecture des réglages",
            PendingControl::SetPermissionMode => "mode de permission",
            PendingControl::SetModel => "modèle",
            PendingControl::SetEffort => "effort",
            PendingControl::SetUltracode => "ultracode",
            PendingControl::Interrupt => "interruption",
        }
    }
}

/// Errors from driving a session through its handle.
#[derive(Debug)]
pub enum SessionError {
    Spawn(TransportError),
    /// The session task is gone (process exited or shut down).
    Closed,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Delegate to the transport error, which already carries a
            // human-readable, actionable message surfaced in the UI.
            SessionError::Spawn(e) => write!(f, "{e}"),
            SessionError::Closed => write!(f, "session is closed"),
        }
    }
}

impl std::error::Error for SessionError {}

/// A cloneable handle to a running session. Commands are delivered to the actor
/// over a bounded channel.
#[derive(Clone)]
pub struct SessionHandle {
    pub id: String,
    cmd_tx: mpsc::Sender<SessionCommand>,
}

impl SessionHandle {
    pub async fn send_user_text(&self, text: impl Into<String>) -> Result<(), SessionError> {
        self.send(SessionCommand::SendUserText(text.into())).await
    }

    pub async fn answer_permission(
        &self,
        request_id: String,
        decision: PermissionDecision,
    ) -> Result<(), SessionError> {
        self.send(SessionCommand::AnswerPermission { request_id, decision })
            .await
    }

    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), SessionError> {
        self.send(SessionCommand::SetPermissionMode(mode)).await
    }

    pub async fn set_model(&self, model: String) -> Result<(), SessionError> {
        self.send(SessionCommand::SetModel(model)).await
    }

    pub async fn set_effort_level(&self, level: String) -> Result<(), SessionError> {
        self.send(SessionCommand::SetEffortLevel(level)).await
    }

    pub async fn enable_ultracode(&self) -> Result<(), SessionError> {
        self.send(SessionCommand::EnableUltracode).await
    }

    pub async fn interrupt(&self) -> Result<(), SessionError> {
        self.send(SessionCommand::Interrupt).await
    }

    pub async fn shutdown(&self) -> Result<(), SessionError> {
        self.send(SessionCommand::Shutdown).await
    }

    async fn send(&self, cmd: SessionCommand) -> Result<(), SessionError> {
        self.cmd_tx.send(cmd).await.map_err(|_| SessionError::Closed)
    }
}

/// Spawn a `claude` session: starts the transport and the actor task, returns a
/// handle to drive it. Events are delivered through `emitter`.
///
/// `on_exit` runs once after the session has fully torn down (process gone),
/// whatever the cause (explicit stop, the process exiting on its own, or the
/// command channel closing). The IPC layer uses it to evict the dead session
/// from its registry so entries never leak.
pub fn spawn_session(
    id: String,
    cfg: SpawnConfig,
    initial: InitialControls,
    emitter: Arc<dyn SessionEmitter>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
) -> Result<SessionHandle, SessionError> {
    let (transport, msg_rx) = Transport::spawn(cfg).map_err(SessionError::Spawn)?;
    let core = SessionCore::new(id.clone(), initial, emitter, transport.outbound());
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    tokio::spawn(run_actor(core, transport, msg_rx, cmd_rx, on_exit));
    Ok(SessionHandle { id, cmd_tx })
}

/// The actor loop: drive [`SessionCore`] from the transport stream and the
/// command channel, then tear the process down and announce the exit.
async fn run_actor(
    mut core: SessionCore,
    mut transport: Transport,
    mut msg_rx: mpsc::UnboundedReceiver<CliMessage>,
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
) {
    core.initialize();
    loop {
        tokio::select! {
            maybe_msg = msg_rx.recv() => match maybe_msg {
                Some(msg) => core.on_message(msg),
                None => break, // transport closed: the process exited
            },
            maybe_cmd = cmd_rx.recv() => match maybe_cmd {
                Some(SessionCommand::Shutdown) | None => break,
                Some(cmd) => core.on_command(cmd),
            },
        }
    }
    // Announce the end so the UI stops showing a live session.
    core.emit_ended();
    // Drop the core (and its outbound sender clone) so the writer's channel can
    // close and stdin can EOF, then run the graceful teardown ladder.
    drop(core);
    transport.shutdown().await;
    // Let the owner (e.g. the IPC registry) evict this dead session.
    on_exit();
}

/// A `can_use_tool` request we have surfaced and are waiting to answer.
struct PendingPermission {
    tool_use_id: String,
    input: Value,
}

/// Protocol logic for one session, decoupled from process I/O via `outbound`.
struct SessionCore {
    id: String,
    emitter: Arc<dyn SessionEmitter>,
    assembler: Assembler,
    /// Inbound permission prompts keyed by their `request_id`.
    pending: HashMap<String, PendingPermission>,
    /// Our OUTBOUND control requests awaiting their ack, keyed by `request_id`, so
    /// the response can be routed (read-back applied, surface an error). Distinct
    /// from `pending` (inbound permission prompts).
    pending_control: HashMap<String, PendingControl>,
    /// The `request_id` of our outbound `initialize` request, kept so we can pick
    /// its `control_response` out of the stream and harvest the slash commands.
    /// Cleared once consumed (the handshake happens once per session).
    init_request_id: Option<String>,
    /// Whether to restore the ultracode flag after init (the `--effort` spawn flag
    /// sets the effort level but not the separate ultracode flag).
    restore_ultracode: bool,
    next_req: u64,
    /// Outbound JSON lines (→ the process stdin in production, → a test channel
    /// in unit tests).
    outbound: mpsc::UnboundedSender<Value>,
}

impl SessionCore {
    fn new(
        id: String,
        initial: InitialControls,
        emitter: Arc<dyn SessionEmitter>,
        outbound: mpsc::UnboundedSender<Value>,
    ) -> Self {
        let mut assembler = Assembler::new();
        // Seed the live state with the spawn controls so the UI shows the right
        // values from t=0 — before system/init (model + permission) and the first
        // get_settings read-back (effort + ultracode) land.
        assembler.seed_controls(
            initial.model.clone(),
            initial.effort.clone(),
            initial.permission_mode.clone(),
            initial.ultracode,
        );
        Self {
            id,
            emitter,
            assembler,
            pending: HashMap::new(),
            pending_control: HashMap::new(),
            init_request_id: None,
            restore_ultracode: initial.ultracode,
            next_req: 0,
            outbound,
        }
    }

    fn send(&self, line: Value) {
        if self.outbound.send(line).is_err() {
            // The writer channel is closed — the process is gone but the actor
            // hasn't observed it yet. Log so a dropped line is diagnosable.
            eprintln!("[session {}] outbound channel closed; dropped a line", self.id);
        }
    }

    fn next_request_id(&mut self) -> String {
        self.next_req += 1;
        format!("tosse-{}", self.next_req)
    }

    /// Send an outbound control request and remember what it was, so its ack can be
    /// routed (read-back / error) instead of silently dropped. `make` builds the
    /// wire line from the allocated `request_id`.
    fn send_tracked(&mut self, kind: PendingControl, make: impl FnOnce(&str) -> Value) {
        let rid = self.next_request_id();
        let line = make(&rid);
        self.pending_control.insert(rid, kind);
        self.send(line);
    }

    /// Query the session's live applied settings (model/effort/ultracode). The ack
    /// is the authoritative read-back — the ONLY reliable source of the effort level
    /// (absent from system/init) and proof a change really landed.
    fn refresh_settings(&mut self) {
        self.send_tracked(PendingControl::GetSettings, control::get_settings_request);
    }

    /// Surface a control-request failure as a visible notice — never a silent error.
    fn emit_control_error(&self, kind: PendingControl, detail: &str) {
        self.emit(SessionEvent::Item(ConversationItem::Notice {
            subtype: "control_error".to_string(),
            detail: serde_json::json!({ "control": kind.label(), "message": detail }),
        }));
    }

    fn emit(&self, ev: SessionEvent) {
        match ev {
            SessionEvent::State(s) => self.emitter.emit_state(&self.id, &s),
            SessionEvent::Item(i) => self.emitter.emit_item(&self.id, &i),
            SessionEvent::Permission(p) => self.emitter.emit_permission(&self.id, &p),
            SessionEvent::Commands(c) => self.emitter.emit_commands(&self.id, &c),
        }
    }

    /// Initialize handshake at startup (spec §4.4). We do NOT block on it, but we
    /// remember its `request_id` so the matching `control_response` — which carries
    /// the session's slash commands — is harvested when it arrives. We then restore
    /// ultracode if needed and read the live settings back so the UI reflects the
    /// real spawn state (the effort level is absent from system/init).
    fn initialize(&mut self) {
        let rid = self.next_request_id();
        self.init_request_id = Some(rid.clone());
        self.send(control::initialize_request(&rid));
        // The `--effort` spawn flag set the effort LEVEL; if this conversation was
        // running ultracode, re-enable the separate flag (it has no spawn flag).
        if self.restore_ultracode {
            self.send_tracked(PendingControl::SetUltracode, |rid| {
                control::set_ultracode_request(rid, true)
            });
        }
        // Read the applied settings back so effort + ultracode (and the resolved
        // model id) reflect reality, not just the optimistic seed.
        self.refresh_settings();
    }

    /// Emit a terminal state event (the session has ended).
    fn emit_ended(&mut self) {
        let ev = self.assembler.set_ended();
        self.emit(ev);
    }

    fn on_message(&mut self, msg: CliMessage) {
        match msg {
            // Outbound control acks. The `initialize` ack carries the session's
            // slash commands; the rest are correlated by `request_id` so a
            // get_settings read-back is applied and any rejection is surfaced.
            CliMessage::ControlResponse(v) => self.on_control_response(v),
            CliMessage::ControlRequest(v) => self.on_control_request(v),
            CliMessage::ControlCancelRequest { request_id } => {
                if self.pending.remove(&request_id).is_some() {
                    let ev = self.assembler.set_awaiting_permission(false);
                    self.emit(ev);
                }
            }
            other => {
                for ev in self.assembler.ingest(&other) {
                    self.emit(ev);
                }
            }
        }
    }

    /// Handle an outbound-request acknowledgement (spec §4.1, keyed on the nested
    /// `response.request_id`). Three cases:
    ///   - the one-shot `initialize` ack → harvest the slash commands (spec §4.4);
    ///   - a tracked control request → apply its read-back / confirm, or surface a
    ///     rejection (never a silent failure);
    ///   - anything else → an unmatched ack we ignore.
    fn on_control_response(&mut self, v: Value) {
        let Some(resp) = control::parse_control_response(&v) else {
            return;
        };
        // The initialize handshake completes exactly once.
        if Some(resp.request_id.as_str()) == self.init_request_id.as_deref() {
            self.init_request_id = None;
            if let Some(commands) = control::parse_initialize_commands(&v) {
                self.emit(SessionEvent::Commands(commands));
            }
            return;
        }
        let Some(kind) = self.pending_control.remove(&resp.request_id) else {
            return; // an ack we did not track (or already consumed)
        };
        if !resp.ok {
            // A rejection (invalid model, unsupported mode/effort, …) must be
            // visible. Then re-read the truth so the indicator never lies.
            let detail = resp.error.as_deref().unwrap_or("requête de contrôle rejetée");
            self.emit_control_error(kind, detail);
            if !matches!(kind, PendingControl::GetSettings) {
                self.refresh_settings();
            }
            return;
        }
        match kind {
            // The authoritative read-back: model + effort + ultracode, live. Emits the
            // state PLUS a "control changed" notice for whatever actually moved.
            PendingControl::GetSettings => {
                if let Some(applied) = control::parse_get_settings_applied(&v) {
                    for ev in
                        self.assembler
                            .apply_settings(applied.model, applied.effort, applied.ultracode)
                    {
                        self.emit(ev);
                    }
                }
            }
            // The ack echoes the mode the CLI ACTUALLY applied (may differ from the
            // requested one, e.g. a downgrade) — trust it over the optimistic value,
            // and announce the confirmed transition.
            PendingControl::SetPermissionMode => {
                if let Some(mode) = control::parse_set_permission_mode_ack(&v) {
                    for ev in self.assembler.confirm_permission_mode(&mode) {
                        self.emit(ev);
                    }
                }
            }
            // The bare success of set_model / apply_flag_settings carries no payload;
            // the follow-up get_settings (queued right after) reports the truth.
            PendingControl::SetModel
            | PendingControl::SetEffort
            | PendingControl::SetUltracode
            | PendingControl::Interrupt => {}
        }
    }

    fn on_control_request(&mut self, v: Value) {
        let Some((request_id, parsed)) = control::parse_inbound_control(&v) else {
            eprintln!("[session {}] control_request without a usable request_id", self.id);
            return;
        };
        // A known-but-malformed (or otherwise un-typeable) request still gets an
        // error response — otherwise the CLI hangs waiting on us (e.g. a
        // can_use_tool with a missing field would never be answered).
        let body = match parsed {
            Ok(body) => body,
            Err(e) => {
                eprintln!("[session {}] malformed control_request: {e}", self.id);
                self.send(control::control_error_response(&request_id, "malformed control request"));
                return;
            }
        };
        match body {
            InboundControl::CanUseTool(req) => {
                // Dedupe re-delivery of an in-flight prompt.
                if self.pending.contains_key(&request_id) {
                    return;
                }
                let payload = PermissionRequestPayload {
                    request_id: request_id.clone(),
                    tool_name: req.tool_name,
                    tool_use_id: req.tool_use_id.clone(),
                    input: req.input.clone(),
                    title: req.title,
                    description: req.description,
                    suggestions: req.permission_suggestions,
                };
                self.pending.insert(
                    request_id,
                    PendingPermission {
                        tool_use_id: req.tool_use_id,
                        input: req.input,
                    },
                );
                let state_ev = self.assembler.set_awaiting_permission(true);
                self.emit(SessionEvent::Permission(payload));
                self.emit(state_ev);
            }
            // Hooks / MCP / dialogs are not supported yet. Reply with an error so
            // the CLI does not hang waiting on us (spec §4.1/§4.6).
            InboundControl::Unknown => {
                self.send(control::control_error_response(&request_id, "unsupported control request"));
            }
        }
    }

    fn on_command(&mut self, cmd: SessionCommand) {
        match cmd {
            SessionCommand::SendUserText(text) => {
                self.send(transport::user_message(text));
                let ev = self.assembler.set_busy(true);
                self.emit(ev);
            }
            SessionCommand::AnswerPermission { request_id, decision } => {
                match self.pending.remove(&request_id) {
                    Some(p) => {
                        let line = match decision {
                            PermissionDecision::Allow { updated_input } => control::permission_allow_response(
                                &request_id,
                                &p.tool_use_id,
                                updated_input.unwrap_or(p.input),
                            ),
                            PermissionDecision::Deny { message } => {
                                control::permission_deny_response(&request_id, &p.tool_use_id, &message)
                            }
                        };
                        self.send(line);
                        let ev = self.assembler.set_awaiting_permission(false);
                        self.emit(ev);
                    }
                    None => eprintln!(
                        "[session {}] answer for unknown permission request '{request_id}'",
                        self.id
                    ),
                }
            }
            SessionCommand::SetPermissionMode(mode) => {
                // Optimistic for snappy UX (the four reachable modes are never
                // downgraded); the ack then confirms the mode the CLI really applied.
                let mode_str = serde_json::to_value(mode)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default();
                let ev = self.assembler.set_permission_mode(&mode_str);
                self.emit(ev);
                self.send_tracked(PendingControl::SetPermissionMode, |rid| {
                    control::set_permission_mode_request(rid, mode)
                });
            }
            SessionCommand::SetModel(model) => {
                // Optimistic (the alias); the get_settings read-back replaces it with
                // the resolved id and confirms effort/ultracode under the new model.
                let ev = self.assembler.set_model(&model);
                self.emit(ev);
                self.send_tracked(PendingControl::SetModel, |rid| {
                    control::set_model_request(rid, &model)
                });
                self.refresh_settings();
            }
            SessionCommand::SetEffortLevel(level) => {
                // Selecting a plain level always clears ultracode first (mirrors the
                // extension), then sets the level. get_settings reads the truth back.
                self.send_tracked(PendingControl::SetUltracode, |rid| {
                    control::set_ultracode_request(rid, false)
                });
                self.send_tracked(PendingControl::SetEffort, |rid| {
                    control::set_effort_level_request(rid, &level)
                });
                // Optimistic (snappy chip) WITHOUT announcing — the timeline line is
                // emitted by the get_settings read-back below, i.e. the confirmed value.
                let ev = self.assembler.set_effort_optimistic(Some(level), false);
                self.emit(ev);
                self.refresh_settings();
            }
            SessionCommand::EnableUltracode => {
                // Ultracode = effortLevel xhigh + the separate ultracode flag, in
                // that order (the extension's sequence).
                self.send_tracked(PendingControl::SetEffort, |rid| {
                    control::set_effort_level_request(rid, "xhigh")
                });
                self.send_tracked(PendingControl::SetUltracode, |rid| {
                    control::set_ultracode_request(rid, true)
                });
                let ev = self
                    .assembler
                    .set_effort_optimistic(Some("xhigh".to_string()), true);
                self.emit(ev);
                self.refresh_settings();
            }
            SessionCommand::Interrupt => {
                self.send_tracked(PendingControl::Interrupt, control::interrupt_request);
            }
            // Shutdown is handled in the run loop (breaks before reaching here).
            SessionCommand::Shutdown => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::model::{ConversationItem, PermissionRequestPayload, SessionStatePayload};
    use serde_json::json;

    /// Test sink: forwards every event onto a channel for assertions.
    struct ChannelEmitter {
        tx: mpsc::UnboundedSender<SessionEvent>,
    }

    impl SessionEmitter for ChannelEmitter {
        fn emit_state(&self, _session: &str, state: &SessionStatePayload) {
            let _ = self.tx.send(SessionEvent::State(state.clone()));
        }
        fn emit_item(&self, _session: &str, item: &ConversationItem) {
            let _ = self.tx.send(SessionEvent::Item(item.clone()));
        }
        fn emit_permission(&self, _session: &str, request: &PermissionRequestPayload) {
            let _ = self.tx.send(SessionEvent::Permission(request.clone()));
        }
        fn emit_commands(&self, _session: &str, commands: &[crate::supervisor::model::SlashCommand]) {
            let _ = self.tx.send(SessionEvent::Commands(commands.to_vec()));
        }
    }

    /// Build a `SessionCore` wired to two inspectable channels (events, outbound).
    fn test_core() -> (
        SessionCore,
        mpsc::UnboundedReceiver<SessionEvent>,
        mpsc::UnboundedReceiver<Value>,
    ) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let core = SessionCore::new(
            "s".to_string(),
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            out_tx,
        );
        (core, event_rx, out_rx)
    }

    /// Find the first outbound control_request with the given subtype.
    fn find_req<'a>(lines: &'a [Value], subtype: &str) -> Option<&'a Value> {
        lines.iter().find(|l| l["request"]["subtype"] == json!(subtype))
    }

    fn drain<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> Vec<T> {
        let mut v = Vec::new();
        while let Ok(item) = rx.try_recv() {
            v.push(item);
        }
        v
    }

    fn can_use_tool(request_id: &str, tool: &str) -> CliMessage {
        serde_json::from_value(json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "can_use_tool",
                "tool_name": tool,
                "input": { "command": "echo hi" },
                "tool_use_id": "toolu_1"
            }
        }))
        .unwrap()
    }

    /// ACCEPTANCE (deterministic): an inbound `can_use_tool` surfaces a permission
    /// event, and answering DENY writes the correct doubly-nested control_response.
    #[test]
    fn permission_prompt_can_be_denied() {
        let (mut core, mut events, mut out) = test_core();

        core.on_message(can_use_tool("req-1", "Bash"));

        let perm = drain(&mut events)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Permission(p) => Some(p),
                _ => None,
            })
            .expect("a permission event should be emitted");
        assert_eq!(perm.request_id, "req-1");
        assert_eq!(perm.tool_name, "Bash");
        assert_eq!(perm.tool_use_id, "toolu_1");

        core.on_command(SessionCommand::AnswerPermission {
            request_id: "req-1".to_string(),
            decision: PermissionDecision::Deny { message: "no".to_string() },
        });

        let line = drain(&mut out)
            .into_iter()
            .find(|l| l["type"] == json!("control_response"))
            .expect("a control_response should be written");
        assert_eq!(line["response"]["subtype"], json!("success"));
        assert_eq!(line["response"]["request_id"], json!("req-1"));
        assert_eq!(line["response"]["response"]["behavior"], json!("deny"));
        assert_eq!(line["response"]["response"]["message"], json!("no"));
        assert_eq!(line["response"]["response"]["toolUseID"], json!("toolu_1"));
    }

    /// ACCEPTANCE (deterministic): answering ALLOW echoes the original tool input
    /// in `updatedInput` when no rewrite is supplied.
    #[test]
    fn permission_prompt_can_be_allowed_echoing_input() {
        let (mut core, _events, mut out) = test_core();

        core.on_message(can_use_tool("req-2", "Read"));
        core.on_command(SessionCommand::AnswerPermission {
            request_id: "req-2".to_string(),
            decision: PermissionDecision::Allow { updated_input: None },
        });

        let line = drain(&mut out)
            .into_iter()
            .find(|l| l["type"] == json!("control_response"))
            .expect("a control_response should be written");
        assert_eq!(line["response"]["response"]["behavior"], json!("allow"));
        assert_eq!(line["response"]["response"]["updatedInput"], json!({ "command": "echo hi" }));
        assert_eq!(line["response"]["response"]["toolUseID"], json!("toolu_1"));
    }

    #[test]
    fn answering_an_unknown_permission_is_a_no_op() {
        let (mut core, _events, mut out) = test_core();
        core.on_command(SessionCommand::AnswerPermission {
            request_id: "ghost".to_string(),
            decision: PermissionDecision::Deny { message: "x".to_string() },
        });
        assert!(drain(&mut out).is_empty(), "no control_response for an unknown request");
    }

    #[test]
    fn initialize_is_sent_first_then_reads_settings_back() {
        let (mut core, _events, mut out) = test_core();
        core.initialize();
        let lines = drain(&mut out);
        // initialize first, then a get_settings read-back (no ultracode to restore
        // with the default InitialControls).
        assert_eq!(lines[0]["type"], json!("control_request"));
        assert_eq!(lines[0]["request"]["subtype"], json!("initialize"));
        assert!(
            find_req(&lines, "get_settings").is_some(),
            "init should also read the live settings back"
        );
        assert!(
            find_req(&lines, "apply_flag_settings").is_none(),
            "no ultracode restore when it wasn't enabled"
        );
    }

    /// A get_settings ack updates the live state with the applied effort + ultracode
    /// (the model id is the resolved one) — the read-back source of truth.
    #[test]
    fn get_settings_ack_applies_live_settings() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::SetEffortLevel("high".to_string()));
        // The get_settings request id is whatever was allocated last; find it.
        let gid = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("get_settings"))
            .and_then(|l| l["request_id"].as_str().map(str::to_string))
            .expect("a get_settings request should be sent");
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": gid,
                    "response": { "applied": { "model": "claude-opus-4-8", "effort": "high", "ultracode": false } }
                }
            }))
            .unwrap(),
        );
        let last_state = drain(&mut events)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::State(s) => Some(s),
                _ => None,
            })
            .last()
            .expect("a state event");
        assert_eq!(last_state.effort.as_deref(), Some("high"));
        assert!(!last_state.ultracode);
        assert_eq!(last_state.model.as_deref(), Some("claude-opus-4-8"));
    }

    /// Selecting a plain effort level clears ultracode (off) then sets the level,
    /// then reads back — and the optimistic state reflects it immediately.
    #[test]
    fn set_effort_clears_ultracode_then_sets_level() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::SetEffortLevel("medium".to_string()));
        let lines = drain(&mut out);
        // ultracode:null (off) BEFORE the effortLevel, plus a get_settings read-back.
        let flags: Vec<_> = lines
            .iter()
            .filter(|l| l["request"]["subtype"] == json!("apply_flag_settings"))
            .collect();
        assert_eq!(flags[0]["request"]["settings"]["ultracode"], Value::Null);
        assert_eq!(flags[1]["request"]["settings"]["effortLevel"], json!("medium"));
        assert!(find_req(&lines, "get_settings").is_some());
        let s = drain(&mut events)
            .into_iter()
            .filter_map(|e| match e { SessionEvent::State(s) => Some(s), _ => None })
            .last()
            .unwrap();
        assert_eq!(s.effort.as_deref(), Some("medium"));
        assert!(!s.ultracode);
    }

    /// Enabling ultracode sends xhigh then ultracode:true (in that order).
    #[test]
    fn enable_ultracode_sends_xhigh_then_flag() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::EnableUltracode);
        let lines = drain(&mut out);
        let flags: Vec<_> = lines
            .iter()
            .filter(|l| l["request"]["subtype"] == json!("apply_flag_settings"))
            .collect();
        assert_eq!(flags[0]["request"]["settings"]["effortLevel"], json!("xhigh"));
        assert_eq!(flags[1]["request"]["settings"]["ultracode"], json!(true));
        let s = drain(&mut events)
            .into_iter()
            .filter_map(|e| match e { SessionEvent::State(s) => Some(s), _ => None })
            .last()
            .unwrap();
        assert_eq!(s.effort.as_deref(), Some("xhigh"));
        assert!(s.ultracode);
    }

    /// A rejected control request surfaces a `control_error` notice — never silent.
    #[test]
    fn rejected_control_surfaces_a_notice() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::SetModel("bogus".to_string()));
        let sm_id = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("set_model"))
            .and_then(|l| l["request_id"].as_str().map(str::to_string))
            .expect("a set_model request");
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": { "subtype": "error", "request_id": sm_id, "error": "unknown model" }
            }))
            .unwrap(),
        );
        let notice = drain(&mut events).into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::Notice { subtype, detail }) => Some((subtype, detail)),
            _ => None,
        });
        let (subtype, detail) = notice.expect("a control_error notice");
        assert_eq!(subtype, "control_error");
        assert_eq!(detail["message"], json!("unknown model"));
    }

    #[test]
    fn send_user_text_writes_a_user_message() {
        let (mut core, _events, mut out) = test_core();
        core.on_command(SessionCommand::SendUserText("hello".to_string()));
        let lines = drain(&mut out);
        assert_eq!(lines[0]["type"], json!("user"));
        assert_eq!(lines[0]["message"]["content"][0]["text"], json!("hello"));
    }

    /// ACCEPTANCE: the `initialize` control_response (matched by its echoed
    /// request_id) is harvested into a single `Commands` event, with the
    /// camelCase `argumentHint` wire key mapped to `argument_hint`.
    #[test]
    fn initialize_response_harvests_slash_commands() {
        let (mut core, mut events, _out) = test_core();
        core.initialize(); // sends "tosse-1" and remembers it

        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "tosse-1",
                    "response": {
                        "commands": [
                            { "name": "compact", "description": "Compact the conversation", "argumentHint": "" },
                            { "name": "tosse-workflow:pickup", "description": "Start a task", "argumentHint": "<task_id>" }
                        ],
                        "models": []
                    }
                }
            }))
            .unwrap(),
        );

        let cmds = drain(&mut events)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Commands(c) => Some(c),
                _ => None,
            })
            .expect("a Commands event should be emitted");
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].name, "compact");
        assert_eq!(cmds[1].name, "tosse-workflow:pickup");
        assert_eq!(cmds[1].argument_hint, "<task_id>");

        // A second matching response must NOT re-emit (handshake is one-shot).
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": "tosse-1",
                    "response": { "commands": [{ "name": "x", "description": "", "argumentHint": "" }] } }
            }))
            .unwrap(),
        );
        assert!(
            !drain(&mut events).iter().any(|e| matches!(e, SessionEvent::Commands(_))),
            "the initialize handshake should be consumed exactly once"
        );
    }

    /// LIVE end-to-end: spawn a real `claude`, run a tool to completion. In this
    /// environment the tool is auto-allowed by settings (so no prompt arrives) —
    /// we still validate the full pipeline: tool_result is delivered and the turn
    /// succeeds. If a permission prompt *does* arrive, we allow it (read/echo are
    /// harmless). The precise allow/deny response wiring is covered by the
    /// deterministic tests above.
    ///
    /// Ignored by default (needs the binary, network, auth, quota). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored live_session_runs_a_tool --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary (network + auth + quota)"]
    async fn live_session_runs_a_tool_end_to_end() {
        let (tx, mut rx) = mpsc::unbounded_channel::<SessionEvent>();
        let emitter = Arc::new(ChannelEmitter { tx });
        let cwd = std::env::current_dir().unwrap();
        let handle = spawn_session(
            "test".to_string(),
            SpawnConfig::new(cwd),
            InitialControls::default(),
            emitter,
            Box::new(|| {}),
        )
        .expect("session should spawn");

        handle
            .send_user_text("Use the Bash tool to run: echo tosse-probe. You MUST call the Bash tool.")
            .await
            .expect("send should queue");

        let mut saw_tool_result = false;
        let mut turn_ok = None;

        let drain_loop = async {
            while let Some(ev) = rx.recv().await {
                match ev {
                    SessionEvent::Permission(p) => {
                        handle
                            .answer_permission(p.request_id, PermissionDecision::Allow { updated_input: None })
                            .await
                            .expect("answer should queue");
                    }
                    SessionEvent::Item(ConversationItem::ToolResult { .. }) => saw_tool_result = true,
                    SessionEvent::Item(ConversationItem::TurnResult { is_error, .. }) => {
                        turn_ok = Some(!is_error);
                        break;
                    }
                    _ => {}
                }
            }
        };

        tokio::time::timeout(std::time::Duration::from_secs(120), drain_loop)
            .await
            .expect("turn should complete within the deadline");
        handle.shutdown().await.ok();

        assert!(saw_tool_result, "expected a tool_result from the Bash call");
        assert_eq!(turn_ok, Some(true), "expected a successful turn");
    }
}
