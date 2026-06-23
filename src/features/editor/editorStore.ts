// State for the lightweight editor panel: the panel's layout (open / split
// orientation / sizes — global, persisted) and, per conversation, its file tree
// (lazily expanded), open tabs and file buffers.
//
// Identity: keyed by a conversation's STABLE id (never the live `session-N`
// handle), like every other read path in the app. The tree root is a cwd, which
// can MOVE mid-conversation (the agent enters a worktree) — when it does we reset
// that conversation's tree to the new root.
//
// Conflict policy (agreed with the user): the on-disk file is watched live. If
// the editor buffer is clean, an external write (e.g. the agent edits the file)
// reloads it in place. If the buffer has UNSAVED edits, we never clobber them —
// we keep the user's text and surface a "modified on disk" banner offering to
// reload or keep. Saving is autosave (debounced) plus Cmd+S.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { commands } from "../../ipc/client";
import type { FsEntry } from "../../ipc/client";
import { baseName, dirName, imageMimeForPath, isImagePath, languageForPath } from "./language";

/** Debounce before an edited buffer is autosaved to disk (ms). */
const AUTOSAVE_MS = 1000;

export type SplitOrientation = "row" | "column"; // side-by-side | stacked

export interface FileBuffer {
  path: string;
  name: string;
  language: string;
  /** Current editor text (the edit surface). */
  content: string;
  /** Last text known to be on disk (saved or freshly loaded). dirty = content≠saved. */
  saved: string;
  dirty: boolean;
  loading: boolean;
  /** Non-null when the file couldn't be read (e.g. deleted on disk). */
  error: string | null;
  binary: boolean;
  tooLarge: boolean;
  /** This path is a known image extension: rendered in the ImageViewer, never
   *  Monaco. Set from the path up front (before the bytes load). */
  isImage: boolean;
  /** A ready-to-use `data:<mime>;base64,…` URL for an image buffer (null until
   *  loaded, and always null for non-image buffers). */
  imageDataUrl: string | null;
  /** Image byte size on disk (for the viewer's info line); null until loaded. */
  imageSize: number | null;
  /** Per-tab image view, preserved when switching tabs and back: the zoom
   *  multiplier over "fit" and the pan offset (px). Undefined = the default fit
   *  view (zoom 1, centered). */
  imageZoom?: number;
  imageOffset?: { x: number; y: number };
  /** An external write arrived while the buffer was dirty (banner shown). */
  diskChanged: boolean;
  /** The pending external content for the "reload" action (null otherwise). */
  diskContent: string | null;
  /** Markdown only: show the rendered preview instead of the source. */
  preview: boolean;
}

interface ConvEditor {
  /** The tree root (a cwd). Reset wipes tree state when this moves. */
  root: string;
  /** Loaded directory listings, keyed by absolute dir path (presence = loaded). */
  dirs: Record<string, FsEntry[]>;
  expanded: Record<string, boolean>;
  loadingDirs: Record<string, boolean>;
  /** Read error per directory path (surfaced in the tree; also stops the
   *  auto-load effect from retrying a failing read forever). */
  dirErrors: Record<string, string>;
  /** Open tab paths, in tab order. */
  tabs: string[];
  activeTab: string | null;
  buffers: Record<string, FileBuffer>;
  /**
   * The single "preview" (temporary) tab, à la VS Code: a single-click opens a
   * file here (shown in italics) and the next single-click REPLACES it. A
   * double-click — on the file or the tab — or any edit promotes it to a pinned
   * tab. Null when there is no preview tab.
   */
  previewTab: string | null;
}

interface EditorState {
  // ---- Global layout (persisted) ----
  // The "side region" (right of, or below, the conversation) holds the editor
  // and/or the integrated terminal. `open` = editor shown; `terminalOpen` =
  // terminal shown. `orientation` places the WHOLE side region (row = right,
  // column = below). `editorFraction` is the side region's share of the main
  // area; `terminalFraction` splits the side region between editor and terminal
  // when both are open.
  open: boolean;
  terminalOpen: boolean;
  orientation: SplitOrientation;
  /** Fraction of the main area given to the side region (0..1). */
  editorFraction: number;
  /** Fraction of the side region given to the terminal when both panes are open (0..1). */
  terminalFraction: number;
  /** File-tree column width, px. */
  treeWidth: number;
  /** The file tree is hidden (focus-on-files mode); the editor still shows. */
  treeCollapsed: boolean;

  // ---- Per conversation ----
  byConv: Record<string, ConvEditor>;

  // ---- Layout actions ----
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  setOrientation: (o: SplitOrientation) => void;
  setEditorFraction: (f: number) => void;
  setTerminalFraction: (f: number) => void;
  setTreeWidth: (w: number) => void;
  setTreeCollapsed: (collapsed: boolean) => void;
  toggleTree: () => void;

  // ---- Tree ----
  /** Initialise a conversation's tree at `root`, resetting it if the root moved. */
  ensureConv: (convId: string, root: string) => void;
  toggleDir: (convId: string, path: string) => Promise<void>;

  // ---- Tabs / buffers ----
  /** Open a file. `preview` (single-click) uses the reusable temporary tab;
   *  omitting it / false (double-click) opens a pinned tab. */
  openFile: (convId: string, path: string, opts?: { preview?: boolean }) => Promise<void>;
  /** Promote a path's tab to pinned (no longer the reusable preview tab). */
  pinTab: (convId: string, path: string) => void;
  closeTab: (convId: string, path: string) => void;
  selectTab: (convId: string, path: string) => void;
  setContent: (convId: string, path: string, content: string) => void;
  saveBuffer: (convId: string, path: string) => Promise<void>;
  togglePreview: (convId: string, path: string) => void;
  /** Persist an image tab's zoom/pan so it survives switching away and back. */
  setImageView: (convId: string, path: string, zoom: number, offset: { x: number; y: number }) => void;

  // ---- Live filesystem changes ----
  onExternalChange: (convId: string, paths: string[]) => Promise<void>;
  /** Apply the pending on-disk content over the local buffer ("reload"). */
  reloadFromDisk: (convId: string, path: string) => void;
  /** Dismiss the "modified on disk" banner, keeping local edits. */
  keepLocal: (convId: string, path: string) => void;
}

// ---- Layout persistence (localStorage, mirrors store/notifications.ts) -------

const LS_KEY = "tosse:editor";

interface LayoutPrefs {
  open: boolean;
  terminalOpen: boolean;
  orientation: SplitOrientation;
  editorFraction: number;
  terminalFraction: number;
  treeWidth: number;
  /** The file tree is collapsed (focus-on-files mode) — the editor still shows. */
  treeCollapsed: boolean;
}

const DEFAULT_LAYOUT: LayoutPrefs = {
  open: false,
  terminalOpen: false,
  orientation: "row",
  editorFraction: 0.42,
  terminalFraction: 0.4,
  treeWidth: 220,
  treeCollapsed: false,
};

function loadLayout(): LayoutPrefs {
  if (typeof localStorage === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const p = JSON.parse(raw) as Partial<LayoutPrefs>;
    return {
      open: typeof p.open === "boolean" ? p.open : DEFAULT_LAYOUT.open,
      terminalOpen: typeof p.terminalOpen === "boolean" ? p.terminalOpen : DEFAULT_LAYOUT.terminalOpen,
      orientation: p.orientation === "column" ? "column" : "row",
      editorFraction:
        typeof p.editorFraction === "number" ? clamp(p.editorFraction, 0.15, 0.85) : DEFAULT_LAYOUT.editorFraction,
      terminalFraction:
        typeof p.terminalFraction === "number" ? clamp(p.terminalFraction, 0.15, 0.85) : DEFAULT_LAYOUT.terminalFraction,
      treeWidth: typeof p.treeWidth === "number" ? clamp(p.treeWidth, 120, 600) : DEFAULT_LAYOUT.treeWidth,
      treeCollapsed: typeof p.treeCollapsed === "boolean" ? p.treeCollapsed : DEFAULT_LAYOUT.treeCollapsed,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function saveLayout(s: EditorState): void {
  if (typeof localStorage === "undefined") return;
  const prefs: LayoutPrefs = {
    open: s.open,
    terminalOpen: s.terminalOpen,
    orientation: s.orientation,
    editorFraction: s.editorFraction,
    terminalFraction: s.terminalFraction,
    treeWidth: s.treeWidth,
    treeCollapsed: s.treeCollapsed,
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full / unavailable — layout just won't persist */
  }
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Await an IPC command, turning a thrown transport rejection into a normal error
 * Result. The generated bindings RETHROW genuine `Error`s (only string command
 * errors become error Results), so without this an unexpected failure would
 * reject the action and leave UI stuck (e.g. a tab loading forever). With it,
 * every command error — string or thrown — flows through the caller's
 * `status !== "ok"` branch and is surfaced, never swallowed.
 */
async function safeCmd<T>(
  run: () => Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>,
): Promise<{ status: "ok"; data: T } | { status: "error"; error: string }> {
  try {
    return await run();
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Autosave timers (module-level, not store state) ------------------------

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const timerKey = (convId: string, path: string) => `${convId} ${path}`;

function clearAutosave(convId: string, path: string): void {
  const k = timerKey(convId, path);
  const t = autosaveTimers.get(k);
  if (t) {
    clearTimeout(t);
    autosaveTimers.delete(k);
  }
}

// ---- Immutable update helpers ----------------------------------------------

function emptyConv(root: string): ConvEditor {
  return {
    root,
    dirs: {},
    expanded: {},
    loadingDirs: {},
    dirErrors: {},
    tabs: [],
    activeTab: null,
    buffers: {},
    previewTab: null,
  };
}

function fileBufferFrom(path: string): FileBuffer {
  return {
    path,
    name: baseName(path),
    language: languageForPath(path),
    content: "",
    saved: "",
    dirty: false,
    loading: true,
    error: null,
    binary: false,
    tooLarge: false,
    isImage: isImagePath(path),
    imageDataUrl: null,
    imageSize: null,
    diskChanged: false,
    diskContent: null,
    preview: false,
  };
}

/** Build a `data:` URL the webview can render from base64 image bytes. */
function imageDataUrlFor(path: string, base64: string): string {
  const mime = imageMimeForPath(path) ?? "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

export const useEditorStore = create<EditorState>()((set, get) => {
  const layout = loadLayout();

  /** Replace one conversation's slice and persist nothing (per-conv is in-memory). */
  function patchConv(convId: string, fn: (c: ConvEditor) => ConvEditor): void {
    set((s) => {
      const cur = s.byConv[convId];
      if (!cur) return s;
      return { byConv: { ...s.byConv, [convId]: fn(cur) } };
    });
  }

  /** Replace one buffer within a conversation. */
  function patchBuffer(convId: string, path: string, fn: (b: FileBuffer) => FileBuffer): void {
    patchConv(convId, (c) => {
      const b = c.buffers[path];
      if (!b) return c;
      return { ...c, buffers: { ...c.buffers, [path]: fn(b) } };
    });
  }

  /** Persist layout after any layout mutation. */
  function withLayout(patch: Partial<LayoutPrefs>): void {
    set(patch as Partial<EditorState>);
    saveLayout(get());
  }

  return {
    ...layout,
    byConv: {},

    toggleOpen: () => withLayout({ open: !get().open }),
    setOpen: (open) => withLayout({ open }),
    toggleTerminal: () => withLayout({ terminalOpen: !get().terminalOpen }),
    setTerminalOpen: (terminalOpen) => withLayout({ terminalOpen }),
    setOrientation: (orientation) => withLayout({ orientation }),
    setEditorFraction: (f) => withLayout({ editorFraction: clamp(f, 0.15, 0.85) }),
    setTerminalFraction: (f) => withLayout({ terminalFraction: clamp(f, 0.15, 0.85) }),
    setTreeWidth: (w) => withLayout({ treeWidth: clamp(w, 120, 600) }),
    setTreeCollapsed: (treeCollapsed) => withLayout({ treeCollapsed }),
    toggleTree: () => withLayout({ treeCollapsed: !get().treeCollapsed }),

    ensureConv: (convId, root) => {
      const cur = get().byConv[convId];
      if (cur && cur.root === root) return; // already at this root
      // New conversation, or its cwd moved (worktree): (re)start at the new root.
      // Keep open tabs across a root move only if their files are still in scope?
      // Simpler + predictable: a root move resets the tree but KEEPS open tabs
      // (absolute paths stay valid until the file is gone — the watcher handles
      // deletion). On first init there are no tabs anyway.
      set((s) => {
        const existing = s.byConv[convId];
        const next: ConvEditor = existing
          ? {
              ...emptyConv(root),
              tabs: existing.tabs,
              activeTab: existing.activeTab,
              buffers: existing.buffers,
              previewTab: existing.previewTab,
            }
          : emptyConv(root);
        return { byConv: { ...s.byConv, [convId]: next } };
      });
    },

    toggleDir: async (convId, path) => {
      const conv = get().byConv[convId];
      if (!conv) return;
      const isLoaded = conv.dirs[path] !== undefined;
      if (isLoaded) {
        patchConv(convId, (c) => ({ ...c, expanded: { ...c.expanded, [path]: !c.expanded[path] } }));
        return;
      }
      if (conv.loadingDirs[path]) return;
      // Clear any prior error on (re)try; mark loading.
      patchConv(convId, (c) => {
        const dirErrors = { ...c.dirErrors };
        delete dirErrors[path];
        return { ...c, dirErrors, loadingDirs: { ...c.loadingDirs, [path]: true } };
      });
      const res = await safeCmd(() => commands.readDir(path));
      patchConv(convId, (c) => {
        const loadingDirs = { ...c.loadingDirs };
        delete loadingDirs[path];
        if (res.status !== "ok") {
          // Surface the error in the tree AND record it so the auto-load effect
          // doesn't retry a failing read in a tight loop. Click retries.
          console.error("readDir failed:", res.error);
          return { ...c, loadingDirs, dirErrors: { ...c.dirErrors, [path]: res.error } };
        }
        const dirErrors = { ...c.dirErrors };
        delete dirErrors[path];
        return {
          ...c,
          loadingDirs,
          dirErrors,
          dirs: { ...c.dirs, [path]: res.data },
          expanded: { ...c.expanded, [path]: true },
        };
      });
    },

    openFile: async (convId, path, opts) => {
      const conv = get().byConv[convId];
      if (!conv) return;
      const preview = opts?.preview ?? false;

      // Already open: focus it. A pin request (double-click) on the current
      // preview tab promotes it to a permanent tab.
      if (conv.buffers[path]) {
        if (!preview && conv.previewTab === path) {
          patchConv(convId, (c) => ({ ...c, activeTab: path, previewTab: null }));
        } else {
          get().selectTab(convId, path);
        }
        return;
      }

      // A new file opened in preview mode REUSES the single preview tab's slot
      // (replacing whatever was previewed), so single-clicking through files never
      // piles up tabs. A pinned open just appends.
      const replacing = preview && conv.previewTab && conv.buffers[conv.previewTab] ? conv.previewTab : null;
      if (replacing) clearAutosave(convId, replacing);
      patchConv(convId, (c) => {
        const buffers = { ...c.buffers, [path]: fileBufferFrom(path) };
        let tabs: string[];
        if (replacing) {
          delete buffers[replacing];
          const i = c.tabs.indexOf(replacing);
          tabs = i >= 0 ? [...c.tabs.slice(0, i), path, ...c.tabs.slice(i + 1)] : [...c.tabs, path];
        } else {
          tabs = [...c.tabs, path];
        }
        return { ...c, tabs, activeTab: path, buffers, previewTab: preview ? path : c.previewTab };
      });
      // Images take a separate path: read the raw bytes (base64) and render them
      // in the ImageViewer, never decoding as text / loading Monaco.
      if (isImagePath(path)) {
        const res = await safeCmd(() => commands.readImage(path));
        patchBuffer(convId, path, (b) => {
          if (res.status !== "ok") {
            return { ...b, loading: false, error: res.error };
          }
          const img = res.data;
          return {
            ...b,
            loading: false,
            tooLarge: img.too_large,
            imageSize: img.size,
            imageDataUrl: img.too_large ? null : imageDataUrlFor(path, img.data_base64),
          };
        });
        return;
      }

      const res = await safeCmd(() => commands.readFile(path));
      patchBuffer(convId, path, (b) => {
        if (res.status !== "ok") {
          return { ...b, loading: false, error: res.error };
        }
        const f = res.data;
        return {
          ...b,
          loading: false,
          content: f.content,
          saved: f.content,
          dirty: false,
          binary: f.binary,
          tooLarge: f.too_large,
          // Markdown opens in rendered preview by default (read-first); the
          // toggle flips to source for editing.
          preview: !f.binary && !f.too_large && b.language === "markdown",
        };
      });
    },

    pinTab: (convId, path) =>
      patchConv(convId, (c) => (c.previewTab === path ? { ...c, previewTab: null } : c)),

    closeTab: (convId, path) => {
      clearAutosave(convId, path);
      patchConv(convId, (c) => {
        if (!c.buffers[path]) return c;
        const tabs = c.tabs.filter((p) => p !== path);
        const buffers = { ...c.buffers };
        delete buffers[path];
        let activeTab = c.activeTab;
        if (activeTab === path) {
          const idx = c.tabs.indexOf(path);
          activeTab = tabs[idx] ?? tabs[idx - 1] ?? tabs[tabs.length - 1] ?? null;
        }
        return { ...c, tabs, buffers, activeTab, previewTab: c.previewTab === path ? null : c.previewTab };
      });
    },

    selectTab: (convId, path) => patchConv(convId, (c) => ({ ...c, activeTab: path })),

    setContent: (convId, path, content) => {
      patchBuffer(convId, path, (b) => {
        if (b.content === content) return b;
        return { ...b, content, dirty: content !== b.saved };
      });
      // Editing a preview tab pins it (à la VS Code) — your edits get a real tab.
      if (get().byConv[convId]?.previewTab === path) get().pinTab(convId, path);
      // Debounced autosave — only schedule when there's something to persist.
      const b = get().byConv[convId]?.buffers[path];
      if (b && b.dirty && !b.binary && !b.tooLarge) {
        clearAutosave(convId, path);
        autosaveTimers.set(
          timerKey(convId, path),
          setTimeout(() => {
            autosaveTimers.delete(timerKey(convId, path));
            void get().saveBuffer(convId, path);
          }, AUTOSAVE_MS),
        );
      }
    },

    saveBuffer: async (convId, path) => {
      clearAutosave(convId, path);
      const b = get().byConv[convId]?.buffers[path];
      if (!b || !b.dirty || b.binary || b.tooLarge) return;
      const content = b.content;
      const res = await safeCmd(() => commands.writeFile(path, content));
      if (res.status !== "ok") {
        console.error("writeFile failed:", res.error);
        patchBuffer(convId, path, (bb) => ({ ...bb, error: `Échec de la sauvegarde : ${res.error}` }));
        return;
      }
      // Mark clean against exactly what we wrote (the buffer may have changed again
      // while the write was in flight → it stays dirty and reschedules).
      patchBuffer(convId, path, (bb) => ({
        ...bb,
        saved: content,
        dirty: bb.content !== content,
        error: null,
        // Our own write will echo back via the watcher; clear any stale flag.
        diskChanged: false,
        diskContent: null,
      }));
    },

    togglePreview: (convId, path) => patchBuffer(convId, path, (b) => ({ ...b, preview: !b.preview })),

    setImageView: (convId, path, zoom, offset) =>
      patchBuffer(convId, path, (b) => ({ ...b, imageZoom: zoom, imageOffset: offset })),

    onExternalChange: async (convId, paths) => {
      const conv = get().byConv[convId];
      if (!conv) return;
      const changed = new Set(paths);

      // 1) Refresh any loaded (expanded) directory that a change touched, so new /
      //    deleted files appear in the tree. We re-read the parent dir of each
      //    changed path that we've loaded, plus the root.
      const dirsToRefresh = new Set<string>();
      for (const p of paths) {
        const parent = dirName(p);
        if (conv.dirs[parent] !== undefined) dirsToRefresh.add(parent);
      }
      for (const dir of dirsToRefresh) {
        const res = await safeCmd(() => commands.readDir(dir));
        if (res.status === "ok") {
          patchConv(convId, (c) =>
            c.dirs[dir] !== undefined ? { ...c, dirs: { ...c.dirs, [dir]: res.data } } : c,
          );
        } else {
          console.error("readDir (live refresh) failed:", res.error);
        }
      }

      // 2) Reload any OPEN file that changed, applying the conflict policy.
      for (const path of conv.tabs) {
        if (!changed.has(path)) continue;
        // Images are never editable (no dirty state) → always live-reload the
        // bytes. A fresh data URL forces the <img> to repaint the new content.
        if (conv.buffers[path]?.isImage) {
          const res = await safeCmd(() => commands.readImage(path));
          if (res.status !== "ok") {
            patchBuffer(convId, path, (b) => ({ ...b, error: "Image indisponible sur le disque." }));
            continue;
          }
          const img = res.data;
          patchBuffer(convId, path, (b) => ({
            ...b,
            error: null,
            tooLarge: img.too_large,
            imageSize: img.size,
            imageDataUrl: img.too_large ? null : imageDataUrlFor(path, img.data_base64),
          }));
          continue;
        }
        const res = await safeCmd(() => commands.readFile(path));
        if (res.status !== "ok") {
          // The file likely vanished — flag it but keep the tab/content.
          patchBuffer(convId, path, (b) => ({ ...b, error: "Fichier indisponible sur le disque." }));
          continue;
        }
        const f = res.data;
        patchBuffer(convId, path, (b) => {
          // No real change vs what we already have on disk → ignore (this also
          // absorbs the echo of our own save).
          if (f.content === b.saved) return { ...b, diskChanged: false, diskContent: null };
          if (b.binary || f.binary || f.too_large) {
            return { ...b, binary: f.binary, tooLarge: f.too_large, saved: f.content, content: f.content };
          }
          if (b.dirty) {
            // Unsaved local edits: never clobber. Surface the on-disk version.
            return { ...b, diskChanged: true, diskContent: f.content };
          }
          // Clean buffer: live-reload in place.
          return { ...b, content: f.content, saved: f.content, dirty: false, error: null };
        });
      }
    },

    reloadFromDisk: (convId, path) =>
      patchBuffer(convId, path, (b) => {
        if (b.diskContent === null) return b;
        return { ...b, content: b.diskContent, saved: b.diskContent, dirty: false, diskChanged: false, diskContent: null };
      }),

    keepLocal: (convId, path) =>
      patchBuffer(convId, path, (b) => ({ ...b, diskChanged: false, diskContent: null })),
  };
});

// ---- Selectors --------------------------------------------------------------

export const useEditorOpen = () => useEditorStore((s) => s.open);
export const useEditorLayout = () =>
  useEditorStore(
    useShallow((s) => ({
      open: s.open,
      terminalOpen: s.terminalOpen,
      orientation: s.orientation,
      editorFraction: s.editorFraction,
      terminalFraction: s.terminalFraction,
      treeWidth: s.treeWidth,
    })),
  );

/** A conversation's editor slice (tree + tabs + buffers), or undefined. */
export const useConvEditor = (convId: string | null) =>
  useEditorStore((s) => (convId ? s.byConv[convId] : undefined));
