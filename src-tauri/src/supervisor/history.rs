//! History restore — rebuild a past conversation from Claude's own transcript.
//!
//! Claude Code writes a full JSON-lines transcript for every session at
//! `<config>/projects/<cwd-slug>/<session_id>.jsonl`. When we resume a
//! conversation with `claude --resume`, the CLI does **not** re-stream that
//! history as stream-json — it just initializes and waits — so the live event
//! path delivers nothing and the UI would show an empty conversation.
//!
//! We read the transcript ourselves and normalize it into the same
//! [`ConversationItem`]s the live [`Assembler`](super::assembler) produces, so
//! the UI rebuilds the conversation identically (this is what the official VS
//! Code extension does on resume).
//!
//! We locate the file by scanning every project dir for `<session_id>.jsonl`
//! (session ids are unique UUIDs) rather than reimplementing Claude's cwd→slug
//! encoding, which is lossy: both `/` and `.` map to `-`, so the slug cannot be
//! inverted and is easy to get subtly wrong.

use std::io::BufRead;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;

use super::assembler::{context_used_from_usage, normalize_blocks};
use super::model::{ContextFill, ConversationItem, GoalState};

/// Claude's config dir: `$CLAUDE_CONFIG_DIR` if set, else `$HOME/.claude`. Shared
/// with [`super::subagents`], which reads the sibling task-artifact directories.
pub(crate) fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude"))
}

/// List the project directories under `<config>/projects` — the parent of every
/// session's transcript and its sibling task-artifact dir. A genuinely-absent
/// `projects/` dir → empty (the normal "nothing on disk yet" state); a permission/IO
/// error reading it is DISTINCT and logged before returning empty, so a real failure is
/// never silently equated with "absent" (finding #4). Shared with [`super::subagents`]
/// so this error policy lives in ONE place.
pub(crate) fn project_dirs(config_dir: &Path) -> Vec<PathBuf> {
    let projects = config_dir.join("projects");
    match std::fs::read_dir(&projects) {
        Ok(rd) => rd.flatten().map(|e| e.path()).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            eprintln!("[history] cannot read projects dir {}: {e}", projects.display());
            Vec::new()
        }
    }
}

/// Find the transcript for `session_id` by scanning every project dir under
/// `config_dir/projects` for `<session_id>.jsonl`.
fn find_transcript(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let file_name = format!("{session_id}.jsonl");
    project_dirs(config_dir)
        .into_iter()
        .map(|dir| dir.join(&file_name))
        .find(|candidate| candidate.is_file())
}

/// Load and normalize the conversation history for `session_id`, returning the
/// ordered items the UI replays. An absent or unreadable transcript yields an
/// empty vec — "no history to show" is a normal state, not an error.
pub fn load_history(session_id: &str) -> Vec<ConversationItem> {
    match claude_config_dir() {
        Some(dir) => load_history_in(&dir, session_id),
        None => Vec::new(),
    }
}

/// The mtime (Unix ms) of `session_id`'s transcript file, or `None` if it can't
/// be located/stat'd. Claude rewrites the transcript on every message, so its
/// mtime is a reliable proxy for "time of the last message" — used to backfill
/// `last_activity_at` for conversations that predate that column (see
/// [`crate::store::Store::backfill_last_activity`]).
pub fn transcript_mtime_ms(session_id: &str) -> Option<i64> {
    let path = find_transcript(&claude_config_dir()?, session_id)?;
    let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(ms as i64)
}

/// [`load_history`] against an explicit config dir — the testable core (no env).
fn load_history_in(config_dir: &Path, session_id: &str) -> Vec<ConversationItem> {
    match find_transcript(config_dir, session_id) {
        Some(path) => parse_transcript(&path),
        None => Vec::new(),
    }
}

/// Read a conversation's current context FILL (used tokens only) from its transcript,
/// so the UI can render the ring the moment the conversation is opened — before any
/// new live turn reports usage. Uses the most recent MAIN-thread, real-model assistant
/// `usage` (input + cache = prompt size).
///
/// `context_window` is deliberately left `None`: the transcript carries NO authoritative
/// window, and the model name can't tell e.g. Opus-200k from Opus-1M apart (both are
/// `claude-opus-4-8`). The window comes from the live `modelUsage` and the persisted
/// per-conversation cache on the front, never guessed here. Absent/empty transcript
/// → all-`None`.
pub fn load_context_fill(session_id: &str) -> ContextFill {
    match claude_config_dir() {
        Some(dir) => load_context_fill_in(&dir, session_id),
        None => ContextFill::default(),
    }
}

fn load_context_fill_in(config_dir: &Path, session_id: &str) -> ContextFill {
    let Some(path) = find_transcript(config_dir, session_id) else {
        return ContextFill::default();
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        // The ring is a soft indicator (the next live turn corrects it), so a read
        // failure stays non-fatal — but log a REAL IO error (vs a benign vanished
        // file) instead of silently defaulting, matching the module's policy.
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[history] cannot read transcript for context fill {}: {e}", path.display());
            }
            return ContextFill::default();
        }
    };
    let mut fill = ContextFill::default();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Sub-agent (sidechain) turns run on their own window — never let them drive
        // the conversation's meter.
        if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        // Skip non-real-model lines (a trailing `<synthetic>` compact-boundary / injected
        // message isn't a real model call and would mis-measure the fill).
        match message.get("model").and_then(Value::as_str) {
            Some(m) if !m.is_empty() && m != "<synthetic>" => {}
            _ => continue,
        }
        // The freshest main-thread usage wins (largest accumulated context); keep
        // scanning so the LAST one sticks.
        if let Some(used) = message.get("usage").and_then(context_used_from_usage) {
            fill.context_tokens = Some(used);
        }
    }
    fill
}

/// Reconstruct a conversation's active `/goal` from its on-disk transcript. The CLI records
/// goal state as `attachment` lines of `type:"goal_status"` (DISK-ONLY — never on the live
/// stream), so this is the only way to know a goal is active. Lifecycle snapshots:
/// - `{met:false, sentinel:true, condition}` → goal SET (now active).
/// - `{met:false, condition, reason}` (no sentinel) → still active, unmet check (freshest reason).
/// - `{met:true, condition, reason, …}` (no sentinel) → ACHIEVED → auto-cleared (inactive).
/// - `{met:true, sentinel:true, condition}` → manually CLEARED (inactive).
///
/// We walk in order and keep the last un-terminated goal — exactly what the CLI's own
/// `restoreGoalFromTranscript` does. Returns `None` when no goal is active. An absent/unreadable
/// transcript yields `None` (soft signal, the next turn-edge refetch corrects it).
pub fn load_active_goal(session_id: &str) -> Option<GoalState> {
    let dir = claude_config_dir()?;
    load_active_goal_in(&dir, session_id)
}

fn load_active_goal_in(config_dir: &Path, session_id: &str) -> Option<GoalState> {
    let path = find_transcript(config_dir, session_id)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[history] cannot read transcript for goal scan {}: {e}", path.display());
            }
            return None;
        }
    };
    let mut active: Option<GoalState> = None;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Goals are session-scoped on the main thread; a sub-agent's own transcript must not
        // drive the parent conversation's goal (mirrors the context-fill scan).
        if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("attachment") => {
                let Some(att) = entry.get("attachment") else { continue };
                if att.get("type").and_then(Value::as_str) != Some("goal_status") {
                    continue;
                }
                let met = att.get("met").and_then(Value::as_bool).unwrap_or(false);
                let sentinel = att.get("sentinel").and_then(Value::as_bool).unwrap_or(false);
                match (sentinel, met) {
                    // SET snapshot — a goal is now active. Reason arrives only after the first eval.
                    (true, false) => {
                        let condition = att
                            .get("condition")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        active = Some(GoalState { condition, reason: None });
                    }
                    // Terminal snapshots — manual clear (sentinel+met) or achieved (met). Goal gone.
                    (true, true) | (false, true) => {
                        active = None;
                    }
                    // Unmet check between turns — still active, carry the freshest evaluator reason.
                    (false, false) => {
                        if let Some(goal) = active.as_mut() {
                            if let Some(reason) = att.get("reason").and_then(Value::as_str) {
                                goal.reason = Some(reason.to_string());
                            }
                        }
                    }
                }
            }
            // The `/goal clear` local command prints a stdout the CLI treats as authoritative
            // ("Goal cleared: …" or "No goal set"). Honour it so a stale SET sentinel with no
            // goal_status terminal — e.g. the goal was cleared while our chip was showing it —
            // never keeps the goal alive. Read straight from the `<local-command-stdout>` text.
            Some("user") => {
                if let Some(inner) = local_command_stdout(&entry) {
                    let inner = inner.trim_start();
                    if inner.starts_with("Goal cleared:") || inner.starts_with("No goal set") {
                        active = None;
                    }
                }
            }
            _ => {}
        }
    }
    active
}

/// The inner text of a `user` line whose content is a single `<local-command-stdout>…</…>`
/// (what a LOCAL slash command like `/goal` prints back). `None` for any other user line.
fn local_command_stdout(entry: &Value) -> Option<String> {
    let content = entry.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| {
                (b.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| b.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let t = text.trim();
    let inner = t.strip_prefix("<local-command-stdout>")?;
    Some(inner.strip_suffix("</local-command-stdout>").unwrap_or(inner).to_string())
}

/// Is this user-message text pure `/goal` plumbing — the slash-command echo or its
/// local-command stdout — that the dedicated goal UI (target icon + composer chip) now
/// represents? We drop it from the thread so MANAGING a goal, above all clearing it from the
/// chip, never leaves `/goal clear` / "No goal set" / "Goal set:" noise in the conversation.
/// Matches the `<command-name>/goal</command-name>` invocation (any args) and the `/goal`
/// `<local-command-stdout>` responses (Goal set / cleared / status / "No goal set").
pub(crate) fn is_goal_command_noise(text: &str) -> bool {
    let t = text.trim_start();
    if t.starts_with("<command-name>/goal</command-name>") {
        return true;
    }
    if let Some(rest) = t.strip_prefix("<local-command-stdout>") {
        let inner = rest.trim_start();
        return inner.starts_with("Goal ") || inner.starts_with("No goal set");
    }
    false
}

fn parse_transcript(path: &Path) -> Vec<ConversationItem> {
    match std::fs::read_to_string(path) {
        // The main conversation transcript: skip sidechain (sub-agent) turns — the
        // root Task/Agent tool_use + its result still show, and the sub-agent's own
        // transcript is read separately (see [`super::subagents`]).
        Ok(content) => {
            let (mut items, skipped) = parse_transcript_str(&content, true);
            // Malformed lines were silently dropped before — restoring fewer turns than
            // the transcript holds, with no hint. Surface it as a timeline notice so a
            // partially-restored conversation is never silently incomplete.
            if skipped > 0 {
                items.push(history_notice(format!(
                    "{skipped} history line(s) were unreadable — some messages may be missing."
                )));
            }
            items
        }
        // `find_transcript` already proved the file exists, so NotFound is a rare race
        // (deleted underfoot) — still "nothing to show", not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        // A REAL read error (permissions / IO) on a file we know exists: don't
        // collapse it to an empty conversation — say the history couldn't be read.
        Err(e) => {
            eprintln!("[history] cannot read transcript {}: {e}", path.display());
            vec![history_notice(format!(
                "Unable to read this conversation's history: {e}"
            ))]
        }
    }
}

/// A timeline notice carrying a history-restore problem (unreadable / partially
/// corrupt transcript). Rendered as a visible error bubble by the UI — restoring a
/// conversation must never drop messages silently.
fn history_notice(message: String) -> ConversationItem {
    ConversationItem::Notice {
        subtype: "history_error".to_string(),
        detail: json!({ "message": message }),
    }
}

/// Normalize a JSON-lines transcript into [`ConversationItem`]s plus the COUNT of
/// malformed lines that had to be skipped (so the caller can surface a "history may be
/// incomplete" notice). When `skip_sidechain` is true, sub-agent (`isSidechain:true`)
/// turns are dropped — the behavior the main conversation restore wants. A SUB-AGENT's
/// own transcript is itself entirely sidechain, so [`super::subagents`] calls this with
/// `skip_sidechain = false` to keep every line.
pub(crate) fn parse_transcript_str(
    content: &str,
    skip_sidechain: bool,
) -> (Vec<ConversationItem>, usize) {
    let mut items = Vec::new();
    let mut skipped = 0usize;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            skipped += 1; // tolerate a malformed line, never abort the restore — but count it
            continue;
        };
        if skip_sidechain && entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("user") => push_user(&entry, &mut items),
            Some("assistant") => push_assistant(&entry, &mut items),
            // mode / system / attachment / file-history-snapshot / summary / … —
            // bookkeeping the UI does not render.
            _ => {}
        }
    }
    (items, skipped)
}

/// A `user` transcript line is either a real prompt (string or text blocks) or
/// the delivery vehicle for `tool_result` blocks.
fn push_user(entry: &Value, items: &mut Vec<ConversationItem>) {
    // Meta user lines (injected command output, system reminders, …) are not real
    // turns — the UI never shows them, so drop them on restore too.
    if entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let Some(content) = entry.get("message").and_then(|m| m.get("content")) else {
        return;
    };
    let uuid = entry
        .get("uuid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    match content {
        Value::String(text) => push_user_text(&uuid, text, items),
        Value::Array(blocks) => {
            let mut text = String::new();
            let mut has_image = false;
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                    Some("image") => has_image = true,
                    Some("tool_result") => items.push(ConversationItem::ToolResult {
                        tool_use_id: b
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        content: b.get("content").cloned().unwrap_or(Value::Null),
                        is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                        parent_tool_use_id: None,
                    }),
                    _ => {}
                }
            }
            // An image-only human turn (no text block) still gets a bubble on reload —
            // a "[image]" placeholder, consistent with the history-list excerpt — instead
            // of vanishing (the base64 itself is never rendered as text).
            if text.trim().is_empty() && has_image {
                push_user_text(&uuid, "[image]", items);
            } else {
                push_user_text(&uuid, &text, items);
            }
        }
        _ => {}
    }
}

fn push_user_text(uuid: &str, text: &str, items: &mut Vec<ConversationItem>) {
    if text.trim().is_empty() {
        return;
    }
    // `/goal` plumbing (the command echo + its "Goal set/cleared" / "No goal set" stdout) is now
    // shown by the dedicated goal UI — drop it so it never clutters the restored thread.
    if is_goal_command_noise(text) {
        return;
    }
    items.push(ConversationItem::UserMessage {
        id: uuid.to_string(),
        text: text.to_string(),
        parent_tool_use_id: None,
        // A transcript restore is already chronological → appended, never spliced.
        replay: false,
    });
}

/// An `assistant` transcript line carries an Anthropic `message` with the same
/// `content[]` shape the live assembler normalizes.
fn push_assistant(entry: &Value, items: &mut Vec<ConversationItem>) {
    let Some(message) = entry.get("message") else {
        return;
    };
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let blocks = normalize_blocks(message.get("content"));
    if blocks.is_empty() {
        return;
    }
    // The CLI may persist one logical assistant turn (same message id) across
    // several lines; merge them into a single message so the UI shows one bubble
    // and the store's id-dedup never drops the later blocks.
    if !id.is_empty() {
        if let Some(ConversationItem::AssistantMessage {
            id: prev_id,
            blocks: prev_blocks,
            ..
        }) = items.last_mut()
        {
            if *prev_id == id {
                prev_blocks.extend(blocks);
                return;
            }
        }
    }
    items.push(ConversationItem::AssistantMessage {
        id,
        blocks,
        parent_tool_use_id: None,
        // Claude targets rewind/fork by prompt text — no Codex turn id.
        turn_id: None,
    });
}

// ============================================================================
// Rewind — truncate a conversation's transcript at a chosen message.
//
// "Resume from here" cuts the on-disk transcript so the conversation ends
// just before a genuine human-prompt boundary, then the app re-spawns
// `claude --resume` on the shortened file. VERIFIED (live probe, binary 2.1.187):
// resume HONOURS a truncated transcript — the dropped turns do not survive in the
// resumed context, and there is no hidden cache; the file is resolved by the
// cwd→slug mapping, so the same `session_id` file under the conversation's cwd is
// read fresh. Cutting ONLY at a genuine human-prompt boundary guarantees the kept
// history always ends on a COMPLETE assistant response — never a dangling `tool_use`
// whose `tool_result` (delivered as a later `user` line) was dropped.
// ============================================================================

/// What a rewind removed, returned to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RewindOutcome {
    /// For a USER-message rewind, the text of the removed prompt so the composer can be
    /// re-seeded with it ("go back to this prompt"). `None` for an assistant-message rewind
    /// (its response is kept; the user just continues with a new message).
    pub removed_prompt: Option<String>,
    /// How many transcript lines were dropped. `0` means nothing followed the target —
    /// a no-op (the conversation already ended there), and the file is left untouched.
    pub removed_lines: usize,
}

/// The result of a fork ("branch a new conversation here"): the freshly-written
/// branch conversation (ready to bring into the app via `reactivateDiskConversation`) and,
/// for a USER-message fork, the removed prompt text to seed the new conversation's composer.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ForkOutcome {
    pub conversation: DiskConversation,
    pub removed_prompt: Option<String>,
}

/// The prompt text of a GENUINE human turn at line `i` (a real bubble the user sees) —
/// `None` for a tool_result delivery, a meta/sidechain line, or an assistant line.
/// Reuses [`first_user_text`] so a cut boundary matches exactly what the history excerpt
/// treats as a prompt. Gating on `type == "user"` is required: `first_user_text` alone
/// would also return an assistant line's text blocks.
fn human_prompt_at(parsed: &[Option<Value>], i: usize) -> Option<String> {
    let v = parsed.get(i)?.as_ref()?;
    if v.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    first_user_text(v)
}

/// A stable comparison key for matching a LIVE user turn's text (from the front) against an
/// on-disk human-prompt line, tolerant of the two shapes the SAME action takes on each side:
/// - a slash command typed live ("/foo bar") vs its persisted header
///   ("&lt;command-name&gt;/foo&lt;/command-name&gt;…") — both reduce to the command token "/foo";
/// - the image placeholder ("[image]") stays itself;
/// - a plain prompt maps to itself.
/// MUST mirror the front's `promptMatchKey` (ConductorThread) so occurrence counting agrees.
fn prompt_match_key(text: &str) -> String {
    let t = text.trim();
    // Persisted slash-command header → the command name only.
    if let Some(name) = extract_tag(t, "command-name") {
        return name.trim().to_string();
    }
    // Raw slash command typed live → its command token (drop args so "/foo a" ≡ the header).
    if t.starts_with('/') {
        return t.split_whitespace().next().unwrap_or(t).to_string();
    }
    t.to_string()
}

/// Text between `<tag>` and `</tag>`, if present.
fn extract_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(&close)?;
    Some(rest[..end].to_string())
}

/// The removed prompt as USABLE composer text: `None` for the image placeholder (nothing to
/// re-type), the reconstructed "/cmd args" for a persisted slash-command header, else the
/// text verbatim. Keeps the composer re-seed clean instead of dumping raw &lt;command-*&gt; XML.
fn clean_prompt_for_composer(text: &str) -> Option<String> {
    if text.trim() == "[image]" {
        return None;
    }
    if let Some(name) = extract_tag(text, "command-name") {
        let args = extract_tag(text, "command-args").unwrap_or_default();
        let args = args.trim();
        let name = name.trim();
        return Some(if args.is_empty() { name.to_string() } else { format!("{name} {args}") });
    }
    Some(text.to_string())
}

/// Resolve where to cut the transcript for a rewind/fork at `target_id`, returning the cut
/// line index (keep `[0, cut)`, drop the rest) and, for a USER target, the removed prompt as
/// clean composer text.
///
/// - USER target: located by its top-level `uuid` (= the front's user `Turn.id` for a
///   RESUMED conversation). A LIVE turn instead carries a synthetic front id (`user_N`) that
///   never appears on disk, so we FALL BACK to matching by [`prompt_match_key`] over
///   `target_text` (tolerant of slash/image shapes). `occurrence` (the front's index among
///   identical-key prompts) disambiguates repeats — critical since short prompts ("ok",
///   "continue") recur; without it the fallback would silently cut at the LAST repeat. The
///   cut lands ON the prompt (it and everything after are dropped). Refused on the first
///   prompt (would leave an unresumable, turn-less file).
/// - ASSISTANT target: located by `message.id` (stable both live and on disk). The cut lands
///   at the NEXT genuine human prompt, keeping the whole response + its tool_results intact.
fn resolve_cut(
    raw: &[&str],
    parsed: &[Option<Value>],
    target_id: &str,
    target_is_user: bool,
    target_text: Option<&str>,
    occurrence: Option<usize>,
) -> Result<(usize, Option<String>), String> {
    if target_is_user {
        // 1. Exact top-level `uuid` match (a resumed conversation's real transcript id).
        let mut ti = (0..raw.len()).find(|&i| {
            parsed[i].as_ref().and_then(|v| v.get("uuid").and_then(Value::as_str)) == Some(target_id)
                && human_prompt_at(parsed, i).is_some()
        });
        // 2. Fallback for a LIVE turn (synthetic id): match by key, disambiguated by the
        //    front's occurrence index; fall back to the LAST match only if unspecified.
        if ti.is_none() {
            if let Some(text) = target_text {
                let key = prompt_match_key(text);
                let matches: Vec<usize> = (0..raw.len())
                    .filter(|&i| human_prompt_at(parsed, i).map(|t| prompt_match_key(&t)) == Some(key.clone()))
                    .collect();
                ti = occurrence
                    .and_then(|o| matches.get(o).copied())
                    .or_else(|| matches.last().copied());
            }
        }
        let ti = ti.ok_or_else(|| "target message not found in the transcript".to_string())?;
        let has_prior_turn = (0..ti).any(|i| human_prompt_at(parsed, i).is_some());
        if !has_prior_turn {
            return Err(
                "Cannot resume before the first message of the conversation.".to_string(),
            );
        }
        let removed = human_prompt_at(parsed, ti).and_then(|t| clean_prompt_for_composer(&t));
        Ok((ti, removed))
    } else {
        // An assistant turn may span several lines sharing one `message.id` — take its
        // LAST line, then cut at the NEXT genuine human prompt after it.
        let mut ai = None;
        for i in (0..raw.len()).rev() {
            let is_target = parsed[i]
                .as_ref()
                .and_then(|v| v.get("message").and_then(|m| m.get("id")).and_then(Value::as_str))
                == Some(target_id);
            if is_target {
                ai = Some(i);
                break;
            }
        }
        let ai = ai.ok_or_else(|| "target response not found in the transcript".to_string())?;
        let next_human = (ai + 1..raw.len()).find(|&i| human_prompt_at(parsed, i).is_some());
        Ok((next_human.unwrap_or(raw.len()), None))
    }
}

/// Read a transcript and split it into raw (verbatim) lines + their parsed values, kept
/// index-aligned. Shared by rewind and fork.
fn read_transcript_lines(path: &Path) -> Result<(String, Vec<Option<Value>>), String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("could not read the transcript: {e}"))?;
    let parsed: Vec<Option<Value>> =
        content.lines().map(|l| serde_json::from_str::<Value>(l.trim()).ok()).collect();
    Ok((content, parsed))
}

/// Truncate `session_id`'s transcript at `target_id` (rewind the conversation IN PLACE).
/// Env wrapper around the testable [`rewind_transcript_in`] core. See [`resolve_cut`].
pub fn rewind_transcript(
    session_id: &str,
    target_id: &str,
    target_is_user: bool,
    target_text: Option<&str>,
    occurrence: Option<usize>,
) -> Result<RewindOutcome, String> {
    let config_dir = claude_config_dir()
        .ok_or_else(|| "Claude config directory not found".to_string())?;
    rewind_transcript_in(&config_dir, session_id, target_id, target_is_user, target_text, occurrence)
}

fn rewind_transcript_in(
    config_dir: &Path,
    session_id: &str,
    target_id: &str,
    target_is_user: bool,
    target_text: Option<&str>,
    occurrence: Option<usize>,
) -> Result<RewindOutcome, String> {
    let path = find_transcript(config_dir, session_id)
        .ok_or_else(|| "conversation transcript not found".to_string())?;
    let (content, parsed) = read_transcript_lines(&path)?;
    let raw: Vec<&str> = content.lines().collect();

    let (cut_index, removed_prompt) =
        resolve_cut(&raw, &parsed, target_id, target_is_user, target_text, occurrence)?;

    let removed_lines = raw.len() - cut_index;
    if removed_lines == 0 {
        // Nothing after the target — the conversation already ends here. Leave the file
        // untouched (a no-op the UI can surface as "nothing to rewind").
        return Ok(RewindOutcome { removed_prompt, removed_lines: 0 });
    }

    // Rewrite the kept lines verbatim via a temp file + atomic rename, so a crash
    // mid-write can never leave a half-truncated (corrupt) transcript in place.
    let kept = &raw[..cut_index];
    let body = if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) };
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("transcript");
    let tmp = path.with_file_name(format!(".{file_name}.rewind-tmp"));
    std::fs::write(&tmp, &body)
        .map_err(|e| format!("could not write the truncated transcript: {e}"))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("could not replace the transcript: {e}"))?;

    Ok(RewindOutcome { removed_prompt, removed_lines })
}

/// Fork a NEW conversation branched at `target_id` (NON-destructive: the original
/// transcript is untouched). Writes the kept history to a fresh `<new_uuid>.jsonl` in the
/// SAME project dir (so `--resume` resolves it under the same cwd slug), rewriting each
/// line's `sessionId` to the new id, then head-reads it back into a [`DiskConversation`]
/// the UI turns into a real conversation. Env wrapper around [`fork_transcript_in`].
pub fn fork_transcript(
    session_id: &str,
    target_id: &str,
    target_is_user: bool,
    target_text: Option<&str>,
    occurrence: Option<usize>,
) -> Result<ForkOutcome, String> {
    let config_dir = claude_config_dir()
        .ok_or_else(|| "Claude config directory not found".to_string())?;
    fork_transcript_in(&config_dir, session_id, target_id, target_is_user, target_text, occurrence)
}

fn fork_transcript_in(
    config_dir: &Path,
    session_id: &str,
    target_id: &str,
    target_is_user: bool,
    target_text: Option<&str>,
    occurrence: Option<usize>,
) -> Result<ForkOutcome, String> {
    let path = find_transcript(config_dir, session_id)
        .ok_or_else(|| "conversation transcript not found".to_string())?;
    let (content, parsed) = read_transcript_lines(&path)?;
    let raw: Vec<&str> = content.lines().collect();

    let (cut_index, removed_prompt) =
        resolve_cut(&raw, &parsed, target_id, target_is_user, target_text, occurrence)?;

    // The branch needs a fresh session id AND filename (a session id IS its file stem). Write
    // it beside the original so the cwd→slug resolution that `--resume` relies on still holds.
    let new_id = uuid::Uuid::new_v4().to_string();
    let new_path = path.with_file_name(format!("{new_id}.jsonl"));

    // Rewrite each kept line's `sessionId` to the new id (parsed, not verbatim, since the id
    // is embedded per line); a rare unparseable line is copied through as-is.
    let mut out = String::new();
    for (i, line) in raw[..cut_index].iter().enumerate() {
        match &parsed[i] {
            Some(v) => {
                let mut v = v.clone();
                if v.get("sessionId").is_some() {
                    v["sessionId"] = Value::String(new_id.clone());
                }
                out.push_str(&v.to_string());
                out.push('\n');
            }
            None => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    std::fs::write(&new_path, &out)
        .map_err(|e| format!("could not write the forked conversation: {e}"))?;

    // Head-read the new file back into the same row shape the history panel uses.
    let conversation = scan_disk_conversation(&new_path)
        .ok_or_else(|| "the forked conversation could not be re-read".to_string())?;
    Ok(ForkOutcome { conversation, removed_prompt })
}

// ============================================================================
// On-disk conversation HISTORY (the search-history panel).
//
// Lists EVERY conversation transcript on disk — including ones the app has
// forgotten (no SQLite row, "orphans") — with the cheap head-read metadata the
// panel shows, plus a cached full-text search index. The PREVIEW reuses
// [`load_history`] (a full parse of one transcript), so nothing here re-renders
// messages. Two passes by design (finding #Option-A): the LIST is a bounded
// head-read so the panel opens instantly; the heavier full-text INDEX is built
// lazily off that path (see the `HistoryIndex` managed state on the IPC side).
// ============================================================================

/// How far into a transcript the listing head-read scans before giving up on the
/// optional `ai-title`. The cwd and first human message sit in the first lines and
/// trigger an early break; this only bounds the worst case of a title-less file, so
/// we never read a whole (possibly huge) transcript just to LIST it.
/// Shared with the Codex rollout scanner ([`super::codex::history`]).
pub(crate) const HEAD_SCAN_LINES: usize = 256;

/// The identifying excerpt (first human message) is flattened to one line and capped
/// at this many chars. Shared with the Codex rollout scanner so both backends' rows
/// truncate identically.
pub(crate) const EXCERPT_CHARS: usize = 120;

/// Once the cwd + first human message are known, how many more lines to read looking
/// for the optional `ai-title` before stopping. The title line sits right after the
/// first user+assistant exchange, so a small window catches it; a title-LESS
/// transcript (every Tosse-native conversation — the binary is asked NOT to persist a
/// title) then costs only a couple of parses instead of the full HEAD_SCAN_LINES cap.
const TITLE_GRACE_LINES: usize = 24;

/// Per-conversation searchable-body cap (bytes). Bounds the index's memory and
/// per-query scan on a very long conversation; the overflow is dropped (logged once
/// per build — never a silent truncation). Shared with the Codex rollout indexer.
pub(crate) const INDEX_BODY_CAP: usize = 200_000;

/// One conversation discovered on disk — the cheap "head-read" row the history panel
/// lists. NO full parse here (that's [`load_history`], used by the preview). Field
/// names are snake_case to match the other IPC payloads; the front consumes this
/// shape directly (it is a transient view, not a persisted domain record).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DiskConversation {
    /// Claude's session UUID (= transcript file stem). Join key to a SQLite row and
    /// the `--resume` target.
    pub session_id: String,
    /// Real absolute cwd the session ran in (read from the transcript itself — the
    /// dir slug is lossy and can't be inverted back to a path).
    pub cwd: String,
    /// Repo root derived from `cwd` (an app worktree segment stripped). Drives the
    /// panel's repo grouping and the repo to (re)create on reactivation.
    pub repo_root: String,
    /// Git branch captured in the transcript, if any (a label hint).
    pub git_branch: Option<String>,
    /// Auto-generated title (`ai-title` line), if the CLI wrote one — the nicest
    /// label for an orphan that has no SQLite name.
    pub title: Option<String>,
    /// First human message, flattened + capped — the row's identifying line.
    pub excerpt: String,
    /// Transcript mtime (Unix ms) ≈ time of the last message. Recency sort key.
    pub mtime_ms: i64,
    /// Agent backend this conversation ran on (`"claude"` | `"codex"`). Drives the
    /// panel's backend badge and — on reactivation — which conversation `kind` (and
    /// which cold-history reader) the front creates. Claude rows read from `~/.claude`
    /// transcripts; Codex rows from `~/.codex` rollouts.
    pub backend: String,
}

/// App convention: a worktree lives at `<repo>/.claude/worktrees/<branch>` (see the
/// `EnterWorktree` tooling). Roll such a cwd back up to `<repo>` so every worktree of
/// a repo groups under — and reactivates into — the one repo, matching the front's
/// existing longest-prefix association. A non-worktree cwd is its own root.
pub fn repo_root_from_cwd(cwd: &str) -> String {
    match cwd.find("/.claude/worktrees/") {
        Some(idx) => cwd[..idx].to_string(),
        None => cwd.to_string(),
    }
}

/// List every conversation found on disk, most-recent-first — BOTH backends: Claude's
/// transcripts (`~/.claude/projects`) and Codex's rollouts (`~/.codex/sessions`), merged
/// and re-sorted so a mixed history reads as one recency-ordered list.
pub fn list_disk_conversations() -> Vec<DiskConversation> {
    let mut out = match claude_config_dir() {
        Some(dir) => list_disk_conversations_in(&dir),
        None => Vec::new(),
    };
    out.extend(super::codex::list_codex_disk_conversations());
    // Re-sort the merged set: each backend's scan is internally ordered, but the two
    // interleave by time (a recent Codex thread must sit above an older Claude one).
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

fn list_disk_conversations_in(config_dir: &Path) -> Vec<DiskConversation> {
    let mut out = Vec::new();
    for dir in project_dirs(config_dir) {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            // Top-level `<session_id>.jsonl` only — a sub-agent's transcript lives in
            // a `subagents/` sub-dir, never a conversation of its own.
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(conv) = scan_disk_conversation(&path) {
                out.push(conv);
            }
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

/// Milliseconds since the Unix epoch of a file's mtime, `0` when unavailable. The
/// recency key shared by the disk listing ([`scan_disk_conversation`]) and the search
/// index ([`index_one`]) — kept in one place so the two always order conversations the
/// same way.
pub(crate) fn file_mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Bounded head-read of one transcript → its listing row, or `None` for an
/// empty/aborted session (no human message) which is filtered out as noise.
fn scan_disk_conversation(path: &Path) -> Option<DiskConversation> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime_ms = file_mtime_ms(&meta);

    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut cwd: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut title: Option<String> = None;
    let mut excerpt: Option<String> = None;
    // The line index after which to stop once cwd + excerpt are known (a short grace
    // window to still catch an `ai-title` line). `None` until both are found.
    let mut settle_at: Option<usize> = None;

    for (i, line) in reader.lines().enumerate().take(HEAD_SCAN_LINES) {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            if let Some(c) = entry.get("cwd").and_then(Value::as_str) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }
        if git_branch.is_none() {
            if let Some(b) = entry.get("gitBranch").and_then(Value::as_str) {
                if !b.is_empty() {
                    git_branch = Some(b.to_string());
                }
            }
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("ai-title") => {
                if let Some(t) = entry.get("aiTitle").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        title = Some(t.to_string());
                    }
                }
            }
            Some("user") if excerpt.is_none() => {
                if let Some(t) = first_user_text(&entry) {
                    excerpt = Some(flatten_truncate(&t, EXCERPT_CHARS));
                }
            }
            _ => {}
        }
        // A title is the best label — nothing better lies further in; stop now.
        if title.is_some() {
            break;
        }
        // Otherwise, once cwd + excerpt are known, read only a short grace window more
        // (to catch a title) then stop — so the common title-less case stays cheap.
        if cwd.is_some() && excerpt.is_some() {
            match settle_at {
                None => settle_at = Some(i + TITLE_GRACE_LINES),
                Some(limit) if i >= limit => break,
                _ => {}
            }
        }
    }

    // Noise filter: no human message → aborted/empty session, never listed. Kept in
    // lock-step with `index_one`'s filter so the index never holds a row the list can't
    // show (else a search hit would be silently dropped on the front).
    let excerpt = excerpt?;
    let cwd = cwd.unwrap_or_default();
    let repo_root = repo_root_from_cwd(&cwd);
    Some(DiskConversation {
        session_id,
        cwd,
        repo_root,
        git_branch,
        title,
        excerpt,
        mtime_ms,
        backend: "claude".to_string(),
    })
}

/// The text of a `user` transcript line IF it is a real human prompt — `None` for a
/// meta / sidechain line or a `tool_result`-only delivery (no human text). Mirrors
/// [`push_user`]'s filtering so the listed excerpt is the same first prompt the
/// preview shows.
fn first_user_text(entry: &Value) -> Option<String> {
    if entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let content = entry.get("message").and_then(|m| m.get("content"))?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            let mut t = String::new();
            let mut has_image = false;
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(s) = b.get("text").and_then(Value::as_str) {
                            if !t.is_empty() {
                                t.push(' ');
                            }
                            t.push_str(s);
                        }
                    }
                    Some("image") => has_image = true,
                    _ => {}
                }
            }
            // An image-only human turn (e.g. a screenshot sent with no caption) is real
            // content — give it a placeholder excerpt so the conversation is still listed
            // and indexed, instead of being discarded as an empty "noise" session.
            if t.trim().is_empty() && has_image {
                return Some("[image]".to_string());
            }
            t
        }
        _ => return None,
    };
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// The concatenated text blocks of an `assistant` line (for the search body).
fn assistant_text(entry: &Value) -> String {
    let Some(Value::Array(blocks)) = entry.get("message").and_then(|m| m.get("content")) else {
        return String::new();
    };
    let mut t = String::new();
    for b in blocks {
        if b.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(s) = b.get("text").and_then(Value::as_str) {
                if !t.is_empty() {
                    t.push(' ');
                }
                t.push_str(s);
            }
        }
    }
    t
}

/// Collapse all whitespace to single spaces and cap at `max` chars (… elided).
pub(crate) fn flatten_truncate(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let head: String = flat.chars().take(max).collect();
        format!("{head}…")
    }
}

// ---- Full-text search index ------------------------------------------------

/// A conversation's full searchable text, built once and cached (see the
/// `HistoryIndex` managed state on the IPC side). Holds the FOLDED (lowercased +
/// accent-stripped) haystacks for matching plus the original body for snippets.
pub struct IndexedConversation {
    pub session_id: String,
    title_fold: String,
    excerpt_fold: String,
    body_fold: String,
    /// Original (unfolded) body, for cutting a readable snippet around a hit. Has the
    /// SAME char count as `body_fold` ([`fold`] is 1 char → 1 char), so a char index
    /// into one maps to the other.
    body: String,
    mtime_ms: i64,
}

impl IndexedConversation {
    /// Build an index row from raw (unfolded) `title`/`excerpt`/`body`. Used by the Codex
    /// backend, which derives the same searchable shape from a rollout — keeping the
    /// folding + field layout in ONE place so Claude and Codex rows score identically
    /// (and the [`fold`] 1-char→1-char snippet invariant holds for both).
    pub(crate) fn from_text(
        session_id: String,
        title: &str,
        excerpt: &str,
        body: String,
        mtime_ms: i64,
    ) -> Self {
        IndexedConversation {
            session_id,
            title_fold: fold(title),
            excerpt_fold: fold(excerpt),
            body_fold: fold(&body),
            body,
            mtime_ms,
        }
    }
}

/// A search result: which conversation matched, its relevance score, and a short
/// snippet around the first body hit (empty when only title/excerpt matched).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SearchHit {
    pub session_id: String,
    pub score: i64,
    pub snippet: String,
}

/// Build the full-text index over every main-thread transcript of BOTH backends
/// (Claude transcripts + Codex rollouts). Heavy (reads each file in full) — callers run
/// it once, off the panel-open path, and cache it.
pub fn build_search_index() -> Vec<IndexedConversation> {
    let mut out = match claude_config_dir() {
        Some(dir) => build_search_index_in(&dir),
        None => Vec::new(),
    };
    out.extend(super::codex::build_codex_search_index());
    out
}

fn build_search_index_in(config_dir: &Path) -> Vec<IndexedConversation> {
    let mut out = Vec::new();
    for dir in project_dirs(config_dir) {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(idx) = index_one(&path) {
                out.push(idx);
            }
        }
    }
    out
}

fn index_one(path: &Path) -> Option<IndexedConversation> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let mtime_ms = std::fs::metadata(path)
        .ok()
        .map(|m| file_mtime_ms(&m))
        .unwrap_or(0);
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut title = String::new();
    let mut excerpt = String::new();
    let mut body = String::new();
    let mut truncated = false;

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Sub-agent turns run on their own thread — keep them out of the
        // conversation's search text (consistent with the main-thread preview).
        if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("ai-title") => {
                if let Some(t) = entry.get("aiTitle").and_then(Value::as_str) {
                    title = t.to_string();
                }
            }
            Some("user") => {
                if let Some(t) = first_user_text(&entry) {
                    if excerpt.is_empty() {
                        excerpt = flatten_truncate(&t, EXCERPT_CHARS);
                    }
                    append_capped(&mut body, &t, INDEX_BODY_CAP, &mut truncated);
                }
            }
            Some("assistant") => {
                let t = assistant_text(&entry);
                if !t.is_empty() {
                    append_capped(&mut body, &t, INDEX_BODY_CAP, &mut truncated);
                }
            }
            _ => {}
        }
    }
    if truncated {
        eprintln!("[history] search index: body for {session_id} capped at {INDEX_BODY_CAP} bytes");
    }
    // Same noise filter as the list (`scan_disk_conversation`): a transcript with no
    // human message is an aborted/empty session. Keeping the two in lock-step means the
    // index never contains a conversation the list can't display — otherwise a search
    // hit on such a row would be silently dropped by the front (it joins hits to the
    // listed rows by session_id).
    if excerpt.trim().is_empty() {
        return None;
    }
    Some(IndexedConversation {
        session_id,
        title_fold: fold(&title),
        excerpt_fold: fold(&excerpt),
        body_fold: fold(&body),
        body,
        mtime_ms,
    })
}

/// Append `add` to `body` (space-separated) unless already at the byte cap. Caps at
/// `cap` + at most one message — bounds memory without an O(n²) char recount. Shared
/// with the Codex rollout indexer so both backends' bodies grow the same way.
pub(crate) fn append_capped(body: &mut String, add: &str, cap: usize, truncated: &mut bool) {
    if body.len() >= cap {
        *truncated = true;
        return;
    }
    if !body.is_empty() {
        body.push(' ');
    }
    body.push_str(add);
}

/// Lowercase + strip common Latin diacritics so search ignores case AND accents
/// ("déployé" ⇄ "deploye", "AUTH" ⇄ "auth"). Deliberately **1 char → 1 char** (NOT
/// `str::to_lowercase`, which can change length, e.g. ß→ss) so a folded match
/// position maps back to the original body for snippets. Covers the French/Latin
/// accents that actually occur in these transcripts, not every Unicode case.
fn fold(s: &str) -> String {
    s.chars().map(fold_char).collect()
}

fn fold_char(c: char) -> char {
    match c {
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'Ç' | 'ç' => 'c',
        'È' | 'É' | 'Ê' | 'Ë' | 'è' | 'é' | 'ê' | 'ë' => 'e',
        'Ì' | 'Í' | 'Î' | 'Ï' | 'ì' | 'í' | 'î' | 'ï' => 'i',
        'Ñ' | 'ñ' => 'n',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'ù' | 'ú' | 'û' | 'ü' => 'u',
        'Ý' | 'Ÿ' | 'ý' | 'ÿ' => 'y',
        other => other.to_ascii_lowercase(),
    }
}

/// Score every indexed conversation against `query`, best-first (recency breaks
/// ties). A conversation matches only when EVERY query term is found (AND); a term
/// matches by accent/case-insensitive substring across title/excerpt/body, with a
/// light edit-distance-1 fallback on the short fields so a small typo still finds a
/// conversation by its title.
pub fn score_index(index: &[IndexedConversation], query: &str) -> Vec<SearchHit> {
    let terms: Vec<String> = fold(query).split_whitespace().map(str::to_string).collect();
    if terms.is_empty() {
        return Vec::new();
    }
    // (score, mtime, hit) so the recency tiebreak survives the projection to SearchHit.
    let mut scored: Vec<(i64, i64, SearchHit)> = Vec::new();
    for conv in index {
        let mut score = 0i64;
        let mut all = true;
        for term in &terms {
            let mut term_score = 0i64;
            if conv.title_fold.contains(term.as_str()) {
                term_score += 100;
            }
            if conv.excerpt_fold.contains(term.as_str()) {
                term_score += 40;
            }
            let body_hits = conv.body_fold.matches(term.as_str()).count();
            if body_hits > 0 {
                term_score += 10 + (body_hits.min(5) as i64) * 2;
            }
            // Typo tolerance: short fields only (cheap) and only if nothing matched.
            if term_score == 0 && term.chars().count() >= 4 {
                if fuzzy_token_match(&conv.title_fold, term) {
                    term_score += 25;
                } else if fuzzy_token_match(&conv.excerpt_fold, term) {
                    term_score += 15;
                }
            }
            if term_score == 0 {
                all = false;
                break;
            }
            score += term_score;
        }
        if all {
            let snippet = snippet_around(&conv.body, &conv.body_fold, &terms);
            scored.push((
                score,
                conv.mtime_ms,
                SearchHit {
                    session_id: conv.session_id.clone(),
                    score,
                    snippet,
                },
            ));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    scored.into_iter().map(|(_, _, h)| h).collect()
}

/// A short readable snippet of the ORIGINAL body around the first term hit, or empty
/// when no term hits the body (title/excerpt-only match). Works in CHAR indices
/// because [`fold`] is 1 char → 1 char, so `body_fold` and `body` align by char.
fn snippet_around(body: &str, body_fold: &str, terms: &[String]) -> String {
    let mut pos: Option<usize> = None;
    for t in terms {
        if let Some(byte) = body_fold.find(t.as_str()) {
            let char_idx = body_fold[..byte].chars().count();
            pos = Some(pos.map_or(char_idx, |p| p.min(char_idx)));
        }
    }
    let Some(pos) = pos else {
        return String::new();
    };
    // Map the char window [pos-40, pos+80) to byte offsets in a single pass, instead of
    // collecting the whole body into a `Vec<char>` just to slice it (the body is capped at
    // INDEX_BODY_CAP, so that Vec was up to ~200K elements allocated per hit). We stop as
    // soon as the window's end is reached — reaching it proves there is more body after the
    // snippet, which is exactly the trailing-"…" condition.
    let start_char = pos.saturating_sub(40);
    let end_char = pos + 80;
    let mut byte_start = 0usize;
    let mut byte_end: Option<usize> = None;
    for (ci, (bi, _)) in body.char_indices().enumerate() {
        if ci == start_char {
            byte_start = bi;
        }
        if ci == end_char {
            byte_end = Some(bi);
            break;
        }
    }
    let core = match byte_end {
        Some(b) => &body[byte_start..b],
        None => &body[byte_start..],
    };
    let mut s = core.split_whitespace().collect::<Vec<_>>().join(" ");
    if start_char > 0 {
        s = format!("…{s}");
    }
    if byte_end.is_some() {
        s.push('…');
    }
    s
}

/// True if any alphanumeric token of `haystack_fold` is within edit distance 1 of
/// `term` (both already folded).
fn fuzzy_token_match(haystack_fold: &str, term: &str) -> bool {
    haystack_fold
        .split(|c: char| !c.is_alphanumeric())
        .any(|tok| !tok.is_empty() && within_edit_distance_1(tok, term))
}

/// Levenshtein distance ≤ 1 (one insertion, deletion, or substitution).
fn within_edit_distance_1(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (mut i, mut j, mut edits) = (0usize, 0usize, 0u32);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        match a.len().cmp(&b.len()) {
            std::cmp::Ordering::Equal => {
                i += 1;
                j += 1;
            } // substitution
            std::cmp::Ordering::Greater => i += 1, // deletion from `a`
            std::cmp::Ordering::Less => j += 1,    // insertion into `a`
        }
    }
    // Any unconsumed tail is one more edit.
    edits as usize + (a.len() - i) + (b.len() - j) <= 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::model::NormalizedBlock;
    use std::io::Write;

    /// Write a transcript fixture into a fake config dir and load it back through
    /// the glob-by-session-id path, asserting the normalized items match a real
    /// (user → assistant → tool) exchange.
    #[test]
    fn loads_user_assistant_and_tool_result_from_transcript() {
        // Isolated temp config dir so the test never touches the real ~/.claude.
        let base = std::env::temp_dir().join(format!("tosse-hist-{}", std::process::id()));
        let proj = base.join("projects").join("-some-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        let session_id = "11111111-2222-3333-4444-555555555555";
        let mut f = std::fs::File::create(proj.join(format!("{session_id}.jsonl"))).unwrap();
        // A meta user line (skipped), a real prompt, an assistant turn with a
        // tool_use, the tool_result delivery, then the final assistant text. The
        // assistant turn is split across two same-id lines to exercise merging.
        let lines = [
            r#"{"type":"user","isMeta":true,"uuid":"m0","message":{"role":"user","content":"<system-reminder>"}}"#,
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"list the files"}}"#,
            r#"{"type":"assistant","uuid":"a1","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"sure"}]}}"#,
            r#"{"type":"assistant","uuid":"a2","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}"#,
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a.txt","is_error":false}]}}"#,
            r#"{"type":"assistant","uuid":"a3","message":{"id":"msg_2","role":"assistant","content":[{"type":"text","text":"done"}]}}"#,
            // A sidechain line must be ignored.
            r#"{"type":"assistant","isSidechain":true,"uuid":"a4","message":{"id":"msg_9","role":"assistant","content":[{"type":"text","text":"subagent"}]}}"#,
        ];
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        drop(f);

        let items = load_history_in(&base, session_id);
        std::fs::remove_dir_all(&base).ok();

        // user prompt, assistant(text+tool_use merged), tool_result, assistant(text)
        assert_eq!(items.len(), 4, "got {items:#?}");
        match &items[0] {
            ConversationItem::UserMessage { text, .. } => assert_eq!(text, "list the files"),
            other => panic!("expected UserMessage, got {other:?}"),
        }
        match &items[1] {
            ConversationItem::AssistantMessage { id, blocks, .. } => {
                assert_eq!(id, "msg_1");
                assert_eq!(blocks.len(), 2, "split same-id lines should merge");
                assert!(matches!(&blocks[0], NormalizedBlock::Text { text } if text == "sure"));
                assert!(matches!(&blocks[1], NormalizedBlock::ToolUse { name, .. } if name == "Bash"));
            }
            other => panic!("expected AssistantMessage, got {other:?}"),
        }
        match &items[2] {
            ConversationItem::ToolResult { tool_use_id, is_error, .. } => {
                assert_eq!(tool_use_id, "toolu_1");
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
        match &items[3] {
            ConversationItem::AssistantMessage { id, .. } => assert_eq!(id, "msg_2"),
            other => panic!("expected AssistantMessage, got {other:?}"),
        }
    }

    #[test]
    fn missing_transcript_is_empty_not_an_error() {
        let base = std::env::temp_dir().join("tosse-hist-nope-dir");
        assert!(load_history_in(&base, "does-not-exist").is_empty());
        // Same for the context fill: no transcript → nothing seeded, not an error.
        assert_eq!(load_context_fill_in(&base, "does-not-exist"), ContextFill::default());
    }

    /// REGRESSION (task 2247ebd6): a MODEL-invoked skill's SKILL.md body lands on disk as a
    /// `user` line with `isMeta:true` (a text-block array opening on "Base directory for this
    /// skill:"). On restore it MUST be skipped — mirroring the live assembler — so a reloaded
    /// conversation never shows the body as a fake user bubble. Exercises `push_user` directly.
    #[test]
    fn skill_body_line_is_skipped_on_restore() {
        let entry: Value = serde_json::from_str(
            r#"{"type":"user","isMeta":true,"uuid":"m1","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /x/.claude/skills/done\n\n# Done\n…body…"}]}}"#,
        )
        .unwrap();
        let mut items = Vec::new();
        push_user(&entry, &mut items);
        assert!(items.is_empty(), "a skill's isMeta body must be skipped on restore");
    }

    /// REGRESSION (silent error): a malformed transcript line is tolerated (the good
    /// turns still restore) BUT no longer vanishes silently — a `history_error` notice
    /// is appended so the user knows the restored conversation may be incomplete.
    #[test]
    fn malformed_transcript_line_surfaces_a_history_error_notice() {
        let base = std::env::temp_dir().join(format!("tosse-hist-bad-{}", std::process::id()));
        let proj = base.join("projects").join("-some-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        let session_id = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
        let mut f = std::fs::File::create(proj.join(format!("{session_id}.jsonl"))).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","uuid":"u1","message":{{"role":"user","content":"hi"}}}}"#
        )
        .unwrap();
        writeln!(f, "{{ this is not valid json").unwrap();
        drop(f);

        let items = load_history_in(&base, session_id);
        std::fs::remove_dir_all(&base).ok();

        // The good line still restores…
        assert!(
            items
                .iter()
                .any(|i| matches!(i, ConversationItem::UserMessage { text, .. } if text == "hi")),
            "the well-formed turn must still be restored"
        );
        // …and the skipped malformed line surfaces a visible notice.
        assert!(
            items
                .iter()
                .any(|i| matches!(i, ConversationItem::Notice { subtype, .. } if subtype == "history_error")),
            "a skipped malformed line must surface a history_error notice"
        );
    }

    #[test]
    fn context_fill_uses_latest_real_main_thread_usage() {
        let base = std::env::temp_dir().join(format!("tosse-ctx-{}", std::process::id()));
        let proj = base.join("projects").join("-some-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        let session_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let mut f = std::fs::File::create(proj.join(format!("{session_id}.jsonl"))).unwrap();
        let lines = [
            // An early small turn…
            r#"{"type":"assistant","uuid":"a1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}"#,
            // …then the latest real main-thread turn — this one must win.
            r#"{"type":"assistant","uuid":"a2","message":{"id":"m2","model":"claude-opus-4-8","usage":{"input_tokens":5000,"cache_creation_input_tokens":9000,"cache_read_input_tokens":15000,"output_tokens":12}}}"#,
            // A sidechain turn with bigger numbers must be ignored.
            r#"{"type":"assistant","isSidechain":true,"uuid":"a3","message":{"id":"m9","model":"claude-haiku-4-5","usage":{"input_tokens":999999,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}"#,
            // A trailing `<synthetic>` line (compact boundary / injection) must NOT
            // reset the fill — it isn't a real model call.
            r#"{"type":"assistant","uuid":"a4","message":{"id":"s","model":"<synthetic>","usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}"#,
        ];
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        drop(f);

        let fill = load_context_fill_in(&base, session_id);
        std::fs::remove_dir_all(&base).ok();

        // 5000 + 9000 + 15000 = 29000 from the latest real main-thread turn (the
        // sidechain and the trailing synthetic line are both skipped).
        assert_eq!(fill.context_tokens, Some(29_000));
        // The window is NEVER inferred from the transcript (name can't tell 200k from
        // 1M) — it's sourced live / from the front cache.
        assert_eq!(fill.context_window, None);
    }

    #[test]
    fn active_goal_tracks_set_unmet_achieved_and_clear() {
        let base = std::env::temp_dir().join(format!("tosse-goal-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();

        // (1) A goal SET (sentinel + not met) then TWO unmet checks with different reasons → still
        //     active, and the FRESHEST (last) reason wins (exercises the overwrite across turns).
        let sid1 = "11111111-1111-1111-1111-111111111111";
        write_transcript(&base, "-p", sid1, &[
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"all tests pass"}}"#,
            r#"{"type":"assistant","uuid":"a","message":{"model":"claude-opus-4-8"}}"#,
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"condition":"all tests pass","reason":"5 tests still failing"}}"#,
            r#"{"type":"assistant","uuid":"b","message":{"model":"claude-opus-4-8"}}"#,
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"condition":"all tests pass","reason":"3 tests still failing"}}"#,
        ]);
        let g = load_active_goal_in(&base, sid1).expect("goal active");
        assert_eq!(g.condition, "all tests pass");
        assert_eq!(g.reason.as_deref(), Some("3 tests still failing")); // the LAST reason, not "5 tests"

        // (2) Goal ACHIEVED (met, no sentinel) → cleared.
        let sid2 = "22222222-2222-2222-2222-222222222222";
        write_transcript(&base, "-p", sid2, &[
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"all tests pass"}}"#,
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":true,"condition":"all tests pass","reason":"all green","iterations":2}}"#,
        ]);
        assert_eq!(load_active_goal_in(&base, sid2), None);

        // (3) Goal manually CLEARED (sentinel + met) → cleared.
        let sid3 = "33333333-3333-3333-3333-333333333333";
        write_transcript(&base, "-p", sid3, &[
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"ship it"}}"#,
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":true,"sentinel":true,"condition":"ship it"}}"#,
        ]);
        assert_eq!(load_active_goal_in(&base, sid3), None);

        // (4) Re-setting after a clear → the NEW goal is active.
        let sid4 = "44444444-4444-4444-4444-444444444444";
        write_transcript(&base, "-p", sid4, &[
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":true,"sentinel":true,"condition":"old goal"}}"#,
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"new goal"}}"#,
        ]);
        let g4 = load_active_goal_in(&base, sid4).expect("re-set goal active");
        assert_eq!(g4.condition, "new goal");

        // (5) No goal at all, and a sidechain goal_status must never drive the parent.
        let sid5 = "55555555-5555-5555-5555-555555555555";
        write_transcript(&base, "-p", sid5, &[
            r#"{"type":"assistant","uuid":"a","message":{"model":"claude-opus-4-8"}}"#,
            r#"{"type":"attachment","isSidechain":true,"attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"subagent goal"}}"#,
        ]);
        assert_eq!(load_active_goal_in(&base, sid5), None);

        // (6) A `/goal clear` stdout clears a stale SET sentinel even with no goal_status terminal
        //     (the CLI's own "Goal cleared:" / "No goal set" is authoritative).
        let sid6 = "66666666-6666-6666-6666-666666666666";
        write_transcript(&base, "-p", sid6, &[
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"ship it"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Goal cleared: ship it</local-command-stdout>"}}"#,
        ]);
        assert_eq!(load_active_goal_in(&base, sid6), None);

        let sid7 = "77777777-7777-7777-7777-777777777777";
        write_transcript(&base, "-p", sid7, &[
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"stale"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>No goal set</local-command-stdout>"}}"#,
        ]);
        assert_eq!(load_active_goal_in(&base, sid7), None);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn goal_command_noise_is_recognized_and_dropped_on_reload() {
        // The `/goal` echo + its local stdout are recognized as noise…
        assert!(is_goal_command_noise("<command-name>/goal</command-name>\n  <command-args>clear</command-args>"));
        assert!(is_goal_command_noise("<local-command-stdout>Goal set: all tests pass</local-command-stdout>"));
        assert!(is_goal_command_noise("<local-command-stdout>Goal cleared: x</local-command-stdout>"));
        assert!(is_goal_command_noise("<local-command-stdout>No goal set</local-command-stdout>"));
        // …but a real user message and another command's stdout are NOT.
        assert!(!is_goal_command_noise("please set a goal"));
        assert!(!is_goal_command_noise("<command-name>/compact</command-name>"));
        assert!(!is_goal_command_noise("<local-command-stdout>Context compacted</local-command-stdout>"));

        // On reload, the goal echo + stdout are dropped from the thread, real turns kept.
        let base = std::env::temp_dir().join(format!("tosse-goalnoise-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "88888888-8888-8888-8888-888888888888";
        write_transcript(&base, "-p", sid, &[
            r#"{"type":"user","message":{"role":"user","content":"hello"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/goal</command-name>\n<command-args>clear</command-args>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>No goal set</local-command-stdout>"}}"#,
        ]);
        let path = find_transcript(&base, sid).unwrap();
        let (items, _) = parse_transcript_str(&std::fs::read_to_string(&path).unwrap(), true);
        std::fs::remove_dir_all(&base).ok();
        let users: Vec<_> = items
            .iter()
            .filter_map(|i| match i {
                ConversationItem::UserMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(users, vec!["hello"]);
    }

    #[test]
    fn repo_root_rolls_a_worktree_cwd_up_to_the_repo() {
        // An app worktree cwd rolls up to the repo root…
        assert_eq!(
            repo_root_from_cwd("/Users/me/Repos/tosse-code/.claude/worktrees/feat-x"),
            "/Users/me/Repos/tosse-code"
        );
        // …a plain cwd is its own root.
        assert_eq!(repo_root_from_cwd("/Users/me/Repos/other"), "/Users/me/Repos/other");
    }

    #[test]
    fn fold_strips_case_and_accents_one_to_one() {
        let folded = fold("Déployé l'AUTH à Çà");
        assert_eq!(folded, "deploye l'auth a ca");
        // 1 char -> 1 char: the folded string has the same char count as the input.
        let src = "Déjà ÀÉÎÕÜ";
        assert_eq!(fold(src).chars().count(), src.chars().count());
    }

    #[test]
    fn edit_distance_1_accepts_one_typo_rejects_two() {
        assert!(within_edit_distance_1("deploy", "deploy")); // identical
        assert!(within_edit_distance_1("auth", "audh")); // one substitution
        assert!(within_edit_distance_1("auth", "auths")); // one insertion
        assert!(within_edit_distance_1("auths", "auth")); // one deletion
        assert!(!within_edit_distance_1("auth", "xyzw")); // 4 substitutions
        assert!(!within_edit_distance_1("auth", "authzz")); // length gap > 1
    }

    /// Write a transcript file `<session_id>.jsonl` with the given JSON lines under a
    /// fake `<base>/projects/<slug>/` dir.
    fn write_transcript(base: &Path, slug: &str, session_id: &str, lines: &[&str]) {
        let proj = base.join("projects").join(slug);
        std::fs::create_dir_all(&proj).unwrap();
        let mut f = std::fs::File::create(proj.join(format!("{session_id}.jsonl"))).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn list_disk_conversations_scans_titles_excerpts_and_skips_noise_and_subagents() {
        let base = std::env::temp_dir().join(format!("tosse-list-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        // A normal conversation: cwd, a first human prompt, and an ai-title line.
        write_transcript(
            &base,
            "-Users-me-Repos-app",
            "11111111-1111-1111-1111-111111111111",
            &[
                r#"{"type":"queue-operation","cwd":"/Users/me/Repos/app"}"#,
                r#"{"type":"user","userType":"external","cwd":"/Users/me/Repos/app","gitBranch":"main","uuid":"u1","message":{"role":"user","content":"Fix the login scroll bug"}}"#,
                r#"{"type":"ai-title","aiTitle":"Login scroll fix","sessionId":"11111111-1111-1111-1111-111111111111"}"#,
                r#"{"type":"assistant","uuid":"a1","message":{"id":"m1","content":[{"type":"text","text":"sure"}]}}"#,
            ],
        );
        // An orphan-style conversation in a WORKTREE cwd, no ai-title.
        write_transcript(
            &base,
            "-Users-me-Repos-app--claude-worktrees-feat-x",
            "22222222-2222-2222-2222-222222222222",
            &[
                r#"{"type":"user","cwd":"/Users/me/Repos/app/.claude/worktrees/feat-x","message":{"role":"user","content":"Add a dark mode toggle"}}"#,
            ],
        );
        // An aborted session: only a meta line and a tool_result delivery → no human
        // message → must be filtered out as noise.
        write_transcript(
            &base,
            "-Users-me-Repos-app",
            "33333333-3333-3333-3333-333333333333",
            &[
                r#"{"type":"user","isMeta":true,"cwd":"/x","message":{"role":"user","content":"<system-reminder>"}}"#,
                r#"{"type":"user","cwd":"/x","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"out"}]}}"#,
            ],
        );
        // A sub-agent transcript lives in a `subagents/` sub-dir → never listed.
        let sub = base.join("projects").join("-Users-me-Repos-app").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        let mut f = std::fs::File::create(sub.join("agent-deadbeef.jsonl")).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","isSidechain":true,"cwd":"/Users/me/Repos/app","message":{{"role":"user","content":"subagent task"}}}}"#
        )
        .unwrap();
        drop(f);

        let mut got = list_disk_conversations_in(&base);
        std::fs::remove_dir_all(&base).ok();

        // Two real conversations; the aborted one and the sub-agent are excluded.
        assert_eq!(got.len(), 2, "got {got:#?}");
        got.sort_by(|a, b| a.session_id.cmp(&b.session_id));

        let normal = &got[0];
        assert_eq!(normal.session_id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(normal.title.as_deref(), Some("Login scroll fix"));
        assert_eq!(normal.excerpt, "Fix the login scroll bug");
        assert_eq!(normal.cwd, "/Users/me/Repos/app");
        assert_eq!(normal.repo_root, "/Users/me/Repos/app");
        assert_eq!(normal.git_branch.as_deref(), Some("main"));

        let orphan = &got[1];
        assert_eq!(orphan.title, None);
        assert_eq!(orphan.excerpt, "Add a dark mode toggle");
        // The worktree cwd rolled up to the repo root for grouping/reactivation.
        assert_eq!(orphan.repo_root, "/Users/me/Repos/app");
        assert_eq!(orphan.cwd, "/Users/me/Repos/app/.claude/worktrees/feat-x");
    }

    /// A two-exchange transcript: bookkeeping line, prompt P1 + its assistant reply
    /// (split across two same-id lines with a tool_use/result), prompt P2 + its reply.
    /// Shared by the rewind tests.
    fn rewind_fixture(base: &Path, session_id: &str) {
        write_transcript(
            base,
            "-p",
            session_id,
            &[
                r#"{"type":"queue-operation","cwd":"/p"}"#,
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"first prompt"}}"#,
                r#"{"type":"assistant","uuid":"a1","message":{"id":"msg_1","content":[{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"ls"}}]}}"#,
                r#"{"type":"user","uuid":"tr1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool_1","content":"a.txt"}]}}"#,
                r#"{"type":"assistant","uuid":"a2","message":{"id":"msg_1","content":[{"type":"text","text":"first answer"}]}}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"second prompt"}}"#,
                r#"{"type":"assistant","uuid":"a3","message":{"id":"msg_2","content":[{"type":"text","text":"second answer"}]}}"#,
            ],
        );
    }

    /// A USER rewind on the SECOND prompt drops it and everything after, returns the
    /// removed prompt text (to re-seed the composer), and keeps the first full exchange
    /// (including the tool_result) — the truncated file ends on a complete response.
    #[test]
    fn rewind_user_message_drops_it_and_everything_after() {
        let base = std::env::temp_dir().join(format!("tosse-rw-user-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "11111111-1111-1111-1111-111111111111";
        rewind_fixture(&base, sid);

        let outcome = rewind_transcript_in(&base, sid, "u2", true, None, None).expect("rewind ok");
        assert_eq!(outcome.removed_prompt.as_deref(), Some("second prompt"));
        assert_eq!(outcome.removed_lines, 2, "drop P2 + its answer");

        // The truncated transcript restores to exactly the first exchange.
        let items = load_history_in(&base, sid);
        std::fs::remove_dir_all(&base).ok();
        let user_texts: Vec<_> = items
            .iter()
            .filter_map(|i| match i {
                ConversationItem::UserMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(user_texts, vec!["first prompt"], "second prompt is gone");
        assert!(
            items
                .iter()
                .any(|i| matches!(i, ConversationItem::AssistantMessage { id, .. } if id == "msg_1")),
            "the first answer (and its tool_result) are kept"
        );
        assert!(
            !items
                .iter()
                .any(|i| matches!(i, ConversationItem::AssistantMessage { id, .. } if id == "msg_2")),
            "the second answer is gone"
        );
    }

    /// An ASSISTANT rewind keeps the whole targeted response (cutting at the NEXT human
    /// prompt), so the first answer + its tool_result survive and the second exchange is
    /// dropped; nothing is re-seeded into the composer.
    #[test]
    fn rewind_assistant_message_keeps_the_response_cuts_at_next_prompt() {
        let base = std::env::temp_dir().join(format!("tosse-rw-ai-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "22222222-2222-2222-2222-222222222222";
        rewind_fixture(&base, sid);

        // Target the first response by its message id; the cut lands at "second prompt".
        let outcome = rewind_transcript_in(&base, sid, "msg_1", false, None, None).expect("rewind ok");
        assert_eq!(outcome.removed_prompt, None);
        assert_eq!(outcome.removed_lines, 2, "drop P2 + its answer");

        let items = load_history_in(&base, sid);
        std::fs::remove_dir_all(&base).ok();
        assert!(
            items
                .iter()
                .any(|i| matches!(i, ConversationItem::AssistantMessage { id, .. } if id == "msg_1")),
            "the targeted response is kept whole"
        );
        assert!(
            !items
                .iter()
                .any(|i| matches!(i, ConversationItem::UserMessage { text, .. } if text == "second prompt")),
            "the next prompt (and beyond) is dropped"
        );
    }

    /// Rewinding the FIRST prompt is refused (it would leave an unresumable, turn-less
    /// transcript) — the defensive backstop behind the UI's own gating.
    #[test]
    fn rewind_first_user_message_is_refused() {
        let base = std::env::temp_dir().join(format!("tosse-rw-first-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "33333333-3333-3333-3333-333333333333";
        rewind_fixture(&base, sid);
        let err = rewind_transcript_in(&base, sid, "u1", true, None, None).unwrap_err();
        std::fs::remove_dir_all(&base).ok();
        assert!(err.contains("first message"), "got: {err}");
    }

    /// A rewind whose target has nothing after it is a no-op: 0 lines removed and the
    /// transcript is left byte-for-byte untouched.
    #[test]
    fn rewind_last_response_is_a_noop() {
        let base = std::env::temp_dir().join(format!("tosse-rw-noop-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "44444444-4444-4444-4444-444444444444";
        rewind_fixture(&base, sid);
        let path = base.join("projects").join("-p").join(format!("{sid}.jsonl"));
        let before = std::fs::read_to_string(&path).unwrap();

        // "msg_2" is the last response — nothing follows it.
        let outcome = rewind_transcript_in(&base, sid, "msg_2", false, None, None).expect("rewind ok");
        assert_eq!(outcome.removed_lines, 0);
        let after = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&base).ok();
        assert_eq!(before, after, "a no-op rewind must not touch the file");
    }

    /// An unknown target id surfaces an error rather than silently truncating.
    #[test]
    fn rewind_unknown_target_errors() {
        let base = std::env::temp_dir().join(format!("tosse-rw-unk-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "55555555-5555-5555-5555-555555555555";
        rewind_fixture(&base, sid);
        let err = rewind_transcript_in(&base, sid, "does-not-exist", true, None, None).unwrap_err();
        std::fs::remove_dir_all(&base).ok();
        assert!(err.contains("not found"), "got: {err}");
    }

    /// A LIVE user turn carries a synthetic front id (`user_N`) that is NOT on disk, so the
    /// exact-uuid match fails — the rewind must FALL BACK to matching the prompt TEXT.
    #[test]
    fn rewind_user_falls_back_to_text_when_id_is_synthetic() {
        let base = std::env::temp_dir().join(format!("tosse-rw-txt-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "66666666-6666-6666-6666-666666666666";
        rewind_fixture(&base, sid);
        // Front id "user_3" doesn't exist on disk; the text "second prompt" does.
        let outcome = rewind_transcript_in(&base, sid, "user_3", true, Some("second prompt"), None)
            .expect("rewind ok via text fallback");
        assert_eq!(outcome.removed_prompt.as_deref(), Some("second prompt"));
        assert_eq!(outcome.removed_lines, 2);
        std::fs::remove_dir_all(&base).ok();
    }

    /// Two IDENTICAL live prompts: the `occurrence` index disambiguates so a rewind targets
    /// the one the user clicked (the EARLIER "ok"), not the last text match.
    #[test]
    fn rewind_user_uses_occurrence_to_pick_the_right_duplicate() {
        let base = std::env::temp_dir().join(format!("tosse-rw-occ-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "88888888-8888-8888-8888-888888888888";
        write_transcript(
            &base,
            "-p",
            sid,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"start"}}"#,
                r#"{"type":"assistant","uuid":"a1","message":{"id":"m1","content":[{"type":"text","text":"r1"}]}}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"ok"}}"#,
                r#"{"type":"assistant","uuid":"a2","message":{"id":"m2","content":[{"type":"text","text":"r2"}]}}"#,
                r#"{"type":"user","uuid":"u3","message":{"role":"user","content":"ok"}}"#,
                r#"{"type":"assistant","uuid":"a3","message":{"id":"m3","content":[{"type":"text","text":"r3"}]}}"#,
            ],
        );
        // Live ids are synthetic → text fallback. occurrence=1 = the SECOND "ok" (u3): drop
        // it + its answer only (2 lines). occurrence=0 = the FIRST "ok" (u2): drop 4 lines.
        let later = rewind_transcript_in(&base, sid, "user_x", true, Some("ok"), Some(1)).unwrap();
        assert_eq!(later.removed_lines, 2, "occurrence 1 targets the later duplicate");

        // Re-seed the fixture (the first rewind truncated it) and target the FIRST "ok".
        write_transcript(
            &base,
            "-p",
            sid,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"start"}}"#,
                r#"{"type":"assistant","uuid":"a1","message":{"id":"m1","content":[{"type":"text","text":"r1"}]}}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"ok"}}"#,
                r#"{"type":"assistant","uuid":"a2","message":{"id":"m2","content":[{"type":"text","text":"r2"}]}}"#,
                r#"{"type":"user","uuid":"u3","message":{"role":"user","content":"ok"}}"#,
                r#"{"type":"assistant","uuid":"a3","message":{"id":"m3","content":[{"type":"text","text":"r3"}]}}"#,
            ],
        );
        let earlier = rewind_transcript_in(&base, sid, "user_x", true, Some("ok"), Some(0)).unwrap();
        std::fs::remove_dir_all(&base).ok();
        assert_eq!(earlier.removed_lines, 4, "occurrence 0 targets the earlier duplicate");
    }

    /// A live slash-command turn (front sends "/done"; disk holds the <command-name> header)
    /// resolves via prompt_match_key, and the composer re-seed is the clean command, not XML.
    #[test]
    fn rewind_user_matches_slash_command_across_wrapper_and_cleans_the_reseed() {
        let base = std::env::temp_dir().join(format!("tosse-rw-slash-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "99999999-9999-9999-9999-999999999999";
        write_transcript(
            &base,
            "-p",
            sid,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"hello"}}"#,
                r#"{"type":"assistant","uuid":"a1","message":{"id":"m1","content":[{"type":"text","text":"hi"}]}}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args>keep tests</command-args>"}}"#,
                r#"{"type":"assistant","uuid":"a2","message":{"id":"m2","content":[{"type":"text","text":"done"}]}}"#,
            ],
        );
        // Front live text is the raw "/compact keep tests"; must still match the header line.
        let outcome = rewind_transcript_in(&base, sid, "user_9", true, Some("/compact keep tests"), None)
            .expect("slash match ok");
        std::fs::remove_dir_all(&base).ok();
        // The re-seed is the reconstructed clean command, never the raw <command-*> wrapper.
        assert_eq!(outcome.removed_prompt.as_deref(), Some("/compact keep tests"));
        assert_eq!(outcome.removed_lines, 2);
    }

    /// A fork writes a NEW transcript (leaving the original intact) that head-reads back into
    /// a DiskConversation, and keeps history up to the cut (user target → before the prompt).
    #[test]
    fn fork_writes_a_new_branch_leaving_the_original_intact() {
        let base = std::env::temp_dir().join(format!("tosse-fork-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let sid = "77777777-7777-7777-7777-777777777777";
        rewind_fixture(&base, sid);
        let orig_path = base.join("projects").join("-p").join(format!("{sid}.jsonl"));
        let orig_before = std::fs::read_to_string(&orig_path).unwrap();

        // Fork at the second prompt (branch keeps only the first exchange).
        let outcome = fork_transcript_in(&base, sid, "u2", true, None, None).expect("fork ok");
        assert_eq!(outcome.removed_prompt.as_deref(), Some("second prompt"));
        // The new session id differs and its file exists under the same project dir.
        assert_ne!(outcome.conversation.session_id, sid);
        let new_path = base
            .join("projects")
            .join("-p")
            .join(format!("{}.jsonl", outcome.conversation.session_id));
        assert!(new_path.is_file(), "the branch transcript must exist");
        // The ORIGINAL is untouched (non-destructive).
        assert_eq!(std::fs::read_to_string(&orig_path).unwrap(), orig_before);
        // The branch restores to exactly the first exchange (second prompt dropped).
        let items = load_history_in(&base, &outcome.conversation.session_id);
        std::fs::remove_dir_all(&base).ok();
        let user_texts: Vec<_> = items
            .iter()
            .filter_map(|i| match i {
                ConversationItem::UserMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(user_texts, vec!["first prompt"], "branch keeps only up to the cut");
    }

    #[test]
    fn search_index_ranks_matches_does_and_and_tolerates_a_typo() {
        let base = std::env::temp_dir().join(format!("tosse-search-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        // Conv A: the WORD "authentification" is in the TITLE (should rank highest for
        // "auth"); body also mentions déploiement.
        write_transcript(
            &base,
            "-p",
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            &[
                r#"{"type":"ai-title","aiTitle":"Refonte authentification"}"#,
                r#"{"type":"user","message":{"role":"user","content":"Le déploiement casse"}}"#,
                r#"{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"je regarde le login"}]}}"#,
            ],
        );
        // Conv B: "auth" only appears deep in the BODY (lower score than a title hit).
        write_transcript(
            &base,
            "-p",
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            &[
                r#"{"type":"user","message":{"role":"user","content":"corrige le bouton"}}"#,
                r#"{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"il faut revoir l'auth du serveur"}]}}"#,
            ],
        );
        let index = build_search_index_in(&base);
        std::fs::remove_dir_all(&base).ok();
        assert_eq!(index.len(), 2);

        // "auth": both match; the TITLE hit (A) ranks above the body-only hit (B).
        let hits = score_index(&index, "auth");
        assert_eq!(hits.len(), 2, "got {hits:#?}");
        assert_eq!(hits[0].session_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

        // Accent-insensitive: "deploiement" (no accent) finds A's body "déploiement".
        let hits = score_index(&index, "deploiement");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        assert!(hits[0].snippet.contains("déploiement"), "snippet: {:?}", hits[0].snippet);

        // AND across terms: only A has BOTH "auth" and "deploiement".
        let hits = score_index(&index, "auth deploiement");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

        // Typo tolerance on the title: "authentificaton" (missing an 'i') still finds A.
        let hits = score_index(&index, "authentificaton");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

        // Empty query → no hits (the front shows the full unfiltered list instead).
        assert!(score_index(&index, "   ").is_empty());
    }

    #[test]
    fn snippet_around_windows_on_char_boundaries_with_ellipses() {
        // Helper: fold the body the way the index does, so the term position aligns.
        let snip = |body: &str, term: &str| snippet_around(body, &fold(body), &[term.to_string()]);

        // Hit deep inside a long body → trimmed on BOTH sides (leading + trailing "…").
        // The window straddles multi-byte accents ("é"), exercising the char→byte mapping.
        let long = format!("{}café déployé serveur {}", "mot ".repeat(40), "fin ".repeat(40));
        let mid = snip(&long, "deploye");
        assert!(mid.starts_with('…'), "leading ellipsis: {mid:?}");
        assert!(mid.ends_with('…'), "trailing ellipsis: {mid:?}");
        assert!(mid.contains("café déployé serveur"), "window content: {mid:?}");

        // Hit near the START → no leading "…", but trailing "…" (more body after).
        let head = snip(&format!("déployé {}", "mot ".repeat(60)), "deploye");
        assert!(!head.starts_with('…'), "no leading ellipsis at start: {head:?}");
        assert!(head.ends_with('…'), "trailing ellipsis: {head:?}");

        // Hit near the END → leading "…", but no trailing "…" (body ends here).
        let tail = snip(&format!("{}déployé", "mot ".repeat(60)), "deploye");
        assert!(tail.starts_with('…'), "leading ellipsis: {tail:?}");
        assert!(!tail.ends_with('…'), "no trailing ellipsis at end: {tail:?}");
        assert!(tail.contains("déployé"), "keeps the accented hit: {tail:?}");

        // Title/excerpt-only match (no body hit) → empty snippet.
        assert_eq!(snip("rien ici", "absent"), "");
    }
}
