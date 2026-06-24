//! Normalized, UI-facing model emitted by a session.
//!
//! Design principle (spec §6.3): **normalize in Rust, keep React dumb.** The
//! core assembles the raw stream-json into these typed events; the UI just
//! renders them. They derive `specta::Type` so the IPC layer can re-export them
//! to TypeScript verbatim.
//!
//! Dynamic, schema-free payloads (a tool's input, a tool_result's content) are
//! kept as [`serde_json::Value`] — they are arbitrary by nature and the UI shows
//! them generically.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// Coarse lifecycle + identity of a session, emitted whenever it changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct SessionStatePayload {
    /// `true` while a turn is in flight (between a user message and its `result`).
    pub busy: bool,
    /// The CLI-assigned conversation id (from `system/init`); enables `--resume`.
    pub session_id: Option<String>,
    /// The session's CURRENT working directory (from `system/init`). The CLI can
    /// move it mid-session when the agent calls `EnterWorktree`/`ExitWorktree`, so
    /// the UI reads this — not the static spawn cwd — to show which worktree the
    /// conversation is in right now.
    pub cwd: Option<String>,
    /// Current model id (from `system/init`, refined by the `get_settings`
    /// read-back to the resolved id, e.g. `claude-opus-4-8[1m]`).
    pub model: Option<String>,
    /// Current permission mode (from `system/init` / the `set_permission_mode` ack).
    pub permission_mode: Option<String>,
    /// Current reasoning-effort level (`low`/`medium`/`high`/`xhigh`). NOT carried
    /// by `system/init` — sourced from the `get_settings` control read-back (and the
    /// spawn seed). `None` until the first read-back. Drives the effort gauge.
    pub effort: Option<String>,
    /// Whether "ultracode" (xhigh effort + standing dynamic-workflow orchestration)
    /// is active right now. A SEPARATE boolean flag in the CLI, not an effort value.
    pub ultracode: bool,
    /// Fine-grained activity hint from `system/status` (e.g. `"requesting"`).
    pub activity: Option<String>,
    /// `true` while waiting on the user to answer a permission prompt.
    pub awaiting_permission: bool,
    /// `true` once the session has ended (the `claude` process exited or was
    /// stopped). A final state event with this set lets the UI mark the session
    /// dead instead of showing it as live forever.
    pub ended: bool,
    /// Tokens occupying the model's context window right now: the last model call's
    /// `input + cache_creation + cache_read` (from `message_start` live, then the
    /// `result`). `None` until the first turn reports usage. Drives the context ring.
    pub context_tokens: Option<u64>,
    /// Size of the active model's context window (from `result.modelUsage[…].contextWindow`,
    /// e.g. 200k or 1M for Opus in 1M mode). `None` until a `result` reports it; once
    /// known it is kept across turns that omit it. The ring's denominator.
    pub context_window: Option<u64>,
    /// Latest subscription rate-limit snapshot (from `rate_limit_event`). `None` until
    /// the CLI emits one. NOTE: the stream only carries status + reset, NOT a usage
    /// percentage — that lives behind the `/api/oauth/usage` endpoint (separate task).
    pub rate_limit: Option<RateLimitSnapshot>,
}

/// Context-meter seed for a conversation, read from its on-disk transcript so the
/// ring shows the real fill the moment a conversation is opened / its stream turned
/// on — before the first new turn streams live usage. `context_window` is the model's
/// provisional window (the transcript carries no authoritative `modelUsage`); the
/// first live `result` later refines it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ContextFill {
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
}

/// Subscription rate-limit status, normalized from `rate_limit_event.rate_limit_info`.
/// Carries only what the stream-json protocol exposes: the coarse `status`, the
/// reset time, the window type, and whether overage is active. The precise usage
/// percentage is NOT in the stream (it comes from `GET /api/oauth/usage`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct RateLimitSnapshot {
    /// `"allowed"` (no warning), `"allowed_warning"` (approaching), `"rejected"` (limited), …
    pub status: Option<String>,
    /// Unix epoch seconds when the current window resets.
    pub resets_at: Option<i64>,
    /// Which window this refers to: `"five_hour"`, `"seven_day"`, …
    pub limit_type: Option<String>,
    /// `true` while the account is spending overage credits.
    pub using_overage: bool,
}

/// One authoritative content block of an assistant message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedBlock {
    Text { text: String },
    Thinking { text: String },
    ToolUse { id: String, name: String, input: Value },
    /// Any block kind we do not specialize (images, documents, …) kept raw.
    Other { raw: Value },
}

/// A normalized conversation event the UI applies incrementally. Tagged on
/// `kind` so the TS side is a simple discriminated union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationItem {
    /// An assistant turn began (from `stream_event/message_start`).
    MessageStarted {
        id: String,
        role: String,
        parent_tool_use_id: Option<String>,
    },
    /// Live assistant text token(s) (from `content_block_delta/text_delta`).
    TextDelta {
        message_id: Option<String>,
        text: String,
    },
    /// Live extended-thinking token(s).
    ThinkingDelta {
        message_id: Option<String>,
        text: String,
    },
    /// A past user turn, replayed from Claude's transcript when a conversation is
    /// resumed. The live path never emits this — the UI adds user turns
    /// optimistically on send — so it only appears during history restore.
    UserMessage {
        id: String,
        text: String,
        parent_tool_use_id: Option<String>,
    },
    /// The authoritative assembled assistant message (text + tool_use blocks).
    /// Carries the same `id` as the streamed `message_start` — the UI reconciles.
    AssistantMessage {
        id: String,
        blocks: Vec<NormalizedBlock>,
        parent_tool_use_id: Option<String>,
    },
    /// A tool result, delivered by the CLI as a `user` message.
    ToolResult {
        tool_use_id: String,
        content: Value,
        is_error: bool,
        parent_tool_use_id: Option<String>,
    },
    /// End of a turn (`result`).
    TurnResult {
        subtype: String,
        is_error: bool,
        result: Option<Value>,
        /// API-level error status on an errored turn (e.g. `"overloaded"`); `None` on
        /// success or when the CLI omits it. Drives a typed error heading in the UI.
        api_error_status: Option<String>,
        total_cost_usd: Option<f64>,
        num_turns: Option<u64>,
        duration_ms: Option<u64>,
    },
    /// A non-conversational notice surfaced in the timeline. Two families:
    ///  - informational: `control_change` (a confirmed model/effort/mode move),
    ///    compact boundaries, …
    ///  - errors: `control_error`, `process_exited`, `send_failed`, `protocol_error`,
    ///    and the generic `error` — each carries `detail.message` (+ optional
    ///    `detail.detail`/`stderr`/`exit_code`) and renders as a visible error bubble.
    ///    This is the single channel any layer uses to surface an error without new
    ///    plumbing (the "zero silent error" contract).
    Notice {
        subtype: String,
        detail: Value,
    },
}

/// A `can_use_tool` permission prompt surfaced to the UI. The UI answers it via
/// the `answer_permission` command, echoing `request_id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PermissionRequestPayload {
    pub request_id: String,
    pub tool_name: String,
    pub tool_use_id: String,
    pub input: Value,
    pub title: Option<String>,
    pub description: Option<String>,
    /// CLI-provided suggestions (kept raw).
    pub suggestions: Value,
}

/// One slash command available in the session, as advertised by the CLI in its
/// `initialize` control response (spec §4.4). The same shape the official VS Code
/// extension consumes to drive its `/` autocomplete menu. `name` carries NO
/// leading slash (e.g. `"compact"`, `"tosse-workflow:pickup"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SlashCommand {
    pub name: String,
    /// Human-readable description (may be empty). For skills, the CLI prefixes a
    /// `(plugin)` / `(dynamic workflow)` source hint.
    pub description: String,
    /// Hint for the command's arguments (e.g. `"<task_id>"`), empty when none.
    pub argument_hint: String,
}

/// Which producer a background task came from. The `claude` binary runs ONE generic
/// background-task system for four producers; we tell them apart from `task_type`
/// plus the correlated `tool_use` name (see [`super::assembler`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskKind {
    /// A sub-agent launched by the `Agent` tool (`task_type:"local_agent"`).
    Agent,
    /// A dynamic-workflow run launched by the `Workflow` tool.
    Workflow,
    /// A shell command launched by `Bash` with `run_in_background:true`.
    Bash,
    /// A live watch launched by the `Monitor` tool.
    Monitor,
    /// A background task whose producer could not be classified yet.
    Other,
}

/// Coarse lifecycle status of a background task, normalized from `task_*` events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskStatus {
    /// Created and not yet finished (`task_started`, or a non-terminal patch).
    Running,
    /// Finished successfully (`patch.status`/notification `"completed"`).
    Completed,
    /// Finished with an error (`"failed"`/`"error"`).
    Failed,
    /// Cancelled via `TaskStop` / session end (`"stopped"`/`"cancelled"`).
    Stopped,
}

/// A normalized background task, keyed by `task_id` and updated in place as its
/// `task_*` lifecycle events arrive. The single model behind the (future) sub-agent /
/// workflow / Monitor / background-Bash views — the rich per-producer detail (full
/// transcript, manifest, output) is read from disk on demand (see
/// [`super::subagents`]), never carried here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct BackgroundTask {
    /// Stable id that ties every `task_*` event of this task together.
    pub task_id: String,
    pub kind: BackgroundTaskKind,
    /// The `tool_use` block that spawned the task (== `parent_tool_use_id` of any
    /// streamed child content). Lets the UI anchor the task under its tool card.
    pub tool_use_id: Option<String>,
    /// Human label (the `description`: a sub-agent's task, a Bash command, …).
    pub label: Option<String>,
    /// Sub-agent type (`Agent` only, e.g. `"Explore"`).
    pub subagent_type: Option<String>,
    /// Model the sub-agent ran on (`Agent` only), e.g. `"claude-haiku-4-5"`. Captured
    /// from the sub-agent's streamed `assistant` message (`message.model`) — the wire's
    /// ONLY place a sub-agent's model surfaces (it is absent from every `task_*` event
    /// and from the normalized transcript). `None` for non-agent tasks, or until the
    /// sub-agent streams its first assistant message.
    pub model: Option<String>,
    /// The sub-agent's id (`Agent` only), i.e. the key for [`super::subagents::load_subagent_transcript`].
    /// Derived from the `output_file` basename (`subagents/agent-<agentId>.jsonl`), since
    /// the wire carries it only inside that path. Lets the UI drill into the transcript
    /// without re-parsing the path itself.
    pub agent_id: Option<String>,
    pub status: BackgroundTaskStatus,
    /// Latest live progress text (`Workflow`: `"<phase>: <label>"`).
    pub progress: Option<String>,
    /// Total tokens used (from the `task_notification` usage roll-up).
    pub tokens: Option<u64>,
    /// Tool-call count (from the usage roll-up).
    pub tool_uses: Option<u64>,
    /// Wall-clock duration in ms (from the usage roll-up).
    pub duration_ms: Option<u64>,
    /// End-of-task human summary (from the `task_notification`).
    pub summary: Option<String>,
    /// On-disk file holding the task's full output: `tasks/<id>.output` for
    /// Bash-bg/Monitor, the sub-agent transcript for `Agent`.
    pub output_file: Option<String>,
}

/// One phase of a workflow run, from a `workflows/wf_<id>.json` manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPhase {
    pub title: String,
    pub detail: Option<String>,
}

/// A workflow run's manifest (`workflows/wf_<id>.json`), the data model behind the
/// `/workflows`-style view. Field names mirror the on-disk camelCase manifest. The
/// dynamic, per-entry-shaped `workflowProgress` and `result` are kept raw
/// ([`Value`]) — the Workflow display task types them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub run_id: String,
    pub task_id: Option<String>,
    pub status: Option<String>,
    pub workflow_name: Option<String>,
    pub default_model: Option<String>,
    pub duration_ms: Option<u64>,
    pub agent_count: Option<u64>,
    pub total_tokens: Option<u64>,
    pub total_tool_calls: Option<u64>,
    pub summary: Option<String>,
    /// `#[serde(default)]` alone covers a MISSING key, but an explicit `"phases":null`
    /// would still fail the WHOLE manifest parse (blanking the entire workflow view).
    /// `deserialize_null_default` maps null → empty, mirroring the stream structs'
    /// `Option` null-tolerance ([`super::protocol::TaskNotificationMsg::usage`]).
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub phases: Vec<WorkflowPhase>,
    /// Array of `{type:"workflow_phase"|"workflow_agent", …}` entries — kept raw.
    #[serde(default)]
    pub workflow_progress: Value,
    /// The workflow's final return value — kept raw.
    #[serde(default)]
    pub result: Value,
}

/// Deserialize that maps an explicit JSON `null` to `T::default()`. `#[serde(default)]`
/// alone only substitutes the default for a MISSING key — an explicit `"field": null`
/// still fails the whole struct. Pair the two (`#[serde(default, deserialize_with = …)]`)
/// for a manifest field the CLI may write as `null`.
fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// What a session emits to the outside world.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    State(SessionStatePayload),
    Item(ConversationItem),
    Permission(PermissionRequestPayload),
    /// The session's available slash commands (one-shot, from the `initialize`
    /// control response). Drives the composer's `/` autocomplete.
    Commands(Vec<SlashCommand>),
    /// A background task was created or changed state. Emitted on every `task_*`
    /// transition, keyed by `task_id`, so the UI tracks the live fleet of
    /// sub-agents / workflows / watches / background shells.
    Task(BackgroundTask),
    /// A model-generated conversation title (from a `generate_session_title` control
    /// response). The UI triggers it on each of the first few user messages of an
    /// untitled conversation (regenerated from the accumulated intent until it
    /// settles), carrying the monotonic `seq` it sent so the UI can drop an
    /// out-of-order (stale) response. Applied as the name UNLESS the user set a
    /// custom title in the meantime.
    Title { title: String, seq: u32 },
}

/// Sink for a session's events. The IPC layer implements this over a Tauri
/// `AppHandle` (emitting tauri-specta events); tests implement it over a channel.
pub trait SessionEmitter: Send + Sync + 'static {
    fn emit_state(&self, session: &str, state: &SessionStatePayload);
    fn emit_item(&self, session: &str, item: &ConversationItem);
    fn emit_permission(&self, session: &str, request: &PermissionRequestPayload);
    fn emit_commands(&self, session: &str, commands: &[SlashCommand]);
    fn emit_task(&self, session: &str, task: &BackgroundTask);
    fn emit_title(&self, session: &str, title: &str, seq: u32);
}
