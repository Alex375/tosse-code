// The single service that speaks the local filesystem for the lightweight editor
// panel: listing a directory, reading a file, writing a file, and watching a
// working tree for live changes. Same encapsulation pattern as `store/db.rs`
// (SQL) and `git/mod.rs` (the `git` binary): the rest of the core and the IPC
// layer go through here and never touch `std::fs` for editor concerns, so the
// implementation stays swappable.
//
// The watcher is deliberately lean (perf is a core requirement): a single active
// watch on the conversation's current working directory, recursive (cheap on
// macOS FSEvents), with noisy build/VCS directories filtered out and events
// coalesced over a short debounce window before they reach the UI as one
// `FsChangeEvent`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::ipc::events::FsChangeEvent;

/// Files larger than this are not read into the editor (returned as `too_large`).
/// The cap is about COST, not binariness: `read_file` loads the whole file into
/// memory, `from_utf8_lossy` decodes a second copy, the IPC layer serialises a
/// third (JSON), the webview deserialises a fourth, and Monaco then builds a model
/// from it. Tens of MiB through that pipeline stalls the webview for seconds —
/// against the core "stay responsive" requirement. 16 MiB comfortably opens real
/// source, lockfiles and generated files while still refusing a pathological dump
/// (a multi-hundred-MB log) that would freeze the UI.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// How long the watcher batches incoming change events before emitting them as a
/// single coalesced `FsChangeEvent`. A burst (e.g. `git checkout`, a formatter)
/// thus produces one UI refresh instead of dozens.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Directory names whose contents are noise for an editor watcher: VCS internals
/// and build output. A change anywhere under one of these is dropped, so a busy
/// `node_modules` or `.git` never floods the UI.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
];

/// One immediate child of a listed directory. The tree expands lazily (a click
/// reads exactly one level), so a huge repo never reads more than what is shown.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// A file's contents plus the guards the editor needs: `too_large` (skipped, over
/// [`MAX_FILE_BYTES`]) and `binary` (a NUL byte was found — not shown as text).
/// In both guard cases `content` is empty.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub too_large: bool,
    pub binary: bool,
    pub size: u64,
}

/// List one directory level, directories first then files, case-insensitive
/// alphabetical. Symlinks resolve to their target's kind so a symlinked directory
/// still expands. Hidden entries are kept (the tree is honest); only the *watcher*
/// filters noise.
pub fn read_dir(path: &str) -> std::io::Result<Vec<FsEntry>> {
    let mut entries: Vec<FsEntry> = Vec::new();
    for dent in fs::read_dir(path)? {
        let dent = dent?;
        let ft = dent.file_type()?;
        let is_dir = if ft.is_symlink() {
            // Resolve the link so a symlinked dir is treated as a dir.
            fs::metadata(dent.path()).map(|m| m.is_dir()).unwrap_or(false)
        } else {
            ft.is_dir()
        };
        entries.push(FsEntry {
            name: dent.file_name().to_string_lossy().into_owned(),
            path: dent.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        // `true` sorts after `false`, so compare dir flags reversed to put dirs first.
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Read a file for the editor, guarding size and binariness. A file over
/// [`MAX_FILE_BYTES`] returns `too_large`; one with a NUL byte in its first 8 KiB
/// returns `binary`; otherwise its bytes are decoded UTF-8 (lossily, so an odd
/// byte never fails the read). `content` is empty in both guard cases.
pub fn read_file(path: &str) -> std::io::Result<FileContent> {
    let size = fs::metadata(path)?.len();
    if size > MAX_FILE_BYTES {
        return Ok(FileContent {
            path: path.to_string(),
            content: String::new(),
            too_large: true,
            binary: false,
            size,
        });
    }
    let bytes = fs::read(path)?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Ok(FileContent {
            path: path.to_string(),
            content: String::new(),
            too_large: false,
            binary: true,
            size,
        });
    }
    Ok(FileContent {
        path: path.to_string(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        too_large: false,
        binary: false,
        size,
    })
}

/// An image file's bytes, base64-encoded for the webview to render as a `data:`
/// URL. Unlike [`read_file`], the binary content IS the payload here — images are
/// never decoded as text. `too_large` (over [`MAX_FILE_BYTES`]) leaves
/// `data_base64` empty; the front shows a guard instead of the image.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ImageContent {
    pub path: String,
    /// Base64 of the raw file bytes, NO `data:` prefix (the front prepends the
    /// `data:<mime>;base64,` header, choosing the MIME from the extension).
    pub data_base64: String,
    pub too_large: bool,
    pub size: u64,
}

/// Read an image file for the viewer, base64-encoding its bytes. Same size guard
/// as [`read_file`] (a multi-hundred-MB file would bloat ~33% more as base64 and
/// stall the webview) — over [`MAX_FILE_BYTES`] returns `too_large` with empty
/// data. No binariness check: the caller already routed here BECAUSE the path is a
/// known image extension, and the bytes are meant to be binary.
pub fn read_image(path: &str) -> std::io::Result<ImageContent> {
    use base64::Engine;
    let size = fs::metadata(path)?.len();
    if size > MAX_FILE_BYTES {
        return Ok(ImageContent {
            path: path.to_string(),
            data_base64: String::new(),
            too_large: true,
            size,
        });
    }
    let bytes = fs::read(path)?;
    Ok(ImageContent {
        path: path.to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        too_large: false,
        size,
    })
}

/// Write the editor buffer back to disk (overwriting). The parent directory must
/// already exist (we never create files outside the tree the user is editing).
pub fn write_file(path: &str, content: &str) -> std::io::Result<()> {
    fs::write(path, content)
}

/// Whether any path segment is an ignored build/VCS directory.
fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| match c {
        std::path::Component::Normal(os) => os
            .to_str()
            .map(|s| IGNORED_DIRS.contains(&s))
            .unwrap_or(false),
        _ => false,
    })
}

/// The app's single active filesystem watch. `watch` replaces whatever was being
/// watched (we only ever watch the conversation currently shown in the editor);
/// `unwatch` stops it. Held as Tauri managed state.
#[derive(Default)]
pub struct FsWatcher {
    inner: Mutex<Option<ActiveWatch>>,
}

struct ActiveWatch {
    // Dropped on replace/unwatch, which stops the OS watch and closes the channel,
    // letting the debounce thread exit.
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

impl FsWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start (or replace) the watch on `root`, emitting a coalesced `FsChangeEvent`
    /// to the webview whenever non-ignored paths under it change.
    pub fn watch(&self, app: tauri::AppHandle, root: PathBuf) -> notify::Result<()> {
        self.unwatch(); // at most one active watch
        let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            match res {
                Ok(event) => {
                    for p in event.paths {
                        if !is_ignored(&p) {
                            // The receiver is only gone once the watch is being torn
                            // down; ignore the send error in that race.
                            let _ = tx.send(p);
                        }
                    }
                }
                // A watcher backend error is rare but must not vanish silently.
                Err(e) => eprintln!("[fs watcher] event error: {e}"),
            }
        })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        std::thread::spawn(move || debounce_loop(rx, app, stop_thread));
        *self.inner.lock().unwrap() = Some(ActiveWatch {
            _watcher: watcher,
            stop,
        });
        Ok(())
    }

    /// Stop the active watch, if any.
    pub fn unwatch(&self) {
        if let Some(active) = self.inner.lock().unwrap().take() {
            active.stop.store(true, Ordering::SeqCst);
            // Dropping `active` drops the watcher → closes the channel → the
            // debounce thread sees `Disconnected` and exits.
        }
    }
}

/// Collect change paths and flush them as one `FsChangeEvent` per quiet window.
/// Exits when the channel closes (watch torn down) or the stop flag is set.
fn debounce_loop(rx: Receiver<PathBuf>, app: tauri::AppHandle, stop: Arc<AtomicBool>) {
    use std::collections::HashSet;
    loop {
        // Block until the first change of a new burst (or the channel closes).
        let first = match rx.recv() {
            Ok(p) => p,
            Err(_) => return,
        };
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let mut batch: HashSet<PathBuf> = HashSet::new();
        batch.insert(first);
        // Keep draining while changes keep arriving within the debounce window.
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(p) => {
                    batch.insert(p);
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    emit_batch(&app, batch);
                    return;
                }
            }
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        emit_batch(&app, batch);
    }
}

fn emit_batch(app: &tauri::AppHandle, batch: std::collections::HashSet<PathBuf>) {
    if batch.is_empty() {
        return;
    }
    let paths: Vec<String> = batch
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let _ = FsChangeEvent { paths }.emit(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A fresh, empty temp directory unique to this test run.
    fn fresh_dir() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let mut d = std::env::temp_dir();
        d.push(format!("tosse-fs-test-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn read_dir_lists_dirs_first_then_alpha() {
        let d = fresh_dir();
        fs::create_dir(d.join("zsub")).unwrap();
        fs::write(d.join("B.txt"), "b").unwrap();
        fs::write(d.join("a.txt"), "a").unwrap();
        let entries = read_dir(d.to_str().unwrap()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zsub", "a.txt", "B.txt"]);
        assert!(entries[0].is_dir);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn read_file_roundtrips_text_and_flags_binary() {
        let d = fresh_dir();
        let f = d.join("hello.txt");
        write_file(f.to_str().unwrap(), "héllo").unwrap();
        let got = read_file(f.to_str().unwrap()).unwrap();
        assert_eq!(got.content, "héllo");
        assert!(!got.binary && !got.too_large);

        let bin = d.join("blob.bin");
        fs::write(&bin, [0u8, 1, 2, 3]).unwrap();
        let got = read_file(bin.to_str().unwrap()).unwrap();
        assert!(got.binary);
        assert!(got.content.is_empty());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn read_image_base64_encodes_bytes() {
        use base64::Engine;
        let d = fresh_dir();
        // A tiny "image" — read_image doesn't care about real format, just bytes.
        let img = d.join("pixel.png");
        let bytes = [0x89u8, b'P', b'N', b'G', 0, 1, 2, 3];
        fs::write(&img, bytes).unwrap();
        let got = read_image(img.to_str().unwrap()).unwrap();
        assert!(!got.too_large);
        assert_eq!(got.size, bytes.len() as u64);
        assert_eq!(
            got.data_base64,
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn ignored_dirs_are_filtered() {
        assert!(is_ignored(Path::new("/repo/node_modules/x/y.js")));
        assert!(is_ignored(Path::new("/repo/.git/HEAD")));
        assert!(!is_ignored(Path::new("/repo/src/main.rs")));
    }
}
