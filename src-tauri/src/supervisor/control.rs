//! Control channel (subtask 2).
//!
//! The control channel multiplexes `control_request` / `control_response`
//! JSON-lines over the *same* stdio stream as the conversation (spec §4). It is
//! bidirectional:
//!   - **outbound** (we → CLI): `initialize`, `interrupt`, `set_permission_mode`,
//!     `set_model`, `apply_flag_settings` (effort + ultracode), `get_settings`.
//!   - **inbound** (CLI → we): `can_use_tool` (a permission prompt), plus other
//!     subtypes we do not support yet and answer with an error.
//!
//! This module owns the wire shapes and the (de)serialization. The correlation
//! tables and the decision policy live in [`super::session`].

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;

use super::model::SlashCommand;

/// Permission mode, switched at runtime via `set_permission_mode` (spec §4.5).
/// The wire tokens are exactly these camelCase strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    AcceptEdits,
    Auto,
    BypassPermissions,
    Default,
    DontAsk,
    Plan,
}

impl PermissionMode {
    /// The exact camelCase wire token (matches the serde rename). Infallible, so
    /// callers never fall back to an empty string on a serialisation hiccup.
    pub fn as_wire(self) -> &'static str {
        match self {
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Auto => "auto",
            PermissionMode::BypassPermissions => "bypassPermissions",
            PermissionMode::Default => "default",
            PermissionMode::DontAsk => "dontAsk",
            PermissionMode::Plan => "plan",
        }
    }
}

/// A UI decision for a `can_use_tool` prompt (the `answer_permission` command
/// input). Tagged on `behavior` to mirror the protocol's result shape.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "behavior", rename_all = "snake_case")]
pub enum PermissionDecision {
    /// Allow the tool. `updated_input` optionally rewrites the tool input;
    /// `None` echoes the original input unchanged.
    Allow { updated_input: Option<Value> },
    /// Deny the tool with a human-readable reason.
    Deny { message: String },
}

/// Typed inbound `control_request` bodies (the `request` object). Only the
/// subtypes we act on are modeled; everything else falls through to `Unknown`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum InboundControl {
    CanUseTool(CanUseToolReq),
    #[serde(other)]
    Unknown,
}

/// The `can_use_tool` permission request payload (spec §5.1, snake_case fields).
#[derive(Debug, Clone, Deserialize)]
pub struct CanUseToolReq {
    pub tool_name: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub permission_suggestions: Value,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub tool_use_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub blocked_path: Option<String>,
    #[serde(default)]
    pub decision_reason: Value,
}

/// Parse an inbound `control_request` line (already deserialized to a [`Value`]
/// by the transport) into its `request_id` and the typed body.
///
/// Returns `None` only when there is no usable `request_id` (truly
/// unaddressable). The body is a `Result`: `Err` means the `request_id` was
/// fine but the `request` payload failed to type (e.g. a known subtype missing a
/// required field). The caller MUST still answer such a request with an error
/// `control_response` — otherwise the CLI hangs waiting on us. Note that
/// `#[serde(other)]` only catches unknown *subtype values*, never a typing error
/// inside a known variant, which is exactly why this distinction matters.
pub fn parse_inbound_control(v: &Value) -> Option<(String, Result<InboundControl, String>)> {
    let request_id = v.get("request_id")?.as_str()?.to_string();
    let request = v.get("request").cloned().unwrap_or(Value::Null);
    let body = serde_json::from_value::<InboundControl>(request).map_err(|e| e.to_string());
    Some((request_id, body))
}

/// Extract the slash-command list from a successful `initialize` control
/// response (spec §4.4). The list lives at `response.response.commands` and each
/// element is `{name, description, argumentHint}` (note the camelCase wire key).
/// Returns `None` for any non-`initialize`-shaped response so the caller can skip
/// it; missing per-command fields default to empty strings.
pub fn parse_initialize_commands(line: &Value) -> Option<Vec<SlashCommand>> {
    let arr = line
        .get("response")?
        .get("response")?
        .get("commands")?
        .as_array()?;
    Some(
        arr.iter()
            .filter_map(|c| {
                let name = c.get("name")?.as_str()?.to_string();
                let description = c
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let argument_hint = c
                    .get("argumentHint")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                Some(SlashCommand {
                    name,
                    description,
                    argument_hint,
                })
            })
            .collect(),
    )
}

/// A correlated outbound-request acknowledgement (`control_response`). `request_id`
/// echoes the request we sent; `ok` is true for `subtype:"success"`. On failure
/// `error` carries the CLI's message (a plain string, spec §4.1). We MUST read this
/// for our own requests (set_model / apply_flag_settings / set_permission_mode):
/// otherwise a rejection would be a silent failure.
pub struct ControlResponse {
    pub request_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Parse the outer envelope of any `control_response` into its correlation key and
/// success/error. Returns `None` when there is no nested `request_id` (so it can't
/// be matched to an outbound request).
pub fn parse_control_response(line: &Value) -> Option<ControlResponse> {
    let resp = line.get("response")?;
    let request_id = resp.get("request_id")?.as_str()?.to_string();
    let ok = resp.get("subtype").and_then(Value::as_str) == Some("success");
    let error = resp.get("error").and_then(Value::as_str).map(str::to_string);
    Some(ControlResponse { request_id, ok, error })
}

/// The live applied settings carried by a successful `get_settings` response
/// (`response.response.applied = {model, effort, ultracode}`). Each field is
/// optional — the CLI may omit one. This is the authoritative live read-back.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppliedSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub ultracode: Option<bool>,
}

/// Parse the `applied` block out of a `get_settings` control response. Returns
/// `None` when there is no `applied` object (e.g. a non-`get_settings` response).
pub fn parse_get_settings_applied(line: &Value) -> Option<AppliedSettings> {
    let applied = line.get("response")?.get("response")?.get("applied")?;
    Some(AppliedSettings {
        model: applied.get("model").and_then(Value::as_str).map(str::to_string),
        effort: applied.get("effort").and_then(Value::as_str).map(str::to_string),
        ultracode: applied.get("ultracode").and_then(Value::as_bool),
    })
}

/// The effective mode echoed by a successful `set_permission_mode` ack
/// (`response.response.mode`). The CLI confirms the mode it ACTUALLY applied, which
/// can differ from what we asked (e.g. `bypassPermissions` downgraded to `default`
/// without `--allow-dangerously-skip-permissions`). `None` if absent.
pub fn parse_set_permission_mode_ack(line: &Value) -> Option<String> {
    line.get("response")?
        .get("response")?
        .get("mode")?
        .as_str()
        .map(str::to_string)
}

/// Wrap a `request` body into a full `control_request` envelope (spec §4.1).
fn control_request(request_id: &str, request: Value) -> Value {
    json!({ "request_id": request_id, "type": "control_request", "request": request })
}

/// `initialize` — sent fire-and-forget at session start (spec §4.4). Minimal
/// body; we advertise no hooks / MCP servers / dialogs yet.
pub fn initialize_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "initialize" }))
}

/// `interrupt` — stop the current turn without killing the process (spec §2.4).
pub fn interrupt_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "interrupt" }))
}

/// `set_permission_mode` — switch the permission mode mid-session (spec §4.5).
pub fn set_permission_mode_request(request_id: &str, mode: PermissionMode) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "set_permission_mode", "mode": mode }),
    )
}

/// `set_model` — switch the active model mid-session (spec §4.5, sibling of
/// `set_permission_mode`). `model` is a CLI model id/alias passed verbatim
/// (e.g. "opus", "sonnet", "haiku", "default"). Cross-checked against the
/// official extension SDK transport (`{subtype:"set_model", model}`).
pub fn set_model_request(request_id: &str, model: &str) -> Value {
    control_request(request_id, json!({ "subtype": "set_model", "model": model }))
}

/// The reasoning-effort levels the CLI's `apply_flag_settings{effortLevel}` runtime
/// control accepts. Verified against the binary (2.1.185) and the extension settings
/// schema (`effortLevel: enum["low","medium","high","xhigh"]`): anything else is
/// silently coerced away (`.catch(void 0)`) — an ack of `success` does NOT prove a
/// value was applied. NOTE: `"max"` is a `--effort` SPAWN-flag alias only, NOT a
/// runtime settings value; `"ultracode"` is a SEPARATE boolean flag (see
/// [`set_ultracode_request`]), never an effort value. So the app must validate
/// before sending and read the result back via [`get_settings_request`].
pub const VALID_EFFORT_LEVELS: [&str; 4] = ["low", "medium", "high", "xhigh"];

/// Whether `level` is a valid runtime `effortLevel` (see [`VALID_EFFORT_LEVELS`]).
pub fn is_valid_effort_level(level: &str) -> bool {
    VALID_EFFORT_LEVELS.contains(&level)
}

/// `apply_flag_settings` — push a session flag/setting change. Used here to set the
/// reasoning effort level (one of [`VALID_EFFORT_LEVELS`]). Mirrors the extension
/// SDK (`{subtype:"apply_flag_settings", settings:{effortLevel}}`). Callers MUST
/// validate `level` first ([`is_valid_effort_level`]): the CLI swallows an invalid
/// value silently, so an unvalidated send would no-op without any error.
pub fn set_effort_level_request(request_id: &str, level: &str) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": level } }),
    )
}

/// `apply_flag_settings` toggling the **ultracode** flag (xhigh effort + standing
/// dynamic-workflow orchestration). The CLI models this as a SEPARATE boolean flag,
/// not an `effortLevel` value: enabling sends `{ultracode:true}` (the caller first
/// sets `effortLevel:"xhigh"`); disabling sends `{ultracode:null}` — `null` deletes
/// the key, which is exactly how the extension turns it off (NOT `false`). Requires
/// an xhigh-capable model with workflows enabled. Verified live against the binary.
pub fn set_ultracode_request(request_id: &str, on: bool) -> Value {
    let value = if on { Value::Bool(true) } else { Value::Null };
    control_request(
        request_id,
        json!({ "subtype": "apply_flag_settings", "settings": { "ultracode": value } }),
    )
}

/// `get_settings` — query the session's live applied settings. The response carries
/// `response.response.applied = {model, effort, ultracode}` — the ONLY reliable live
/// source of the effort level (it is absent from `system/init`) and the
/// authoritative read-back after any change, since the CLI silently coerces invalid
/// values. Verified live against the binary.
pub fn get_settings_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "get_settings" }))
}

/// `generate_session_title` — ask the binary to derive a short, human title for the
/// conversation from `description` (the user's accumulated messages so far — the
/// caller may regenerate from a growing description as the session evolves). The
/// title is produced by a model call INSIDE the `claude` binary (so it rides the Max
/// subscription, no separate API key, no prompt to maintain here). Mirrors the official VS Code
/// extension's SDK call (`{subtype:"generate_session_title", description, persist}`):
/// it auto-titles a conversation from what the user is doing. `persist:false` —
/// Tosse persists the name in its OWN store, so we never ask the binary to write an
/// `ai-title` entry into its transcript. The title comes back at
/// `response.response.title` (see [`parse_generate_session_title`]).
pub fn generate_session_title_request(request_id: &str, description: &str) -> Value {
    control_request(
        request_id,
        json!({
            "subtype": "generate_session_title",
            "description": description,
            "persist": false,
        }),
    )
}

/// Parse the generated title out of a `generate_session_title` control response. The
/// title lives at `response.response.title` (the same doubly-nested shape as
/// `get_settings`/`initialize`). Returns `None` when absent or empty — the caller
/// then keeps the optimistic placeholder rather than blanking the conversation name.
pub fn parse_generate_session_title(line: &Value) -> Option<String> {
    let title = line
        .get("response")?
        .get("response")?
        .get("title")?
        .as_str()?
        .trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// A successful `control_response` carrying a permission ALLOW result (spec §5.2).
/// Note the doubly-nested `response.response` and the camelCase result fields.
pub fn permission_allow_response(request_id: &str, tool_use_id: &str, updated_input: Value) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": "allow",
                "updatedInput": updated_input,
                "toolUseID": tool_use_id,
            }
        }
    })
}

/// A successful `control_response` carrying a permission DENY result (spec §5.2).
pub fn permission_deny_response(request_id: &str, tool_use_id: &str, message: &str) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": "deny",
                "message": message,
                "toolUseID": tool_use_id,
            }
        }
    })
}

/// An error `control_response` for an inbound request we cannot satisfy (spec
/// §4.1: `error` is a string). Used for unsupported inbound control subtypes so
/// the CLI does not hang waiting on us.
pub fn control_error_response(request_id: &str, error: &str) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": request_id, "error": error }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mode_serializes_to_exact_wire_tokens() {
        assert_eq!(serde_json::to_value(PermissionMode::AcceptEdits).unwrap(), json!("acceptEdits"));
        assert_eq!(serde_json::to_value(PermissionMode::BypassPermissions).unwrap(), json!("bypassPermissions"));
        assert_eq!(serde_json::to_value(PermissionMode::DontAsk).unwrap(), json!("dontAsk"));
        assert_eq!(serde_json::to_value(PermissionMode::Plan).unwrap(), json!("plan"));
    }

    #[test]
    fn parses_inbound_can_use_tool() {
        let line = json!({
            "type": "control_request",
            "request_id": "req-1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "input": { "command": "echo hi" },
                "tool_use_id": "toolu_123",
                "permission_suggestions": []
            }
        });
        let (rid, body) = parse_inbound_control(&line).expect("should parse");
        assert_eq!(rid, "req-1");
        match body.expect("body should type") {
            InboundControl::CanUseTool(req) => {
                assert_eq!(req.tool_name, "Bash");
                assert_eq!(req.tool_use_id, "toolu_123");
                assert_eq!(req.input["command"], json!("echo hi"));
            }
            InboundControl::Unknown => panic!("expected can_use_tool"),
        }
    }

    #[test]
    fn unknown_inbound_control_does_not_error() {
        let line = json!({
            "type": "control_request",
            "request_id": "req-2",
            "request": { "subtype": "hook_callback", "callback_id": "hook_1" }
        });
        let (_, body) = parse_inbound_control(&line).expect("should parse");
        assert!(matches!(body.expect("unknown subtype types ok"), InboundControl::Unknown));
    }

    #[test]
    fn malformed_known_subtype_surfaces_an_error_with_its_request_id() {
        // A `can_use_tool` missing the required `tool_use_id`: `#[serde(other)]`
        // does NOT catch this, so the body must come back as `Err` (with the
        // request_id preserved) so the caller can still answer and not hang the CLI.
        let line = json!({
            "type": "control_request",
            "request_id": "req-3",
            "request": { "subtype": "can_use_tool", "tool_name": "Bash" }
        });
        let (rid, body) = parse_inbound_control(&line).expect("request_id is present");
        assert_eq!(rid, "req-3");
        assert!(body.is_err(), "a malformed known subtype must surface as Err, not Unknown");
    }

    #[test]
    fn allow_response_has_doubly_nested_camelcase_shape() {
        let r = permission_allow_response("req-1", "toolu_123", json!({"command":"echo hi"}));
        assert_eq!(r["type"], json!("control_response"));
        assert_eq!(r["response"]["subtype"], json!("success"));
        assert_eq!(r["response"]["request_id"], json!("req-1"));
        assert_eq!(r["response"]["response"]["behavior"], json!("allow"));
        assert_eq!(r["response"]["response"]["toolUseID"], json!("toolu_123"));
        assert_eq!(r["response"]["response"]["updatedInput"]["command"], json!("echo hi"));
    }

    #[test]
    fn deny_response_carries_message() {
        let r = permission_deny_response("req-9", "toolu_9", "not allowed in tests");
        assert_eq!(r["response"]["response"]["behavior"], json!("deny"));
        assert_eq!(r["response"]["response"]["message"], json!("not allowed in tests"));
        assert_eq!(r["response"]["response"]["toolUseID"], json!("toolu_9"));
    }

    #[test]
    fn effort_level_validation_matches_the_cli_enum() {
        // The four the runtime control accepts — and the two the gauge once offered
        // that the CLI silently swallows.
        for ok in ["low", "medium", "high", "xhigh"] {
            assert!(is_valid_effort_level(ok), "{ok} should be valid");
        }
        assert!(!is_valid_effort_level("max"), "'max' is a --effort alias, not a wire value");
        assert!(!is_valid_effort_level("ultracode"), "'ultracode' is a separate flag, not an effort");
        assert!(!is_valid_effort_level("banana"));
    }

    #[test]
    fn effort_request_carries_camelcase_key() {
        let r = set_effort_level_request("e-1", "high");
        assert_eq!(r["request"]["subtype"], json!("apply_flag_settings"));
        assert_eq!(r["request"]["settings"]["effortLevel"], json!("high"));
    }

    #[test]
    fn ultracode_on_is_true_off_is_null() {
        // Enabling sends `true`; disabling sends `null` (deletes the key) — NOT false.
        let on = set_ultracode_request("u-1", true);
        assert_eq!(on["request"]["settings"]["ultracode"], json!(true));
        let off = set_ultracode_request("u-2", false);
        assert_eq!(off["request"]["settings"]["ultracode"], Value::Null);
        // The key must be PRESENT-and-null, so the CLI deletes it (not absent).
        assert!(off["request"]["settings"].as_object().unwrap().contains_key("ultracode"));
    }

    #[test]
    fn get_settings_request_shape() {
        let r = get_settings_request("g-1");
        assert_eq!(r["type"], json!("control_request"));
        assert_eq!(r["request"]["subtype"], json!("get_settings"));
    }

    #[test]
    fn parses_get_settings_applied() {
        let line = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "g-1",
                "response": { "applied": { "model": "claude-sonnet-4-6", "effort": "high", "ultracode": false } }
            }
        });
        let applied = parse_get_settings_applied(&line).expect("applied present");
        assert_eq!(applied.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(applied.effort.as_deref(), Some("high"));
        assert_eq!(applied.ultracode, Some(false));
        // A response with no `applied` yields None (so the caller skips it).
        let bare = json!({ "response": { "subtype": "success", "request_id": "x", "response": {} } });
        assert!(parse_get_settings_applied(&bare).is_none());
    }

    #[test]
    fn generate_session_title_request_shape() {
        let r = generate_session_title_request("t-1", "Aide-moi à fixer le bug du login");
        assert_eq!(r["type"], json!("control_request"));
        assert_eq!(r["request_id"], json!("t-1"));
        assert_eq!(r["request"]["subtype"], json!("generate_session_title"));
        assert_eq!(r["request"]["description"], json!("Aide-moi à fixer le bug du login"));
        // persist:false — Tosse stores the name itself; the binary must NOT write an
        // ai-title into its transcript.
        assert_eq!(r["request"]["persist"], json!(false));
    }

    #[test]
    fn parses_generated_title_from_doubly_nested_response() {
        let line = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "t-1",
                "response": { "title": "  Fix du bug de login  " }
            }
        });
        // Trimmed to the inner text.
        assert_eq!(parse_generate_session_title(&line).as_deref(), Some("Fix du bug de login"));
        // A blank/missing title yields None (so the caller keeps the placeholder).
        let blank = json!({ "response": { "response": { "title": "   " } } });
        assert!(parse_generate_session_title(&blank).is_none());
        let missing = json!({ "response": { "response": {} } });
        assert!(parse_generate_session_title(&missing).is_none());
    }

    #[test]
    fn parses_control_response_success_and_error() {
        let ok = json!({ "response": { "subtype": "success", "request_id": "a-1" } });
        let r = parse_control_response(&ok).expect("parses");
        assert_eq!(r.request_id, "a-1");
        assert!(r.ok);
        assert!(r.error.is_none());

        let err = json!({ "response": { "subtype": "error", "request_id": "a-2", "error": "nope" } });
        let r = parse_control_response(&err).expect("parses");
        assert!(!r.ok);
        assert_eq!(r.error.as_deref(), Some("nope"));
    }

    #[test]
    fn parses_permission_mode_ack() {
        let line = json!({
            "response": { "subtype": "success", "request_id": "p-1", "response": { "mode": "plan" } }
        });
        assert_eq!(parse_set_permission_mode_ack(&line).as_deref(), Some("plan"));
    }
}
