//! Write actions: commit, and remote sync (push / pull / fetch). These mutate the
//! repository, so each is a single, explicit user-initiated git invocation — git's
//! own safety (e.g. `pull --ff-only` refusing a non-fast-forward) is the guard, and
//! any failure surfaces verbatim through [`GitError`] to the conversation.

use super::{run_git, GitError};

/// Stage every change (tracked + untracked) and commit it with `message`.
/// Returns the new commit's short oid. v1 has no per-file staging UI, so a commit
/// captures the whole working tree — matching exactly what the changes list shows.
pub fn commit(cwd: &str, message: &str) -> Result<String, GitError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(GitError::Parse("the commit message is empty".into()));
    }
    run_git(cwd, &["add", "-A"])?;
    // With nothing staged, `git commit` exits non-zero but prints its reason to
    // STDOUT (which run_git discards) — surfacing a useless "git commit … failed".
    // Detect the empty index first and give a clear message. `git diff
    // --cached --quiet` exits 0 when there is NOTHING staged, non-zero otherwise.
    if run_git(cwd, &["diff", "--cached", "--quiet"]).is_ok() {
        return Err(GitError::Parse("nothing to commit".into()));
    }
    run_git(cwd, &["commit", "-m", message])?;
    let oid = run_git(cwd, &["rev-parse", "--short", "HEAD"])?;
    Ok(oid.trim().to_string())
}

/// Push the current branch to its upstream. With no upstream set, git fails and
/// the error (e.g. "has no upstream branch") is surfaced to the user.
pub fn push(cwd: &str) -> Result<(), GitError> {
    run_git(cwd, &["push"]).map(|_| ())
}

/// Pull with `--ff-only`: integrate upstream only when it fast-forwards. A
/// diverged branch fails loudly instead of silently creating a merge commit —
/// the conservative default for v1 (no conflict-resolution UI yet).
pub fn pull(cwd: &str) -> Result<(), GitError> {
    run_git(cwd, &["pull", "--ff-only"]).map(|_| ())
}

/// Fetch every remote and prune deleted remote branches. Read-only on the working
/// tree — only updates remote-tracking refs, so ahead/behind counts refresh.
pub fn fetch(cwd: &str) -> Result<(), GitError> {
    run_git(cwd, &["fetch", "--all", "--prune"]).map(|_| ())
}
