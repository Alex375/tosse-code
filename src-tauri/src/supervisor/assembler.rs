//! Assembler — turns the raw [`CliMessage`] stream into normalized,
//! UI-facing [`SessionEvent`]s (spec §6.2 "assembler").
//!
//! Design choices for robustness:
//!   - Live typing comes from `stream_event` text/thinking deltas.
//!   - Authoritative content (tool_use blocks, final text) is read from the
//!     top-level `assistant` message, which carries the full `content[]`. We do
//!     NOT reconstruct tool inputs from `input_json_delta` fragments — reading
//!     the assembled block is simpler and less fragile (spec §3.6).
//!   - `stop_reason` / final usage come from the `result` line.
//!
//! The assembler owns the coarse [`SessionStatePayload`]; the session asks it to
//! reflect permission / mode changes so all state lives in one place.

use serde_json::Value;

use super::model::{ConversationItem, NormalizedBlock, SessionEvent, SessionStatePayload};
use super::protocol::{AssistantMsg, CliMessage, ResultMsg, StreamEventMsg, SystemMsg, UserMsg};

/// Stateful normalizer for one session.
#[derive(Debug, Default)]
pub struct Assembler {
    state: SessionStatePayload,
    /// Id of the assistant message currently streaming (for delta correlation).
    current_message_id: Option<String>,
}

impl Assembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read-only view of the current session state.
    pub fn state(&self) -> &SessionStatePayload {
        &self.state
    }

    /// Flip the "awaiting permission" flag and return the resulting state event.
    pub fn set_awaiting_permission(&mut self, awaiting: bool) -> SessionEvent {
        self.state.awaiting_permission = awaiting;
        SessionEvent::State(self.state.clone())
    }

    /// Reflect a permission-mode change (after `set_permission_mode`).
    pub fn set_permission_mode(&mut self, mode: &str) -> SessionEvent {
        self.state.permission_mode = Some(mode.to_string());
        SessionEvent::State(self.state.clone())
    }

    /// Mark the session as ended and return the terminal state event.
    pub fn set_ended(&mut self) -> SessionEvent {
        self.state.busy = false;
        self.state.awaiting_permission = false;
        self.state.activity = None;
        self.state.ended = true;
        SessionEvent::State(self.state.clone())
    }

    /// Ingest one inbound message, returning the events to emit (possibly none).
    /// Control-channel messages are handled by the session, not here.
    pub fn ingest(&mut self, msg: &CliMessage) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        match msg {
            CliMessage::System(sys) => self.ingest_system(sys, &mut out),
            CliMessage::StreamEvent(se) => self.ingest_stream_event(se, &mut out),
            CliMessage::Assistant(a) => self.ingest_assistant(a, &mut out),
            CliMessage::User(u) => self.ingest_user(u, &mut out),
            CliMessage::Result(r) => self.ingest_result(r, &mut out),
            // rate_limit_event / control_* / keep_alive / transcript_mirror /
            // unknown: nothing for the UI at this layer.
            _ => {}
        }
        out
    }

    fn ingest_system(&mut self, sys: &SystemMsg, out: &mut Vec<SessionEvent>) {
        match sys {
            SystemMsg::Init(init) => {
                self.state.session_id = init.session_id.clone();
                self.state.model = init.model.clone();
                self.state.permission_mode = init.permission_mode.clone();
                self.state.busy = true; // a turn is starting
                out.push(SessionEvent::State(self.state.clone()));
            }
            SystemMsg::Status {
                status,
                permission_mode,
                session_id,
            } => {
                if let Some(pm) = permission_mode {
                    self.state.permission_mode = Some(pm.clone());
                }
                if session_id.is_some() {
                    self.state.session_id = session_id.clone();
                }
                self.state.activity = status.clone();
                out.push(SessionEvent::State(self.state.clone()));
            }
            // Other subtypes are discarded by the protocol layer's catch-all; we
            // surface nothing for them yet.
            SystemMsg::Unknown => {}
        }
    }

    fn ingest_stream_event(&mut self, se: &StreamEventMsg, out: &mut Vec<SessionEvent>) {
        let event = &se.event;
        match event.get("type").and_then(Value::as_str).unwrap_or_default() {
            "message_start" => {
                let id = event
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.current_message_id = (!id.is_empty()).then(|| id.clone());
                if !self.state.busy {
                    self.state.busy = true;
                    out.push(SessionEvent::State(self.state.clone()));
                }
                out.push(SessionEvent::Item(ConversationItem::MessageStarted {
                    id,
                    role: "assistant".to_string(),
                    parent_tool_use_id: se.parent_tool_use_id.clone(),
                }));
            }
            "content_block_delta" => {
                if let Some(delta) = event.get("delta") {
                    match delta.get("type").and_then(Value::as_str).unwrap_or_default() {
                        "text_delta" => {
                            if let Some(text) = delta.get("text").and_then(Value::as_str) {
                                out.push(SessionEvent::Item(ConversationItem::TextDelta {
                                    message_id: self.current_message_id.clone(),
                                    text: text.to_string(),
                                }));
                            }
                        }
                        "thinking_delta" => {
                            if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                                out.push(SessionEvent::Item(ConversationItem::ThinkingDelta {
                                    message_id: self.current_message_id.clone(),
                                    text: text.to_string(),
                                }));
                            }
                        }
                        _ => {}
                    }
                }
            }
            // message_start handled above; content_block_start/stop, message_delta,
            // message_stop carry no incremental text we surface yet.
            _ => {}
        }
    }

    fn ingest_assistant(&mut self, a: &AssistantMsg, out: &mut Vec<SessionEvent>) {
        let id = a
            .message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let blocks = normalize_blocks(a.message.get("content"));
        out.push(SessionEvent::Item(ConversationItem::AssistantMessage {
            id,
            blocks,
            parent_tool_use_id: a.parent_tool_use_id.clone(),
        }));
    }

    fn ingest_user(&mut self, u: &UserMsg, out: &mut Vec<SessionEvent>) {
        // A `user` message is the delivery vehicle for tool_result blocks.
        if let Some(Value::Array(blocks)) = u.message.get("content") {
            for b in blocks {
                if b.get("type").and_then(Value::as_str) == Some("tool_result") {
                    out.push(SessionEvent::Item(ConversationItem::ToolResult {
                        tool_use_id: b
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        content: b.get("content").cloned().unwrap_or(Value::Null),
                        is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                        parent_tool_use_id: u.parent_tool_use_id.clone(),
                    }));
                }
            }
        }
    }

    fn ingest_result(&mut self, r: &ResultMsg, out: &mut Vec<SessionEvent>) {
        self.state.busy = false;
        self.state.activity = None;
        self.state.awaiting_permission = false;
        self.current_message_id = None;
        out.push(SessionEvent::Item(ConversationItem::TurnResult {
            subtype: r.subtype.clone(),
            is_error: r.is_error,
            result: r.result.clone(),
            total_cost_usd: r.total_cost_usd,
            num_turns: r.num_turns,
            duration_ms: r.duration_ms,
        }));
        out.push(SessionEvent::State(self.state.clone()));
    }
}

/// Turn an assistant `content[]` array into typed normalized blocks.
fn normalize_blocks(content: Option<&Value>) -> Vec<NormalizedBlock> {
    let mut blocks = Vec::new();
    if let Some(Value::Array(arr)) = content {
        for b in arr {
            match b.get("type").and_then(Value::as_str).unwrap_or_default() {
                "text" => blocks.push(NormalizedBlock::Text {
                    text: b.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
                }),
                "thinking" => blocks.push(NormalizedBlock::Thinking {
                    text: b
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                }),
                "tool_use" | "server_tool_use" => blocks.push(NormalizedBlock::ToolUse {
                    id: b.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                    name: b.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    input: b.get("input").cloned().unwrap_or(Value::Null),
                }),
                _ => blocks.push(NormalizedBlock::Other { raw: b.clone() }),
            }
        }
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPTURE: &str = include_str!("fixtures/capture_text.jsonl");

    #[test]
    fn assembles_fixture_into_normalized_events() {
        let mut asm = Assembler::new();
        let mut streamed_text = String::new();
        let mut saw_model = false;
        let mut saw_session_id = false;
        let mut turn = None;
        let mut ended_idle = None;

        for line in CAPTURE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                match ev {
                    SessionEvent::State(s) => {
                        saw_model |= s.model.is_some();
                        saw_session_id |= s.session_id.is_some();
                        ended_idle = Some(s.busy);
                    }
                    SessionEvent::Item(ConversationItem::TextDelta { text, .. }) => {
                        streamed_text.push_str(&text);
                    }
                    SessionEvent::Item(ConversationItem::TurnResult {
                        subtype, is_error, ..
                    }) => {
                        turn = Some((subtype, is_error));
                    }
                    _ => {}
                }
            }
        }

        assert!(saw_model, "a state event should carry the model");
        assert!(saw_session_id, "a state event should carry the session_id");
        assert!(
            streamed_text.to_lowercase().contains("hello world"),
            "streamed text deltas should reconstruct the reply, got {streamed_text:?}"
        );
        assert_eq!(turn, Some(("success".to_string(), false)));
        assert_eq!(ended_idle, Some(false), "session should be idle after the result");
    }

    #[test]
    fn normalizes_assistant_tool_use_blocks() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": {
                "id": "msg_1",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "let me check"},
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}
                ]
            },
            "session_id": "s", "uuid": "u"
        });
        let msg: CliMessage = serde_json::from_value(assistant).unwrap();
        let mut asm = Assembler::new();
        let events = asm.ingest(&msg);
        let blocks = events.into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::AssistantMessage { blocks, .. }) => Some(blocks),
            _ => None,
        });
        let blocks = blocks.expect("expected an AssistantMessage");
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], NormalizedBlock::Text { text } if text == "let me check"));
        assert!(matches!(&blocks[1], NormalizedBlock::ToolUse { name, .. } if name == "Bash"));
    }

    #[test]
    fn normalizes_user_tool_result() {
        let user = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok", "is_error": false}]
            },
            "session_id": "s", "uuid": "u"
        });
        let msg: CliMessage = serde_json::from_value(user).unwrap();
        let mut asm = Assembler::new();
        let events = asm.ingest(&msg);
        let result = events.into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::ToolResult { tool_use_id, .. }) => Some(tool_use_id),
            _ => None,
        });
        assert_eq!(result.as_deref(), Some("toolu_1"));
    }
}
