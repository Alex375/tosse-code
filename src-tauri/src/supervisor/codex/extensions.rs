//! Extensions v2 — the ACTIONS on Codex's extension inventory (toggles, live plugin
//! inventory, per-plugin contents, hooks, marketplaces), all through the app-server's
//! official RPCs. `config.rs` stays the read-only on-disk snapshot; THIS module is the
//! write/live side. Every mutation goes through the BINARY (`skills/config/write`,
//! `config/value/write`) — we NEVER edit `config.toml` ourselves, so its comments and
//! secret-bearing tables (`env`, `headers`, …) are preserved by the binary's surgical
//! writer (verified live against codex-cli 0.142.5).
//!
//! ## Secret redaction (same invariant as `config.rs`)
//! `config/read` and `plugin/installed` responses can carry secrets (`env` tables come
//! back IN CLEAR in the effective config). No raw wire `Value` ever crosses the IPC:
//! everything is mapped through the whitelisted structs below.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

use super::server::{CodexError, CodexServer};
use crate::extensions::{ExtScope, McpServerInfo, PluginContents, SkillInfo};

/// A TOML bare-key: the only server names we allow to be spliced into a
/// `config/value/write` keyPath. Anything else (dots, quotes, spaces) could address a
/// DIFFERENT config key — a keyPath injection — so it is rejected with a clear error.
fn is_toml_bare_key(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A plugin id safe to splice into a QUOTED keyPath segment (`plugins."<id>".enabled`).
/// Quotes/backslashes/control chars would escape the quoted segment → rejected.
fn is_safe_quoted_key(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| c == '"' || c == '\\' || c.is_control())
}

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------

/// Enable/disable a Codex SKILL (`skills/config/write`). `skill_path` is the path the
/// snapshot carries — the `SKILL.md` file — while the config selector is the skill DIR,
/// so the parent is what goes on the wire. Returns the server-resolved effective state.
pub async fn set_skill_enabled(skill_path: &str, enabled: bool) -> Result<bool, CodexError> {
    let p = Path::new(skill_path);
    let dir = if p.file_name().is_some_and(|f| f == "SKILL.md") {
        p.parent().unwrap_or(p)
    } else {
        p
    };
    let value = CodexServer::oneshot(
        "skills/config/write",
        json!({ "path": dir.to_string_lossy(), "enabled": enabled }),
        &std::env::temp_dir(),
    )
    .await?;
    Ok(value
        .get("effectiveEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(enabled))
}

/// Enable/disable a Codex MCP server. No dedicated RPC exists — the official path
/// (verified live) is writing `mcp_servers.<name>.enabled` via `config/value/write`
/// (the binary edits the existing block in place, preserving `env` secrets and
/// comments), then `config/mcpServer/reload`. ⚠️ The reload only affects the server
/// process it is sent to — so it also fires on `shared` (the app's long-lived server
/// carrying the LIVE conversations); the transient writer's own reload would change
/// nothing anyone sees. No live server running is the normal case, not an error.
///
/// Returns whether the LIVE sessions reflect the change: `true` when the reload
/// succeeded (or there was nothing live to reload), `false` when it failed — the
/// config IS written either way (it applies on the next spawn), but the front must
/// warn the user instead of showing a state the live sessions don't have.
pub async fn set_mcp_enabled(
    name: &str,
    enabled: bool,
    shared: &CodexServer,
) -> Result<bool, CodexError> {
    if !is_toml_bare_key(name) {
        return Err(CodexError::Rpc(format!(
            "nom de serveur MCP invalide pour un toggle : « {name} »"
        )));
    }
    // Only a server DEFINED in config.toml can be toggled by writing its `enabled` key:
    // the Codex runtime also injects servers (codex_apps, computer-use) that have NO
    // config entry and whose transport lives outside config.toml. Writing
    // `mcp_servers.<injected>.enabled` would create a table with an `enabled` flag and
    // NO transport → the app-server rejects the whole config ("invalid transport",
    // verified live). Refuse with an actionable message instead of surfacing that
    // cryptic validation error. (The front already hides the toggle for these; this is
    // the belt.)
    if !super::config::mcp_server_in_config(name) {
        return Err(CodexError::Rpc(format!(
            "« {name} » est un serveur MCP fourni par Codex : il n'est pas dans votre config.toml \
             et ne peut pas être activé/désactivé depuis la configuration."
        )));
    }
    let key_path = format!("mcp_servers.{name}.enabled");
    CodexServer::oneshot(
        "config/value/write",
        json!({ "keyPath": key_path, "value": enabled, "mergeStrategy": "upsert" }),
        &std::env::temp_dir(),
    )
    .await?;
    // ON TOP of a successful write: the config IS changed; a reload failure only delays
    // live pickup (the next spawn reads the file anyway) — but it is REPORTED, not
    // swallowed, so the UI never pretends the live sessions switched.
    match shared.request("config/mcpServer/reload", json!({})).await {
        Ok(_) => Ok(true),
        Err(CodexError::Closed) => Ok(true), // no live Codex session — nothing to reload
        Err(e) => {
            eprintln!("[codex-ext] config/mcpServer/reload on live server failed: {e}");
            Ok(false)
        }
    }
}

/// Enable/disable a Codex PLUGIN. The config key is the FULL id (`name@marketplace`),
/// quoted (verified live: `plugins."x@mkt".enabled` writes the right block).
pub async fn set_plugin_enabled(plugin_id: &str, enabled: bool) -> Result<(), CodexError> {
    if !is_safe_quoted_key(plugin_id) {
        return Err(CodexError::Rpc(format!(
            "identifiant de plugin invalide pour un toggle : « {plugin_id} »"
        )));
    }
    let key_path = format!("plugins.\"{plugin_id}\".enabled");
    CodexServer::oneshot(
        "config/value/write",
        json!({ "keyPath": key_path, "value": enabled, "mergeStrategy": "upsert" }),
        &std::env::temp_dir(),
    )
    .await
    .map(|_| ())
}

// ---------------------------------------------------------------------------
// Live plugin inventory (plugin/installed) + per-plugin contents (plugin/read)
// ---------------------------------------------------------------------------

/// One plugin from the authoritative `plugin/installed` inventory — a WHITELIST of the
/// wire `PluginSummary` (no share context, no auth policy, no remote catalog internals).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginLive {
    /// `name@marketplace` — the config key used by the enable toggle.
    pub id: String,
    pub name: String,
    pub marketplace: String,
    /// The marketplace's local file path — needed by `plugin/read` for the explorer.
    /// `None` for a remote-only catalog entry.
    pub marketplace_path: Option<String>,
    pub display_name: Option<String>,
    pub short_description: Option<String>,
    pub version: Option<String>,
    pub installed: bool,
    pub enabled: bool,
}

/// The live Codex plugin inventory, grouped flat with marketplace names for the UI's
/// existing per-marketplace grouping. `load_errors` carries marketplaces that failed
/// to load (message only — paths are fine, they are user-local marketplace files).
#[derive(Debug, Clone, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginsLive {
    pub plugins: Vec<CodexPluginLive>,
    /// Registered marketplace names (even empty ones), for the marketplaces view.
    pub marketplaces: Vec<CodexMarketplaceLive>,
    pub load_errors: Vec<String>,
}

/// One registered Codex marketplace (from `plugin/installed`).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceLive {
    pub name: String,
    pub display_name: Option<String>,
    pub path: Option<String>,
    pub plugin_count: u32,
}

/// The authoritative INSTALLED plugin inventory (`plugin/installed` — local
/// marketplaces only, no remote catalog round-trip). Richer than the config.toml
/// snapshot: it sees bundled/runtime plugins with their versions and display metadata.
pub async fn list_plugins_live(cwds: Vec<String>) -> Result<CodexPluginsLive, CodexError> {
    let value = CodexServer::oneshot(
        "plugin/installed",
        json!({ "cwds": cwds }),
        &std::env::temp_dir(),
    )
    .await?;
    let mut out = CodexPluginsLive::default();
    for m in value
        .get("marketplaces")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let mkt_name = m.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let mkt_path = m.get("path").and_then(Value::as_str).map(str::to_string);
        let plugins = m.get("plugins").and_then(Value::as_array).cloned().unwrap_or_default();
        out.marketplaces.push(CodexMarketplaceLive {
            name: mkt_name.clone(),
            display_name: m
                .get("interface")
                .and_then(|i| i.get("displayName"))
                .and_then(Value::as_str)
                .map(str::to_string),
            path: mkt_path.clone(),
            plugin_count: plugins.len() as u32,
        });
        for p in &plugins {
            let iface = p.get("interface");
            out.plugins.push(CodexPluginLive {
                id: p.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                name: p.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                marketplace: mkt_name.clone(),
                marketplace_path: mkt_path.clone(),
                display_name: iface
                    .and_then(|i| i.get("displayName"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                short_description: iface
                    .and_then(|i| i.get("shortDescription"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                version: p.get("localVersion").and_then(Value::as_str).map(str::to_string),
                installed: p.get("installed").and_then(Value::as_bool).unwrap_or(false),
                enabled: p.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            });
        }
    }
    for e in value
        .get("marketplaceLoadErrors")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let path = e.get("marketplacePath").and_then(Value::as_str).unwrap_or("?");
        let msg = e.get("message").and_then(Value::as_str).unwrap_or("erreur inconnue");
        out.load_errors.push(format!("{path} : {msg}"));
    }
    Ok(out)
}

/// Everything ONE Codex plugin provides (`plugin/read`), mapped onto the SAME
/// [`PluginContents`] domain shape as the Claude explorer so the front's drill-in
/// renders it with zero new primitives. Codex plugins have no sub-agents; their MCP
/// servers come back as names only (no command/url in `PluginDetail`).
pub async fn plugin_contents(
    plugin_name: &str,
    marketplace_path: Option<String>,
    plugin_id: &str,
) -> Result<PluginContents, CodexError> {
    let value = CodexServer::oneshot(
        "plugin/read",
        json!({ "pluginName": plugin_name, "marketplacePath": marketplace_path }),
        &std::env::temp_dir(),
    )
    .await?;
    let detail = value.get("plugin").cloned().unwrap_or(Value::Null);
    let mut contents = PluginContents::default();
    for s in detail.get("skills").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        let Some(name) = s.get("name").and_then(Value::as_str) else { continue };
        contents.skills.push(SkillInfo {
            name: name.to_string(),
            description: s
                .get("description")
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
                .map(str::to_string),
            scope: ExtScope::Plugin,
            source: Some(plugin_id.to_string()),
            path: s
                .get("path")
                .and_then(Value::as_str)
                .map(|p| {
                    // The snapshot convention is the SKILL.md path (the doc viewer reads it).
                    let p = Path::new(p);
                    if p.file_name().is_some_and(|f| f == "SKILL.md") {
                        p.to_string_lossy().into_owned()
                    } else {
                        p.join("SKILL.md").to_string_lossy().into_owned()
                    }
                })
                .unwrap_or_default(),
            enabled: s.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        });
    }
    for name in detail
        .get("mcpServers")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(Value::as_str)
    {
        contents.mcp_servers.push(McpServerInfo {
            name: name.to_string(),
            scope: ExtScope::Plugin,
            transport: None,
            command: None,
            url: None,
            source: Some(plugin_id.to_string()),
            enabled: true,
        });
    }
    Ok(contents)
}

// ---------------------------------------------------------------------------
// Hooks (hooks/list — read-only view; Codex exposes no hook toggle RPC)
// ---------------------------------------------------------------------------

/// One configured Codex hook, whitelisted from the wire `HookMetadata`. The `command`
/// is the user's OWN configured handler (their config, not a secret store) — same
/// visibility as Claude's settings.json hooks.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexHook {
    pub key: String,
    pub event_name: String,
    /// `command` | `prompt` | `agent`.
    pub handler_type: String,
    pub command: Option<String>,
    /// Where it is configured: `user` | `project` | `plugin` | `system` | …
    pub source: String,
    pub source_path: String,
    pub plugin_id: Option<String>,
    pub enabled: bool,
    /// `trusted` | `untrusted` | `modified` | `managed`.
    pub trust_status: String,
}

/// The hooks visible from one cwd, with that scan's warnings/errors surfaced (a broken
/// hooks file must never read as "no hooks").
#[derive(Debug, Clone, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexHooksSnapshot {
    pub hooks: Vec<CodexHook>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

/// List the Codex hooks for `cwds` (`hooks/list`), flattened across entries.
pub async fn list_hooks(cwds: Vec<String>) -> Result<CodexHooksSnapshot, CodexError> {
    let cwd = cwds
        .first()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let value = CodexServer::oneshot("hooks/list", json!({ "cwds": cwds }), &cwd).await?;
    let mut out = CodexHooksSnapshot::default();
    for entry in value.get("data").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        for h in entry.get("hooks").and_then(Value::as_array).unwrap_or(&Vec::new()) {
            let s = |k: &str| h.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            out.hooks.push(CodexHook {
                key: s("key"),
                event_name: s("eventName"),
                handler_type: s("handlerType"),
                command: h.get("command").and_then(Value::as_str).map(str::to_string),
                source: s("source"),
                source_path: s("sourcePath"),
                plugin_id: h.get("pluginId").and_then(Value::as_str).map(str::to_string),
                enabled: h.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                trust_status: s("trustStatus"),
            });
        }
        for w in entry.get("warnings").and_then(Value::as_array).unwrap_or(&Vec::new()) {
            if let Some(w) = w.as_str() {
                out.warnings.push(w.to_string());
            }
        }
        for e in entry.get("errors").and_then(Value::as_array).unwrap_or(&Vec::new()) {
            let path = e.get("path").and_then(Value::as_str).unwrap_or("?");
            let msg = e.get("message").and_then(Value::as_str).unwrap_or("erreur inconnue");
            out.errors.push(format!("{path} : {msg}"));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Marketplaces
// ---------------------------------------------------------------------------

/// Register a Codex marketplace (`marketplace/add` — a git URL / owner-repo / local path).
pub async fn marketplace_add(source: &str) -> Result<(), CodexError> {
    CodexServer::oneshot(
        "marketplace/add",
        json!({ "source": source }),
        &std::env::temp_dir(),
    )
    .await
    .map(|_| ())
}

/// Unregister a Codex marketplace by name (`marketplace/remove`).
pub async fn marketplace_remove(name: &str) -> Result<(), CodexError> {
    CodexServer::oneshot(
        "marketplace/remove",
        json!({ "marketplaceName": name }),
        &std::env::temp_dir(),
    )
    .await
    .map(|_| ())
}

/// Refresh a Codex marketplace's pinned content (`marketplace/upgrade`); `None` → all.
pub async fn marketplace_upgrade(name: Option<String>) -> Result<(), CodexError> {
    CodexServer::oneshot(
        "marketplace/upgrade",
        json!({ "marketplaceName": name }),
        &std::env::temp_dir(),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keypath_guards_reject_injection_shapes() {
        // Bare-key MCP names: dots/quotes/spaces could address another config key.
        assert!(is_toml_bare_key("railway"));
        assert!(is_toml_bare_key("node_repl-2"));
        assert!(!is_toml_bare_key("a.b"));
        assert!(!is_toml_bare_key("a\"b"));
        assert!(!is_toml_bare_key("a b"));
        assert!(!is_toml_bare_key(""));
        // Quoted plugin ids: quotes/backslashes/control chars escape the segment.
        assert!(is_safe_quoted_key("documents@openai-primary-runtime"));
        assert!(is_safe_quoted_key("my plugin@mkt"));
        assert!(!is_safe_quoted_key("x\".enabled] [oops\"@mkt"));
        assert!(!is_safe_quoted_key("x\\y@mkt"));
        assert!(!is_safe_quoted_key(""));
    }

    #[tokio::test]
    #[ignore = "spawns the real codex app-server; read-only inventory probes"]
    async fn live_list_plugins_and_hooks() {
        let plugins = list_plugins_live(vec![]).await.expect("plugin/installed should succeed");
        eprintln!(
            "codex plugins: {:?}",
            plugins.plugins.iter().map(|p| (&p.id, p.enabled)).collect::<Vec<_>>()
        );
        assert!(
            plugins.plugins.iter().all(|p| !p.id.is_empty()),
            "every plugin has an id"
        );
        let hooks = list_hooks(vec!["/tmp".into()]).await.expect("hooks/list should succeed");
        eprintln!("codex hooks: {} ({} warnings)", hooks.hooks.len(), hooks.warnings.len());
    }
}
