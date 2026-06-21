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

use super::model::{
    ConversationItem, NormalizedBlock, RateLimitSnapshot, SessionEvent, SessionStatePayload,
};
use super::protocol::{
    AssistantMsg, CliMessage, RateLimitMsg, ResultMsg, StreamEventMsg, SystemMsg, UserMsg,
};

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

    /// Mark a turn in flight on user send (before the CLI streams anything back),
    /// so the composer flips to "working" immediately.
    pub fn set_busy(&mut self, busy: bool) -> SessionEvent {
        self.state.busy = busy;
        SessionEvent::State(self.state.clone())
    }

    /// Reflect a permission-mode change (after `set_permission_mode`).
    pub fn set_permission_mode(&mut self, mode: &str) -> SessionEvent {
        self.state.permission_mode = Some(mode.to_string());
        SessionEvent::State(self.state.clone())
    }

    /// Reflect a model change (after `set_model`).
    pub fn set_model(&mut self, model: &str) -> SessionEvent {
        self.state.model = Some(model.to_string());
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
            CliMessage::RateLimitEvent(rl) => self.ingest_rate_limit(rl, &mut out),
            // control_* / keep_alive / transcript_mirror / unknown: nothing for the
            // UI at this layer.
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
                // `system/init` is re-emitted at the start of EACH turn, so when the
                // agent moves the session into/out of a worktree (EnterWorktree /
                // ExitWorktree), the next turn's init carries the new cwd — the UI's
                // worktree indicator follows along.
                self.state.cwd = init.cwd.clone();
                // Do NOT force busy here: `system/init` is emitted at the start of
                // each turn (not at spawn). Marking busy on init is fine for turns,
                // but busy is driven by user-send (set_busy) + message_start /
                // result so the composer is never wedged "busy" without a turn.
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
                let mut state_changed = false;
                if !self.state.busy {
                    self.state.busy = true;
                    state_changed = true;
                }
                // Live context fill: a ROOT model call's input usage = the prompt size
                // sent to the model = current context occupancy. Sub-agent (Task) calls
                // have `parent_tool_use_id` set and their own window — never let them
                // clobber the conversation's context meter.
                if se.parent_tool_use_id.is_none() {
                    if let Some(used) = event
                        .get("message")
                        .and_then(|m| m.get("usage"))
                        .and_then(context_used_from_usage)
                    {
                        if self.state.context_tokens != Some(used) {
                            self.state.context_tokens = Some(used);
                            state_changed = true;
                        }
                    }
                }
                if state_changed {
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
        // Authoritative end-of-turn context fill + window size. A multi-call turn's
        // top-level `usage` can aggregate its `iterations[]`, so prefer the LAST
        // iteration — the final model call's prompt = current context occupancy.
        let final_usage = r
            .usage
            .get("iterations")
            .and_then(Value::as_array)
            .and_then(|it| it.last())
            .unwrap_or(&r.usage);
        if let Some(used) = context_used_from_usage(final_usage) {
            self.state.context_tokens = Some(used);
        }
        // contextWindow is a model property (stable across the session); only update
        // when this result carries it, so a turn without modelUsage keeps the last value.
        if let Some(window) = context_window_from_model_usage(&r.model_usage) {
            self.state.context_window = Some(window);
        }
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

    /// Normalize a `rate_limit_event` into the session's [`RateLimitSnapshot`]. The
    /// inner `rate_limit_info` has camelCase keys; we read them by hand off the raw
    /// Value (protocol.rs keeps it untyped). Emits a state event only on change so a
    /// per-turn re-emit of the same snapshot does not churn the UI.
    fn ingest_rate_limit(&mut self, rl: &RateLimitMsg, out: &mut Vec<SessionEvent>) {
        let info = &rl.rate_limit_info;
        let snapshot = RateLimitSnapshot {
            status: info.get("status").and_then(Value::as_str).map(str::to_string),
            resets_at: info.get("resetsAt").and_then(Value::as_i64),
            limit_type: info
                .get("rateLimitType")
                .and_then(Value::as_str)
                .map(str::to_string),
            using_overage: info
                .get("isUsingOverage")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        if self.state.rate_limit.as_ref() != Some(&snapshot) {
            self.state.rate_limit = Some(snapshot);
            out.push(SessionEvent::State(self.state.clone()));
        }
    }
}

/// Provisional context-window size for a model id, used to render the ring before
/// the authoritative `result.modelUsage[…].contextWindow` arrives (e.g. seeding a
/// resumed conversation from its transcript, which carries no window). Opus runs
/// with the 1M beta on this CLI; everything else is 200k.
pub(crate) fn default_context_window(model: Option<&str>) -> u64 {
    match model {
        Some(m) if m.to_ascii_lowercase().contains("opus") => 1_000_000,
        _ => 200_000,
    }
}

/// Sum the tokens that occupy the context window from a `usage` object:
/// `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (the full
/// prompt sent to the model). Returns `None` when the object carries no token counts
/// (e.g. an empty/`null` usage), so callers don't reset a known value to zero.
pub(crate) fn context_used_from_usage(usage: &Value) -> Option<u64> {
    let field = |k: &str| usage.get(k).and_then(Value::as_u64);
    let input = field("input_tokens");
    let cache_creation = field("cache_creation_input_tokens");
    let cache_read = field("cache_read_input_tokens");
    if input.is_none() && cache_creation.is_none() && cache_read.is_none() {
        return None;
    }
    Some(input.unwrap_or(0) + cache_creation.unwrap_or(0) + cache_read.unwrap_or(0))
}

/// Pick the active model's context-window size from a `modelUsage` map. A turn may
/// list several models (a sub-agent runs on a cheaper one); the conversation's model
/// is the one that consumed the most input, so we return the `contextWindow` of the
/// entry with the largest `input + cacheRead + cacheCreation`. Returns `None` when the
/// map is absent or carries no window.
pub(crate) fn context_window_from_model_usage(model_usage: &Value) -> Option<u64> {
    let obj = model_usage.as_object()?;
    let mut best: Option<(u64, u64)> = None; // (input_total, context_window)
    for entry in obj.values() {
        let Some(window) = entry.get("contextWindow").and_then(Value::as_u64) else {
            continue;
        };
        let field = |k: &str| entry.get(k).and_then(Value::as_u64).unwrap_or(0);
        let input_total =
            field("inputTokens") + field("cacheReadInputTokens") + field("cacheCreationInputTokens");
        let better = match best {
            Some((b, _)) => input_total >= b,
            None => true,
        };
        if better {
            best = Some((input_total, window));
        }
    }
    best.map(|(_, window)| window)
}

/// Turn an assistant `content[]` array into typed normalized blocks.
///
/// Shared with [`super::history`], which reconstructs assistant turns from
/// Claude's on-disk transcript (same Anthropic `content[]` shape).
pub(crate) fn normalize_blocks(content: Option<&Value>) -> Vec<NormalizedBlock> {
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

    #[test]
    fn captures_context_fill_and_window_from_fixture() {
        let mut asm = Assembler::new();
        for line in CAPTURE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            asm.ingest(&msg);
        }
        // input(5069) + cache_creation(9061) + cache_read(15626) = 29756.
        assert_eq!(asm.state().context_tokens, Some(29_756));
        // Opus 1M window wins over the haiku sub-agent's 200k (more input tokens).
        assert_eq!(asm.state().context_window, Some(1_000_000));
    }

    #[test]
    fn context_helpers_sum_and_pick_window() {
        let usage = serde_json::json!({
            "input_tokens": 100,
            "cache_creation_input_tokens": 20,
            "cache_read_input_tokens": 3,
            "output_tokens": 9
        });
        assert_eq!(context_used_from_usage(&usage), Some(123));
        // Empty usage → None (don't reset a known fill to zero).
        assert_eq!(context_used_from_usage(&serde_json::json!({})), None);

        let model_usage = serde_json::json!({
            "claude-haiku-4-5": {"inputTokens": 500, "contextWindow": 200000},
            "claude-opus-4-8[1m]": {
                "inputTokens": 5000, "cacheReadInputTokens": 15000,
                "cacheCreationInputTokens": 9000, "contextWindow": 1000000
            }
        });
        assert_eq!(context_window_from_model_usage(&model_usage), Some(1_000_000));
        assert_eq!(context_window_from_model_usage(&serde_json::json!({})), None);
        assert_eq!(context_window_from_model_usage(&Value::Null), None);
    }

    #[test]
    fn result_context_uses_last_iteration_not_aggregate() {
        let result = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "ok",
            "stop_reason": "end_turn",
            "session_id": "s",
            "uuid": "u",
            // A multi-call turn: the LAST iteration is the real final prompt size and
            // must win over the (here tiny) top-level number.
            "usage": {
                "input_tokens": 1,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "iterations": [
                    {"input_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                    {"input_tokens": 2000, "cache_read_input_tokens": 18000, "cache_creation_input_tokens": 0}
                ]
            },
            "modelUsage": {"claude-opus-4-8[1m]": {"inputTokens": 2000, "contextWindow": 1000000}}
        });
        let msg: CliMessage = serde_json::from_value(result).unwrap();
        let mut asm = Assembler::new();
        asm.ingest(&msg);
        // last iteration: 2000 + 18000 + 0 = 20000 (NOT the top-level 1).
        assert_eq!(asm.state().context_tokens, Some(20_000));
        assert_eq!(asm.state().context_window, Some(1_000_000));
    }

    #[test]
    fn ingests_rate_limit_event_into_state() {
        let event = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed_warning",
                "resetsAt": 1781618400_i64,
                "rateLimitType": "five_hour",
                "overageStatus": "rejected",
                "isUsingOverage": false
            },
            "session_id": "s", "uuid": "u"
        });
        let msg: CliMessage = serde_json::from_value(event).unwrap();
        let mut asm = Assembler::new();
        let events = asm.ingest(&msg);
        // First sighting emits a state event...
        assert!(events
            .iter()
            .any(|e| matches!(e, SessionEvent::State(_))));
        let rl = asm.state().rate_limit.clone().expect("rate limit captured");
        assert_eq!(rl.status.as_deref(), Some("allowed_warning"));
        assert_eq!(rl.resets_at, Some(1781618400));
        assert_eq!(rl.limit_type.as_deref(), Some("five_hour"));
        assert!(!rl.using_overage);
        // ...re-emitting the same snapshot is a no-op (no churn).
        let again = asm.ingest(&msg);
        assert!(again.is_empty(), "unchanged rate limit should emit nothing");
    }
}
