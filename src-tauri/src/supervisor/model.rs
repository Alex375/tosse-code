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
    /// Current model id (from `system/init`).
    pub model: Option<String>,
    /// Current permission mode (from `system/init` / `set_permission_mode`).
    pub permission_mode: Option<String>,
    /// Fine-grained activity hint from `system/status` (e.g. `"requesting"`).
    pub activity: Option<String>,
    /// `true` while waiting on the user to answer a permission prompt.
    pub awaiting_permission: bool,
    /// `true` once the session has ended (the `claude` process exited or was
    /// stopped). A final state event with this set lets the UI mark the session
    /// dead instead of showing it as live forever.
    pub ended: bool,
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
        total_cost_usd: Option<f64>,
        num_turns: Option<u64>,
        duration_ms: Option<u64>,
    },
    /// A non-conversational system notice (compact boundary, sub-agent task
    /// lifecycle, …) surfaced raw for now.
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

/// What a session emits to the outside world.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    State(SessionStatePayload),
    Item(ConversationItem),
    Permission(PermissionRequestPayload),
    /// The session's available slash commands (one-shot, from the `initialize`
    /// control response). Drives the composer's `/` autocomplete.
    Commands(Vec<SlashCommand>),
}

/// Sink for a session's events. The IPC layer implements this over a Tauri
/// `AppHandle` (emitting tauri-specta events); tests implement it over a channel.
pub trait SessionEmitter: Send + Sync + 'static {
    fn emit_state(&self, session: &str, state: &SessionStatePayload);
    fn emit_item(&self, session: &str, item: &ConversationItem);
    fn emit_permission(&self, session: &str, request: &PermissionRequestPayload);
    fn emit_commands(&self, session: &str, commands: &[SlashCommand]);
}
