//! Wire types for the Codex `app-server` JSON-RPC protocol (newline-delimited over
//! stdio) — the Codex equivalent of the Claude backend's `supervisor::protocol`.
//!
//! This is the SOCLE subset: enough to handshake (`initialize`), open a thread
//! (`thread/start`), run a turn (`turn/start`), and decode the handful of inbound
//! notifications a plain text turn produces. The full ~18 `ThreadItem` types + rich
//! rendering land in the next phase (4.1).
//!
//! Three tolerance rules (the app-server drifts across binary versions, exactly like
//! the Claude wire we already version-pin):
//!   1. **Never require `jsonrpc`** — the server OMITS it in its responses and
//!      notifications. Our envelope makes it `Option` and ignores it. (We DO send it
//!      outbound: it is valid JSON-RPC and proven accepted by the live binary.)
//!   2. **Never `deny_unknown_fields`** — a newer app-server that adds fields must
//!      still decode.
//!   3. **Unknown shapes/methods/items → a fallback, never a hard error** — an
//!      unrecognized top-level shape is [`Incoming::Malformed`]; an unmodelled
//!      `ThreadItem` type is [`ThreadItem::Unknown`]; a drifting enum string (e.g.
//!      `Turn.status`) is kept as a plain `String`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// JSON-RPC id. The server echoes back whatever we sent; the extension namespaces
/// them as strings, so we always SEND strings — but tolerate a numeric id inbound.
pub type RequestId = String;

// ---------------------------------------------------------------------------
// Inbound: a permissive envelope + a classifier
// ---------------------------------------------------------------------------

/// Permissive envelope for ANY incoming line. Every field is optional so a
/// response (`id`+`result`), a notification (`method`+`params`), and a server
/// request (`id`+`method`+`params`) all decode into the same struct; [`classify`]
/// then tells them apart by which fields are present. `jsonrpc` is accepted but
/// ignored (the server omits it).
#[derive(Debug, Clone, Deserialize)]
pub struct RawMessage {
    #[serde(default)]
    pub jsonrpc: Option<String>,
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<Value>,
}

/// A classified incoming message. This is what the transport delivers and the
/// server's demux task dispatches on.
#[derive(Debug, Clone)]
pub enum Incoming {
    /// A reply to one of OUR requests (correlate by `id` against the pending table).
    Response {
        id: RequestId,
        result: Option<Value>,
        error: Option<Value>,
    },
    /// A server-initiated notification (no reply expected). Routed to a thread's
    /// actor by `params.threadId` when present.
    Notification { method: String, params: Value },
    /// A server-initiated request that EXPECTS a reply keyed by `id` (approvals,
    /// elicitations, currentTime/read…). Routed by `params.threadId`.
    ServerRequest {
        id: RequestId,
        method: String,
        params: Value,
    },
    /// A line that fit no JSON-RPC shape (neither `method` nor `id`). Kept so the
    /// caller can log it instead of dropping silently.
    Malformed(Value),
}

impl Incoming {
    /// The `threadId` this message is scoped to, if any — the routing key the
    /// shared app-server's demux uses to fan a message out to the right
    /// conversation actor. Present on every thread-scoped notification and server
    /// request (`params.threadId`); absent on responses and global notifications.
    pub fn thread_id(&self) -> Option<&str> {
        match self {
            Incoming::Notification { params, .. } | Incoming::ServerRequest { params, .. } => {
                params.get("threadId").and_then(Value::as_str)
            }
            _ => None,
        }
    }
}

/// Coerce a JSON-RPC id (string per spec, tolerated numeric) to a string.
fn id_to_string(v: &Value) -> Option<RequestId> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Sort a raw envelope into one of the four JSON-RPC shapes by presence of
/// `method`/`id`. `(method, id)` → server request ; `(method, _)` → notification ;
/// `(_, id)` → response ; neither → malformed.
pub fn classify(raw: RawMessage) -> Incoming {
    let id = raw.id.as_ref().and_then(id_to_string);
    match (raw.method, id) {
        (Some(method), Some(id)) => Incoming::ServerRequest {
            id,
            method,
            params: raw.params.unwrap_or(Value::Null),
        },
        (Some(method), None) => Incoming::Notification {
            method,
            params: raw.params.unwrap_or(Value::Null),
        },
        (None, Some(id)) => Incoming::Response {
            id,
            result: raw.result,
            error: raw.error,
        },
        (None, None) => Incoming::Malformed(json!({
            "params": raw.params,
            "result": raw.result,
            "error": raw.error,
        })),
    }
}

/// Parse one NDJSON line into a classified [`Incoming`]. A JSON parse failure is the
/// only error; every *valid* JSON object classifies (worst case [`Incoming::Malformed`]).
pub fn parse_incoming(line: &str) -> serde_json::Result<Incoming> {
    Ok(classify(serde_json::from_str::<RawMessage>(line)?))
}

// ---------------------------------------------------------------------------
// Inbound payloads (socle subset) — decoded from `Incoming::Notification.params`
// by the conversation actor.
// ---------------------------------------------------------------------------

/// A streaming text token scoped to an item — the shape shared by
/// `item/agentMessage/delta`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`
/// and `item/commandExecution/outputDelta` (all carry `{threadId, turnId, itemId, delta}`
/// plus a delta-specific index we ignore). One struct decodes them all; the actor routes
/// on the notification `method`, not the payload shape.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDelta {
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub delta: String,
}

/// `item/started` / `item/completed` — a thread item that just began or finished. Both
/// notifications carry the SAME envelope (`{item, threadId, turnId, …AtMs}`); the actor
/// tells them apart by method. `item.id` is the stable key we reuse as the normalized
/// tool_use / message id so the front's id-keyed store reconciles the pair.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEnvelope {
    pub item: ThreadItem,
}

/// Back-compat alias: the socle referred to the completed envelope as `ItemCompleted`.
pub type ItemCompleted = ItemEnvelope;

/// `turn/diff/updated` — the latest aggregated unified git diff across every file change
/// in the turn. We keep it for a future turn-level diff view (phase 4.3); per-file diffs
/// already ride on each `fileChange` item.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDiffUpdated {
    #[serde(default)]
    pub diff: String,
}

/// One file's change inside a `fileChange` item: a `path`, an add/modify/delete `kind`,
/// and a per-file unified `diff`. ⚠️ `kind` is a TAGGED OBJECT on the wire
/// (`{"type":"add"}` — a `PatchChangeKind`), NOT a plain string — verified against the
/// live binary — so it's kept raw ([`Value`], tolerance rule 3); modelling it as `String`
/// would fail the whole `fileChange` decode and silently drop the card. `Serialize` so the
/// actor can round-trip it into a tool card's input/result JSON.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUpdateChange {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub kind: Value,
    #[serde(default)]
    pub diff: String,
}

/// A thread content item. Phase 4.1 models the item types a normal coding turn produces
/// (assistant text, reasoning, shell commands, file edits, MCP tool calls, plan, web
/// search); every other `type` (dynamicToolCall, collabAgentToolCall, imageView, review
/// modes, …) decodes to [`ThreadItem::Unknown`] — rendered generically or ignored, never
/// a hard parse error (tolerance rule 3). Field-level defaults keep a drifting item from
/// failing the whole `item/*` decode.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadItem {
    AgentMessage {
        id: String,
        #[serde(default)]
        text: String,
    },
    /// The model's reasoning. `summary` is the human-facing reasoning summary; `content`
    /// is the raw chain (often redacted/empty). BOTH map to a `Thinking` block — NEVER
    /// `Text`, or the raw reasoning would leak into the visible answer.
    Reasoning {
        id: String,
        #[serde(default)]
        summary: Vec<String>,
        #[serde(default)]
        content: Vec<String>,
    },
    /// A shell command execution → a `Bash` tool card. The command is known at
    /// `item/started`; the output + exit code arrive at `item/completed`.
    #[serde(rename_all = "camelCase")]
    CommandExecution {
        id: String,
        #[serde(default)]
        command: String,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        aggregated_output: Option<String>,
        #[serde(default)]
        exit_code: Option<i64>,
        #[serde(default)]
        status: Option<String>,
    },
    /// A patch applied to one or more files → an `ApplyPatch` tool card carrying the
    /// per-file unified diffs.
    FileChange {
        id: String,
        #[serde(default)]
        changes: Vec<FileUpdateChange>,
        #[serde(default)]
        status: Option<String>,
    },
    /// An MCP tool call → an `mcp__<server>__<tool>` tool card.
    #[serde(rename_all = "camelCase")]
    McpToolCall {
        id: String,
        #[serde(default)]
        server: Option<String>,
        #[serde(default)]
        tool: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        arguments: Value,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<Value>,
    },
    /// The agent's running plan (a single markdown blob) → a `Text` block.
    Plan {
        id: String,
        #[serde(default)]
        text: String,
    },
    /// A web search → a `WebSearch` tool card.
    WebSearch {
        id: String,
        #[serde(default)]
        query: String,
    },
    /// Any item type phase 4.1 does not specialize.
    #[serde(other)]
    Unknown,
}

/// `item/commandExecution/requestApproval` — a server request (blocks the turn) asking
/// us to approve a shell command. Carries the command itself, so the UI prompt is rich
/// without needing to correlate the started item. `Default` so a drifting payload still
/// yields a (generic) prompt instead of dropping the request unanswered.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandApprovalParams {
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `item/fileChange/requestApproval` — a server request asking us to approve a patch.
/// It carries only `itemId` + an optional `reason`; the diff rides on the correlated
/// `fileChange` item (already rendered as a card keyed by the same `itemId`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeApprovalParams {
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `turn/completed` — the end of a turn.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompleted {
    pub turn: Turn,
}

/// A turn's terminal state. EVERY field is optional/defaulted so a drifting shape
/// never fails the whole `turn/completed` decode (tolerance rule 3): `status` is a
/// plain `String` (not an enum), and `id` is optional (we never read it — the turn is
/// identified by its thread route, not this id). The actor additionally clears `busy`
/// UNCONDITIONALLY on `turn/completed`, so even a totally-unparseable turn payload can
/// never wedge the UI spinner.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub error: Option<Value>,
}

/// `error` — a server-side error notification. `will_retry` distinguishes a
/// transient error (the turn continues) from a terminal one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorNotification {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub will_retry: Option<bool>,
}

/// The subscription rate-limit snapshot, carried by the `account/rateLimits/updated`
/// PUSH (`params.rateLimits`) and the `account/rateLimits/read` response (`.rateLimits`).
/// Sparse: a window may be absent/null on a push (only the one that moved), so the
/// front merges onto its last snapshot. Only the two windows the usage ring needs are
/// modelled (`primary`/`secondary`); everything else (credits, plan type, …) is ignored
/// (permissive — tolerance rule 2). Mapped to [`crate::usage::PlanUsage`] by
/// `session::rate_limits_to_plan_usage`, keyed by `windowDurationMins` (300 → 5h,
/// 10080 → weekly).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitSnapshot {
    #[serde(default)]
    pub primary: Option<RateLimitWindow>,
    #[serde(default)]
    pub secondary: Option<RateLimitWindow>,
}

/// One rate-limit window: a fill percentage (already 0–100), the window length in
/// minutes (300 = 5h, 10080 = weekly — how we tell the two windows apart), and an epoch
/// reset time. `resetsAt` is kept as `f64` (the unit, seconds vs ms, is normalized when
/// mapping to the UI shape).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    #[serde(default)]
    pub used_percent: f64,
    #[serde(default)]
    pub window_duration_mins: Option<i64>,
    #[serde(default)]
    pub resets_at: Option<f64>,
}

// ---------------------------------------------------------------------------
// Outbound: JSON-RPC envelope builders + typed params
// ---------------------------------------------------------------------------

/// Build an outbound request line: `{jsonrpc, id, method, params}`. We DO include
/// `jsonrpc` (valid, proven accepted live); the server may omit it in its reply.
pub fn request(id: &str, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// Build an outbound notification line. `params` is omitted entirely when `None`
/// (the `initialized` handshake notification carries no params).
pub fn notification(method: &str, params: Option<Value>) -> Value {
    match params {
        Some(p) => json!({ "jsonrpc": "2.0", "method": method, "params": p }),
        None => json!({ "jsonrpc": "2.0", "method": method }),
    }
}

/// Build a success reply to a server request (echo its `id`).
pub fn reply_result(id: &str, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

/// Build an error reply to a server request. Used defensively to decline approvals
/// we cannot honor in-band, so the server never blocks waiting on us.
pub fn reply_error(id: &str, code: i64, message: &str) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message } })
}

/// The `initialize` params — who we are + our capabilities.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub capabilities: ClientCapabilities,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    pub experimental_api: bool,
    pub request_attestation: bool,
}

/// The `thread/start` params. `model` is the conversation's chosen Codex model (a real
/// wire id from `model/list`, e.g. `gpt-5.5`); omitted → the server's default model.
/// Sandbox/approval defaults are set by `CodexServer::start_thread`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
}

/// The `turn/start` params — a user turn scoped to a thread. Beyond the input, every
/// composer control for Codex rides here as a per-turn OVERRIDE ("for this turn and
/// subsequent turns", verified live): there is no `thread/settings/update` on the
/// app-server, so the model / effort / approval policy / sandbox / reasoning summary /
/// personality are (re)asserted on each turn from the conversation's live controls.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub thread_id: String,
    pub input: Vec<UserInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    /// The tagged `SandboxPolicy` object (built from sandbox mode + network access).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personality: Option<String>,
}

impl TurnStartParams {
    /// A plain text/attachment turn with NO control overrides (the base the actor then
    /// layers the conversation's live [`CodexControls`] onto).
    pub fn new(thread_id: String, input: Vec<UserInput>) -> Self {
        Self {
            thread_id,
            input,
            model: None,
            effort: None,
            approval_policy: None,
            sandbox_policy: None,
            summary: None,
            personality: None,
        }
    }
}

/// The Codex-specific composer controls, mirrored from the front and applied as
/// per-turn overrides on `turn/start`. Every field is optional — an unset field leaves
/// the server's current value untouched. Sent alongside each user message (the wire is
/// per-turn), so a mid-conversation change takes effect on the next turn. This is an
/// IPC param → derives `specta::Type` for the generated TS binding.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexControls {
    /// Codex model id (e.g. `gpt-5.5`). Overrides the model for this turn onward.
    pub model: Option<String>,
    /// `ReasoningEffort` (freeform string per the model's `supportedReasoningEfforts`).
    pub effort: Option<String>,
    /// Sandbox mode key: `readOnly` | `workspaceWrite` | `dangerFullAccess`.
    pub sandbox: Option<String>,
    /// Whether the sandbox may reach the network (folds into the `SandboxPolicy`).
    pub network_access: Option<bool>,
    /// `AskForApproval`: `untrusted` | `on-failure` | `on-request` | `never`.
    pub approval_policy: Option<String>,
    /// `ReasoningSummary`: `auto` | `concise` | `detailed` | `none`.
    pub summary: Option<String>,
    /// `Personality`: `none` | `friendly` | `pragmatic`.
    pub personality: Option<String>,
}

/// The outcome of a native `thread/fork` (+ optional `thread/rollback` of the new thread
/// to the cut point): the id of the freshly forked thread + its resolved model. IPC OUTPUT
/// type (`specta::Type` + `Serialize`); the front turns `thread_id` into a new Codex
/// conversation record (like reactivating a disk conversation, but for a branch).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexForkResult {
    pub thread_id: String,
    pub model: Option<String>,
}

/// A Codex model, flattened from `model/list` for the composer's picker. IPC OUTPUT
/// type (`specta::Type` + `Serialize`); parsed from the wire `Model` in `list_models`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub display_name: String,
    /// The reasoning-effort ids the model accepts (`supportedReasoningEfforts`).
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub is_default: bool,
}

/// A Codex skill, flattened from `skills/list` into the shape the composer's `/` menu
/// reuses from the Claude slash-command catalogue (name + description).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkill {
    pub name: String,
    pub description: String,
}

impl CodexControls {
    /// Build the tagged `SandboxPolicy` object the app-server expects on `turn/start`
    /// from the sandbox mode + network toggle. `None` when no sandbox mode is set.
    fn sandbox_policy(&self) -> Option<Value> {
        let net = self.network_access.unwrap_or(false);
        match self.sandbox.as_deref()? {
            "readOnly" => Some(json!({ "type": "readOnly", "networkAccess": net })),
            "workspaceWrite" => Some(json!({
                "type": "workspaceWrite",
                "writableRoots": [],
                "networkAccess": net,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false,
            })),
            "dangerFullAccess" => Some(json!({ "type": "dangerFullAccess" })),
            // An unknown mode is ignored rather than sending a malformed policy.
            _ => None,
        }
    }

    /// Layer these controls onto a base `turn/start` params as per-turn overrides.
    pub fn apply_to(&self, p: &mut TurnStartParams) {
        if self.model.is_some() {
            p.model = self.model.clone();
        }
        if self.effort.is_some() {
            p.effort = self.effort.clone();
        }
        if self.approval_policy.is_some() {
            p.approval_policy = self.approval_policy.clone();
        }
        if let Some(sp) = self.sandbox_policy() {
            p.sandbox_policy = Some(sp);
        }
        if self.summary.is_some() {
            p.summary = self.summary.clone();
        }
        if self.personality.is_some() {
            p.personality = self.personality.clone();
        }
    }
}

/// A single user-input block. `text_elements` is omitted on text — proven optional
/// against the live binary. Codex takes image attachments as a `localImage` pointing at
/// a file PATH (not base64 like Claude): the actor materializes joined images to temp
/// files and references them here (see `session::user_inputs`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInput {
    Text { text: String },
    LocalImage { path: String },
}

impl UserInput {
    pub fn text(s: impl Into<String>) -> Self {
        UserInput::Text { text: s.into() }
    }
    pub fn local_image(path: impl Into<String>) -> Self {
        UserInput::LocalImage { path: path.into() }
    }
}

/// The `turn/start` result — carries the just-started turn (we keep its id so an
/// `Interrupt` can target the live turn, which `turn/interrupt` requires alongside the
/// threadId).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResult {
    pub turn: Turn,
}

/// The `thread/start` result — carries the new thread's id (our routing + resume key).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResult {
    pub thread: ThreadRef,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRef {
    pub id: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_sorts_the_four_shapes() {
        // Response: id + result, no method, NO jsonrpc (as the server sends).
        let r = parse_incoming(r#"{"id":"1","result":{"ok":true}}"#).unwrap();
        assert!(matches!(r, Incoming::Response { id, .. } if id == "1"));
        // Notification: method + params, no id.
        let n = parse_incoming(r#"{"method":"turn/completed","params":{"threadId":"t"}}"#).unwrap();
        assert!(matches!(&n, Incoming::Notification { method, .. } if method == "turn/completed"));
        assert_eq!(n.thread_id(), Some("t"));
        // Server request: id + method + params.
        let s = parse_incoming(
            r#"{"id":"9","method":"item/fileChange/requestApproval","params":{"threadId":"t"}}"#,
        )
        .unwrap();
        assert!(matches!(s, Incoming::ServerRequest { id, .. } if id == "9"));
        // Malformed: neither method nor id.
        let m = parse_incoming(r#"{"foo":1}"#).unwrap();
        assert!(matches!(m, Incoming::Malformed(_)));
    }

    #[test]
    fn numeric_id_is_tolerated() {
        // We send string ids, but a numeric id inbound must still classify.
        let r = parse_incoming(r#"{"id":7,"result":null}"#).unwrap();
        assert!(matches!(r, Incoming::Response { id, .. } if id == "7"));
    }

    #[test]
    fn unknown_notification_still_classifies() {
        // A method the socle does not model is still a well-formed Notification —
        // the actor ignores it, but the parser never fails.
        let n =
            parse_incoming(r#"{"method":"item/reasoning/textDelta","params":{"threadId":"t","delta":"x"}}"#)
                .unwrap();
        assert!(matches!(n, Incoming::Notification { .. }));
    }

    #[test]
    fn unmodelled_thread_item_decodes_to_unknown_not_error() {
        // An item type phase 4.1 does not specialize (dynamicToolCall) must decode, not fail.
        let p: ItemCompleted = serde_json::from_value(
            json!({"item":{"type":"dynamicToolCall","id":"d1","tool":"x","arguments":{}}}),
        )
        .unwrap();
        assert!(matches!(p.item, ThreadItem::Unknown));
        // The assistant text item round-trips with its text.
        let p2: ItemCompleted =
            serde_json::from_value(json!({"item":{"type":"agentMessage","id":"m1","text":"hi"}})).unwrap();
        assert!(matches!(p2.item, ThreadItem::AgentMessage { text, .. } if text == "hi"));
    }

    #[test]
    fn tool_items_decode_with_camelcase_fields() {
        // commandExecution: camelCase fields (aggregatedOutput, exitCode) + drifting status.
        let c: ItemEnvelope = serde_json::from_value(json!({"item":{
            "type":"commandExecution","id":"c1","command":"ls -la","cwd":"/tmp",
            "aggregatedOutput":"a\nb","exitCode":0,"status":"completed","unknownField":1
        }}))
        .unwrap();
        match c.item {
            ThreadItem::CommandExecution { command, aggregated_output, exit_code, .. } => {
                assert_eq!(command, "ls -la");
                assert_eq!(aggregated_output.as_deref(), Some("a\nb"));
                assert_eq!(exit_code, Some(0));
            }
            other => panic!("expected CommandExecution, got {other:?}"),
        }
        // fileChange: per-file diffs.
        let f: ItemEnvelope = serde_json::from_value(json!({"item":{
            "type":"fileChange","id":"f1","status":"completed",
            "changes":[{"path":"src/a.rs","kind":"modify","diff":"@@ -1 +1 @@"}]
        }}))
        .unwrap();
        match f.item {
            ThreadItem::FileChange { changes, .. } => {
                assert_eq!(changes.len(), 1);
                assert_eq!(changes[0].path, "src/a.rs");
                assert_eq!(changes[0].diff, "@@ -1 +1 @@");
            }
            other => panic!("expected FileChange, got {other:?}"),
        }
        // reasoning: summary + content both present.
        let r: ItemEnvelope = serde_json::from_value(json!({"item":{
            "type":"reasoning","id":"r1","summary":["planning"],"content":[]
        }}))
        .unwrap();
        assert!(matches!(r.item, ThreadItem::Reasoning { summary, .. } if summary == vec!["planning"]));
    }

    #[test]
    fn command_approval_params_decode() {
        let p: CommandApprovalParams = serde_json::from_value(json!({
            "threadId":"t","turnId":"u","itemId":"c1","command":"rm x","cwd":"/tmp","reason":"why"
        }))
        .unwrap();
        assert_eq!(p.item_id.as_deref(), Some("c1"));
        assert_eq!(p.command.as_deref(), Some("rm x"));
    }

    #[test]
    fn turn_status_tolerates_an_unseen_value() {
        // A drifting status string must not fail turn/completed.
        let t: TurnCompleted =
            serde_json::from_value(json!({"turn":{"id":"t1","status":"someFutureStatus"}})).unwrap();
        assert_eq!(t.turn.status, "someFutureStatus");
    }

    #[test]
    fn unknown_fields_are_ignored() {
        // A newer app-server that adds a field must still decode (no deny_unknown_fields).
        // One `ItemDelta` decodes every itemId+delta notification (agent / reasoning / output).
        let d: ItemDelta = serde_json::from_value(
            json!({"threadId":"t","itemId":"i","delta":"tok","contentIndex":0,"brandNewField":123}),
        )
        .unwrap();
        assert_eq!(d.delta, "tok");
        assert_eq!(d.item_id.as_deref(), Some("i"));
    }

    #[test]
    fn outbound_request_has_no_hidden_fields_and_omits_notification_params() {
        let req = request("3", "turn/start", json!({"threadId":"t"}));
        assert_eq!(req["jsonrpc"], "2.0");
        assert_eq!(req["id"], "3");
        assert_eq!(req["method"], "turn/start");
        // `initialized` carries NO params key at all.
        let note = notification("initialized", None);
        assert_eq!(note["method"], "initialized");
        assert!(note.get("params").is_none());
    }

    #[test]
    fn user_input_text_omits_text_elements() {
        let v = serde_json::to_value(UserInput::text("hello")).unwrap();
        assert_eq!(v, json!({"type":"text","text":"hello"}));
    }

    #[test]
    fn codex_controls_apply_as_turn_overrides_with_a_tagged_sandbox_policy() {
        let controls = CodexControls {
            model: Some("gpt-5.5".into()),
            effort: Some("high".into()),
            sandbox: Some("workspaceWrite".into()),
            network_access: Some(true),
            approval_policy: Some("never".into()),
            summary: Some("concise".into()),
            personality: Some("friendly".into()),
        };
        let mut p = TurnStartParams::new("t".into(), vec![UserInput::text("hi")]);
        controls.apply_to(&mut p);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["model"], "gpt-5.5");
        assert_eq!(v["effort"], "high");
        assert_eq!(v["approvalPolicy"], "never");
        assert_eq!(v["summary"], "concise");
        assert_eq!(v["personality"], "friendly");
        // The sandbox is a TAGGED object (not a bare string), with network folded in.
        assert_eq!(v["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(v["sandboxPolicy"]["networkAccess"], true);

        // read-only + no network.
        let ro = CodexControls { sandbox: Some("readOnly".into()), ..Default::default() };
        let mut p2 = TurnStartParams::new("t".into(), vec![]);
        ro.apply_to(&mut p2);
        let v2 = serde_json::to_value(&p2).unwrap();
        assert_eq!(v2["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(v2["sandboxPolicy"]["networkAccess"], false);
        // An empty control set leaves the params bare (all overrides omitted).
        let empty = CodexControls::default();
        let mut p3 = TurnStartParams::new("t".into(), vec![]);
        empty.apply_to(&mut p3);
        let v3 = serde_json::to_value(&p3).unwrap();
        assert!(v3.get("model").is_none() && v3.get("sandboxPolicy").is_none());
    }

    #[test]
    fn thread_start_params_carry_model_and_omit_it_when_none() {
        let with = serde_json::to_value(ThreadStartParams {
            model: Some("gpt-5.5".into()),
            cwd: Some("/tmp".into()),
            sandbox: Some("workspace-write".into()),
            approval_policy: Some("on-request".into()),
        })
        .unwrap();
        assert_eq!(with["model"], "gpt-5.5");
        assert_eq!(with["sandbox"], "workspace-write");

        let without = serde_json::to_value(ThreadStartParams {
            model: None,
            cwd: Some("/tmp".into()),
            sandbox: None,
            approval_policy: None,
        })
        .unwrap();
        assert!(without.get("model").is_none(), "None model must be omitted, not null");
    }
}
