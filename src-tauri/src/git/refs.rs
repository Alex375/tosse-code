//! Branch listing — local and remote-tracking refs with their upstream tracking
//! counts. Read-only in v1 (no checkout/create yet); feeds the branch list and
//! the "current branch" indicator.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{run_git, GitError};

/// One branch ref. `is_remote` distinguishes `refs/remotes/*` from local
/// `refs/heads/*`; `ahead`/`behind` come from the branch's upstream tracking
/// (`None` when it has no upstream).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BranchInfo {
    /// Short name, e.g. `main` or `origin/feature`.
    pub name: String,
    /// Commit oid the branch points at.
    pub oid: String,
    /// The currently checked-out branch.
    pub is_head: bool,
    /// A remote-tracking branch (`refs/remotes/*`).
    pub is_remote: bool,
    /// Upstream short name; `None` when unset.
    pub upstream: Option<String>,
    /// Commits ahead of upstream.
    pub ahead: Option<u32>,
    /// Commits behind upstream.
    pub behind: Option<u32>,
}

/// All local + remote-tracking branches. The remote `*/HEAD` symbolic refs are
/// dropped (they are aliases, not real branches).
pub fn branches(cwd: &str) -> Result<Vec<BranchInfo>, GitError> {
    // SOH (0x01) field separator — never appears in ref names. Full refname first
    // so we can tell local from remote reliably.
    let fmt = "%(refname)\u{01}%(refname:short)\u{01}%(objectname)\u{01}%(HEAD)\u{01}%(upstream:short)\u{01}%(upstream:track)";
    let out = run_git(
        cwd,
        &[
            "for-each-ref",
            &format!("--format={fmt}"),
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    Ok(parse_branches(&out))
}

fn parse_branches(out: &str) -> Vec<BranchInfo> {
    let mut v = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let mut f = line.split('\u{01}');
        let full = f.next().unwrap_or("");
        let name = f.next().unwrap_or("").to_string();
        let oid = f.next().unwrap_or("").to_string();
        let head = f.next().unwrap_or("");
        let upstream = f.next().unwrap_or("");
        let track = f.next().unwrap_or("");

        let is_remote = full.starts_with("refs/remotes/");
        if is_remote && name.ends_with("/HEAD") {
            continue; // skip the `origin/HEAD -> origin/main` alias
        }
        let (ahead, behind) = parse_track(track);
        v.push(BranchInfo {
            name,
            oid,
            is_head: head == "*",
            is_remote,
            upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            ahead,
            behind,
        });
    }
    v
}

/// Parse `%(upstream:track)`, e.g. `[ahead 2, behind 1]`, `[ahead 3]`, `[gone]`,
/// or empty. Missing counts stay `None`.
fn parse_track(track: &str) -> (Option<u32>, Option<u32>) {
    let mut ahead = None;
    let mut behind = None;
    let inner = track.trim_start_matches('[').trim_end_matches(']');
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().ok();
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().ok();
        }
    }
    (ahead, behind)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: char = '\u{01}';

    #[test]
    fn parses_local_head_and_remote() {
        let out = format!(
            "refs/heads/main{S}main{S}aaaa{S}*{S}origin/main{S}[ahead 2, behind 1]\n\
             refs/heads/wip{S}wip{S}bbbb{S}{S}{S}\n\
             refs/remotes/origin/main{S}origin/main{S}aaaa{S}{S}{S}\n\
             refs/remotes/origin/HEAD{S}origin/HEAD{S}aaaa{S}{S}{S}"
        );
        let bs = parse_branches(&out);
        assert_eq!(bs.len(), 3, "the origin/HEAD alias is skipped");

        let main = &bs[0];
        assert_eq!(main.name, "main");
        assert!(main.is_head && !main.is_remote);
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert_eq!(main.ahead, Some(2));
        assert_eq!(main.behind, Some(1));

        let wip = &bs[1];
        assert!(!wip.is_head && !wip.is_remote);
        assert_eq!(wip.upstream, None);
        assert_eq!(wip.ahead, None);

        let remote = &bs[2];
        assert!(remote.is_remote);
        assert_eq!(remote.name, "origin/main");
    }

    #[test]
    fn track_parsing_handles_partials() {
        assert_eq!(parse_track("[ahead 3]"), (Some(3), None));
        assert_eq!(parse_track("[behind 4]"), (None, Some(4)));
        assert_eq!(parse_track("[gone]"), (None, None));
        assert_eq!(parse_track(""), (None, None));
    }
}
