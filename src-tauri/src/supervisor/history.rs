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

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::assembler::normalize_blocks;
use super::model::ConversationItem;

/// Claude's config dir: `$CLAUDE_CONFIG_DIR` if set, else `$HOME/.claude`.
fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude"))
}

/// Find the transcript for `session_id` by scanning every project dir under
/// `config_dir/projects` for `<session_id>.jsonl`.
fn find_transcript(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let projects = config_dir.join("projects");
    let file_name = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(&projects).ok()?.flatten() {
        let candidate = entry.path().join(&file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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

fn parse_transcript(path: &Path) -> Vec<ConversationItem> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue; // tolerate a malformed line, never abort the restore
        };
        // Skip sub-agent (sidechain) turns: the transcript threads them via a
        // `parentUuid` chain we don't reconstruct here (the live path scopes them
        // by `parent_tool_use_id`). The root Task tool_use + its result still show.
        if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
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
    items
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
            push_user_text(&uuid, &text, items);
        }
        _ => {}
    }
}

fn push_user_text(uuid: &str, text: &str, items: &mut Vec<ConversationItem>) {
    if text.trim().is_empty() {
        return;
    }
    items.push(ConversationItem::UserMessage {
        id: uuid.to_string(),
        text: text.to_string(),
        parent_tool_use_id: None,
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
    });
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
    }
}
