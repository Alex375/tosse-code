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

use std::collections::HashMap;

use serde_json::Value;

use super::model::{
    BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus, ConversationItem, NormalizedBlock,
    RateLimitSnapshot, SessionEvent, SessionStatePayload,
};
use super::protocol::{
    AssistantMsg, CliMessage, RateLimitMsg, ResultMsg, StreamEventMsg, SystemMsg,
    TaskNotificationMsg, TaskProgressMsg, TaskStartedMsg, TaskUpdatedMsg, UserMsg,
};

/// Stateful normalizer for one session.
#[derive(Debug, Default)]
pub struct Assembler {
    state: SessionStatePayload,
    /// Id of the assistant message currently streaming (for delta correlation).
    current_message_id: Option<String>,
    /// Last CONFIRMED (model-felt) control values we announced in the timeline, as
    /// friendly labels. Distinct from `state` (which updates optimistically on a
    /// click): a "control changed" notice fires ONLY when a confirmed source moves
    /// one of these — the `get_settings` read-back (effort + model), the
    /// `set_permission_mode` ack, or `system/init` (model + permission, per turn) —
    /// never on the optimistic click. So the line always reflects what the model
    /// actually got, and it also catches a change made from the chat (e.g. /model).
    announced: Announced,
    /// `tool_use.id` → tool `name`, recorded from each assistant `tool_use` block.
    /// The ONLY way to tell a background `Bash` from a `Monitor` apart (both carry
    /// `task_type:"local_bash"`): we correlate a `task_*`'s `tool_use_id` back to the
    /// tool that spawned it. Populated before the matching `task_started` (the tool
    /// must be requested before it runs).
    tool_names: HashMap<String, String>,
    /// Live background tasks keyed by `task_id`, updated in place on every `task_*`
    /// transition (spec §6.2).
    background_tasks: HashMap<String, BackgroundTask>,
}

/// The last-announced friendly labels for the three controls (see [`Assembler`]).
#[derive(Debug, Default)]
struct Announced {
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
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

    /// Seed the live state with the spawn controls, so the FIRST emitted state event
    /// already carries them (before the round-trips land). Also seeds the announced
    /// baseline, so the INITIAL state — and the first confirming `get_settings` /
    /// `system/init` — never produces a spurious "control changed" notice. Does NOT
    /// emit — the session emits its first state on a real event.
    pub fn seed_controls(
        &mut self,
        model: Option<String>,
        effort: Option<String>,
        permission_mode: Option<String>,
        ultracode: bool,
    ) {
        self.announced.model = model.as_deref().map(model_label);
        self.announced.effort = effort_label(effort.as_deref(), ultracode);
        self.announced.permission = permission_mode.as_deref().map(permission_label);
        self.state.model = model;
        self.state.effort = effort;
        self.state.permission_mode = permission_mode;
        self.state.ultracode = ultracode;
    }

    /// Optimistically reflect an effort/ultracode change from a UI click: updates the
    /// display state immediately, but does NOT announce — the timeline line waits for
    /// the `get_settings` read-back ([`apply_settings`]), so it shows the CONFIRMED
    /// value, never the optimistic one.
    pub fn set_effort_optimistic(
        &mut self,
        effort: Option<String>,
        ultracode: bool,
    ) -> SessionEvent {
        if let Some(e) = effort {
            self.state.effort = Some(e);
        }
        self.state.ultracode = ultracode;
        SessionEvent::State(self.state.clone())
    }

    /// Apply a live `get_settings` read-back: the authoritative model / effort /
    /// ultracode the CLI reports. A field absent from the response (`None`) is left
    /// untouched. Returns the state event PLUS a "control changed" notice for each
    /// value that actually MOVED (the model-felt source of truth).
    pub fn apply_settings(
        &mut self,
        model: Option<String>,
        effort: Option<String>,
        ultracode: Option<bool>,
    ) -> Vec<SessionEvent> {
        if let Some(m) = &model {
            self.state.model = Some(m.clone());
        }
        if let Some(e) = &effort {
            self.state.effort = Some(e.clone());
        }
        if let Some(u) = ultracode {
            self.state.ultracode = u;
        }
        let mut out = vec![SessionEvent::State(self.state.clone())];
        if let Some(m) = &model {
            self.announce_model(m, &mut out);
        }
        if effort.is_some() || ultracode.is_some() {
            self.announce_effort(&mut out);
        }
        out
    }

    /// Apply the CONFIRMED permission mode from a `set_permission_mode` ack (it echoes
    /// the mode the CLI actually applied, which can differ from the requested one).
    /// Returns the state event plus a "control changed" notice if it moved.
    pub fn confirm_permission_mode(&mut self, mode: &str) -> Vec<SessionEvent> {
        self.state.permission_mode = Some(mode.to_string());
        let mut out = vec![SessionEvent::State(self.state.clone())];
        self.announce_permission(mode, &mut out);
        out
    }

    /// Emit a "Modèle : X → Y" notice if the confirmed model moved (compared by
    /// friendly label, so an alias vs the resolved id never false-positives and a
    /// per-turn re-report of the same model is silent). The first sighting only
    /// records the baseline.
    fn announce_model(&mut self, id: &str, out: &mut Vec<SessionEvent>) {
        let to = model_label(id);
        match self.announced.model.clone() {
            Some(from) if from == to => {}
            Some(from) => {
                out.push(change_notice("Modèle", "diamond", &from, &to));
                self.announced.model = Some(to);
            }
            None => self.announced.model = Some(to),
        }
    }

    /// Emit an "Effort de réflexion : X → Y" notice if the confirmed effort/ultracode
    /// moved (the Ultra code tier folds in as its own label).
    fn announce_effort(&mut self, out: &mut Vec<SessionEvent>) {
        let Some(to) = effort_label(self.state.effort.as_deref(), self.state.ultracode) else {
            return;
        };
        match self.announced.effort.clone() {
            Some(from) if from == to => {}
            Some(from) => {
                out.push(change_notice("Effort de réflexion", "bolt", &from, &to));
                self.announced.effort = Some(to);
            }
            None => self.announced.effort = Some(to),
        }
    }

    /// Emit a "Mode de permission : X → Y" notice if the confirmed mode moved.
    fn announce_permission(&mut self, mode: &str, out: &mut Vec<SessionEvent>) {
        let to = permission_label(mode);
        match self.announced.permission.clone() {
            Some(from) if from == to => {}
            Some(from) => {
                out.push(change_notice("Mode de permission", "shield", &from, &to));
                self.announced.permission = Some(to);
            }
            None => self.announced.permission = Some(to),
        }
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
                // `system/init` carries the authoritative model + permission each
                // turn: announce a change made from the chat (e.g. /model) too. Same
                // value → silent (announce_* dedupes).
                if let Some(m) = &init.model {
                    self.announce_model(m, out);
                }
                if let Some(pm) = &init.permission_mode {
                    self.announce_permission(pm, out);
                }
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
                if let Some(pm) = permission_mode {
                    self.announce_permission(pm, out);
                }
            }
            SystemMsg::TaskStarted(t) => self.ingest_task_started(t, out),
            SystemMsg::TaskProgress(t) => self.ingest_task_progress(t, out),
            SystemMsg::TaskUpdated(t) => self.ingest_task_updated(t, out),
            SystemMsg::TaskNotification(t) => self.ingest_task_notification(t, out),
            // Other subtypes are discarded by the protocol layer's catch-all; we
            // surface nothing for them yet.
            SystemMsg::Unknown => {}
        }
    }

    /// A background task was created: classify its producer (from `task_type` + the
    /// correlated tool name), seed a [`BackgroundTask`] keyed by `task_id`, and emit.
    fn ingest_task_started(&mut self, t: &TaskStartedMsg, out: &mut Vec<SessionEvent>) {
        let tool_name = t
            .tool_use_id
            .as_deref()
            .and_then(|id| self.tool_names.get(id))
            .map(String::as_str);
        let kind = classify_task(t.task_type.as_deref(), tool_name);
        let task = BackgroundTask {
            task_id: t.task_id.clone(),
            kind,
            tool_use_id: t.tool_use_id.clone(),
            label: t.description.clone(),
            subagent_type: t.subagent_type.clone(),
            agent_id: None,
            status: BackgroundTaskStatus::Running,
            progress: None,
            tokens: None,
            tool_uses: None,
            duration_ms: None,
            summary: None,
            output_file: None,
        };
        self.background_tasks.insert(t.task_id.clone(), task.clone());
        out.push(SessionEvent::Task(task));
    }

    /// A live progress tick. Stash the latest `description` (a `Workflow` emits
    /// `"<phase>: <label>"`) and re-emit. Tolerates a tick for an unseen task.
    fn ingest_task_progress(&mut self, t: &TaskProgressMsg, out: &mut Vec<SessionEvent>) {
        let task = self.task_entry(&t.task_id, t.tool_use_id.as_deref());
        if t.description.is_some() {
            task.progress = t.description.clone();
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// A state patch (the terminal transition for Bash/Monitor/Agent). Map the patch
    /// status onto our coarse status and re-emit.
    fn ingest_task_updated(&mut self, t: &TaskUpdatedMsg, out: &mut Vec<SessionEvent>) {
        let task = self.task_entry(&t.task_id, None);
        if let Some(status) = t.patch.as_ref().and_then(|p| p.status.as_deref()) {
            task.status = map_status(status);
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// A task finished: fold in the final status, summary, output file and usage
    /// roll-up, then re-emit the terminal state.
    fn ingest_task_notification(&mut self, t: &TaskNotificationMsg, out: &mut Vec<SessionEvent>) {
        let task = self.task_entry(&t.task_id, t.tool_use_id.as_deref());
        // A notification ALWAYS means the task finished. So never leave it Running: a
        // recognized status maps as usual; a present-but-UNRECOGNIZED terminal status
        // (a future CLI vocab like "timed_out") must NOT silently stay Running — fall
        // back to Completed and log it so the unknown vocab surfaces and gets captured.
        task.status = match t.status.as_deref() {
            Some(status) => match map_status(status) {
                BackgroundTaskStatus::Running => {
                    eprintln!(
                        "[assembler] task_notification with unrecognized terminal status {status:?}; treating as completed"
                    );
                    BackgroundTaskStatus::Completed
                }
                terminal => terminal,
            },
            None => BackgroundTaskStatus::Completed,
        };
        if t.summary.is_some() {
            task.summary = t.summary.clone();
        }
        if t.output_file.is_some() {
            task.output_file = t.output_file.clone();
        }
        if let Some(usage) = &t.usage {
            if usage.total_tokens.is_some() {
                task.tokens = usage.total_tokens;
            }
            if usage.tool_uses.is_some() {
                task.tool_uses = usage.tool_uses;
            }
            if usage.duration_ms.is_some() {
                task.duration_ms = usage.duration_ms;
            }
        }
        // For a sub-agent, the only place the agent id appears on the wire is inside
        // `output_file` (`subagents/agent-<agentId>.jsonl`). Surface it as a first-class
        // field so a drill-down can call `load_subagent_transcript` without re-parsing.
        if task.kind == BackgroundTaskKind::Agent && task.agent_id.is_none() {
            if let Some(of) = task.output_file.as_deref() {
                task.agent_id = agent_id_from_output_file(of);
            }
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// Get (or lazily create) the tracked task for `task_id`. A `task_updated` /
    /// `task_notification` for a task whose `task_started` we missed (e.g. the stream
    /// was joined mid-run) still yields a usable entry, classified from whatever the
    /// late event carries.
    fn task_entry(&mut self, task_id: &str, tool_use_id: Option<&str>) -> &mut BackgroundTask {
        let tool_name = tool_use_id
            .and_then(|id| self.tool_names.get(id))
            .map(String::clone);
        self.background_tasks
            .entry(task_id.to_string())
            .or_insert_with(|| BackgroundTask {
                task_id: task_id.to_string(),
                kind: classify_task(None, tool_name.as_deref()),
                tool_use_id: tool_use_id.map(str::to_string),
                label: None,
                subagent_type: None,
                agent_id: None,
                status: BackgroundTaskStatus::Running,
                progress: None,
                tokens: None,
                tool_uses: None,
                duration_ms: None,
                summary: None,
                output_file: None,
            })
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
            "content_block_start" => {
                // A tool_use block is announced here (id + name) BEFORE the assembled
                // assistant message and well before the tool runs / emits `task_started`.
                // Recording the name now guarantees a background task is classified
                // correctly the moment it starts (Bash vs Monitor hinges on this name).
                if let Some(cb) = event.get("content_block") {
                    if cb.get("type").and_then(Value::as_str) == Some("tool_use") {
                        let id = cb.get("id").and_then(Value::as_str).unwrap_or_default();
                        let name = cb.get("name").and_then(Value::as_str).unwrap_or_default();
                        self.record_tool_name(id, name, out);
                    }
                }
            }
            // content_block_stop, message_delta, message_stop carry no incremental
            // text we surface yet.
            _ => {}
        }
    }

    /// Record a background-capable tool_use's `id → name` for later `task_*`
    /// correlation, and — belt-and-suspenders — re-classify an ALREADY-tracked task
    /// that turns out to belong to it (covers the rare wire ordering where a
    /// `task_started` beat the tool name). Only background-capable tools are kept, which
    /// bounds the map to the handful of task-spawning calls instead of every tool_use.
    fn record_tool_name(&mut self, id: &str, name: &str, out: &mut Vec<SessionEvent>) {
        if id.is_empty() || !is_bg_capable_tool(name) {
            return;
        }
        self.tool_names.insert(id.to_string(), name.to_string());
        // If a task for this tool_use already exists but was classified before the name
        // was known (ambiguous `local_bash` → Bash fallback, or `Other`), correct it now
        // — the tool name is the authoritative signal — and re-emit so the UI updates.
        if let Some(task) = self
            .background_tasks
            .values_mut()
            .find(|t| t.tool_use_id.as_deref() == Some(id))
        {
            let corrected = classify_task(None, Some(name));
            if corrected != task.kind {
                task.kind = corrected;
                out.push(SessionEvent::Task(task.clone()));
            }
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
        // Remember each background-capable tool_use's name so a later `task_*` (which
        // only carries the tool_use_id) can be classified — e.g. Bash vs Monitor. The
        // assembled `assistant` message is the AUTHORITATIVE source; the streamed
        // `content_block_start` (handled in ingest_stream_event) records it EARLIER, so
        // the name is known before `task_started` even though this message arrives at
        // end-of-turn.
        for b in &blocks {
            if let NormalizedBlock::ToolUse { id, name, .. } = b {
                self.record_tool_name(id, name, out);
            }
        }
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
        // Authoritative window for THIS session's model (distinguishes 200k vs 1M).
        // Only updates when the result reports the session model's own entry — a
        // sub-agent-only turn returns None and keeps the last known window.
        if let Some(window) =
            context_window_from_model_usage(&r.model_usage, self.state.model.as_deref())
        {
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

/// Build a "control changed" timeline notice (`{control} : {from} → {to}`) — the
/// model-felt signal that a control actually moved. The front renders it as a subtle
/// inline line (mirrors the VS Code extension's settings lines).
fn change_notice(control: &str, icon: &str, from: &str, to: &str) -> SessionEvent {
    SessionEvent::Item(ConversationItem::Notice {
        subtype: "control_change".to_string(),
        detail: serde_json::json!({ "control": control, "icon": icon, "from": from, "to": to }),
    })
}

/// The tools that spawn background tasks. Only these are remembered in `tool_names`
/// (the correlation map), which bounds it to the few task-spawning calls rather than
/// every tool_use in the session.
fn is_bg_capable_tool(name: &str) -> bool {
    matches!(name, "Agent" | "Workflow" | "Bash" | "Monitor")
}

/// Extract a sub-agent's id from its transcript `output_file`
/// (`…/subagents/agent-<agentId>.jsonl` → `<agentId>`). `None` if the path does not
/// match that shape.
fn agent_id_from_output_file(path: &str) -> Option<String> {
    let file = path.rsplit('/').next()?;
    file.strip_suffix(".jsonl")?
        .strip_prefix("agent-")
        .map(str::to_string)
}

/// Classify a background task's producer. The tool NAME is the strongest signal
/// (it is the only thing that separates a background `Bash` from a `Monitor`, which
/// share `task_type:"local_bash"`); `task_type` is the fallback when the tool name
/// is not yet known.
fn classify_task(task_type: Option<&str>, tool_name: Option<&str>) -> BackgroundTaskKind {
    match tool_name {
        Some("Agent") => return BackgroundTaskKind::Agent,
        Some("Workflow") => return BackgroundTaskKind::Workflow,
        Some("Bash") => return BackgroundTaskKind::Bash,
        Some("Monitor") => return BackgroundTaskKind::Monitor,
        _ => {}
    }
    match task_type {
        // `local_bash` is ambiguous without the tool name (Bash bg AND Monitor) —
        // default to Bash, the common case; a later event with the name refines it.
        Some("local_bash") => BackgroundTaskKind::Bash,
        Some("local_agent") => BackgroundTaskKind::Agent,
        _ => BackgroundTaskKind::Other,
    }
}

/// Map a wire status string onto our coarse [`BackgroundTaskStatus`]. Anything we do
/// not recognize is treated as still-running (a conservative default — a real
/// terminal state always sends `completed`/`failed`/etc.).
fn map_status(status: &str) -> BackgroundTaskStatus {
    match status {
        "completed" | "success" | "done" => BackgroundTaskStatus::Completed,
        "failed" | "error" | "timeout" | "timed_out" | "expired" => BackgroundTaskStatus::Failed,
        "stopped" | "cancelled" | "canceled" | "killed" => BackgroundTaskStatus::Stopped,
        // Non-terminal (`in_progress`, `running`, `queued`, …) or an unknown vocab. A
        // `task_notification` caller treats this as terminal (and logs it); a
        // `task_updated` legitimately stays Running until a terminal patch arrives.
        _ => BackgroundTaskStatus::Running,
    }
}

/// Friendly label for a model id (alias OR resolved id) — matches the composer's.
fn model_label(id: &str) -> String {
    let s = id.to_lowercase();
    if s.contains("opus") {
        "Opus 4.8".to_string()
    } else if s.contains("sonnet") {
        "Sonnet 4.6".to_string()
    } else if s.contains("haiku") {
        "Haiku 4.5".to_string()
    } else if s.contains("fable") {
        "Fable 5".to_string()
    } else {
        id.to_string()
    }
}

/// Friendly effort label, folding the ultracode tier in. `None` when there is no
/// known effort yet (so we never announce a phantom transition).
fn effort_label(effort: Option<&str>, ultracode: bool) -> Option<String> {
    if ultracode {
        return Some("Ultra code".to_string());
    }
    Some(
        match effort? {
            "low" => "Low",
            "medium" => "Medium",
            "high" => "High",
            "xhigh" => "Extra high",
            other => return Some(other.to_string()),
        }
        .to_string(),
    )
}

/// Friendly permission-mode label — matches the composer's PERM_LABEL.
fn permission_label(mode: &str) -> String {
    match mode {
        "auto" => "Auto mode",
        "default" => "Default",
        "acceptEdits" => "Auto-accept edits",
        "plan" => "Plan mode",
        "bypassPermissions" | "dontAsk" => "Bypass permissions",
        other => other,
    }
    .to_string()
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

/// The AUTHORITATIVE context-window size for the session's own model, read from a
/// `result.modelUsage` map. This is the only reliable source of the window: the
/// number distinguishes e.g. Opus-200k from Opus-1M, which the model NAME cannot
/// (both are `claude-opus-4-8`; only the `[1m]` variant — and its `contextWindow`
/// value — tells them apart).
///
/// We match the entry whose key is `session_model` exactly, or `session_model`
/// followed by a bracketed beta suffix (`claude-opus-4-8[1m]`). Requiring the `[`
/// boundary (rather than a bare prefix) keeps a short id from matching a longer
/// sibling version — `claude-opus-4` must NOT swallow `claude-opus-4-8`. We
/// deliberately DO NOT fall back to "some other model in the map": a turn that only
/// ran a sub-agent (e.g. haiku 200k) must not shrink an Opus conversation's window —
/// returning `None` there tells the caller to KEEP the last known window instead of
/// clobbering it.
pub(crate) fn context_window_from_model_usage(
    model_usage: &Value,
    session_model: Option<&str>,
) -> Option<u64> {
    let obj = model_usage.as_object()?;
    let model = session_model?;
    // Exact key first, then `model[…]` (absorbs a `[1m]`-style beta suffix without
    // matching a longer version id).
    obj.iter()
        .find(|(k, _)| k.as_str() == model)
        .or_else(|| {
            obj.iter()
                .find(|(k, _)| k.strip_prefix(model).is_some_and(|rest| rest.starts_with('[')))
        })
        .and_then(|(_, entry)| entry.get("contextWindow"))
        .and_then(Value::as_u64)
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
        // Matches the session model by prefix (absorbs the `[1m]` suffix) → 1M, NOT
        // the sub-agent's 200k.
        assert_eq!(
            context_window_from_model_usage(&model_usage, Some("claude-opus-4-8")),
            Some(1_000_000)
        );
        // A 200k model resolves to 200k — the VALUE, not the name, sets the window.
        assert_eq!(
            context_window_from_model_usage(&model_usage, Some("claude-haiku-4-5")),
            Some(200_000)
        );
        // No entry for the session model → None (caller keeps the last known window,
        // so a sub-agent-only turn can't shrink an Opus conversation).
        assert_eq!(
            context_window_from_model_usage(&model_usage, Some("claude-sonnet-4-6")),
            None
        );
        // A shorter version id must NOT match a longer sibling by bare prefix: the
        // suffix has to start with `[`, so `claude-opus-4` doesn't swallow
        // `claude-opus-4-8[1m]`.
        assert_eq!(
            context_window_from_model_usage(&model_usage, Some("claude-opus-4")),
            None
        );
        assert_eq!(context_window_from_model_usage(&model_usage, None), None);
        assert_eq!(context_window_from_model_usage(&Value::Null, Some("x")), None);
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
        // The window is matched to the session model, so set it (system/init does this
        // live); the modelUsage key carries a `[1m]` suffix the prefix match absorbs.
        let _ = asm.set_model("claude-opus-4-8");
        asm.ingest(&msg);
        // last iteration: 2000 + 18000 + 0 = 20000 (NOT the top-level 1).
        assert_eq!(asm.state().context_tokens, Some(20_000));
        assert_eq!(asm.state().context_window, Some(1_000_000));
    }

    const TASKS_CAPTURE: &str = include_str!("fixtures/capture_tasks.jsonl");

    /// Feed the captured task lifecycle through the assembler and collect the final
    /// [`BackgroundTask`] per id. Asserts the four producers are classified — crucially
    /// Bash vs Monitor (same `task_type:"local_bash"`, told apart by tool name) — and
    /// that the terminal status + usage roll-up land.
    #[test]
    fn ingests_background_tasks_and_classifies_producers() {
        use std::collections::HashMap;
        let mut asm = Assembler::new();
        let mut tasks: HashMap<String, BackgroundTask> = HashMap::new();
        let mut emissions = 0;
        for line in TASKS_CAPTURE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                if let SessionEvent::Task(t) = ev {
                    emissions += 1;
                    tasks.insert(t.task_id.clone(), t);
                }
            }
        }
        // Every task_* transition emits (4 producers × {started, updated, notif} +
        // the workflow's progress tick = 13).
        assert_eq!(emissions, 13, "one Task event per task_* transition");
        assert_eq!(tasks.len(), 4, "four distinct background tasks");

        let agent = &tasks["task_agent_1"];
        assert_eq!(agent.kind, BackgroundTaskKind::Agent);
        assert_eq!(agent.subagent_type.as_deref(), Some("Explore"));
        assert_eq!(agent.status, BackgroundTaskStatus::Completed);
        assert_eq!(agent.tokens, Some(11174));
        assert_eq!(agent.tool_uses, Some(3));
        assert_eq!(agent.duration_ms, Some(859));
        assert_eq!(agent.tool_use_id.as_deref(), Some("toolu_agent"));
        // agent_id parsed from the notification's output_file (…/subagents/agent-aa11.jsonl).
        assert_eq!(agent.agent_id.as_deref(), Some("aa11"));

        let wf = &tasks["task_wf_1"];
        assert_eq!(wf.kind, BackgroundTaskKind::Workflow);
        assert_eq!(wf.progress.as_deref(), Some("Research: r-alpha"));
        assert_eq!(wf.status, BackgroundTaskStatus::Completed);

        let bash = &tasks["task_bash_1"];
        assert_eq!(bash.kind, BackgroundTaskKind::Bash, "local_bash + Bash tool → Bash");
        assert_eq!(bash.status, BackgroundTaskStatus::Completed);
        assert!(bash.output_file.as_deref().unwrap().ends_with("task_bash_1.output"));

        let mon = &tasks["task_mon_1"];
        assert_eq!(
            mon.kind,
            BackgroundTaskKind::Monitor,
            "local_bash + Monitor tool → Monitor (NOT Bash)"
        );
        assert_eq!(mon.status, BackgroundTaskStatus::Completed);
    }

    /// The classifier prefers the tool name (the only Bash/Monitor discriminator),
    /// falls back to `task_type`, and the status mapper folds wire strings onto the
    /// coarse states.
    #[test]
    fn classify_and_status_mapping() {
        assert_eq!(classify_task(Some("local_bash"), Some("Monitor")), BackgroundTaskKind::Monitor);
        assert_eq!(classify_task(Some("local_bash"), Some("Bash")), BackgroundTaskKind::Bash);
        assert_eq!(classify_task(None, Some("Workflow")), BackgroundTaskKind::Workflow);
        assert_eq!(classify_task(Some("local_agent"), None), BackgroundTaskKind::Agent);
        // Ambiguous local_bash with no tool name yet defaults to Bash (refined later).
        assert_eq!(classify_task(Some("local_bash"), None), BackgroundTaskKind::Bash);
        assert_eq!(classify_task(None, None), BackgroundTaskKind::Other);

        assert_eq!(map_status("completed"), BackgroundTaskStatus::Completed);
        assert_eq!(map_status("failed"), BackgroundTaskStatus::Failed);
        assert_eq!(map_status("timed_out"), BackgroundTaskStatus::Failed);
        assert_eq!(map_status("stopped"), BackgroundTaskStatus::Stopped);
        assert_eq!(map_status("in_progress"), BackgroundTaskStatus::Running);

        assert_eq!(agent_id_from_output_file("/x/s/subagents/agent-aa11.jsonl").as_deref(), Some("aa11"));
        assert_eq!(agent_id_from_output_file("/x/s/tasks/t.output"), None);
    }

    /// A Monitor's tool name, recorded from `content_block_start`, must classify the
    /// task as Monitor (NOT Bash) even though `task_started` arrives before the
    /// assembled assistant message — the ordering hazard (finding #2).
    #[test]
    fn monitor_classified_from_content_block_start_before_assistant_message() {
        let mut asm = Assembler::new();
        let cbs: CliMessage = serde_json::from_str(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_mon","name":"Monitor","input":{}}},"session_id":"s"}"#,
        )
        .unwrap();
        asm.ingest(&cbs);
        let started: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"tk_mon","tool_use_id":"tu_mon","description":"watch","task_type":"local_bash"}"#,
        )
        .unwrap();
        let task = asm.ingest(&started).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        assert_eq!(task.expect("a Task event").kind, BackgroundTaskKind::Monitor);
    }

    /// If `task_started` truly beats the tool name, the task starts as the ambiguous
    /// Bash fallback but is RE-CLASSIFIED (and re-emitted) the moment the name arrives.
    #[test]
    fn late_tool_name_reclassifies_an_ambiguous_local_bash_task() {
        let mut asm = Assembler::new();
        let started: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"tk_late","tool_use_id":"tu_late","description":"watch","task_type":"local_bash"}"#,
        )
        .unwrap();
        let first = asm.ingest(&started).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        // No name yet → ambiguous local_bash defaults to Bash.
        assert_eq!(first.expect("a Task event").kind, BackgroundTaskKind::Bash);

        // The name arrives late (assistant message); the task is corrected to Monitor.
        let assistant: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "assistant",
            "message": {"id": "m", "role": "assistant", "content": [
                {"type": "tool_use", "id": "tu_late", "name": "Monitor", "input": {}}
            ]},
            "session_id": "s"
        }))
        .unwrap();
        let corrected = asm.ingest(&assistant).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        assert_eq!(
            corrected.expect("a re-classify Task event").kind,
            BackgroundTaskKind::Monitor
        );
    }

    /// A late `task_updated` for a task whose `task_started` we missed still yields a
    /// usable (Running→Completed) entry — the stream can be joined mid-run.
    #[test]
    fn task_updated_without_prior_started_is_tolerated() {
        let mut asm = Assembler::new();
        let msg: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_updated","task_id":"orphan","patch":{"status":"completed"}}"#,
        )
        .unwrap();
        let ev = asm.ingest(&msg);
        let task = ev.into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        let task = task.expect("a Task event even without a prior task_started");
        assert_eq!(task.task_id, "orphan");
        assert_eq!(task.status, BackgroundTaskStatus::Completed);
        assert_eq!(task.kind, BackgroundTaskKind::Other);
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

    // ---- "control changed" announcements -----------------------------------

    fn first_notice(events: Vec<SessionEvent>) -> Option<(String, Value)> {
        events.into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::Notice { subtype, detail }) => Some((subtype, detail)),
            _ => None,
        })
    }

    fn seeded() -> Assembler {
        let mut asm = Assembler::new();
        // Spawn baseline: Opus / Extra high / Default.
        asm.seed_controls(Some("opus".into()), Some("xhigh".into()), Some("default".into()), false);
        asm
    }

    /// A read-back that MATCHES the seed must not announce (no notice on spawn /
    /// resume); a real effort move must announce exactly one transition.
    #[test]
    fn effort_change_announces_only_a_real_move() {
        let mut asm = seeded();
        // The initial get_settings confirms the seed → state only, no notice.
        let evs = asm.apply_settings(Some("claude-opus-4-8[1m]".into()), Some("xhigh".into()), Some(false));
        assert!(first_notice(evs).is_none(), "confirming the seed must stay silent");
        // Now a genuine change xhigh → high.
        let (subtype, detail) = first_notice(asm.apply_settings(None, Some("high".into()), Some(false)))
            .expect("a control_change notice");
        assert_eq!(subtype, "control_change");
        assert_eq!(detail["control"], serde_json::json!("Effort de réflexion"));
        assert_eq!(detail["from"], serde_json::json!("Extra high"));
        assert_eq!(detail["to"], serde_json::json!("High"));
        // Re-reading the same value is silent (idempotent).
        assert!(first_notice(asm.apply_settings(None, Some("high".into()), Some(false))).is_none());
    }

    /// Ultra code is announced as its own label, not as "Extra high".
    #[test]
    fn ultracode_change_announces_its_own_label() {
        let mut asm = seeded();
        let (_, detail) = first_notice(asm.apply_settings(None, Some("xhigh".into()), Some(true)))
            .expect("a notice");
        assert_eq!(detail["from"], serde_json::json!("Extra high"));
        assert_eq!(detail["to"], serde_json::json!("Ultra code"));
    }

    /// A confirmed permission move announces; re-confirming the same mode is silent.
    #[test]
    fn permission_confirm_announces_then_is_idempotent() {
        let mut asm = seeded();
        let (_, detail) = first_notice(asm.confirm_permission_mode("plan")).expect("a notice");
        assert_eq!(detail["control"], serde_json::json!("Mode de permission"));
        assert_eq!(detail["from"], serde_json::json!("Default"));
        assert_eq!(detail["to"], serde_json::json!("Plan mode"));
        assert!(first_notice(asm.confirm_permission_mode("plan")).is_none());
    }

    /// A model change reported by `system/init` (e.g. switched via /model in chat)
    /// is announced; the permission, unchanged from the seed, stays silent.
    #[test]
    fn model_change_from_system_init_is_announced() {
        let mut asm = seeded();
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init",
            "session_id": "s", "uuid": "u", "cwd": "/x",
            "model": "claude-sonnet-4-6", "permissionMode": "default",
            "tools": ["Bash"], "slash_commands": []
        }))
        .unwrap();
        let (_, detail) = first_notice(asm.ingest(&init)).expect("a model change notice");
        assert_eq!(detail["control"], serde_json::json!("Modèle"));
        assert_eq!(detail["from"], serde_json::json!("Opus 4.8"));
        assert_eq!(detail["to"], serde_json::json!("Sonnet 4.6"));
    }
}
