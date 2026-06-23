//! Real subscription **usage percentage** (5h + weekly windows).
//!
//! The stream-json protocol only exposes a coarse rate-limit *status* (allowed /
//! warning / rejected) + reset time — NOT a percentage (see
//! [`crate::supervisor::model::RateLimitSnapshot`]). The precise figure lives behind
//! the CLI's internal `GET /api/oauth/usage`, which we replicate here.
//!
//! This module is the SINGLE place that touches OAuth credentials and the usage
//! endpoint (same encapsulation pattern as `git::mod` / `store::db`), so swapping
//! the source or endpoint means rewriting only this file.
//!
//! ## Contract (clean-room, verified against the `claude` 2.1.186 bundle)
//! - `GET https://api.anthropic.com/api/oauth/usage`
//! - Headers: `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
//!   `Content-Type: application/json`, `User-Agent: claude-cli/<v> (external, cli)`.
//!   The CLI does NOT send `anthropic-version` on this call.
//! - Body (verified against the LIVE response): the windows are at the **top level**
//!   — `{ "five_hour": {...}, "seven_day": {...}, ... }` — each with `utilization`
//!   already a **percentage 0–100** (e.g. `29.0` = 29%) and `resets_at` an **ISO 8601
//!   string**. We still tolerate a `rate_limits` wrapper (structural only) and pass
//!   `resets_at` through as a string for the JS `Date` parser on the frontend.
//!
//! ## Policy (validated with the user)
//! - **Token source**: `~/.claude/.credentials.json` FIRST (no Keychain prompt; absent
//!   on macOS where the token lives in the Keychain), then the Keychain item
//!   `Claude Code-credentials` via `/usr/bin/security` (found by service name alone).
//!   The Keychain read may surface a macOS access prompt because this (unsigned) app
//!   isn't in the item's ACL — clicking "Always Allow" persists it for `/usr/bin/security`.
//! - **Read-only**: token used as-is, never refreshed nor written back — the `claude`
//!   process this app keeps alive refreshes it for us. On any failure we return a
//!   typed [`UsageError`] so the UI can tell the user exactly what to do.

use serde::Serialize;
use serde_json::Value;
use specta::Type;

/// Internal usage endpoint the CLI's `/usage` hits with the OAuth bearer token.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Mimic the CLI's User-Agent so the endpoint sees a familiar client. The version is
/// pinned to a known-good CLI release; a drift here is very unlikely to be rejected
/// (the endpoint authenticates on the Bearer token + `oauth-2025-04-20` beta).
///
/// MAINTENANCE: this version is hand-pinned and duplicated from the protocol fixture's
/// capture version (`supervisor::protocol` `TASKS_CAPTURE`, captured on `2.1.186`). Bump
/// it together with the fixture re-capture on every `claude` CLI upgrade — no test or
/// build step catches a stale value here.
const USER_AGENT: &str = "claude-cli/2.1.186 (external, cli)";

/// Real plan-usage snapshot: the two subscription windows, each with a fill %.
/// A window is `None` when the endpoint did not report it.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PlanUsage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
}

/// One rate-limit window's real fill: `used_percentage` (0–100) + optional reset as a
/// raw timestamp string (ISO 8601, or epoch-seconds digits for the alternate shape) —
/// the frontend converts it with the JS `Date` parser.
#[derive(Debug, Clone, Serialize, Type)]
pub struct UsageWindow {
    pub used_percentage: f64,
    pub resets_at: Option<String>,
}

/// Why fetching the real usage % failed, typed so the UI can give a tailored next
/// step instead of a dead-end "unavailable". Tagged on `kind` → a clean TS union.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UsageError {
    /// No token in the file nor the Keychain (user never logged in via the CLI).
    NoToken,
    /// The Keychain refused access (unsigned app not in the item ACL, or cancelled).
    KeychainDenied { detail: String },
    /// Endpoint rejected the token (HTTP 401/403): expired or revoked.
    Unauthorized { status: u16 },
    /// The usage endpoint is itself rate-limited (HTTP 429). `retry_after` = seconds
    /// from the `Retry-After` header when present. Do NOT hammer it — back off.
    RateLimited { retry_after: Option<u64> },
    /// Any other non-success HTTP status from the endpoint (carries status + body).
    Http { status: u16, body: String },
    /// Network-level failure (DNS, TLS, timeout, offline).
    Network { detail: String },
    /// Response received but unparseable into the expected shape (carries body).
    Parse { body: String },
}

/// Fetch the real usage percentages. Reads the token off-thread (file/Keychain are
/// blocking), then queries the endpoint. Returns a typed [`UsageError`] on failure.
pub async fn fetch_plan_usage() -> Result<PlanUsage, UsageError> {
    let token = tokio::task::spawn_blocking(read_oauth_token)
        .await
        .map_err(|e| UsageError::Network {
            detail: format!("token read task failed: {e}"),
        })??;

    ensure_crypto_provider();
    // Use the FALLIBLE builder (Client::new() panics on build failure, and the release
    // profile is `panic = "abort"` → a panic would take the whole app down). A timeout
    // is mandatory: the async client has none by default, so without it a stalled
    // connection would hang the command future (and the background poll) indefinitely.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| UsageError::Network {
            detail: format!("HTTP client build failed: {e}"),
        })?;
    let resp = client
        .get(USAGE_URL)
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| UsageError::Network { detail: e.to_string() })?;

    let status = resp.status();
    // Read Retry-After (seconds) BEFORE consuming the response into text — used to
    // tell the user when to retry on a 429.
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let body = resp.text().await.map_err(|e| UsageError::Network {
        detail: format!("reading body failed: {e}"),
    })?;

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(UsageError::Unauthorized {
            status: status.as_u16(),
        });
    }
    // The usage endpoint is itself rate-limited (it's polled by the CLI too) — give it
    // its own cause so the UI says "wait" instead of "server error", and so the caller
    // can back off rather than retry.
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(UsageError::RateLimited { retry_after });
    }
    if !status.is_success() {
        return Err(UsageError::Http {
            status: status.as_u16(),
            body: snippet(&body),
        });
    }

    parse_usage(&body).ok_or_else(|| UsageError::Parse {
        body: snippet(&body),
    })
}

/// First ~300 chars of a response body, for error details (never dump a full,
/// possibly large or sensitive payload into a UI error string).
fn snippet(body: &str) -> String {
    body.chars().take(300).collect()
}

/// reqwest is built with `rustls-no-provider`, so a process-wide crypto provider must
/// be installed before the first client builds (else it panics). We install `ring`
/// (the same provider the tree already compiles for tauri-plugin-updater). Idempotent:
/// the `get_default` guard makes this a no-op if the updater already installed it.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Resolve the OAuth access token: config file first (no Keychain prompt), then the
/// macOS Keychain (cause-aware error). Returns a typed [`UsageError`] when no usable
/// token is found.
fn read_oauth_token() -> Result<String, UsageError> {
    if let Some(blob) = read_credentials_file() {
        match parse_access_token(&blob) {
            Some(tok) => return Ok(tok),
            // The file is PRESENT but carries no usable token (truncated mid-write, a
            // renamed field, …). That is a real failure, NOT the normal "absent" state —
            // surface it loudly before falling back to the Keychain (the "never silently
            // equate broken with missing" policy), so a corrupt file doesn't masquerade
            // as a misleading NoToken/KeychainDenied.
            None => eprintln!(
                "[usage] ~/.claude/.credentials.json is present but has no usable accessToken; falling back to Keychain"
            ),
        }
    }
    read_keychain_token()
}

/// Read `~/.claude/.credentials.json` if present. An ABSENT file → `None` silently (the
/// common case on macOS, where the token lives in the Keychain); a present-but-unreadable
/// file (permissions/IO) is a real failure → logged before `None`, never silently equated
/// with "absent".
fn read_credentials_file() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home)
        .join(".claude")
        .join(".credentials.json");
    match std::fs::read_to_string(&path) {
        Ok(blob) => Some(blob),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            eprintln!("[usage] cannot read {}: {e}", path.display());
            None
        }
    }
}

/// Read the Keychain credentials blob via `/usr/bin/security` (finds the item by
/// service name alone, so no account is needed), mapping the exit code to a precise
/// cause so the UI can guide the user. macOS `security` exits with the OSStatus
/// truncated to 8 bits: 44 = item-not-found (errSecItemNotFound −25300), 36/51/128 =
/// interaction-not-allowed / authFailed / userCancelled (access denied).
#[cfg(target_os = "macos")]
fn read_keychain_token() -> Result<String, UsageError> {
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .map_err(|e| UsageError::KeychainDenied {
            detail: format!("failed to run /usr/bin/security: {e}"),
        })?;

    if out.status.success() {
        let blob = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return parse_access_token(&blob).ok_or_else(|| UsageError::Parse {
            body: "keychain item is not valid credentials JSON".to_string(),
        });
    }

    let code = out.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    match code {
        44 => Err(UsageError::NoToken),
        _ => Err(UsageError::KeychainDenied {
            detail: format!("security exit {code}: {stderr}"),
        }),
    }
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_token() -> Result<String, UsageError> {
    // No Keychain off macOS; the file is the only source and it was absent.
    Err(UsageError::NoToken)
}

/// Extract the OAuth access token from the credentials blob (same JSON shape in the
/// file and the Keychain): `{ "claudeAiOauth": { "accessToken": "..." } }`. Falls
/// back to a top-level `accessToken` in case the shape ever flattens.
fn parse_access_token(blob: &str) -> Option<String> {
    let v: Value = serde_json::from_str(blob).ok()?;
    v.get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(Value::as_str)
        .or_else(|| v.get("accessToken").and_then(Value::as_str))
        .map(str::to_string)
}

/// Parse the usage endpoint payload. The windows (`five_hour`, `seven_day`) sit at the
/// TOP LEVEL of the live body; an older/alternate shape nested them under `rate_limits`,
/// so we fall back to that. `None` when neither window is usable (e.g. an API-key
/// account with no plan limits).
fn parse_usage(body: &str) -> Option<PlanUsage> {
    let v: Value = serde_json::from_str(body).ok()?;
    // Prefer a non-null `rate_limits` wrapper (old shape); otherwise read the root.
    let root = v
        .get("rate_limits")
        .filter(|r| !r.is_null())
        .unwrap_or(&v);
    let five_hour = parse_window(root.get("five_hour"));
    let seven_day = parse_window(root.get("seven_day"));
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(PlanUsage {
        five_hour,
        seven_day,
    })
}

/// One window's `{ utilization, resets_at }` → our `{ used_percentage, resets_at }`.
/// On `/api/oauth/usage`, `utilization` is ALREADY a percentage 0–100 (verified against
/// the live response, e.g. `29.0` = 29%), so we use it as-is (an explicit
/// `used_percentage`, if ever present, is equivalent). `resets_at` is passed through as
/// a raw string (ISO 8601, or epoch-seconds digits) for the frontend to parse. `None`
/// when no percentage field is present (an unusable window). The UI clamps 0–100.
fn parse_window(v: Option<&Value>) -> Option<UsageWindow> {
    let v = v?;
    if v.is_null() {
        return None;
    }
    let used_percentage = v
        .get("used_percentage")
        .or_else(|| v.get("utilization"))
        .and_then(Value::as_f64)?;
    let resets_at = v
        .get("resets_at")
        .or_else(|| v.get("resetsAt"))
        .and_then(|r| {
            r.as_str()
                .map(str::to_string)
                .or_else(|| r.as_i64().map(|n| n.to_string()))
        });
    Some(UsageWindow {
        used_percentage,
        resets_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_access_token_from_nested_shape() {
        let blob = r#"{"claudeAiOauth":{"accessToken":"fake-token-nested","refreshToken":"r"}}"#;
        assert_eq!(parse_access_token(blob).as_deref(), Some("fake-token-nested"));
    }

    #[test]
    fn parses_access_token_from_flat_shape() {
        let blob = r#"{"accessToken":"fake-token-flat"}"#;
        assert_eq!(parse_access_token(blob).as_deref(), Some("fake-token-flat"));
    }

    #[test]
    fn missing_token_is_none() {
        assert!(parse_access_token(r#"{"nope":true}"#).is_none());
        assert!(parse_access_token("not json").is_none());
    }

    #[test]
    fn parses_real_captured_body() {
        // Captured from the LIVE /api/oauth/usage response: top-level windows,
        // `utilization` already a percentage (0–100), `resets_at` an ISO 8601 string,
        // plus dollar fields we ignore. Pins the real contract (not a guess).
        let body = r#"{"five_hour":{"utilization":29.0,"resets_at":"2026-06-23T14:49:59.908810+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null},
                        "seven_day":{"utilization":27.0,"resets_at":"2026-06-29T09:59:59.908834+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null}}"#;
        let u = parse_usage(body).expect("should parse");
        let fh = u.five_hour.expect("five_hour");
        assert_eq!(fh.used_percentage, 29.0);
        assert_eq!(fh.resets_at.as_deref(), Some("2026-06-23T14:49:59.908810+00:00"));
        let sd = u.seven_day.expect("seven_day");
        assert_eq!(sd.used_percentage, 27.0);
        assert_eq!(sd.resets_at.as_deref(), Some("2026-06-29T09:59:59.908834+00:00"));
    }

    #[test]
    fn tolerates_nested_rate_limits_wrapper() {
        // Structural tolerance only: windows nested under `rate_limits`. Utilization is
        // still a percentage; a numeric (epoch) reset is stringified for the frontend.
        let body = r#"{"rate_limits":{"five_hour":{"utilization":42.5,"resets_at":1750000000}}}"#;
        let fh = parse_usage(body).expect("should parse").five_hour.expect("five_hour");
        assert_eq!(fh.used_percentage, 42.5);
        assert_eq!(fh.resets_at.as_deref(), Some("1750000000"));
    }

    #[test]
    fn accepts_explicit_used_percentage() {
        let body = r#"{"five_hour":{"used_percentage":80,"resets_at":"x"}}"#;
        assert_eq!(parse_usage(body).unwrap().five_hour.unwrap().used_percentage, 80.0);
    }

    #[test]
    fn no_usable_window_is_none() {
        // API-key/Bedrock accounts: rate_limits null and no top-level windows.
        assert!(parse_usage(r#"{"rate_limits":null,"rate_limits_available":false}"#).is_none());
        assert!(parse_usage(r#"{"something":"else"}"#).is_none());
    }

    #[test]
    fn missing_window_is_none_but_others_parse() {
        let body = r#"{"five_hour":{"utilization":10.0}}"#;
        let u = parse_usage(body).expect("should parse");
        assert!(u.five_hour.is_some());
        assert!(u.seven_day.is_none());
    }
}
