//! Claude Code extension config — the ONE place in the core that reads Claude's
//! on-disk configuration (MCP servers, plugins, skills, sub-agents) across scopes.
//!
//! Same encapsulation contract as [`crate::store::db`] (SQL) and [`crate::git`]
//! (the `git` CLI): everything outside this module deals only in the domain types
//! below ([`ExtensionsSnapshot`] and friends). Nothing else parses `~/.claude*`
//! files. Swapping where/how the config is read means rewriting this file alone.
//!
//! ## What it reads, and where
//! This is the *configured* picture — it works without any live `claude` process
//! (the lazy-spawn model means a conversation often has none). The *live* picture
//! (real connection status per session) comes from `system/init` and is merged in
//! by the UI. The two are complementary; see the protocol parser.
//!
//! | Scope    | MCP servers                                   | Plugins / skills / agents |
//! |----------|-----------------------------------------------|---------------------------|
//! | User     | `~/.claude.json` → `mcpServers`               | `~/.claude/{skills,agents}/`, plugins enabled in `~/.claude/settings.json` |
//! | Project  | `<repo>/.mcp.json`, `~/.claude.json` → `projects[repo].mcpServers` | `<repo>/.claude/{skills,agents}/` |
//! | Plugin   | each enabled plugin's `.mcp.json`             | each enabled plugin's `skills/` + `agents/` |
//!
//! Plugin install metadata lives in `~/.claude/plugins/installed_plugins.json`
//! (registry, with per-install scope) and the per-plugin cache dir it points to.
//!
//! ## Secrets
//! MCP `env`, `args` and `headers` can carry tokens, so they are NEVER read into
//! the domain types — only `command`, `transport` and a query-stripped `url` are
//! surfaced. The redaction happens here, at the boundary, so no secret can reach
//! the IPC layer or the UI.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

/// Where a configuration entry originates. Drives the "by scope" grouping in the
/// UI. Serialized snake_case so the TS union is `"user" | "project" | …`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExtScope {
    /// Configured globally for the user (`~/.claude*`).
    User,
    /// Shared by the repository (committed `.mcp.json` / `.claude/`), or the
    /// project section of `~/.claude.json`.
    Project,
    /// Bound to this project but kept local (not shared) — `settings.local.json`
    /// or a `local`-scoped plugin install.
    Local,
    /// Provided by an installed plugin.
    Plugin,
}

/// One MCP server visible to a repository, with its resolved enabled state. The
/// live connection status (connected / needs-auth / …) is NOT here — it comes
/// from the running session's `system/init` and is merged by the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct McpServerInfo {
    pub name: String,
    pub scope: ExtScope,
    /// `"stdio"` | `"http"` | `"sse"` when declared (stdio is the implicit default).
    pub transport: Option<String>,
    /// Launch command for a stdio server (e.g. `npx`, `railway`). Args omitted
    /// (may carry secrets).
    pub command: Option<String>,
    /// Endpoint for an http/sse server, with any query string stripped.
    pub url: Option<String>,
    /// Plugin id (`<plugin>@<marketplace>`) when `scope == Plugin`.
    pub source: Option<String>,
    /// Resolved on-disk enabled state for this repo (project toggles applied).
    pub enabled: bool,
}

/// One installed plugin relevant to a repository (user-global, or project/local
/// scoped to this repo).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PluginInfo {
    /// `<plugin>@<marketplace>` — the key used in `enabledPlugins`.
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub enabled: bool,
    pub scope: ExtScope,
    /// What the plugin provides (scanned from its cache dir), regardless of
    /// enabled state — so the UI can show "5 skills" even when toggled off.
    pub skill_count: u32,
    pub agent_count: u32,
    pub command_count: u32,
    pub mcp_count: u32,
}

/// One skill available to a repository (file-based or plugin-provided).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SkillInfo {
    pub name: String,
    pub description: Option<String>,
    pub scope: ExtScope,
    /// Plugin id when plugin-provided; `None` for a user/project file skill.
    pub source: Option<String>,
    /// Absolute path to the skill's `SKILL.md` — the UI reads it to render a clean
    /// markdown view of the skill.
    pub path: String,
}

/// One sub-agent available to a repository (file-based or plugin-provided).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentInfo {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub scope: ExtScope,
    pub source: Option<String>,
    /// Absolute path to the agent's `.md` definition — the UI reads it to render a
    /// clean markdown view of the sub-agent.
    pub path: String,
}

/// The full configured picture for one repository, across all scopes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ExtensionsSnapshot {
    pub mcp_servers: Vec<McpServerInfo>,
    pub plugins: Vec<PluginInfo>,
    pub skills: Vec<SkillInfo>,
    pub agents: Vec<AgentInfo>,
    /// Config files that exist but could NOT be read/parsed (corrupt JSON, IO error).
    /// The scan still degrades to a usable snapshot, but these are surfaced so a
    /// broken config is never indiscernible from "nothing configured" — without them
    /// a corrupt `~/.claude.json` reads as an empty inventory, and a corrupt
    /// `settings.json` would (wrongly) show every plugin as enabled. Empty = clean.
    pub warnings: Vec<String>,
}

/// Everything ONE plugin provides — for the per-plugin explorer (click a plugin →
/// browse its skills / sub-agents / MCP servers, like Claude.ai's Customize panel).
///
/// Scanned straight from the plugin's install dir REGARDLESS of its enabled state:
/// a disabled plugin must still be browsable. This is why it is a separate read
/// from [`list_extensions`], which only folds an *enabled* plugin's contributions
/// into the active snapshot.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct PluginContents {
    pub skills: Vec<SkillInfo>,
    pub agents: Vec<AgentInfo>,
    pub mcp_servers: Vec<McpServerInfo>,
}

// ---- on-disk wire shapes (private; only what we read) ---------------------

/// Subset of `~/.claude.json` we care about. The file is large (megabytes of
/// caches/telemetry) but serde only keeps these keys.
#[derive(Debug, Default, Deserialize)]
struct ClaudeJson {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpRaw>,
    #[serde(default)]
    projects: BTreeMap<String, ProjectEntry>,
}

/// One `projects[<abs-path>]` entry — only the MCP-toggle fields.
#[derive(Debug, Default, Deserialize)]
struct ProjectEntry {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpRaw>,
    /// Named (user/plugin) servers disabled for this project.
    #[serde(default, rename = "disabledMcpServers")]
    disabled_mcp: Vec<String>,
    /// `.mcp.json` servers explicitly approved for this project.
    #[serde(default, rename = "enabledMcpjsonServers")]
    enabled_mcpjson: Vec<String>,
    /// `.mcp.json` servers explicitly rejected for this project.
    #[serde(default, rename = "disabledMcpjsonServers")]
    disabled_mcpjson: Vec<String>,
}

/// One MCP server definition. `args`/`env`/`headers` are deliberately absent so
/// secrets can never be deserialized in the first place.
#[derive(Debug, Default, Deserialize)]
struct McpRaw {
    #[serde(default, rename = "type")]
    transport: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// A `{ "mcpServers": { … } }` file (`<repo>/.mcp.json`, a plugin's `.mcp.json`).
#[derive(Debug, Default, Deserialize)]
struct McpJsonFile {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpRaw>,
}

/// A `settings.json` (user `~/.claude/settings.json`, project `.claude/settings.json`,
/// or local `.claude/settings.local.json`): the plugin enable map AND `mcpServers`
/// — the schema allows declaring MCP servers directly in settings, a file-based
/// location distinct from `~/.claude.json` / `.mcp.json` that must be scanned too.
#[derive(Debug, Default, Deserialize)]
struct SettingsJson {
    #[serde(default, rename = "enabledPlugins")]
    enabled_plugins: BTreeMap<String, bool>,
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpRaw>,
}

/// `~/.claude/plugins/installed_plugins.json` (version 2).
#[derive(Debug, Default, Deserialize)]
struct InstalledPlugins {
    #[serde(default)]
    plugins: BTreeMap<String, Vec<PluginInstall>>,
}

/// One installation record of a plugin (a plugin can be installed at several
/// scopes — user, or project/local pinned to a `projectPath`).
#[derive(Debug, Default, Deserialize)]
struct PluginInstall {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default, rename = "projectPath")]
    project_path: Option<String>,
    #[serde(default, rename = "installPath")]
    install_path: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

/// `<plugin>/.claude-plugin/plugin.json` — only name/description/version.
#[derive(Debug, Default, Deserialize)]
struct PluginManifest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

// ---- public entry point ----------------------------------------------------

/// Read the configured extensions visible to the repository (or worktree) at
/// `repo_path`, across user / project / plugin scopes.
///
/// Best-effort and infallible: a missing or malformed file yields empties rather
/// than an error — an explorer must degrade gracefully, never fail to open. File
/// IO is synchronous; the IPC command runs it off the async runtime.
pub fn list_extensions(repo_path: &str) -> ExtensionsSnapshot {
    let home = match home_dir() {
        Some(h) => h,
        None => return ExtensionsSnapshot::default(),
    };
    let repo = Path::new(repo_path);

    let mut snap = ExtensionsSnapshot::default();

    // Main config files go through read_or_warn: a present-but-corrupt one records a
    // warning (surfaced in the UI) instead of silently reading as "empty" — a corrupt
    // ~/.claude.json must not look like "no MCP", and a corrupt settings.json must not
    // make every plugin look enabled (the `.unwrap_or(true)` below).
    let claude_json: ClaudeJson = read_or_warn(&home.join(".claude.json"), &mut snap.warnings);
    let settings: SettingsJson =
        read_or_warn(&home.join(".claude/settings.json"), &mut snap.warnings);
    let project = claude_json.projects.get(repo_path);

    // --- MCP: user scope (named servers; disabled per-project via disabledMcpServers)
    for (name, raw) in &claude_json.mcp_servers {
        let disabled = project.is_some_and(|p| p.disabled_mcp.iter().any(|n| n == name));
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::User, None, !disabled));
    }
    // --- MCP declared in settings.json files (schema-allowed, file-based). User-global
    // from ~/.claude/settings.json; project (committed) + local from the repo. Same
    // per-project disable rule for the user ones as the ~/.claude.json named servers.
    for (name, raw) in &settings.mcp_servers {
        let disabled = project.is_some_and(|p| p.disabled_mcp.iter().any(|n| n == name));
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::User, None, !disabled));
    }
    let project_settings: SettingsJson =
        read_or_warn(&repo.join(".claude/settings.json"), &mut snap.warnings);
    for (name, raw) in &project_settings.mcp_servers {
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::Project, None, true));
    }
    let local_settings: SettingsJson =
        read_or_warn(&repo.join(".claude/settings.local.json"), &mut snap.warnings);
    for (name, raw) in &local_settings.mcp_servers {
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::Local, None, true));
    }

    // --- MCP: PROJECT scope = the COMMITTED <repo>/.mcp.json (shared with the team).
    // A `.mcp.json` server is active when explicitly approved (`enabledMcpjsonServers`)
    // or simply not rejected (`disabledMcpjsonServers`).
    let project_mcp: McpJsonFile = read_or_warn(&repo.join(".mcp.json"), &mut snap.warnings);
    for (name, raw) in &project_mcp.mcp_servers {
        let enabled = project.map_or(true, |p| {
            p.enabled_mcpjson.iter().any(|n| n == name)
                || !p.disabled_mcpjson.iter().any(|n| n == name)
        });
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::Project, None, enabled));
    }

    // --- MCP: LOCAL scope = ~/.claude.json `projects[<repo>].mcpServers` — PRIVATE to
    // you for THIS repo (the `claude mcp add` default scope). Distinct from project
    // (committed/shared) and coexists with a `.mcp.json` — it is NOT a fallback.
    if let Some(p) = project {
        for (name, raw) in &p.mcp_servers {
            snap.mcp_servers
                .push(mcp_info(name, raw, ExtScope::Local, None, true));
        }
    }

    // --- Plugins (+ their skills/agents/mcp). Only installs relevant to this repo.
    let installed: InstalledPlugins =
        read_or_warn(&home.join(".claude/plugins/installed_plugins.json"), &mut snap.warnings);
    for (id, installs) in &installed.plugins {
        let Some(install) = relevant_install(installs, repo_path) else {
            continue;
        };
        let scope = install_scope(install);
        let enabled = settings.enabled_plugins.get(id).copied().unwrap_or(true);
        let marketplace = id.split_once('@').map(|(_, m)| m).unwrap_or("").to_string();
        let dir = install.install_path.as_deref().map(PathBuf::from);

        let manifest: PluginManifest = dir
            .as_ref()
            .and_then(|d| read_json(&d.join(".claude-plugin/plugin.json")))
            .unwrap_or_default();

        // Scan what the plugin provides (counts always; entries only when enabled).
        let skills = dir
            .as_ref()
            .map(|d| scan_skills(&d.join("skills"), ExtScope::Plugin, Some(id)))
            .unwrap_or_default();
        let agents = dir
            .as_ref()
            .map(|d| scan_agents(&d.join("agents"), ExtScope::Plugin, Some(id)))
            .unwrap_or_default();
        let command_count = dir
            .as_ref()
            .map(|d| count_markdown(&d.join("commands")))
            .unwrap_or(0);
        let plugin_mcp: McpJsonFile = dir
            .as_ref()
            .and_then(|d| read_json(&d.join(".mcp.json")))
            .unwrap_or_default();

        snap.plugins.push(PluginInfo {
            id: id.clone(),
            name: manifest
                .name
                .unwrap_or_else(|| id.split_once('@').map(|(n, _)| n).unwrap_or(id).to_string()),
            marketplace,
            version: manifest.version.or_else(|| install.version.clone()),
            description: manifest.description,
            enabled,
            scope,
            skill_count: skills.len() as u32,
            agent_count: agents.len() as u32,
            command_count,
            mcp_count: plugin_mcp.mcp_servers.len() as u32,
        });

        // An enabled plugin contributes its skills/agents/mcp to what Claude sees.
        if enabled {
            snap.skills.extend(skills);
            snap.agents.extend(agents);
            for (name, raw) in &plugin_mcp.mcp_servers {
                snap.mcp_servers
                    .push(mcp_info(name, raw, ExtScope::Plugin, Some(id), true));
            }
        }
    }

    // --- File-based skills/agents: user scope then project scope.
    snap.skills
        .extend(scan_skills(&home.join(".claude/skills"), ExtScope::User, None));
    snap.agents
        .extend(scan_agents(&home.join(".claude/agents"), ExtScope::User, None));
    snap.skills
        .extend(scan_skills(&repo.join(".claude/skills"), ExtScope::Project, None));
    snap.agents
        .extend(scan_agents(&repo.join(".claude/agents"), ExtScope::Project, None));

    snap
}

/// Scan everything a single installed plugin provides (skills / sub-agents / MCP),
/// independent of whether the plugin is enabled. `repo_path` selects the install
/// record relevant to the repo (a plugin can be installed at user/project/local
/// scopes). Best-effort and infallible — an unknown plugin or missing dir yields
/// empties so the explorer always opens.
pub fn list_plugin_contents(repo_path: &str, plugin_id: &str) -> PluginContents {
    let Some(home) = home_dir() else {
        return PluginContents::default();
    };
    let installed: InstalledPlugins =
        read_json(&home.join(".claude/plugins/installed_plugins.json")).unwrap_or_default();
    let Some(install) = installed
        .plugins
        .get(plugin_id)
        .and_then(|installs| relevant_install(installs, repo_path))
    else {
        return PluginContents::default();
    };
    let Some(dir) = install.install_path.as_deref().map(PathBuf::from) else {
        return PluginContents::default();
    };

    let plugin_mcp: McpJsonFile = read_json(&dir.join(".mcp.json")).unwrap_or_default();
    PluginContents {
        skills: scan_skills(&dir.join("skills"), ExtScope::Plugin, Some(plugin_id)),
        agents: scan_agents(&dir.join("agents"), ExtScope::Plugin, Some(plugin_id)),
        mcp_servers: plugin_mcp
            .mcp_servers
            .iter()
            .map(|(name, raw)| mcp_info(name, raw, ExtScope::Plugin, Some(plugin_id), true))
            .collect(),
    }
}

// ---- actions ---------------------------------------------------------------

/// Enable or disable a plugin (by id `<plugin>@<marketplace>`) in the user's
/// `~/.claude/settings.json` `enabledPlugins` map — the same place Claude's own
/// `/plugin` toggle writes.
///
/// Safety: this edits the user's live config, so it
///   - reads the file FRESH right before writing (minimizes the read-modify-write
///     window against a concurrent editor),
///   - changes ONLY the one `enabledPlugins[id]` value, preserving every other key
///     and its order (serde_json `preserve_order`),
///   - writes atomically (temp file + rename) so a crash mid-write can never leave
///     a truncated settings.json.
///
/// Note: `enabledPlugins` is USER-GLOBAL (not per-repo) — this is how Claude stores
/// it. A running session reads it at spawn, so the change takes effect on the next
/// (re)start of a conversation.
pub fn set_plugin_enabled(plugin_id: &str, enabled: bool) -> Result<(), String> {
    let home = home_dir().ok_or("répertoire personnel ($HOME) introuvable")?;
    let path = home.join(".claude/settings.json");
    // A fresh install has no settings.json yet (the CLI writes it only on first
    // setting change) — treat absent as an empty object so the very first plugin
    // toggle CREATES the file instead of erroring. A present-but-unreadable file is
    // still a real error.
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".to_string(),
        Err(e) => return Err(format!("lecture de settings.json impossible : {e}")),
    };
    let updated = apply_plugin_enabled(&text, plugin_id, enabled)?;
    // Ensure ~/.claude exists before the atomic rename (it may not on a fresh install).
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("création du dossier de config impossible : {e}"))?;
    }
    write_atomic(&path, updated.as_bytes())
}

/// Pure transform: set `enabledPlugins[plugin_id] = enabled` in a settings.json
/// document, returning the re-serialized (2-space, key-order-preserving) text.
/// Splitting this out keeps it unit-testable without touching the filesystem.
fn apply_plugin_enabled(text: &str, plugin_id: &str, enabled: bool) -> Result<String, String> {
    let mut root: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("settings.json illisible : {e}"))?;
    let obj = root
        .as_object_mut()
        .ok_or("settings.json n'est pas un objet JSON")?;
    if !obj.get("enabledPlugins").map(|v| v.is_object()).unwrap_or(false) {
        obj.insert("enabledPlugins".to_string(), serde_json::json!({}));
    }
    obj.get_mut("enabledPlugins")
        .and_then(|v| v.as_object_mut())
        .ok_or("enabledPlugins n'est pas un objet")?
        .insert(plugin_id.to_string(), serde_json::Value::Bool(enabled));
    serde_json::to_string_pretty(&root).map_err(|e| format!("sérialisation JSON : {e}"))
}

/// Replace `path` atomically: write a sibling temp file, then rename over the
/// target so a crash mid-write can never leave a truncated file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tosse-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("écriture du fichier temporaire : {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // don't leave the temp behind on failure
        format!("remplacement atomique de settings.json : {e}")
    })
}

// ---- helpers ---------------------------------------------------------------

/// The user's home directory (`$HOME`). macOS/Linux; this app is macOS-first.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Read and deserialize a JSON file; `None` on any failure (absent, unreadable,
/// malformed) so callers can `.unwrap_or_default()`. Use this only where corruption
/// is acceptable to swallow (per-plugin manifests); the MAIN config files go through
/// [`read_or_warn`] so a broken one is surfaced, not silently treated as empty.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Read+parse a JSON config file, distinguishing **absent** (`Ok(None)` — a normal
/// degradation) from **present-but-broken** (`Err` with a human message). This is
/// what lets the scan surface a corrupt config instead of mistaking it for "nothing
/// configured" (the silent-error trap).
fn read_json_checked<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} illisible : {e}", path.display())),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("{} corrompu : {e}", path.display()))
}

/// Read a main config file, degrading to `T::default()` but recording a warning when
/// it exists yet can't be read/parsed (so the failure is never silent).
fn read_or_warn<T: Default + serde::de::DeserializeOwned>(
    path: &Path,
    warnings: &mut Vec<String>,
) -> T {
    match read_json_checked(path) {
        Ok(opt) => opt.unwrap_or_default(),
        Err(msg) => {
            warnings.push(msg);
            T::default()
        }
    }
}

/// Build an [`McpServerInfo`] from a raw server, stripping any URL query string.
fn mcp_info(
    name: &str,
    raw: &McpRaw,
    scope: ExtScope,
    source: Option<&str>,
    enabled: bool,
) -> McpServerInfo {
    McpServerInfo {
        name: name.to_string(),
        scope,
        transport: raw.transport.clone(),
        command: raw.command.clone(),
        url: raw.url.as_deref().map(strip_url_query),
        source: source.map(str::to_string),
        enabled,
    }
}

/// Drop a URL's query string (and fragment) — it can carry an auth token. Keeps
/// scheme/host/path, which is all the UI needs to identify the endpoint.
fn strip_url_query(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or(url).to_string()
}

/// Pick the installation record relevant to `repo_path`: a `user`-scoped install
/// (global), else one whose `projectPath` is this repo. `None` when the plugin is
/// only installed for *other* projects.
fn relevant_install<'a>(installs: &'a [PluginInstall], repo_path: &str) -> Option<&'a PluginInstall> {
    installs
        .iter()
        .find(|i| i.scope.as_deref() == Some("user"))
        .or_else(|| installs.iter().find(|i| i.project_path.as_deref() == Some(repo_path)))
}

/// Map an install's `scope` string to our [`ExtScope`].
fn install_scope(install: &PluginInstall) -> ExtScope {
    match install.scope.as_deref() {
        Some("project") => ExtScope::Project,
        Some("local") => ExtScope::Local,
        _ => ExtScope::User,
    }
}

/// Scan a `skills/` directory: one subdirectory per skill, each holding a
/// `SKILL.md` whose frontmatter carries `name`/`description`. Missing dir → empty.
fn scan_skills(dir: &Path, scope: ExtScope, source: Option<&str>) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        let front = std::fs::read_to_string(&skill_md)
            .ok()
            .map(|c| parse_frontmatter(&c))
            .unwrap_or_default();
        let name = front.name.unwrap_or_else(|| dir_name(&path));
        out.push(SkillInfo {
            name,
            description: front.description,
            scope,
            source: source.map(str::to_string),
            path: skill_md.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Scan an `agents/` directory: one `*.md` per sub-agent, frontmatter carries
/// `name`/`description`/`model`. Missing dir → empty.
fn scan_agents(dir: &Path, scope: ExtScope, source: Option<&str>) -> Vec<AgentInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let front = std::fs::read_to_string(&path)
            .ok()
            .map(|c| parse_frontmatter(&c))
            .unwrap_or_default();
        let name = front
            .name
            .unwrap_or_else(|| path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string());
        out.push(AgentInfo {
            name,
            description: front.description,
            model: front.model,
            scope,
            source: source.map(str::to_string),
            path: path.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Count `*.md` files directly in `dir` (for a plugin's `commands/`). 0 if absent.
fn count_markdown(dir: &Path) -> u32 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                .count() as u32
        })
        .unwrap_or(0)
}

/// Last path component as a `String` (a directory's own name).
fn dir_name(path: &Path) -> String {
    path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

/// The handful of YAML frontmatter fields we read from a SKILL.md / agent .md.
#[derive(Debug, Default, PartialEq)]
struct FrontMatter {
    name: Option<String>,
    description: Option<String>,
    model: Option<String>,
}

/// Minimal YAML-frontmatter extractor for skill/agent markdown — enough for the
/// flat `key: value` and block-scalar (`key: |` / `key: >`) forms these files
/// use, without pulling in a YAML dependency. Reads only the leading
/// `---`…`---` block; ignores everything else. Pure, so it is unit-tested.
fn parse_frontmatter(content: &str) -> FrontMatter {
    let mut fm = FrontMatter::default();
    // Strip a leading UTF-8 BOM first: `str::trim` does NOT remove U+FEFF (it isn't
    // Rust whitespace), so a BOM-prefixed SKILL.md/agent .md (Windows editors) would
    // otherwise have its whole frontmatter ignored (name/description/model lost).
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    // Frontmatter must be the very first thing (allowing a leading BOM/blank).
    if lines.next().map(str::trim) != Some("---") {
        return fm;
    }
    let block: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();

    let mut i = 0;
    while i < block.len() {
        let line = block[i];
        i += 1;
        let Some((key, rest)) = top_level_key(line) else {
            continue;
        };
        let value = if rest == "|" || rest == ">" || rest == "|-" || rest == ">-" {
            // Block scalar: gather the following indented/blank lines.
            let mut parts = Vec::new();
            while i < block.len() {
                let next = block[i];
                if next.trim().is_empty() {
                    i += 1;
                    continue;
                }
                if !next.starts_with(' ') && !next.starts_with('\t') {
                    break; // a new top-level key ends the block
                }
                parts.push(next.trim());
                i += 1;
            }
            parts.join(" ")
        } else {
            unquote(rest).to_string()
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        match key {
            "name" => fm.name = Some(value),
            "description" => fm.description = Some(value),
            "model" => fm.model = Some(value),
            _ => {}
        }
    }
    fm
}

/// Split a line into `(key, rest)` when it is a top-level `key: value` (no
/// leading whitespace, key is `[A-Za-z0-9_-]+`). `rest` is trimmed.
fn top_level_key(line: &str) -> Option<(&str, &str)> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let (key, rest) = line.split_once(':')?;
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    Some((key, rest.trim()))
}

/// Strip a single pair of surrounding single/double quotes from a scalar value.
fn unquote(s: &str) -> &str {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_reads_flat_keys() {
        let md = "---\nname: pickup\nmodel: sonnet\n---\n# body\nname: not-this\n";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("pickup"));
        assert_eq!(fm.model.as_deref(), Some("sonnet"));
        // A `key:` line in the body (after the closing ---) is ignored.
        assert_eq!(fm.description, None);
    }

    #[test]
    fn frontmatter_reads_block_scalar_description() {
        let md = "---\nname: tosse-manager\ndescription: |\n  Agent for CRM ops.\n  Use it when X.\nmodel: sonnet\n---\nbody";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("tosse-manager"));
        assert_eq!(
            fm.description.as_deref(),
            Some("Agent for CRM ops. Use it when X."),
            "block-scalar lines join with a space; `model:` ends the block"
        );
        assert_eq!(fm.model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn frontmatter_unquotes_values() {
        let md = "---\nname: \"quoted name\"\ndescription: 'single'\n---";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("quoted name"));
        assert_eq!(fm.description.as_deref(), Some("single"));
    }

    #[test]
    fn frontmatter_absent_yields_empty() {
        assert_eq!(parse_frontmatter("# just markdown\nname: x"), FrontMatter::default());
        assert_eq!(parse_frontmatter(""), FrontMatter::default());
    }

    #[test]
    fn read_json_checked_distinguishes_absent_from_corrupt() {
        use std::io::Write;
        // Absent → Ok(None) (a normal degradation, no warning).
        let missing = std::env::temp_dir().join("tosse-read-json-absent-xyz.json");
        let _ = std::fs::remove_file(&missing);
        let r: Result<Option<serde_json::Value>, String> = read_json_checked(&missing);
        assert!(matches!(r, Ok(None)), "absent must be Ok(None)");
        // Present but corrupt → Err (a surfaced failure, NOT silently None).
        let bad = std::env::temp_dir().join("tosse-read-json-corrupt-xyz.json");
        std::fs::File::create(&bad).unwrap().write_all(b"{ not json ]").unwrap();
        let r: Result<Option<serde_json::Value>, String> = read_json_checked(&bad);
        assert!(r.is_err(), "corrupt JSON must be Err, not None");
        let _ = std::fs::remove_file(&bad);
    }

    #[test]
    fn frontmatter_tolerates_utf8_bom() {
        // A SKILL.md saved with a leading UTF-8 BOM (Windows editors) must still
        // have its frontmatter read — `str::trim` does NOT strip U+FEFF.
        let md = "\u{feff}---\nname: pickup\ndescription: do it\n---\n# body";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("pickup"));
        assert_eq!(fm.description.as_deref(), Some("do it"));
    }

    #[test]
    fn strip_url_query_drops_token() {
        assert_eq!(strip_url_query("https://x.com/mcp?token=secret"), "https://x.com/mcp");
        assert_eq!(strip_url_query("https://x.com/mcp#frag"), "https://x.com/mcp");
        assert_eq!(strip_url_query("https://x.com/mcp"), "https://x.com/mcp");
    }

    #[test]
    fn relevant_install_prefers_user_then_matching_project() {
        let installs = vec![
            PluginInstall {
                scope: Some("project".into()),
                project_path: Some("/repo/a".into()),
                ..Default::default()
            },
            PluginInstall {
                scope: Some("local".into()),
                project_path: Some("/repo/b".into()),
                ..Default::default()
            },
        ];
        // No user install: only the matching projectPath is relevant.
        assert_eq!(
            relevant_install(&installs, "/repo/b").map(install_scope),
            Some(ExtScope::Local)
        );
        // A repo with no matching install gets nothing.
        assert!(relevant_install(&installs, "/repo/c").is_none());

        let with_user = vec![PluginInstall {
            scope: Some("user".into()),
            ..Default::default()
        }];
        // A user install is global — relevant to any repo.
        assert_eq!(
            relevant_install(&with_user, "/anything").map(install_scope),
            Some(ExtScope::User)
        );
    }

    #[test]
    fn apply_plugin_enabled_flips_one_key_preserving_the_rest_and_order() {
        // A settings.json with keys in a deliberate (non-alphabetical) order and an
        // existing plugin map. Toggling one plugin must keep every other key, value
        // and ORDER intact, and only flip the targeted entry.
        let before = r#"{
  "language": "french",
  "enabledPlugins": {
    "a@m": true,
    "b@m": false
  },
  "voice": { "enabled": true }
}"#;
        let after = apply_plugin_enabled(before, "b@m", true).unwrap();
        // Key order preserved: language before enabledPlugins before voice.
        let lang = after.find("\"language\"").unwrap();
        let plugins = after.find("\"enabledPlugins\"").unwrap();
        let voice = after.find("\"voice\"").unwrap();
        assert!(lang < plugins && plugins < voice, "top-level key order preserved");
        // Other values untouched, targeted plugin flipped, sibling plugin intact.
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["language"], "french");
        assert_eq!(v["voice"]["enabled"], true);
        assert_eq!(v["enabledPlugins"]["a@m"], true);
        assert_eq!(v["enabledPlugins"]["b@m"], true, "targeted plugin was enabled");
    }

    #[test]
    fn apply_plugin_enabled_creates_the_map_when_absent() {
        let after = apply_plugin_enabled(r#"{"language":"french"}"#, "x@y", false).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["enabledPlugins"]["x@y"], false);
        assert_eq!(v["language"], "french", "existing keys are kept");
    }

    #[test]
    fn mcp_info_redacts_url_and_omits_args() {
        let raw = McpRaw {
            transport: Some("http".into()),
            command: None,
            url: Some("https://h/mcp?k=secret".into()),
        };
        let info = mcp_info("srv", &raw, ExtScope::Plugin, Some("p@m"), true);
        assert_eq!(info.url.as_deref(), Some("https://h/mcp"));
        assert_eq!(info.source.as_deref(), Some("p@m"));
        assert!(info.enabled);
    }

    /// Smoke test against the real `~/.claude` of the machine running it. Ignored
    /// by default (touches the home dir) — run with `--ignored`. Mirrors the
    /// live/FS test policy of the git & supervisor modules.
    #[test]
    #[ignore]
    fn list_extensions_reads_real_config() {
        let snap = list_extensions(&std::env::var("HOME").unwrap());
        eprintln!(
            "mcp={} plugins={} skills={} agents={}",
            snap.mcp_servers.len(),
            snap.plugins.len(),
            snap.skills.len(),
            snap.agents.len()
        );
    }
}
