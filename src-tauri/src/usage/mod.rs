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
//! - **Active windows (2026-07)**: the body ALSO carries a `limits` array
//!   (`[{ kind, group, is_active, … }]`). As Anthropic retires the per-session (5h) cap
//!   in favour of a single weekly limit, the legacy top-level `five_hour` object is STILL
//!   emitted (a stale utilization %) but its limit reads `is_active:false`. We must NOT
//!   surface a window whose limit is inactive (it would show a misleading "5h · 0%"), so
//!   we cross-reference `limits`: match `session` → 5h, `weekly_all`/`weekly` → 7d. An
//!   absent `limits` array (older shape) keeps the legacy "present ⇒ shown" behaviour.
//!
//! ## Policy (validated with the user)
//! - **Token source**: `~/.claude/.credentials.json` FIRST *when its token is still valid*
//!   (no Keychain prompt; the file is normally absent on macOS, where the token lives in
//!   the Keychain), then the Keychain item `Claude Code-credentials` via `/usr/bin/security`
//!   (found by service name alone). The Keychain read may surface a macOS access prompt
//!   because this (unsigned) app isn't in the item's ACL — clicking "Always Allow" persists
//!   it for `/usr/bin/security`.
//!   ⚠️ An **expired** file token must NOT shadow the Keychain: on macOS the CLI refreshes
//!   the token in the Keychain only — a stale `~/.claude/.credentials.json` left behind (it
//!   is never rewritten there) would otherwise be returned as-is forever → a perpetual 401.
//!   So we skip an expired file token and fall through to the Keychain (the live source of
//!   truth), keeping the expired file token only as a last resort so the endpoint can still
//!   speak a truthful 401 instead of a misleading `NoToken`.
//! - **Read-only**: token used as-is, never refreshed nor written back — the `claude`
//!   process this app keeps alive refreshes it for us. On any failure we return a
//!   typed [`UsageError`] so the UI can tell the user exactly what to do.

use serde::{Deserialize, Serialize};
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
/// A window is `None` when the endpoint did not report it. `Deserialize` so it can
/// ride the Codex `session_codex_plan_usage` event (the event bus round-trips its
/// payload) — the Codex backend reuses this exact shape for its rate-limit push.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlanUsage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
}

/// One rate-limit window's real fill: `used_percentage` (0–100) + optional reset as a
/// raw timestamp string (ISO 8601, or epoch-seconds digits for the alternate shape) —
/// the frontend converts it with the JS `Date` parser.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

/// Clock-skew margin: treat a file token as expired this many ms BEFORE its stated
/// `expiresAt`, so one that would lapse mid-request isn't trusted (the endpoint call has a
/// 10s timeout — 60s of slack covers it comfortably).
const EXPIRY_SKEW_MS: i64 = 60_000;

/// Resolve the OAuth access token: config file first *when valid* (no Keychain prompt),
/// then the macOS Keychain (cause-aware error). Returns a typed [`UsageError`] when no
/// usable token is found.
fn read_oauth_token() -> Result<String, UsageError> {
    let file_creds = read_credentials_file().and_then(|blob| {
        parse_credentials(&blob).or_else(|| {
            // The file is PRESENT but carries no usable token (truncated mid-write, a
            // renamed field, …). That is a real failure, NOT the normal "absent" state —
            // surface it loudly before falling back to the Keychain (the "never silently
            // equate broken with missing" policy), so a corrupt file doesn't masquerade
            // as a misleading NoToken/KeychainDenied.
            eprintln!(
                "[usage] ~/.claude/.credentials.json is present but has no usable accessToken; falling back to Keychain"
            );
            None
        })
    });
    resolve_token(file_creds, now_unix_ms(), read_keychain_token)
}

/// Pure token-selection policy (I/O injected → unit-testable). Prefer a **non-expired**
/// file token (avoids a Keychain prompt in the common case); otherwise consult the Keychain
/// (the macOS source of truth, refreshed by the live `claude` process). If the Keychain
/// yields nothing usable but we still hold a file token (merely expired), fall back to it so
/// the endpoint returns a truthful 401 (`Unauthorized` → "relaunch claude") rather than a
/// misleading `NoToken`/`KeychainDenied` that hides the real cause.
fn resolve_token(
    file_creds: Option<Credentials>,
    now_ms: i64,
    keychain: impl FnOnce() -> Result<String, UsageError>,
) -> Result<String, UsageError> {
    if let Some(creds) = &file_creds {
        if !creds.is_expired(now_ms) {
            return Ok(creds.access_token.clone());
        }
        eprintln!(
            "[usage] ~/.claude/.credentials.json token is expired; consulting the Keychain for a fresher one"
        );
    }
    match keychain() {
        Ok(tok) => Ok(tok),
        Err(kc_err) => match file_creds {
            Some(creds) => Ok(creds.access_token),
            None => Err(kc_err),
        },
    }
}

/// Current wall-clock time in ms since the Unix epoch. A pre-epoch clock (impossible in
/// practice) collapses to `i64::MAX` → every known expiry reads as expired, which merely
/// forces the Keychain path (safe, never a false "valid").
fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(i64::MAX)
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

/// OAuth credentials parsed from the blob: the access token plus its optional expiry, so
/// the caller can tell a fresh file token from a stale one (see [`resolve_token`]).
struct Credentials {
    access_token: String,
    /// `expiresAt` as ms since the Unix epoch, when the blob carries it. `None` for older
    /// shapes with no expiry field.
    expires_at_ms: Option<i64>,
}

impl Credentials {
    /// True ONLY when the expiry is known and already reached (minus [`EXPIRY_SKEW_MS`]).
    /// An unknown expiry returns `false`: we can't prove it stale, so we keep the prior
    /// "use it" behavior rather than regress a working token to the Keychain.
    fn is_expired(&self, now_ms: i64) -> bool {
        match self.expires_at_ms {
            Some(exp) => exp <= now_ms.saturating_add(EXPIRY_SKEW_MS),
            None => false,
        }
    }
}

/// Parse the OAuth credentials from the blob (same JSON shape in the file and the
/// Keychain): `{ "claudeAiOauth": { "accessToken": "...", "expiresAt": <ms> } }`. Falls
/// back to top-level fields in case the shape ever flattens. `expiresAt` is tolerated as
/// either an integer or a float (ms since epoch).
fn parse_credentials(blob: &str) -> Option<Credentials> {
    let v: Value = serde_json::from_str(blob).ok()?;
    let oauth = v.get("claudeAiOauth").unwrap_or(&v);
    let access_token = oauth
        .get("accessToken")
        .or_else(|| v.get("accessToken"))
        .and_then(Value::as_str)?
        .to_string();
    let expires_at_ms = oauth
        .get("expiresAt")
        .or_else(|| v.get("expiresAt"))
        .and_then(|e| e.as_i64().or_else(|| e.as_f64().map(|f| f as i64)));
    Some(Credentials {
        access_token,
        expires_at_ms,
    })
}

/// Just the access token — used by the Keychain path, which has no expiry policy to apply
/// (the Keychain is already the refreshed source of truth).
fn parse_access_token(blob: &str) -> Option<String> {
    parse_credentials(blob).map(|c| c.access_token)
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
    // Newer payloads carry a `limits` array declaring which windows are actually in force.
    // Drop a window whose limit reads `is_active:false` (e.g. the retired 5h/session cap),
    // even though its stale top-level object is still present. No `limits` array (or no
    // matching entry) → keep the legacy "present ⇒ shown" behaviour.
    let limits = root.get("limits").and_then(Value::as_array);
    let five_hour = parse_window(root.get("five_hour"))
        .filter(|_| window_is_active(limits, &["session"]) != Some(false));
    let seven_day = parse_window(root.get("seven_day"))
        .filter(|_| window_is_active(limits, &["weekly_all", "weekly"]) != Some(false));
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(PlanUsage {
        five_hour,
        seven_day,
    })
}

/// Whether a rate-limit window is currently in force, per the newer `limits` array
/// (`[{ kind, group, is_active, … }]`). Matched by `kind` (a window may be known under
/// several kinds, e.g. `weekly_all`/`weekly`); first match wins. Returns:
/// - `Some(true)`/`Some(false)` when the matching entry states `is_active`;
/// - `None` when there is no `limits` array, no matching entry, or no `is_active` field
///   (older API shape) → the caller keeps the legacy "present ⇒ shown" behaviour.
fn window_is_active(limits: Option<&Vec<Value>>, kinds: &[&str]) -> Option<bool> {
    limits?
        .iter()
        .find(|e| {
            e.get("kind")
                .and_then(Value::as_str)
                .map(|k| kinds.contains(&k))
                .unwrap_or(false)
        })?
        .get("is_active")
        .and_then(Value::as_bool)
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

    #[test]
    fn hides_window_whose_limit_is_inactive() {
        // Real 2026-07 shape: Anthropic retiring the 5h/session cap → its legacy top-level
        // `five_hour` object is still present (utilization 1.0) but `limits[kind=session]`
        // reads `is_active:false`. Only the active weekly limit must survive.
        let body = r#"{
            "five_hour":{"utilization":1.0,"resets_at":"2026-07-15T20:50:00+00:00"},
            "seven_day":{"utilization":17.0,"resets_at":"2026-07-20T10:00:00+00:00"},
            "limits":[
                {"kind":"session","group":"session","percent":1,"is_active":false},
                {"kind":"weekly_all","group":"weekly","percent":17,"is_active":true},
                {"kind":"weekly_scoped","group":"weekly","percent":0,"is_active":false}
            ]
        }"#;
        let u = parse_usage(body).expect("weekly window still usable");
        assert!(u.five_hour.is_none(), "inactive 5h/session window must be hidden");
        let sd = u.seven_day.expect("active weekly window shown");
        assert_eq!(sd.used_percentage, 17.0);
    }

    #[test]
    fn keeps_active_five_hour_window() {
        // Accounts still on the old cap (gradual rollout): session limit is_active:true → shown.
        let body = r#"{
            "five_hour":{"utilization":40.0},
            "seven_day":{"utilization":17.0},
            "limits":[
                {"kind":"session","is_active":true},
                {"kind":"weekly_all","is_active":true}
            ]
        }"#;
        let u = parse_usage(body).expect("both usable");
        assert_eq!(u.five_hour.expect("active 5h shown").used_percentage, 40.0);
        assert!(u.seven_day.is_some());
    }

    #[test]
    fn no_limits_array_keeps_legacy_behavior() {
        // Older payloads without a `limits` array: both windows shown as before.
        let body = r#"{"five_hour":{"utilization":29.0},"seven_day":{"utilization":27.0}}"#;
        let u = parse_usage(body).expect("legacy shape parses");
        assert!(u.five_hour.is_some());
        assert!(u.seven_day.is_some());
    }

    #[test]
    fn all_windows_inactive_is_none() {
        // Degenerate case — every plan limit inactive → no usable window → None (same as an
        // API-key account with no plan limits). Not reachable today: the weekly limit stays
        // active; the real payload always keeps at least `weekly_all` in force.
        let body = r#"{
            "five_hour":{"utilization":1.0},"seven_day":{"utilization":2.0},
            "limits":[{"kind":"session","is_active":false},{"kind":"weekly_all","is_active":false}]
        }"#;
        assert!(parse_usage(body).is_none());
    }

    #[test]
    fn parse_credentials_reads_expiry_nested_and_flat() {
        let nested = r#"{"claudeAiOauth":{"accessToken":"a","expiresAt":1751000000000}}"#;
        let c = parse_credentials(nested).expect("nested");
        assert_eq!(c.access_token, "a");
        assert_eq!(c.expires_at_ms, Some(1751000000000));

        let flat = r#"{"accessToken":"b","expiresAt":1751000000000.0}"#;
        let c = parse_credentials(flat).expect("flat");
        assert_eq!(c.access_token, "b");
        assert_eq!(c.expires_at_ms, Some(1751000000000)); // float tolerated

        // No expiry field → token still parses, expiry unknown.
        let no_exp = r#"{"claudeAiOauth":{"accessToken":"c"}}"#;
        let c = parse_credentials(no_exp).expect("no expiry");
        assert_eq!(c.expires_at_ms, None);
    }

    fn creds(token: &str, expires_at_ms: Option<i64>) -> Credentials {
        Credentials {
            access_token: token.to_string(),
            expires_at_ms,
        }
    }

    #[test]
    fn is_expired_honors_expiry_and_skew() {
        let now = 1_000_000_000_000;
        // Well in the past → expired.
        assert!(creds("t", Some(now - 10_000)).is_expired(now));
        // Well in the future → valid.
        assert!(!creds("t", Some(now + 10 * 60_000)).is_expired(now));
        // Inside the skew margin (expires in 30s < 60s slack) → treated as expired.
        assert!(creds("t", Some(now + 30_000)).is_expired(now));
        // Unknown expiry → NOT expired (can't prove it; keep using it).
        assert!(!creds("t", None).is_expired(now));
    }

    #[test]
    fn resolve_prefers_valid_file_token_without_touching_keychain() {
        let now = 1_000_000_000_000;
        let file = Some(creds("file-fresh", Some(now + 3_600_000)));
        let tok = resolve_token(file, now, || panic!("keychain must not be consulted"))
            .expect("valid file token");
        assert_eq!(tok, "file-fresh");
    }

    #[test]
    fn resolve_expired_file_falls_through_to_keychain() {
        let now = 1_000_000_000_000;
        let file = Some(creds("file-stale", Some(now - 3_600_000)));
        let tok = resolve_token(file, now, || Ok("keychain-fresh".to_string()))
            .expect("keychain token");
        assert_eq!(tok, "keychain-fresh"); // the reported bug: stale file no longer wins
    }

    #[test]
    fn resolve_expired_file_used_as_last_resort_when_keychain_empty() {
        let now = 1_000_000_000_000;
        let file = Some(creds("file-stale", Some(now - 3_600_000)));
        // Keychain has nothing → fall back to the (expired) file token so the endpoint can
        // answer a truthful 401 instead of masking the cause as NoToken.
        let tok = resolve_token(file, now, || Err(UsageError::NoToken)).expect("file fallback");
        assert_eq!(tok, "file-stale");
    }

    #[test]
    fn resolve_no_file_uses_keychain_and_propagates_its_error() {
        let now = 1_000_000_000_000;
        let tok = resolve_token(None, now, || Ok("keychain-only".to_string())).expect("keychain");
        assert_eq!(tok, "keychain-only");

        let err = resolve_token(None, now, || Err(UsageError::NoToken)).unwrap_err();
        assert!(matches!(err, UsageError::NoToken));
    }
}
