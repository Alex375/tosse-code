//! Control channel (subtask 2).
//!
//! The control channel multiplexes `control_request` / `control_response`
//! JSON-lines over the *same* stdio stream as the conversation (spec §4). It is
//! bidirectional:
//!   - **outbound** (we → CLI): `initialize`, `interrupt`, `set_permission_mode`.
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

/// `apply_flag_settings` — push a session flag/setting change. Used here to set
/// the reasoning effort level (e.g. "low", "medium", "high", "xhigh", "max").
/// Mirrors the extension SDK (`{subtype:"apply_flag_settings", settings:{effortLevel}}`).
pub fn set_effort_level_request(request_id: &str, level: &str) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": level } }),
    )
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
}
