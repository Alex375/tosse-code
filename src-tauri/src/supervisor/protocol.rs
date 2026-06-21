//! Wire types for the Claude Code stream-json protocol (CLI v2.1.178).
//!
//! Clean-room model of the messages the `claude` binary emits on stdout when
//! driven in persistent bidirectional `stream-json` mode. Derived from the spec
//! at `docs/claude-code-protocol.md` and validated against the checked-in ground
//! truth fixture (`fixtures/capture_text.jsonl`).
//!
//! Scope note (subtask 1 = transport): this module only needs to *classify and
//! deserialize* inbound lines without losing data. The top-level [`CliMessage`]
//! enum is modeled fully; payloads that belong to later layers are kept as
//! [`serde_json::Value`] on purpose:
//!   - the control-channel bodies (`control_request` / `control_response`) get
//!     typed in subtask 2 (control channel),
//!   - the assistant/user content blocks and stream-event deltas get assembled
//!     in subtask 3 (IPC / assembler).
//!
//! Every variant tolerates unknown fields (serde ignores them by default) and
//! every `#[serde(tag = ...)]` enum has an `Unknown` catch-all, so a future CLI
//! build never makes the reader drop a whole line.

use serde::Deserialize;
use serde_json::Value;

/// A single top-level JSON-lines message emitted by the `claude` binary on
/// stdout. Discriminated by the `"type"` field.
///
/// `tool_use` / `tool_result` are intentionally absent: per the protocol they
/// are *content blocks* inside an `assistant` / `user` message, never top-level
/// message types.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CliMessage {
    /// Session lifecycle (`init`, `status`, …).
    System(SystemMsg),
    /// An assembled assistant message (carries usage / model / tool-input
    /// snapshots; the authoritative `stop_reason` & final usage come from the
    /// `stream_event{message_delta}` and `result` lines — see spec §3.6).
    Assistant(AssistantMsg),
    /// A user turn echo, or — more importantly — the delivery vehicle for a
    /// `tool_result` content block.
    User(UserMsg),
    /// End-of-turn summary (cost, usage, duration, denials).
    Result(ResultMsg),
    /// Incremental SSE delta (only emitted with `--include-partial-messages`).
    StreamEvent(StreamEventMsg),
    /// Rate-limit status snapshot.
    RateLimitEvent(RateLimitMsg),
    /// Control channel — typed in subtask 2; kept raw here.
    ControlRequest(Value),
    /// Control channel — typed in subtask 2; kept raw here.
    ControlResponse(Value),
    /// Abort an in-flight inbound control request we are answering.
    ControlCancelRequest {
        request_id: String,
    },
    /// Housekeeping heartbeat — consume, never reply.
    KeepAlive,
    /// Housekeeping transcript mirror — consume.
    TranscriptMirror(Value),
    /// Forward-compat catch-all for any `"type"` we do not model yet.
    #[serde(other)]
    Unknown,
}

impl CliMessage {
    /// Stable, lowercase discriminant string — handy for logging and tests.
    pub fn kind(&self) -> &'static str {
        match self {
            CliMessage::System(_) => "system",
            CliMessage::Assistant(_) => "assistant",
            CliMessage::User(_) => "user",
            CliMessage::Result(_) => "result",
            CliMessage::StreamEvent(_) => "stream_event",
            CliMessage::RateLimitEvent(_) => "rate_limit_event",
            CliMessage::ControlRequest(_) => "control_request",
            CliMessage::ControlResponse(_) => "control_response",
            CliMessage::ControlCancelRequest { .. } => "control_cancel_request",
            CliMessage::KeepAlive => "keep_alive",
            CliMessage::TranscriptMirror(_) => "transcript_mirror",
            CliMessage::Unknown => "unknown",
        }
    }

    /// `true` when the message fell through to the forward-compat catch-all,
    /// i.e. the CLI emitted a top-level `"type"` we do not model.
    pub fn is_unknown(&self) -> bool {
        matches!(self, CliMessage::Unknown)
    }
}

/// `system` messages, discriminated by `"subtype"`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SystemMsg {
    /// First message of a session: carries `session_id`, the available tools,
    /// the model, the permission mode, etc.
    Init(Box<InitMsg>),
    /// Transient activity status (`requesting`, …).
    Status {
        status: Option<String>,
        #[serde(rename = "permissionMode")]
        permission_mode: Option<String>,
        session_id: Option<String>,
    },
    /// Other system subtypes (`compact_boundary`, `task_*`, `thinking_tokens`, …)
    /// are assembled in subtask 3; tolerated here so they never drop to
    /// [`CliMessage::Unknown`].
    #[serde(other)]
    Unknown,
}

/// `system/init` — the session bootstrap message.
///
/// Only the fields the supervisor needs early are typed; the CLI sends many
/// more (agents, skills, plugins, mcp_servers, slash_commands, memory_paths, …)
/// which serde ignores. Field casing on the wire is mixed, hence the renames.
#[derive(Debug, Clone, Deserialize)]
pub struct InitMsg {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    pub claude_code_version: Option<String>,
    #[serde(rename = "apiKeySource")]
    pub api_key_source: Option<String>,
    pub uuid: Option<String>,
}

/// `assistant` message. The inner `message` (Anthropic message shape with its
/// `content[]` blocks) is kept raw; the assembler (subtask 3) parses it.
#[derive(Debug, Clone, Deserialize)]
pub struct AssistantMsg {
    pub message: Value,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
    pub request_id: Option<String>,
    pub parent_tool_use_id: Option<String>,
}

/// `user` message (user turn echo, or `tool_result` delivery). Inner `message`
/// kept raw for the assembler.
#[derive(Debug, Clone, Deserialize)]
pub struct UserMsg {
    pub message: Value,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
    pub parent_tool_use_id: Option<String>,
}

/// `result` — emitted at the end of every turn (NOT end of session; the session
/// stays alive for the next user message while stdin remains open).
#[derive(Debug, Clone, Deserialize)]
pub struct ResultMsg {
    pub subtype: String,
    #[serde(default)]
    pub is_error: bool,
    /// Final assistant text, or structured output. String in the common case.
    pub result: Option<Value>,
    pub stop_reason: Option<String>,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
    pub num_turns: Option<u64>,
    pub duration_ms: Option<u64>,
    pub total_cost_usd: Option<f64>,
    /// Aggregate usage; shape varies per message kind, kept raw.
    #[serde(default)]
    pub usage: Value,
    /// Per-model usage map (`{"claude-opus-4-8[1m]": {inputTokens, contextWindow, …}}`).
    /// camelCase inner fields; kept raw and read by the assembler to surface the
    /// context-window size. Absent on some result subtypes → defaults to `null`.
    #[serde(default, rename = "modelUsage")]
    pub model_usage: Value,
}

/// `stream_event` — an incremental SSE delta wrapped with session metadata.
/// The inner `event` (message_start / content_block_* / message_*) is parsed by
/// the assembler in subtask 3.
#[derive(Debug, Clone, Deserialize)]
pub struct StreamEventMsg {
    pub event: Value,
    pub session_id: Option<String>,
    pub parent_tool_use_id: Option<String>,
    pub uuid: Option<String>,
    /// Present only on the `message_start` event.
    pub ttft_ms: Option<u64>,
}

/// `rate_limit_event`. Inner info kept raw (camelCase fields on the wire).
#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitMsg {
    pub rate_limit_info: Value,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real text turn captured live from `claude` v2.1.178.
    const CAPTURE: &str = include_str!("fixtures/capture_text.jsonl");

    /// The spec's strongest de-risking lever (§7): every line of a real session
    /// must deserialize into a *known* variant — never erroring, never falling
    /// through to `Unknown`. Re-capture and re-run on every CLI upgrade.
    #[test]
    fn ground_truth_capture_round_trips_into_known_variants() {
        let mut msgs = Vec::new();
        for (i, line) in CAPTURE.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("line {i} failed to parse: {e}\n{line}"));
            assert!(!msg.is_unknown(), "line {i} fell through to Unknown:\n{line}");
            if let CliMessage::System(sys) = &msg {
                assert!(
                    !matches!(sys, SystemMsg::Unknown),
                    "line {i} system subtype fell through to Unknown:\n{line}"
                );
            }
            msgs.push(msg);
        }

        // Exact ordered sequence of a real text turn (see docs §3.x).
        let kinds: Vec<&str> = msgs.iter().map(CliMessage::kind).collect();
        assert_eq!(
            kinds,
            vec![
                "system",           // init
                "system",           // status
                "rate_limit_event", //
                "stream_event",     // message_start
                "stream_event",     // content_block_start
                "stream_event",     // content_block_delta
                "stream_event",     // content_block_delta
                "assistant",        // assembled (side-band snapshot)
                "stream_event",     // content_block_stop
                "stream_event",     // message_delta
                "stream_event",     // message_stop
                "result",           // success
            ],
            "captured message sequence drifted — re-capture against the current CLI"
        );
    }

    #[test]
    fn init_message_exposes_session_metadata() {
        let line = CAPTURE.lines().next().expect("fixture has lines");
        match serde_json::from_str::<CliMessage>(line).unwrap() {
            CliMessage::System(SystemMsg::Init(init)) => {
                assert!(init.session_id.is_some(), "init must carry a session_id");
                assert!(init.model.is_some(), "init must carry a model");
                assert!(!init.tools.is_empty(), "init must list available tools");
                assert!(init.permission_mode.is_some(), "init must carry permissionMode");
            }
            other => panic!("first line should be system/init, got {}", other.kind()),
        }
    }

    #[test]
    fn result_message_reports_success() {
        let line = CAPTURE.lines().last().expect("fixture has a last line");
        match serde_json::from_str::<CliMessage>(line).unwrap() {
            CliMessage::Result(r) => {
                assert_eq!(r.subtype, "success");
                assert!(!r.is_error);
                assert_eq!(r.stop_reason.as_deref(), Some("end_turn"));
                assert_eq!(r.result.as_ref().and_then(Value::as_str), Some("hello world"));
            }
            other => panic!("last line should be result, got {}", other.kind()),
        }
    }

    #[test]
    fn unknown_type_is_tolerated_not_an_error() {
        let msg: CliMessage =
            serde_json::from_str(r#"{"type":"some_future_type","foo":1}"#).unwrap();
        assert!(msg.is_unknown());
    }

    #[test]
    fn control_messages_classify_without_typing_their_bodies() {
        let req: CliMessage = serde_json::from_str(
            r#"{"type":"control_request","request_id":"abc","request":{"subtype":"can_use_tool"}}"#,
        )
        .unwrap();
        assert_eq!(req.kind(), "control_request");

        let cancel: CliMessage =
            serde_json::from_str(r#"{"type":"control_cancel_request","request_id":"abc"}"#).unwrap();
        assert!(matches!(cancel, CliMessage::ControlCancelRequest { .. }));
    }
}
