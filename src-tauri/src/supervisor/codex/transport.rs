//! Transport for the Codex `app-server` — spawn `codex app-server`, read its stdout
//! as newline-delimited JSON-RPC (each line classified into an [`Incoming`]), write
//! outbound JSON lines onto its stdin, and tear it down GRACEFULLY.
//!
//! The Codex sibling of `supervisor::transport` (the Claude one), copying its proven
//! skeleton — own the child, three pump tasks (reader / writer / stderr) — with two
//! deliberate differences:
//!
//!  1. It speaks JSON-RPC (classified via [`protocol::parse_incoming`]), not the Claude
//!     stream-json `CliMessage`. It only PUMPS; the demux (responses by id vs
//!     notifications by threadId) lives in [`super::server::CodexServer`].
//!  2. **The teardown ladder leads with a GENEROUS graceful EOF** (invariant #9): the
//!     app-server spawns MCP children (e.g. `node_repl`) that `setsid` into their OWN
//!     process groups, so a `kill(-pgid)` group sweep does NOT reach them. The ONLY
//!     reliable reaper is the app-server itself shutting down cleanly on stdin EOF —
//!     so step 1 (EOF) is the guarantee and gets a longer timeout; the group SIGKILL
//!     sweep is kept as a benign backstop, NOT counted on for zero-orphans. (The live
//!     spike proved a SIGKILL of the app-server still left zero orphans because the MCP
//!     children self-exit on their own stdio EOF — the graceful path makes that the norm.)
//!
//! Socle scope: the crash-diagnostic scaffolding the Claude transport carries (a
//! bounded stderr tail + terminal reader/writer error slots surfaced in the UI) is a
//! phase-4.1 follow-up; here stderr is logged and a spontaneous death surfaces the
//! generic `process_exited` notice (invariant #6).

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use super::protocol::{self, Incoming};

/// How the shared `codex app-server` process is launched. Socle: just the working
/// directory the server roots in (per-thread cwd is set at `thread/start`, not here).
#[derive(Debug, Clone)]
pub struct CodexSpawnConfig {
    pub cwd: PathBuf,
}

/// A failure launching or driving the app-server. Deliberately Codex-worded (the
/// Claude `TransportError` hardcodes "claude" in its messages).
#[derive(Debug)]
pub enum CodexTransportError {
    /// The `codex` process failed to spawn.
    Spawn(std::io::Error),
    /// The server's working directory no longer exists.
    CwdMissing(PathBuf),
    /// The writer channel is closed — the server is gone.
    Closed,
}

impl std::fmt::Display for CodexTransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodexTransportError::Spawn(e) if e.kind() == std::io::ErrorKind::NotFound => write!(
                f,
                "Binaire « codex » introuvable. Installez le CLI Codex (npm i -g @openai/codex) \
                 ou définissez TOSSE_CODEX_BIN."
            ),
            CodexTransportError::Spawn(e) => {
                write!(f, "Impossible de démarrer « codex app-server » : {e}")
            }
            CodexTransportError::CwdMissing(p) => write!(
                f,
                "Le dossier de travail n'existe plus : {} (worktree supprimé ?)",
                p.display()
            ),
            CodexTransportError::Closed => write!(f, "le transport codex app-server est fermé"),
        }
    }
}

impl std::error::Error for CodexTransportError {}

/// A live `codex app-server` transport. Owns the child + the writer half of stdin;
/// inbound classified messages are delivered over the receiver from [`spawn`].
pub struct CodexTransport {
    pid: Option<u32>,
    /// `None` once [`CodexTransport::shutdown`] has closed stdin (→ EOF).
    writer_tx: Option<mpsc::UnboundedSender<Value>>,
    child: Child,
    pumps: Vec<tokio::task::JoinHandle<()>>,
}

impl CodexTransport {
    /// Spawn `codex app-server` and start the reader / writer / stderr pumps. Returns
    /// the transport handle plus the receiver of classified [`Incoming`] messages.
    pub fn spawn(
        cfg: CodexSpawnConfig,
    ) -> Result<(CodexTransport, mpsc::UnboundedReceiver<Incoming>), CodexTransportError> {
        // The extension launches exactly `codex app-server`; we mirror that, spawning
        // the resolved binary.
        let mut cmd = Command::new(super::resolved_codex_bin());
        cmd.arg("app-server")
            .current_dir(&cfg.cwd)
            // Node ESM wrapper env hygiene, same as the Claude transport.
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Backstop: never orphan the direct child if the handle is dropped.
            .kill_on_drop(true);

        // Own process group (leader; pgid == pid) so the SIGKILL sweep can reach any
        // child that stayed IN the group. (MCP children that `setsid` escape it — hence
        // the graceful-EOF-first ladder in `shutdown`.)
        #[cfg(unix)]
        cmd.process_group(0);

        // A vanished cwd (removed worktree) makes spawn fail with NotFound —
        // indistinguishable from a missing binary. Check first so the error is honest.
        if !cfg.cwd.exists() {
            return Err(CodexTransportError::CwdMissing(cfg.cwd.clone()));
        }

        let mut child = cmd.spawn().map_err(CodexTransportError::Spawn)?;
        let pid = child.id();

        let stdout = child.stdout.take().expect("stdout was piped");
        let stdin = child.stdin.take().expect("stdin was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<Incoming>();
        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<Value>();

        let pumps = vec![
            tokio::spawn(reader_loop(stdout, inbound_tx)),
            tokio::spawn(writer_loop(stdin, writer_rx)),
            tokio::spawn(stderr_loop(stderr)),
        ];

        Ok((
            CodexTransport {
                pid,
                writer_tx: Some(writer_tx),
                child,
                pumps,
            },
            inbound_rx,
        ))
    }

    /// A clone of the outbound line sender. The [`CodexServer`](super::server::CodexServer)
    /// owns exactly ONE such sender (inside its `Started` state) and never distributes
    /// further clones to per-conversation actors — so stdin EOFs the moment that single
    /// owner is dropped (invariant: graceful teardown depends on all writer clones dying).
    pub fn outbound(&self) -> mpsc::UnboundedSender<Value> {
        self.writer_tx
            .as_ref()
            .expect("transport is alive immediately after spawn")
            .clone()
    }

    /// Tear the app-server down along a GRACEFUL-FIRST ladder (invariant #9):
    ///
    ///   1. close stdin (EOF) → the app-server reaps its own MCP children (even the
    ///      `setsid` ones) and exits. **This is the zero-orphan guarantee.** Generous
    ///      timeout (~5s) — tearing down N node MCP servers is slower than `claude`.
    ///   2. else SIGTERM the group — last chance for in-group cleanup handlers.
    ///   3. else SIGKILL the child handle (leader).
    ///   4. always finish with a SIGKILL sweep of the group — benign (ESRCH if empty),
    ///      reaps any straggler left IN the group, but is NOT the guarantee (setsid MCP
    ///      children escape it; only step 1 reaps those).
    pub async fn shutdown(&mut self) {
        // Step 1 — graceful EOF. Dropping the sole writer sender ends writer_loop →
        // stdin is dropped → EOF → the app-server tears down and exits.
        self.writer_tx = None;
        let mut exited = self.wait_for_exit(Duration::from_secs(5)).await;

        #[cfg(unix)]
        if !exited {
            self.signal_group(libc::SIGTERM);
            exited = self.wait_for_exit(Duration::from_secs(2)).await;
        }

        if !exited {
            let _ = self.child.start_kill();
            let _ = self.child.wait().await;
        }

        #[cfg(unix)]
        self.signal_group(libc::SIGKILL);

        self.stop_pumps();
    }

    async fn wait_for_exit(&mut self, d: Duration) -> bool {
        tokio::time::timeout(d, self.child.wait()).await.is_ok()
    }

    #[cfg(unix)]
    fn signal_group(&self, sig: i32) {
        if let Some(pid) = self.pid {
            // SAFETY: a plain kill(2) with a constant signal; the only realistic error
            // is ESRCH (group already gone), which is benign.
            unsafe {
                libc::kill(-(pid as i32), sig);
            }
        }
    }

    fn stop_pumps(&mut self) {
        for task in self.pumps.drain(..) {
            task.abort();
        }
    }
}

/// Read stdout as newline-delimited JSON-RPC. Each non-empty line is classified via
/// [`protocol::parse_incoming`] and handed to the consumer; a JSON parse failure is
/// logged and skipped, never fatal. Ends on EOF or when the consumer drops the receiver.
async fn reader_loop(stdout: ChildStdout, tx: mpsc::UnboundedSender<Incoming>) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match protocol::parse_incoming(trimmed) {
                    Ok(incoming) => {
                        if tx.send(incoming).is_err() {
                            break; // consumer gone
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[codex-transport] skipping unparseable stdout line: {e}: {}",
                            truncate(trimmed, 160)
                        );
                    }
                }
            }
            Ok(None) => break, // clean EOF
            Err(e) => {
                eprintln!("[codex-transport] stdout read error: {e}");
                break;
            }
        }
    }
}

/// Drain the outbound queue onto stdin, one JSON line at a time, flushing each.
/// Stdin stays open until the queue closes (all writer senders dropped) → EOF.
async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<Value>) {
    while let Some(value) = rx.recv().await {
        let mut line = match serde_json::to_string(&value) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[codex-transport] dropping unserializable outbound message: {e}");
                continue;
            }
        };
        line.push('\n');
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            eprintln!("[codex-transport] stdin write failed: {e}");
            break;
        }
        if let Err(e) = stdin.flush().await {
            eprintln!("[codex-transport] stdin flush failed: {e}");
            break;
        }
    }
    // Channel closed → drop stdin here → child receives EOF.
}

/// Forward the app-server's stderr to our log.
async fn stderr_loop(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            eprintln!("[codex app-server stderr] {line}");
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The graceful-EOF path (step 1 of the ladder) actually reaps the process: a fake
    /// "app-server" that reads stdin until EOF then exits must terminate promptly when
    /// `shutdown` drops the writer — no SIGKILL needed. This is the zero-orphan
    /// guarantee for Codex (the live spike further proved real MCP children self-exit on
    /// their own stdio EOF along the same path).
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_reaps_via_graceful_eof() {
        // Bypass the `codex` binary: drive a trivial stdin-draining child through the
        // same pumps by spawning `sh` directly (we can't call `CodexTransport::spawn`,
        // which hardcodes `codex app-server`).
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("while IFS= read -r _; do :; done") // read stdin to EOF, then exit 0
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd.process_group(0);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<Value>();
        let (inbound_tx, _inbound_rx) = mpsc::unbounded_channel::<Incoming>();
        let pumps = vec![
            tokio::spawn(reader_loop(stdout, inbound_tx)),
            tokio::spawn(writer_loop(stdin, writer_rx)),
            tokio::spawn(stderr_loop(stderr)),
        ];
        let mut t = CodexTransport {
            pid,
            writer_tx: Some(writer_tx),
            child,
            pumps,
        };

        // Graceful shutdown: dropping the writer must EOF stdin and let `sh` exit well
        // within step 1's 5s window (never reaching SIGKILL).
        let start = std::time::Instant::now();
        t.shutdown().await;
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "graceful EOF should reap the child inside step 1, not fall through to SIGKILL"
        );
        // Process is gone: signalling its pid now yields ESRCH.
        let alive = unsafe { libc::kill(pid.unwrap() as i32, 0) } == 0;
        assert!(!alive, "child must be fully reaped after graceful shutdown");
    }
}
