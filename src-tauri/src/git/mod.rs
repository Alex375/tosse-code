//! Git worktree operations — the ONE place in the core that speaks `git`.
//!
//! Everything outside this module deals in the domain types below
//! ([`WorktreeInfo`], [`WorktreeStatus`]); nothing else shells out to `git` or
//! parses its output. Swapping the implementation (e.g. to the `git2` crate)
//! means rewriting this file and nothing else — the IPC layer and the UI are
//! insulated from it, exactly like [`crate::store::db`] is for SQL.
//!
//! Why the `git` CLI rather than `git2`/libgit2: worktree management is a rare,
//! user-initiated, off-the-hot-path operation, and the destructive cases
//! (removing a worktree) are far safer delegated to `git` itself — it refuses to
//! delete a worktree with uncommitted work unless explicitly forced, and handles
//! branch creation and the worktree admin files correctly. The `--porcelain`
//! output we parse is a stable, documented contract. This keeps the build free
//! of a libgit2 dependency for what `git` already does well and safely.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use specta::Type;

// The git service is split by concern, but it is still ONE service: every
// submodule below speaks `git` through the shared [`run_git`]/[`run_git_bytes`]
// helpers and nothing outside `crate::git` shells out to git or parses its
// output. Splitting keeps each file small (status, history/graph, branches,
// write actions) without breaking that invariant.
mod history;
mod ops;
mod refs;
mod status;

pub use history::{commit_file_diff, commit_files, log, CommitFile, CommitInfo};
pub use ops::{commit, fetch, pull, push};
pub use refs::{branches, BranchInfo};
pub use status::{diff_worktree, status, GitFileEntry, GitStatus};

/// Identity of one worktree of a repository (the cheap, always-listed part).
///
/// A repository has exactly one MAIN worktree (the original checkout) plus any
/// number of LINKED worktrees created with `git worktree add`. Each is a
/// separate working directory sharing the same `.git` history — which is what
/// lets several `claude` agents work the same repo in parallel without stepping
/// on each other.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorktreeInfo {
    /// Absolute path of the worktree's working directory.
    pub path: String,
    /// Short branch name (`refs/heads/` stripped). `None` when detached or bare.
    pub branch: Option<String>,
    /// Full HEAD commit oid. `None` for the bare entry.
    pub head: Option<String>,
    /// The repository's MAIN worktree (the first entry `git` lists). The one
    /// worktree that can never be removed.
    pub is_main: bool,
    /// HEAD is detached (no branch checked out).
    pub is_detached: bool,
    /// Locked via `git worktree lock` (a removal needs `--force`).
    pub is_locked: bool,
    /// The bare repository entry (has no working tree of its own).
    pub is_bare: bool,
}

/// Working-tree status of one worktree (the heavier, on-demand part — one extra
/// `git` call per worktree, so it is fetched lazily by the manager, never for
/// the always-on indicator).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorktreeStatus {
    /// At least one tracked file has staged or unstaged modifications.
    pub dirty: bool,
    /// At least one untracked file is present.
    pub untracked: bool,
    /// Number of entries `git status --porcelain` reports (changed + untracked).
    pub changed_files: u32,
    /// Commits ahead of the branch's upstream. `None` when no upstream is set.
    pub ahead: Option<u32>,
    /// Commits behind the branch's upstream. `None` when no upstream is set.
    pub behind: Option<u32>,
}

/// Anything that can go wrong talking to `git`.
#[derive(Debug)]
pub enum GitError {
    /// `git` could not be launched at all (not installed / not on PATH).
    Spawn(std::io::Error),
    /// `git` ran but exited non-zero; carries the command and its trimmed stderr.
    Command { args: String, stderr: String },
    /// Output that did not match the shape we expect.
    Parse(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::Spawn(e) => write!(f, "impossible de lancer git : {e}"),
            GitError::Command { args, stderr } => {
                if stderr.is_empty() {
                    write!(f, "git {args} a échoué")
                } else {
                    write!(f, "git {args} : {stderr}")
                }
            }
            GitError::Parse(msg) => write!(f, "sortie git inattendue : {msg}"),
        }
    }
}

impl std::error::Error for GitError {}

/// Run `git -C <dir> <args…>`, returning stdout on success or a [`GitError`]
/// carrying stderr on a non-zero exit. `dir` scopes the command to the right
/// repository / worktree without changing the process's own cwd.
fn run_git(dir: &str, args: &[&str]) -> Result<String, GitError> {
    let output = Command::new("git")
        // Force the C locale so git's messages are stable English — the UI keys
        // off them (e.g. detecting "not a git repository"), and they must not vary
        // with the user's locale.
        .env("LC_ALL", "C")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(GitError::Spawn)?;
    if !output.status.success() {
        return Err(GitError::Command {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Like [`run_git`] but returns raw stdout bytes — for reading file blobs
/// (`git show <rev>:<path>`) whose content may be binary or non-UTF-8. Shared by
/// the `status`/`history` submodules to build diffs.
fn run_git_bytes(dir: &str, args: &[&str]) -> Result<Vec<u8>, GitError> {
    let output = Command::new("git")
        .env("LC_ALL", "C")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(GitError::Spawn)?;
    if !output.status.success() {
        return Err(GitError::Command {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(output.stdout)
}

/// A file's contents on both sides of a diff, handed to the front's Monaco diff
/// editor (which computes the visual diff itself). An empty `old_text` means the
/// file was added; an empty `new_text` means it was deleted. When either side is
/// binary the texts are `None` and the front shows a "binary file" placeholder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GitDiff {
    /// Repo-relative path of the file being diffed.
    pub path: String,
    /// "Before" side content. `None` when binary.
    pub old_text: Option<String>,
    /// "After" side content. `None` when binary.
    pub new_text: Option<String>,
    /// Either side looks binary — no text diff, the UI shows a placeholder.
    pub is_binary: bool,
    /// Human label for the "before" side (e.g. "HEAD", "a1b2c3d^").
    pub old_label: String,
    /// Human label for the "after" side (e.g. "Working tree", "a1b2c3d").
    pub new_label: String,
}

/// A byte sample looks binary if it contains a NUL in its first 8 KiB — the same
/// cheap heuristic git itself uses to flag binary content.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Assemble a [`GitDiff`] from the two sides' raw bytes, decoding to UTF-8
/// (lossy) unless either side looks binary.
fn build_diff(path: &str, old: &[u8], new: &[u8], old_label: &str, new_label: &str) -> GitDiff {
    let is_binary = looks_binary(old) || looks_binary(new);
    GitDiff {
        path: path.to_string(),
        old_text: (!is_binary).then(|| String::from_utf8_lossy(old).into_owned()),
        new_text: (!is_binary).then(|| String::from_utf8_lossy(new).into_owned()),
        is_binary,
        old_label: old_label.to_string(),
        new_label: new_label.to_string(),
    }
}

/// List every worktree of the repository that `repo_path` lives in. The main
/// worktree is first (it is `is_main`), in `git`'s own order. Pure identity —
/// no status — so it stays cheap enough to back the always-on UI indicator.
pub fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeInfo>, GitError> {
    let out = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktree_list(&out))
}

/// Parse `git worktree list --porcelain`. Records are separated by a blank line;
/// each starts with `worktree <path>`, then optional `HEAD <oid>`,
/// `branch refs/heads/<name>`, `detached`, `bare`, `locked`. The first record is
/// the main worktree. Pure function (no IO) so it is unit-tested directly.
fn parse_worktree_list(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut result = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;

    let flush = |result: &mut Vec<WorktreeInfo>, cur: &mut Option<WorktreeInfo>| {
        if let Some(wt) = cur.take() {
            result.push(wt);
        }
    };

    for line in porcelain.lines() {
        if line.is_empty() {
            flush(&mut result, &mut cur);
        } else if let Some(path) = line.strip_prefix("worktree ") {
            // A new record begins; a missing blank separator (last record) is
            // covered by the final flush below.
            flush(&mut result, &mut cur);
            cur = Some(WorktreeInfo {
                path: path.to_string(),
                branch: None,
                head: None,
                is_main: false,
                is_detached: false,
                is_locked: false,
                is_bare: false,
            });
        } else if let Some(oid) = line.strip_prefix("HEAD ") {
            if let Some(w) = cur.as_mut() {
                w.head = Some(oid.to_string());
            }
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some(w) = cur.as_mut() {
                w.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_string());
            }
        } else if line == "detached" {
            if let Some(w) = cur.as_mut() {
                w.is_detached = true;
            }
        } else if line == "bare" {
            if let Some(w) = cur.as_mut() {
                w.is_bare = true;
            }
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(w) = cur.as_mut() {
                w.is_locked = true;
            }
        }
        // Other porcelain lines (e.g. `prunable`) are not needed here.
    }
    flush(&mut result, &mut cur);

    // The first NON-bare working tree git emits is the repository's main
    // worktree — the only one that can never be removed. (A bare repo lists its
    // bare entry first, which is not a usable worktree.)
    if let Some(main) = result.iter_mut().find(|w| !w.is_bare) {
        main.is_main = true;
    }
    result
}

/// Status of a single worktree: dirtiness (from `git status --porcelain`) and
/// the ahead/behind count against the branch's upstream (`None` when unset).
pub fn worktree_status(worktree_path: &str) -> Result<WorktreeStatus, GitError> {
    let porcelain = run_git(worktree_path, &["status", "--porcelain"])?;
    let mut status = WorktreeStatus::default();
    for line in porcelain.lines() {
        if line.is_empty() {
            continue;
        }
        status.changed_files += 1;
        if line.starts_with("??") {
            status.untracked = true;
        } else {
            status.dirty = true;
        }
    }
    let (ahead, behind) = upstream_ahead_behind(worktree_path);
    status.ahead = ahead;
    status.behind = behind;
    Ok(status)
}

/// `(ahead, behind)` of HEAD versus its configured upstream. `git rev-list
/// --left-right --count @{upstream}...HEAD` prints `<behind>\t<ahead>`. Returns
/// `(None, None)` when the branch has no upstream (the common case for a
/// freshly-created local worktree branch) — surfaced as "—" in the UI.
fn upstream_ahead_behind(path: &str) -> (Option<u32>, Option<u32>) {
    match run_git(
        path,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    ) {
        Ok(out) => {
            let mut counts = out.split_whitespace();
            let behind = counts.next().and_then(|s| s.parse().ok());
            let ahead = counts.next().and_then(|s| s.parse().ok());
            (ahead, behind)
        }
        Err(_) => (None, None),
    }
}

/// Create a new worktree for `branch`, checked out in a dedicated directory
/// derived from the repository's MAIN worktree (see [`worktree_dest`]). With
/// `new_branch` the branch is created off `base_ref` (default: the main
/// worktree's HEAD); otherwise an existing `branch` is checked out. Returns the
/// freshly created [`WorktreeInfo`].
pub fn create_worktree(
    repo_path: &str,
    branch: &str,
    base_ref: Option<&str>,
    new_branch: bool,
) -> Result<WorktreeInfo, GitError> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(GitError::Parse("le nom de branche est vide".into()));
    }
    let worktrees = list_worktrees(repo_path)?;
    let main = worktrees
        .iter()
        .find(|w| w.is_main)
        .ok_or_else(|| GitError::Parse("aucun worktree principal trouvé".into()))?;
    let dest = worktree_dest(&main.path, branch);
    let dest = dest.to_string_lossy().into_owned();

    let mut args: Vec<&str> = vec!["worktree", "add"];
    if new_branch {
        args.push("-b");
        args.push(branch);
        args.push(&dest);
        if let Some(base) = base_ref {
            args.push(base);
        }
    } else {
        args.push(&dest);
        args.push(branch);
    }
    run_git(repo_path, &args)?;

    list_worktrees(repo_path)?
        .into_iter()
        .find(|w| same_path(&w.path, &dest))
        .ok_or_else(|| GitError::Parse("worktree créé introuvable dans la liste".into()))
}

/// Remove a worktree. Without `force`, `git` refuses to remove a worktree that
/// has uncommitted or untracked changes (and always refuses the main worktree) —
/// the safety net we rely on. `force` is only ever passed after an explicit,
/// separate user confirmation in the UI.
pub fn remove_worktree(repo_path: &str, worktree_path: &str, force: bool) -> Result<(), GitError> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(worktree_path);
    run_git(repo_path, &args).map(|_| ())
}

/// Where a new worktree for `branch` is checked out: under `.claude/worktrees/`
/// inside the main worktree, one subdirectory per branch (slashes in the branch
/// name flattened to `-`). This deliberately matches the convention of Claude
/// Code's own `EnterWorktree` tool, so app-created and agent-created worktrees
/// live side by side in the same place. git excludes a registered worktree
/// directory from the parent's status, and `.claude/` is conventionally ignored,
/// so it never pollutes the main checkout.
///
/// e.g. main `/Users/me/Repos/app` + branch `feat/x`
///      → `/Users/me/Repos/app/.claude/worktrees/feat-x`.
fn worktree_dest(main_path: &str, branch: &str) -> PathBuf {
    let safe_branch = branch.replace('/', "-");
    Path::new(main_path)
        .join(".claude")
        .join("worktrees")
        .join(safe_branch)
}

/// Compare two filesystem paths for the worktree-matching we need, tolerating a
/// trailing slash. Not a full canonicalization (no symlink resolution) — `git`
/// already emits absolute, normalized worktree paths, and the destinations we
/// build are absolute too.
fn same_path(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_main_and_linked_worktrees() {
        let porcelain = "\
worktree /Users/me/Repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /Users/me/Repos/app.worktrees/feat-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feat/x

worktree /Users/me/Repos/app.worktrees/detached
HEAD 3333333333333333333333333333333333333333
detached
";
        let wts = parse_worktree_list(porcelain);
        assert_eq!(wts.len(), 3);

        assert_eq!(wts[0].path, "/Users/me/Repos/app");
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(wts[0].is_main, "first record is the main worktree");

        assert_eq!(wts[1].branch.as_deref(), Some("feat/x"), "refs/heads/ stripped");
        assert!(!wts[1].is_main);
        assert!(!wts[1].is_detached);

        assert!(wts[2].is_detached);
        assert_eq!(wts[2].branch, None, "a detached worktree has no branch");
    }

    #[test]
    fn parses_trailing_record_without_blank_separator() {
        // The last record may not be followed by a blank line.
        let porcelain = "worktree /a\nHEAD aaaa\nbranch refs/heads/main\n";
        let wts = parse_worktree_list(porcelain);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(wts[0].is_main);
    }

    #[test]
    fn marks_locked_worktrees() {
        let porcelain = "\
worktree /a
HEAD aaaa
branch refs/heads/main

worktree /b
HEAD bbbb
branch refs/heads/wip
locked some reason
";
        let wts = parse_worktree_list(porcelain);
        assert!(!wts[0].is_locked);
        assert!(wts[1].is_locked, "the `locked` line sets is_locked");
    }

    #[test]
    fn bare_entry_is_not_main() {
        // A bare repo lists the bare entry first; it is not a usable main worktree.
        let porcelain = "worktree /repo.git\nbare\n\nworktree /repo/wt\nHEAD aaaa\nbranch refs/heads/main\n";
        let wts = parse_worktree_list(porcelain);
        assert!(wts[0].is_bare);
        assert!(!wts[0].is_main, "the bare entry is never the main worktree");
        assert!(wts[1].is_main, "the first real working tree is main");
    }

    #[test]
    fn worktree_dest_is_under_dot_claude_worktrees_per_branch() {
        let dest = worktree_dest("/Users/me/Repos/app", "feat/login");
        assert_eq!(
            dest.to_string_lossy(),
            "/Users/me/Repos/app/.claude/worktrees/feat-login",
            "slashes in the branch flatten to '-', under .claude/worktrees (matches EnterWorktree)"
        );
    }

    #[test]
    fn same_path_tolerates_trailing_slash() {
        assert!(same_path("/a/b", "/a/b/"));
        assert!(same_path("/a/b/", "/a/b"));
        assert!(!same_path("/a/b", "/a/bc"));
    }

    /// Full round trip against a real `git` repo. Ignored by default (needs the
    /// `git` binary and touches a temp dir) — run with `--ignored`. Mirrors the
    /// live-session test policy in the supervisor.
    #[test]
    #[ignore]
    fn create_list_status_remove_round_trip() {
        let dir = std::env::temp_dir().join(format!("tosse-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_path = repo.to_string_lossy().into_owned();

        // Minimal repo with one commit so HEAD exists.
        run_git(&repo_path, &["init", "-b", "main"]).unwrap();
        run_git(&repo_path, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&repo_path, &["config", "user.name", "t"]).unwrap();
        std::fs::write(repo.join("a.txt"), "hello").unwrap();
        run_git(&repo_path, &["add", "."]).unwrap();
        run_git(&repo_path, &["commit", "-m", "init"]).unwrap();

        // Only the main worktree at first.
        let wts = list_worktrees(&repo_path).unwrap();
        assert_eq!(wts.len(), 1);
        assert!(wts[0].is_main);

        // Create a linked worktree on a new branch.
        let created = create_worktree(&repo_path, "feat/x", None, true).unwrap();
        assert_eq!(created.branch.as_deref(), Some("feat/x"));
        assert!(!created.is_main);

        let wts = list_worktrees(&repo_path).unwrap();
        assert_eq!(wts.len(), 2);

        // Clean worktree: status reports nothing dirty.
        let status = worktree_status(&created.path).unwrap();
        assert!(!status.dirty && !status.untracked);

        // Remove it (clean → no force needed).
        remove_worktree(&repo_path, &created.path, false).unwrap();
        assert_eq!(list_worktrees(&repo_path).unwrap().len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }
}
