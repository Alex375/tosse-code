//! Transport layer for a single `claude` session (subtask 1).
//!
//! Responsibilities, and *only* these:
//!   - spawn the `claude` binary in persistent bidirectional `stream-json` mode
//!     (see `docs/claude-code-protocol.md` §1–§2),
//!   - read its stdout as newline-delimited JSON, parse each line into a
//!     [`CliMessage`], and hand it to a consumer over an mpsc channel,
//!   - serialize outbound messages (one full JSON line at a time) onto stdin,
//!     keeping stdin open for the whole session,
//!   - drain stderr to our log,
//!   - tear the process down gracefully.
//!
//! It does NOT implement the control-channel responder table / state machine
//! (subtask 2) nor the content assembler / IPC surface (subtask 3). Those build
//! on the [`CliMessage`] stream this layer produces and the [`Transport::send_line`]
//! escape hatch it exposes.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use super::protocol::CliMessage;

/// How a `claude` process is launched. Build with [`SpawnConfig::new`] and tweak
/// the optional fields.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    /// Path to the `claude` binary. Defaults to `$TOSSE_CLAUDE_BIN`, else `claude`
    /// resolved on `PATH`.
    pub claude_bin: PathBuf,
    /// Working directory for the session (the repo/workspace folder).
    pub cwd: PathBuf,
    /// Resume an existing conversation by session id (`--resume`).
    pub resume: Option<String>,
    /// Static tool allowlist (`--allowedTools`, comma-joined). Tools resolved
    /// here never trigger a `can_use_tool` prompt.
    pub allowed_tools: Vec<String>,
    /// Static tool denylist (`--disallowedTools`, comma-joined).
    pub disallowed_tools: Vec<String>,
    /// Extra directories tools may access (`--add-dir`, repeated).
    pub add_dirs: Vec<PathBuf>,
    /// Override the session model (`--model`).
    pub model: Option<String>,
}

impl SpawnConfig {
    /// A default config for `cwd`, using the `claude` binary on `PATH` (or
    /// `$TOSSE_CLAUDE_BIN`).
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            claude_bin: default_claude_bin(),
            cwd: cwd.into(),
            resume: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            add_dirs: Vec::new(),
            model: None,
        }
    }
}

fn default_claude_bin() -> PathBuf {
    std::env::var_os("TOSSE_CLAUDE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("claude"))
}

/// Build a `user` turn message in the Anthropic message shape (spec §2.3).
pub fn user_message(text: impl Into<String>) -> Value {
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": text.into() }],
        }
    })
}

/// Errors surfaced by the transport's synchronous API.
#[derive(Debug)]
pub enum TransportError {
    /// The `claude` process failed to spawn.
    Spawn(std::io::Error),
    /// The writer channel is closed — the session is gone.
    Closed,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Spawn(e) => write!(f, "failed to spawn claude: {e}"),
            TransportError::Closed => write!(f, "claude session transport is closed"),
        }
    }
}

impl std::error::Error for TransportError {}

/// A live `claude` session transport. Owns the child process and the writer
/// half of stdin; inbound messages are delivered over the receiver returned by
/// [`Transport::spawn`].
pub struct Transport {
    pid: Option<u32>,
    /// `None` once [`Transport::shutdown`] has closed stdin.
    writer_tx: Option<mpsc::UnboundedSender<Value>>,
    child: Child,
}

impl Transport {
    /// Spawn `claude` and start the reader / writer / stderr tasks.
    ///
    /// Returns the [`Transport`] handle plus the receiver of parsed inbound
    /// [`CliMessage`]s. The session stays alive (stdin held open) until
    /// [`Transport::shutdown`] is called or the handle is dropped.
    pub fn spawn(
        cfg: SpawnConfig,
    ) -> Result<(Transport, mpsc::UnboundedReceiver<CliMessage>), TransportError> {
        let mut cmd = Command::new(&cfg.claude_bin);

        // Persistent bidirectional stream-json mode. NOT `-p`/`--print`: with
        // `--input-format stream-json` the process lives for the whole session
        // and reads many messages from stdin (spec §1.1).
        cmd.arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            // Route permission decisions back over the stdio control channel as
            // `control_request{can_use_tool}` (answered in subtask 2).
            .arg("--permission-prompt-tool")
            .arg("stdio");

        if let Some(resume) = &cfg.resume {
            cmd.arg("--resume").arg(resume);
        }
        if !cfg.allowed_tools.is_empty() {
            cmd.arg("--allowedTools").arg(cfg.allowed_tools.join(","));
        }
        if !cfg.disallowed_tools.is_empty() {
            cmd.arg("--disallowedTools").arg(cfg.disallowed_tools.join(","));
        }
        for dir in &cfg.add_dirs {
            cmd.arg("--add-dir").arg(dir);
        }
        if let Some(model) = &cfg.model {
            cmd.arg("--model").arg(model);
        }

        cmd.current_dir(&cfg.cwd)
            .env("CLAUDE_CODE_ENTRYPOINT", "tosse-code")
            .env("MCP_CONNECTION_NONBLOCKING", "true")
            .env("CLAUDE_CODE_ENABLE_TASKS", "0")
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Backstop: if the handle is dropped without shutdown, don't orphan
            // the process.
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(TransportError::Spawn)?;
        let pid = child.id();

        let stdout = child.stdout.take().expect("stdout was piped");
        let stdin = child.stdin.take().expect("stdin was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let (msg_tx, msg_rx) = mpsc::unbounded_channel::<CliMessage>();
        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<Value>();

        tokio::spawn(reader_loop(stdout, msg_tx));
        tokio::spawn(writer_loop(stdin, writer_rx));
        tokio::spawn(stderr_loop(stderr));

        Ok((
            Transport {
                pid,
                writer_tx: Some(writer_tx),
                child,
            },
            msg_rx,
        ))
    }

    /// OS process id, while the child is alive.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Queue a user turn as a `user` message in the Anthropic message shape
    /// (spec §2.3). Non-blocking: the writer task serializes it onto stdin.
    pub fn send_user_text(&self, text: impl Into<String>) -> Result<(), TransportError> {
        self.send_line(user_message(text))
    }

    /// A clone of the outbound line sender, feeding the same stdin writer task.
    /// Lets a higher layer (the session actor) own the send half while this
    /// `Transport` retains ownership for lifecycle/teardown.
    pub fn outbound(&self) -> mpsc::UnboundedSender<Value> {
        self.writer_tx
            .as_ref()
            .expect("transport is alive immediately after spawn")
            .clone()
    }

    /// Queue an arbitrary already-shaped message onto stdin (one JSON line).
    /// This is the escape hatch the control channel (subtask 2) uses to send
    /// `control_request` / `control_response` lines.
    pub fn send_line(&self, value: Value) -> Result<(), TransportError> {
        self.writer_tx
            .as_ref()
            .ok_or(TransportError::Closed)?
            .send(value)
            .map_err(|_| TransportError::Closed)
    }

    /// Tear the session down (spec §2.5): close stdin (graceful EOF), give the
    /// process a grace period to exit on its own, then force-kill if needed.
    ///
    /// The common case is graceful: `claude` exits shortly after stdin EOF once
    /// the current turn finishes. `kill_on_drop` is the backstop if this is
    /// never called.
    ///
    /// TODO(subtask 2+): insert an intermediate `SIGTERM` before `SIGKILL` to
    /// match the reference's EOF → 2s → SIGTERM → 5s → SIGKILL ladder (needs
    /// `libc::kill` for a real `SIGTERM`; `tokio`'s kill is `SIGKILL`).
    pub async fn shutdown(&mut self) {
        // Drop the writer sender → writer_loop ends → stdin is dropped → EOF.
        self.writer_tx = None;

        // Grace period for a clean exit.
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_ok()
        {
            return; // exited gracefully
        }

        // Still alive after EOF + grace → force kill.
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

/// Read stdout as newline-delimited JSON. Each non-empty line is parsed into a
/// [`CliMessage`]; parse failures are logged and skipped, never fatal (spec
/// §2.1). Ends when the stream closes or the consumer drops the receiver.
async fn reader_loop(stdout: ChildStdout, tx: mpsc::UnboundedSender<CliMessage>) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<CliMessage>(trimmed) {
                    Ok(msg) => {
                        if tx.send(msg).is_err() {
                            break; // consumer gone
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[transport] skipping unparseable stdout line: {e}: {}",
                            truncate(trimmed, 160)
                        );
                    }
                }
            }
            Ok(None) => break,        // EOF: process closed stdout
            Err(e) => {
                eprintln!("[transport] stdout read error: {e}");
                break;
            }
        }
    }
}

/// Drain the outbound queue onto stdin, one full JSON line at a time, flushing
/// after each so the CLI sees complete lines. Stdin stays open until the queue
/// is closed (writer sender dropped), which then signals EOF to the child.
async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<Value>) {
    while let Some(value) = rx.recv().await {
        let mut line = match serde_json::to_string(&value) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[transport] dropping unserializable outbound message: {e}");
                continue;
            }
        };
        line.push('\n');
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            eprintln!("[transport] stdin write failed: {e}");
            break;
        }
        if let Err(e) = stdin.flush().await {
            eprintln!("[transport] stdin flush failed: {e}");
            break;
        }
    }
    // Channel closed → drop stdin here → child receives EOF.
}

/// Forward the child's stderr to our log (debug aid; the protocol never uses it).
async fn stderr_loop(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            eprintln!("[claude stderr] {line}");
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // Respect char boundaries.
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

    #[test]
    fn default_config_uses_path_binary() {
        std::env::remove_var("TOSSE_CLAUDE_BIN");
        let cfg = SpawnConfig::new("/tmp");
        assert_eq!(cfg.claude_bin, PathBuf::from("claude"));
        assert_eq!(cfg.cwd, PathBuf::from("/tmp"));
    }

    /// Live end-to-end transport check. Spawns the real `claude` binary, sends a
    /// no-tool prompt, and asserts we stream an assistant reply and a successful
    /// `result` — all while stdin stays open (persistent mode).
    ///
    /// Ignored by default: needs the `claude` binary, network, auth and a tiny
    /// bit of quota. Run with:
    ///   cargo test -p tosse-code --lib -- --ignored transport_streams_a_real_text_turn --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary (network + auth + quota)"]
    async fn transport_streams_a_real_text_turn() {
        let cwd = std::env::current_dir().unwrap();
        let (mut transport, mut rx) =
            Transport::spawn(SpawnConfig::new(cwd)).expect("claude should spawn");

        transport
            .send_user_text("Reply with exactly the two words: hello world. Do not use any tools.")
            .expect("send should queue");

        let mut saw_init = false;
        let mut saw_assistant_text = false;
        let mut result_ok: Option<bool> = None;

        // Drain until the turn's `result` arrives (session stays alive; result
        // marks end-of-turn, not end-of-session) or we time out.
        let deadline = Duration::from_secs(90);
        let drain = async {
            while let Some(msg) = rx.recv().await {
                match &msg {
                    CliMessage::System(crate::supervisor::protocol::SystemMsg::Init(_)) => {
                        saw_init = true;
                    }
                    CliMessage::Assistant(a) => {
                        let text = a.message.to_string().to_lowercase();
                        if text.contains("hello world") {
                            saw_assistant_text = true;
                        }
                    }
                    CliMessage::Result(r) => {
                        result_ok = Some(!r.is_error);
                        break;
                    }
                    CliMessage::Unknown => panic!("got an Unknown message: {msg:?}"),
                    _ => {}
                }
            }
        };

        tokio::time::timeout(deadline, drain)
            .await
            .expect("turn should complete within the deadline");

        transport.shutdown().await;

        assert!(saw_init, "expected a system/init message");
        assert!(saw_assistant_text, "expected the assistant to stream 'hello world'");
        assert_eq!(result_ok, Some(true), "expected a successful result");
    }
}
