//! Commit history and per-commit diffs — the "git tree" half of the git service.
//! [`log`] emits commits with their PARENT oids so the front can lay out the DAG
//! (rail placement lives in the UI, not here — Rust stays a pure data source).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{build_diff, run_git, run_git_bytes, GitDiff, GitError};

// Field/record separators chosen to never occur in commit text: ASCII US (0x1f)
// between fields, RS (0x1e) between commits.
const F: char = '\u{1f}';
const R: char = '\u{1e}';

/// One commit in the history. `parents` are full oids (0 = root, 1 = normal,
/// 2+ = merge), which the front uses to draw the graph. `refs` are the branch/tag
/// names pointing at this commit (decoration), for badges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CommitInfo {
    /// Full commit oid.
    pub oid: String,
    /// Abbreviated oid (as git chooses it).
    pub short_oid: String,
    /// Parent commit oids, in git's order.
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author timestamp, Unix seconds.
    pub timestamp: i64,
    /// First line of the commit message.
    pub subject: String,
    /// Ref names pointing here (branches/tags/`HEAD`), already de-decorated.
    pub refs: Vec<String>,
}

/// One file changed by a commit (name-status against its first parent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CommitFile {
    pub path: String,
    /// Source path for a rename/copy; `None` otherwise.
    pub orig_path: Option<String>,
    /// Status letter: `M A D R C T`.
    pub status: String,
}

/// A page of history across ALL refs (`--all`), in DAG order (`--date-order`), so
/// the graph shows branches diverging and merging. `limit`/`skip` paginate;
/// parents that fall outside the loaded page keep their rail open at the bottom
/// (the front handles that gracefully).
pub fn log(cwd: &str, limit: u32, skip: u32) -> Result<Vec<CommitInfo>, GitError> {
    let fmt = format!("%H{F}%h{F}%P{F}%an{F}%ae{F}%at{F}%s{F}%D{R}");
    let out = run_git(
        cwd,
        &[
            "log",
            // `--exclude` must precede `--all` to take effect; keeps stash entries
            // (refs/stash) out of the history graph while keeping all branches/tags.
            "--exclude=refs/stash",
            "--all",
            "--date-order",
            &format!("--max-count={limit}"),
            &format!("--skip={skip}"),
            &format!("--pretty=format:{fmt}"),
        ],
    )?;
    Ok(parse_log(&out))
}

/// Files changed by commit `oid`, against its FIRST parent — matching the
/// per-file diff in [`commit_file_diff`] (which uses `oid^`). `git diff
/// <oid>^1 <oid>` gives the first-parent change set for normal AND merge commits
/// (`diff-tree` alone emits nothing for a merge). A root commit has no parent, so
/// `oid^1` fails — fall back to `diff-tree --root`, which lists every file as
/// added. `-z` keeps paths with spaces intact.
pub fn commit_files(cwd: &str, oid: &str) -> Result<Vec<CommitFile>, GitError> {
    let out = match run_git(
        cwd,
        &["diff", "--name-status", "-z", &format!("{oid}^1"), oid],
    ) {
        Ok(out) => out,
        // No first parent (root commit) → show the whole tree as added.
        Err(_) => run_git(
            cwd,
            &["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", oid],
        )?,
    };
    Ok(parse_name_status_z(&out))
}

/// Diff of one file introduced by commit `oid`: "before" = the file at the
/// commit's first parent (`oid^`), "after" = the file at `oid`. Either side is
/// empty when the file was added/deleted in that commit.
pub fn commit_file_diff(
    cwd: &str,
    oid: &str,
    path: &str,
    orig_path: Option<&str>,
) -> Result<GitDiff, GitError> {
    // For a rename/copy the "before" side lives at the parent under the ORIGINAL
    // path; using the new path there fails (empty) and renders as fully added.
    let old_path = orig_path.unwrap_or(path);
    let new = run_git_bytes(cwd, &["show", &format!("{oid}:{path}")]).unwrap_or_default();
    let old = run_git_bytes(cwd, &["show", &format!("{oid}^:{old_path}")]).unwrap_or_default();
    let short = &oid[..oid.len().min(7)];
    Ok(build_diff(path, &old, &new, &format!("{short}^"), short))
}

/// Parse the `log` output: records split on RS, fields on US.
fn parse_log(out: &str) -> Vec<CommitInfo> {
    let mut commits = Vec::new();
    for record in out.split(R) {
        // git separates records with our RS but each line still ends in `\n`;
        // trim the leading newline carried from the previous record.
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut f = record.split(F);
        let oid = f.next().unwrap_or("").to_string();
        if oid.is_empty() {
            continue;
        }
        let short_oid = f.next().unwrap_or("").to_string();
        let parents = f
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let author_name = f.next().unwrap_or("").to_string();
        let author_email = f.next().unwrap_or("").to_string();
        let timestamp = f.next().unwrap_or("").trim().parse().unwrap_or(0);
        let subject = f.next().unwrap_or("").to_string();
        let refs = parse_decoration(f.next().unwrap_or(""));
        commits.push(CommitInfo {
            oid,
            short_oid,
            parents,
            author_name,
            author_email,
            timestamp,
            subject,
            refs,
        });
    }
    commits
}

/// Turn `%D` decoration ("HEAD -> main, origin/main, tag: v1.0") into clean ref
/// tokens. `HEAD -> x` becomes two entries (`HEAD` and `x`); tags keep their
/// `tag: ` marker so the UI can badge them differently.
fn parse_decoration(d: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in d.split(',') {
        let r = raw.trim();
        if r.is_empty() {
            continue;
        }
        if let Some(branch) = r.strip_prefix("HEAD -> ") {
            out.push("HEAD".to_string());
            out.push(branch.to_string());
        } else {
            out.push(r.to_string());
        }
    }
    out
}

/// Parse `git diff-tree --name-status -z`: a status token, then one path token
/// (two for `R`/`C`: original then new).
fn parse_name_status_z(out: &str) -> Vec<CommitFile> {
    let mut files = Vec::new();
    let mut it = out.split('\0');
    while let Some(status) = it.next() {
        if status.is_empty() {
            continue;
        }
        let code = status.chars().next().unwrap_or(' ');
        if code == 'R' || code == 'C' {
            let orig = it.next().unwrap_or("").to_string();
            let path = it.next().unwrap_or("").to_string();
            files.push(CommitFile {
                path,
                orig_path: Some(orig),
                status: code.to_string(),
            });
        } else {
            let path = it.next().unwrap_or("").to_string();
            files.push(CommitFile {
                path,
                orig_path: None,
                status: code.to_string(),
            });
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_two_commits_with_parents_and_refs() {
        // Two records; the first is a merge (two parents) decorated HEAD -> main.
        let out = format!(
            "aaaa{F}aaaa{F}bbbb cccc{F}Ann{F}ann@x{F}1700000000{F}merge it{F}HEAD -> main, origin/main{R}\nbbbb{F}bbbb{F}{F}Bob{F}bob@x{F}1699999999{F}root commit{F}tag: v1{R}"
        );
        let commits = parse_log(&out);
        assert_eq!(commits.len(), 2);

        let a = &commits[0];
        assert_eq!(a.oid, "aaaa");
        assert_eq!(a.parents, vec!["bbbb", "cccc"], "merge has two parents");
        assert_eq!(a.author_name, "Ann");
        assert_eq!(a.timestamp, 1_700_000_000);
        assert_eq!(a.subject, "merge it");
        assert_eq!(a.refs, vec!["HEAD", "main", "origin/main"], "HEAD -> split");

        let b = &commits[1];
        assert!(b.parents.is_empty(), "root commit has no parents");
        assert_eq!(b.refs, vec!["tag: v1"]);
    }

    #[test]
    fn empty_log_yields_no_commits() {
        assert!(parse_log("").is_empty());
        assert!(parse_log("\n").is_empty());
    }

    #[test]
    fn parses_name_status_with_rename() {
        // modified a.txt, then a rename old->new, then an added file.
        let out = "M\0a.txt\0R100\0old.rs\0new.rs\0A\0added.txt\0";
        let files = parse_name_status_z(out);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(files[1].path, "new.rs");
        assert_eq!(files[2].status, "A");
        assert_eq!(files[2].path, "added.txt");
    }
}
