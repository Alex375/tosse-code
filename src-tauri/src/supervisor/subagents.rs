//! Disk readers for background-task artifacts — the socle's disk-reading layer.
//!
//! `claude` writes per-task artifacts under a session's OWN directory, a sibling of
//! its `<session_id>.jsonl` transcript:
//!
//! ```text
//! <config>/projects/<cwd-slug>/<session_id>/
//!   ├── tasks/<task_id>.output                  ← Bash-bg AND Monitor (local_bash)
//!   ├── workflows/wf_<id>.json                  ← workflow run manifest
//!   └── subagents/
//!       ├── agent-<agentId>.jsonl               ← Agent sub-agent transcript
//!       └── workflows/wf_<id>/agent-<id>.jsonl  ← workflow agent transcript
//! ```
//!
//! These are pure, one-shot reads (the IPC layer runs them off the async runtime via
//! `spawn_blocking`). LIVE tailing/watching of a still-running task's output is
//! layered on top by the Monitor / Bash-bg display tasks (the `notify` crate) — the
//! socle just exposes the readers.
//!
//! We locate the session dir by scanning every project dir for a `<session_id>`
//! directory, mirroring how [`super::history`] globs for the transcript: Claude's
//! cwd→slug encoding is lossy (both `/` and `.` map to `-`), so we never invert it.
//!
//! NOTE for consumers: when a LIVE [`super::model::BackgroundTask`] is in hand, its
//! `output_file` already carries the exact absolute artifact path the CLI reported —
//! prefer reading that directly. The session-id scan here is the cold-resume fallback
//! (no live task in memory, e.g. reopening a past conversation), where only the ids
//! persisted in the transcript are available.

use std::path::{Path, PathBuf};

use super::history::{claude_config_dir, parse_transcript_str, project_dirs};
use super::model::{ConversationItem, WorkflowRun};

/// Cap on how deep we recurse under `subagents/` looking for a transcript — enough
/// for `subagents/workflows/wf_<id>/agent-<id>.jsonl` (depth 3) with margin, while
/// never walking an unbounded tree.
const MAX_SUBAGENT_DEPTH: usize = 4;

/// Reject an id that could escape the session directory once interpolated into a path.
/// Ids on the wire are UUIDs / `wf_…` / `tk_…` / agent slugs — ASCII alphanumerics plus
/// `-`/`_`. Anything carrying a path separator, `..`, or any other byte is refused, so a
/// crafted id (e.g. `../../../../etc/passwd`) can never walk outside `<session_dir>`.
/// Defense-in-depth: today the only id source is the trusted `claude` binary, but these
/// readers must stay the validated gatekeepers (same principle as `git::mod` /
/// `store::db`). Cost is nil for the legitimate UUID/slug case.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Find a session's artifact directory (`<config>/projects/<slug>/<session_id>`) by
/// scanning every project dir for a subdirectory named `session_id`. The loud-on-IO-error
/// scan lives in [`super::history::project_dirs`] (shared with the transcript lookup), so
/// a permission/IO error is never silently equated with "absent" (finding #4).
fn find_session_dir(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    project_dirs(config_dir)
        .into_iter()
        .map(|dir| dir.join(session_id))
        .find(|candidate| candidate.is_dir())
}

/// Load and normalize a sub-agent's full transcript into the same
/// [`ConversationItem`]s the live path produces, so the UI renders it with the
/// existing conversation components. Works for both a plain `Agent` sub-agent
/// (`subagents/agent-<id>.jsonl`) and a workflow agent
/// (`subagents/workflows/wf_<id>/agent-<id>.jsonl`) — we search `subagents/` for the
/// matching file. An absent/unreadable transcript yields an empty vec (a normal
/// state, not an error).
pub fn load_subagent_transcript(session_id: &str, agent_id: &str) -> Vec<ConversationItem> {
    match claude_config_dir() {
        Some(dir) => load_subagent_transcript_in(&dir, session_id, agent_id),
        None => Vec::new(),
    }
}

fn load_subagent_transcript_in(
    config_dir: &Path,
    session_id: &str,
    agent_id: &str,
) -> Vec<ConversationItem> {
    if !is_safe_id(session_id) || !is_safe_id(agent_id) {
        eprintln!("[subagents] refusing unsafe id (session={session_id:?}, agent={agent_id:?})");
        return Vec::new();
    }
    let Some(session_dir) = find_session_dir(config_dir, session_id) else {
        return Vec::new();
    };
    let file_name = format!("agent-{agent_id}.jsonl");
    let Some(path) = find_file_recursive(&session_dir.join("subagents"), &file_name, MAX_SUBAGENT_DEPTH)
    else {
        return Vec::new();
    };
    match std::fs::read_to_string(&path) {
        // A sub-agent's transcript is ENTIRELY sidechain, so keep every line.
        Ok(content) => parse_transcript_str(&content, false),
        // `find_file_recursive` already confirmed the file exists, so a read error here
        // is a real failure (permission/IO), not "absent" — log it, never silent.
        Err(e) => {
            eprintln!("[subagents] cannot read sub-agent transcript {}: {e}", path.display());
            Vec::new()
        }
    }
}

/// Read a workflow run's manifest (`workflows/<run_id>.json`) into a [`WorkflowRun`].
/// `run_id` is the `"wf_…"` id; for convenience a bare id is also tried with the
/// `wf_` prefix. `None` when the session/manifest is absent or unparseable.
pub fn load_workflow_run(session_id: &str, run_id: &str) -> Option<WorkflowRun> {
    let dir = claude_config_dir()?;
    load_workflow_run_in(&dir, session_id, run_id)
}

fn load_workflow_run_in(config_dir: &Path, session_id: &str, run_id: &str) -> Option<WorkflowRun> {
    if !is_safe_id(session_id) || !is_safe_id(run_id) {
        eprintln!("[subagents] refusing unsafe id (session={session_id:?}, run={run_id:?})");
        return None;
    }
    let workflows = find_session_dir(config_dir, session_id)?.join("workflows");
    // Try `<run_id>.json`; a bare id (no `wf_`) also tries the `wf_`-prefixed name. The
    // first existing file wins; if none exists we fall through to the read below, which
    // maps NotFound → None.
    let mut candidates = vec![workflows.join(format!("{run_id}.json"))];
    if !run_id.starts_with("wf_") {
        candidates.push(workflows.join(format!("wf_{run_id}.json")));
    }
    let path = candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        // Absent manifest = normal ("no run to show"). A non-NotFound IO error on an
        // existing file is a real failure → log it.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("[subagents] cannot read workflow manifest {}: {e}", path.display());
            return None;
        }
    };
    // A present-but-unparseable manifest (corrupt, truncated mid-write, or a CLI schema
    // change) is a REAL failure, NOT the normal "absent → None" state — so log it loudly
    // (finding #1/#6: never silently equate "broken" with "missing"). Re-capture the
    // fixture if a CLI upgrade changes the manifest shape.
    match serde_json::from_str::<WorkflowRun>(&content) {
        Ok(run) => Some(run),
        Err(e) => {
            eprintln!("[subagents] failed to parse workflow manifest {}: {e}", path.display());
            None
        }
    }
}

/// Read the full current contents of a background task's output file
/// (`tasks/<task_id>.output`) — the sink for both background `Bash` and `Monitor`
/// (both `task_type:"local_bash"`). One-shot; the live tail is the display task's
/// job. `None` when the session/file is absent.
pub fn read_task_output(session_id: &str, task_id: &str) -> Option<String> {
    let dir = claude_config_dir()?;
    read_task_output_in(&dir, session_id, task_id)
}

fn read_task_output_in(config_dir: &Path, session_id: &str, task_id: &str) -> Option<String> {
    if !is_safe_id(session_id) || !is_safe_id(task_id) {
        eprintln!("[subagents] refusing unsafe id (session={session_id:?}, task={task_id:?})");
        return None;
    }
    let path = find_session_dir(config_dir, session_id)?
        .join("tasks")
        .join(format!("{task_id}.output"));
    match std::fs::read_to_string(&path) {
        Ok(c) => Some(c),
        // Absent output = normal (task hasn't written yet / wrong session). A
        // non-NotFound IO error is a real failure → log it.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            eprintln!("[subagents] cannot read task output {}: {e}", path.display());
            None
        }
    }
}

/// Depth-bounded search for a file named exactly `file_name` under `root`. Returns
/// the first match (sub-agent transcript ids are unique, so the first hit is the
/// one). `depth` counts remaining directory levels to descend.
fn find_file_recursive(root: &Path, file_name: &str, depth: usize) -> Option<PathBuf> {
    let direct = root.join(file_name);
    if direct.is_file() {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    // An absent dir → `None` (nothing to find); a permission/IO error is DISTINCT and
    // logged before `None`, never silently equated with "not found" (mirrors the policy
    // of `find_session_dir` / `project_dirs`).
    let entries = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("[subagents] cannot scan {} for {file_name}: {e}", root.display());
            return None;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, file_name, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::model::NormalizedBlock;
    use std::io::Write;

    /// Build a fake `<config>/projects/<slug>/<session_id>/` artifact tree and read
    /// each artifact back through the public (config-dir-injected) readers.
    #[test]
    fn reads_subagent_transcript_workflow_manifest_and_task_output() {
        let base = std::env::temp_dir().join(format!("tosse-sub-{}", std::process::id()));
        let session_id = "ssssssss-1111-2222-3333-444444444444";
        let session_dir = base.join("projects").join("-some-cwd").join(session_id);
        std::fs::create_dir_all(session_dir.join("subagents")).unwrap();
        std::fs::create_dir_all(session_dir.join("subagents/workflows/wf_abc")).unwrap();
        std::fs::create_dir_all(session_dir.join("workflows")).unwrap();
        std::fs::create_dir_all(session_dir.join("tasks")).unwrap();

        // A plain Agent sub-agent transcript — entirely sidechain, must be KEPT.
        let mut f = std::fs::File::create(session_dir.join("subagents/agent-aaa.jsonl")).unwrap();
        for l in [
            r#"{"type":"user","isSidechain":true,"uuid":"u1","message":{"role":"user","content":"do the thing"}}"#,
            r#"{"type":"assistant","isSidechain":true,"uuid":"a1","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"done"}]}}"#,
        ] {
            writeln!(f, "{l}").unwrap();
        }
        drop(f);

        // A workflow agent transcript nested two levels deep (find_file_recursive).
        let mut f =
            std::fs::File::create(session_dir.join("subagents/workflows/wf_abc/agent-bbb.jsonl"))
                .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","isSidechain":true,"uuid":"a2","message":{{"id":"m2","role":"assistant","content":[{{"type":"text","text":"wf agent"}}]}}}}"#
        )
        .unwrap();
        drop(f);

        // A workflow manifest (camelCase, as on disk).
        let mut f = std::fs::File::create(session_dir.join("workflows/wf_abc.json")).unwrap();
        write!(
            f,
            r#"{{"runId":"wf_abc","taskId":"tk1","status":"completed","durationMs":1234,"agentCount":2,"defaultModel":"claude-opus-4-8","phases":[{{"title":"Review","detail":"d"}}],"workflowProgress":[{{"type":"workflow_phase","index":1,"title":"Review"}}],"result":{{"ok":true}}}}"#
        )
        .unwrap();
        drop(f);

        // A background task output file.
        std::fs::write(session_dir.join("tasks/tk_bash.output"), "line1\nline2\n").unwrap();

        // --- sub-agent transcript (sidechain kept) ---
        let items = load_subagent_transcript_in(&base, session_id, "aaa");
        assert_eq!(items.len(), 2, "got {items:#?}");
        assert!(matches!(&items[0], ConversationItem::UserMessage { text, .. } if text == "do the thing"));
        match &items[1] {
            ConversationItem::AssistantMessage { blocks, .. } => {
                assert!(matches!(&blocks[0], NormalizedBlock::Text { text } if text == "done"));
            }
            other => panic!("expected AssistantMessage, got {other:?}"),
        }

        // --- nested workflow agent transcript ---
        let wf_items = load_subagent_transcript_in(&base, session_id, "bbb");
        assert_eq!(wf_items.len(), 1, "the nested workflow agent transcript should be found");

        // --- workflow manifest ---
        let run = load_workflow_run_in(&base, session_id, "wf_abc").expect("manifest parses");
        assert_eq!(run.run_id, "wf_abc");
        assert_eq!(run.task_id.as_deref(), Some("tk1"));
        assert_eq!(run.status.as_deref(), Some("completed"));
        assert_eq!(run.duration_ms, Some(1234));
        assert_eq!(run.agent_count, Some(2));
        assert_eq!(run.phases.len(), 1);
        assert_eq!(run.phases[0].title, "Review");
        assert_eq!(run.result["ok"], serde_json::json!(true));
        // A bare id (no `wf_`) resolves to the same manifest via the prefix retry.
        assert!(load_workflow_run_in(&base, session_id, "abc").is_some());

        // --- task output ---
        assert_eq!(
            read_task_output_in(&base, session_id, "tk_bash").as_deref(),
            Some("line1\nline2\n")
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_artifacts_are_empty_or_none_not_errors() {
        let base = std::env::temp_dir().join("tosse-sub-missing-dir");
        assert!(load_subagent_transcript_in(&base, "nope", "x").is_empty());
        assert!(load_workflow_run_in(&base, "nope", "wf_x").is_none());
        assert!(read_task_output_in(&base, "nope", "x").is_none());
    }

    #[test]
    fn workflow_manifest_with_explicit_null_phases_still_parses() {
        // Mirror of the stream's `explicit_null_patch_and_usage_do_not_drop_the_line`:
        // an explicit `"phases":null` in the manifest must NOT fail the whole parse
        // (which would blank the entire workflow view) — it degrades to an empty list.
        let run: WorkflowRun = serde_json::from_str(r#"{"runId":"wf_z","phases":null}"#)
            .expect("explicit null phases must be tolerated");
        assert_eq!(run.run_id, "wf_z");
        assert!(run.phases.is_empty());
    }

    #[test]
    fn unsafe_ids_are_rejected_without_touching_disk() {
        // A path-traversal-shaped id never reaches `format!`/`join` — it is refused.
        assert!(!is_safe_id("../../../../etc/passwd"));
        assert!(!is_safe_id("a/b"));
        assert!(!is_safe_id(".."));
        assert!(!is_safe_id(""));
        // Legitimate wire ids (UUID, `wf_`/`tk_` slugs, agent ids) pass unchanged.
        assert!(is_safe_id("ssssssss-1111-2222-3333-444444444444"));
        assert!(is_safe_id("wf_abc"));
        assert!(is_safe_id("tk_bash"));
        let base = std::env::temp_dir().join("tosse-sub-unsafe");
        assert!(load_subagent_transcript_in(&base, "..", "x").is_empty());
        assert!(load_workflow_run_in(&base, "ok", "../escape").is_none());
        assert!(read_task_output_in(&base, "ok", "a/b").is_none());
    }
}
