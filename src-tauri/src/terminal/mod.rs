// The single service that speaks a PTY for the integrated terminal panel. Same
// encapsulation pattern as `fs/mod.rs` (filesystem), `git/mod.rs` (the `git`
// binary) and `store/db.rs` (SQL): the rest of the core and the IPC layer go
// through `Terminals` and never touch `portable-pty` directly, so the backend
// stays swappable.
//
// One live shell per terminal id (the front keys it by conversation id). Opening
// spawns the user's login+interactive shell under a real PTY so PATH, aliases and
// the prompt match a normal terminal; output is pumped to the webview as a
// `TerminalOutputEvent` (base64 — lossless, xterm reassembles UTF-8 across reads),
// and the shell exiting fires a one-shot `TerminalExitEvent`. Keystrokes / paste
// come back in via `write`, and the front reports its measured grid via `resize`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri_specta::Event;

use crate::ipc::events::{TerminalExitEvent, TerminalOutputEvent};

/// PTY read chunk. A terminal is interactive, so reads are small and frequent;
/// 8 KiB comfortably absorbs a burst (e.g. `cat` of a file) in few iterations.
const READ_BUF: usize = 8192;

/// One live terminal: the master side (for resize), the writer (keystrokes) and
/// the child shell (for kill). The reader half lives in a dedicated thread.
struct TermHandle {
    master: Box<dyn MasterPty + Send>,
    /// The writer has its OWN lock so a (blocking) keystroke/paste write never holds
    /// the registry lock: a PTY write blocks when the child stops draining stdin
    /// (a paused TUI, a huge paste into a non-reading program). Keeping it out of
    /// the registry lock means one wedged terminal can't freeze every other terminal
    /// op (resize/open/close/kill_all) nor hang app quit.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    /// The shell's pid. portable-pty puts the shell in its own session/process group
    /// (setsid), so this is also the process-group id — used to signal the WHOLE
    /// group at teardown so anything it backgrounded (`npm run dev &`) dies too.
    pid: Option<u32>,
}

/// Kill a terminal's shell AND its process group, then reap the leader. The shell
/// is a process-group leader (portable-pty calls setsid), so signalling the group
/// (`-pid`) also takes down whatever it backgrounded — the same no-orphan guarantee
/// the session supervisor gives `claude`. Killing the child releases the slave, so
/// the reader thread then reads EOF and ends on its own.
fn terminate(h: &mut TermHandle) {
    // SIGHUP the whole group (a clean hang-up, like closing a terminal window) so a
    // backgrounded grandchild gets it too...
    #[cfg(unix)]
    if let Some(pid) = h.pid {
        unsafe { libc::kill(-(pid as i32), libc::SIGHUP) };
    }
    // ...ask the child to die (child.kill = SIGHUP + bounded grace + SIGKILL fallback)...
    let _ = h.child.kill();
    // ...then SIGKILL any group member still alive.
    #[cfg(unix)]
    if let Some(pid) = h.pid {
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
    reap(h);
}

/// Fast teardown for app quit: SIGKILL the whole group at once and reap the leader,
/// WITHOUT the polite SIGHUP grace `terminate` gives — a clean hang-up is pointless
/// when the app is exiting, and the per-shell grace poll (~200ms each) would stack up
/// serially across N terminals and stall quit. Grandchildren get the group SIGKILL too.
fn terminate_fast(h: &mut TermHandle) {
    #[cfg(unix)]
    {
        if let Some(pid) = h.pid {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        } else {
            let _ = h.child.kill();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = h.child.kill();
    }
    reap(h);
}

/// Reap the leader so it can't linger as a zombie. The shell has just been SIGKILL'd
/// (directly, or via `child.kill`'s fallback) — SIGKILL can't be caught or ignored, so
/// the child is dead or imminently so and this wait returns promptly. Without it, a
/// shell that trapped/ignored SIGHUP and outran the grace window would be killed but
/// never `wait`ed (std/portable-pty don't reap on drop), leaking a zombie until quit.
fn reap(h: &mut TermHandle) {
    let _ = h.child.wait();
}

/// The app's live integrated terminals, keyed by id. Held as Tauri managed state.
#[derive(Default)]
pub struct Terminals {
    inner: Mutex<HashMap<String, TermHandle>>,
}

impl Terminals {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open (or replace) terminal `id`: spawn the user's shell under a fresh PTY
    /// rooted at `cwd`, sized `cols`×`rows`, and start pumping its output to the
    /// webview. Replacing first kills the old shell.
    pub fn open(
        &self,
        app: tauri::AppHandle,
        id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        // Idempotent-replace: a re-open of the same id starts a clean shell.
        self.close(&id);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        // Login shell: sources the user's profile/rc (PATH, aliases, prompt) so the
        // integrated terminal behaves like Terminal.app. It is interactive anyway
        // because stdin is a tty. The app's PATH is already repaired at boot
        // (see lib.rs), and CommandBuilder inherits our env on top of that.
        cmd.arg("-l");
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // The shell's pid is its process-group id (portable-pty calls setsid), kept
        // so teardown can signal the whole group, not just the shell.
        let pid = child.process_id();
        // Drop the slave: with it still open the master would never see EOF when
        // the shell exits, so the reader thread could not detect the exit.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| e.to_string())?,
        ));

        // Reader thread: PTY bytes → base64 → `TerminalOutputEvent`. On EOF (shell
        // exited) or any read error, emit a single `TerminalExitEvent` and stop.
        // A blocking dedicated thread (not tokio) mirrors `fs::FsWatcher`'s
        // debounce thread — `portable-pty` readers are synchronous.
        let app_for_reader = app.clone();
        let id_for_reader = id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data =
                            base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let ev = TerminalOutputEvent {
                            id: id_for_reader.clone(),
                            data,
                        };
                        if ev.emit(&app_for_reader).is_err() {
                            break; // window gone — stop pumping
                        }
                    }
                }
            }
            let _ = TerminalExitEvent {
                id: id_for_reader,
            }
            .emit(&app_for_reader);
        });

        self.inner.lock().unwrap().insert(
            id,
            TermHandle {
                master: pair.master,
                writer,
                child,
                pid,
            },
        );
        Ok(())
    }

    /// Send keystrokes / pasted text to a terminal (raw UTF-8 bytes into the PTY).
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        // Take only the writer Arc under the registry lock, then RELEASE the lock
        // before the (possibly blocking) write — so a stuck write never holds up any
        // other terminal op (resize/open/close/kill_all). See `TermHandle::writer`.
        let writer = {
            let guard = self.inner.lock().unwrap();
            guard.get(id).ok_or("terminal not found")?.writer.clone()
        };
        let mut w = writer.lock().unwrap();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    /// Tell the PTY its new grid size (the front fits xterm to the panel and
    /// reports the measured cols/rows; the kernel then signals SIGWINCH).
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self.inner.lock().unwrap();
        let h = guard.get(id).ok_or("terminal not found")?;
        h.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Kill a terminal's shell (and its process group) and forget it. Killing the
    /// child releases the slave, so the reader thread then reads EOF and ends.
    pub fn close(&self, id: &str) {
        // Remove under the lock, terminate OUTSIDE it (the kill has a bounded grace).
        let handle = self.inner.lock().unwrap().remove(id);
        if let Some(mut h) = handle {
            terminate(&mut h);
        }
    }

    /// Kill every live terminal (app teardown — never orphan a shell). Drains the
    /// registry under the lock, then terminates outside it so the per-shell kill
    /// can't hold the lock (nor wedge quit) — paired with the lock-free `write`, no
    /// stuck terminal can stall shutdown. Uses the fast (SIGKILL-now, no SIGHUP grace)
    /// path so quit isn't delayed by the serial per-shell grace polls.
    pub fn kill_all(&self) {
        let handles: Vec<TermHandle> = {
            let mut guard = self.inner.lock().unwrap();
            guard.drain().map(|(_, h)| h).collect()
        };
        for mut h in handles {
            terminate_fast(&mut h);
        }
    }
}
