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
use super::model::{PermissionRequestPayload, SessionEmitter, SessionEvent};
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
    SetEffortLevel(String),
    Interrupt,
    Shutdown,
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
            SessionError::Spawn(e) => write!(f, "failed to start session: {e}"),
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
    emitter: Arc<dyn SessionEmitter>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
) -> Result<SessionHandle, SessionError> {
    let (transport, msg_rx) = Transport::spawn(cfg).map_err(SessionError::Spawn)?;
    let core = SessionCore::new(id.clone(), emitter, transport.outbound());
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
    next_req: u64,
    /// Outbound JSON lines (→ the process stdin in production, → a test channel
    /// in unit tests).
    outbound: mpsc::UnboundedSender<Value>,
}

impl SessionCore {
    fn new(id: String, emitter: Arc<dyn SessionEmitter>, outbound: mpsc::UnboundedSender<Value>) -> Self {
        Self {
            id,
            emitter,
            assembler: Assembler::new(),
            pending: HashMap::new(),
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

    fn emit(&self, ev: SessionEvent) {
        match ev {
            SessionEvent::State(s) => self.emitter.emit_state(&self.id, &s),
            SessionEvent::Item(i) => self.emitter.emit_item(&self.id, &i),
            SessionEvent::Permission(p) => self.emitter.emit_permission(&self.id, &p),
        }
    }

    /// Fire-and-forget initialize handshake at startup (spec §4.4).
    fn initialize(&mut self) {
        let rid = self.next_request_id();
        self.send(control::initialize_request(&rid));
    }

    /// Emit a terminal state event (the session has ended).
    fn emit_ended(&mut self) {
        let ev = self.assembler.set_ended();
        self.emit(ev);
    }

    fn on_message(&mut self, msg: CliMessage) {
        match msg {
            // Outbound control acks (initialize/interrupt/set_permission_mode):
            // fire-and-forget for the MVP — consume and drop.
            CliMessage::ControlResponse(_) => {}
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
                let rid = self.next_request_id();
                self.send(control::set_permission_mode_request(&rid, mode));
                let mode_str = serde_json::to_value(mode)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default();
                let ev = self.assembler.set_permission_mode(&mode_str);
                self.emit(ev);
            }
            SessionCommand::SetModel(model) => {
                let rid = self.next_request_id();
                self.send(control::set_model_request(&rid, &model));
                let ev = self.assembler.set_model(&model);
                self.emit(ev);
            }
            SessionCommand::SetEffortLevel(level) => {
                // Effort is a fire-and-forget flag change; the CLI carries no
                // effort field in its state, so there is no event to emit back —
                // the UI owns the selected level locally.
                let rid = self.next_request_id();
                self.send(control::set_effort_level_request(&rid, &level));
            }
            SessionCommand::Interrupt => {
                let rid = self.next_request_id();
                self.send(control::interrupt_request(&rid));
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
    }

    /// Build a `SessionCore` wired to two inspectable channels (events, outbound).
    fn test_core() -> (
        SessionCore,
        mpsc::UnboundedReceiver<SessionEvent>,
        mpsc::UnboundedReceiver<Value>,
    ) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let core = SessionCore::new("s".to_string(), Arc::new(ChannelEmitter { tx: event_tx }), out_tx);
        (core, event_rx, out_rx)
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
    fn initialize_is_sent_first() {
        let (mut core, _events, mut out) = test_core();
        core.initialize();
        let lines = drain(&mut out);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["type"], json!("control_request"));
        assert_eq!(lines[0]["request"]["subtype"], json!("initialize"));
    }

    #[test]
    fn send_user_text_writes_a_user_message() {
        let (mut core, _events, mut out) = test_core();
        core.on_command(SessionCommand::SendUserText("hello".to_string()));
        let lines = drain(&mut out);
        assert_eq!(lines[0]["type"], json!("user"));
        assert_eq!(lines[0]["message"]["content"][0]["text"], json!("hello"));
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
        let handle = spawn_session("test".to_string(), SpawnConfig::new(cwd), emitter, Box::new(|| {}))
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
