// Exercises the editor store's buffer lifecycle and — crucially — the live/edit
// conflict policy. Runs against the browser IPC mock (jsdom → not Tauri), whose
// readFile returns deterministic synthetic content, so "external change" is real.

import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore, type FileBuffer } from "./editorStore";

const CONV = "conv-1";
const ROOT = "/repo";
const FILE = "/repo/a.txt";

function buffer(path = FILE): FileBuffer {
  const b = useEditorStore.getState().byConv[CONV]?.buffers[path];
  if (!b) throw new Error("buffer not found");
  return b;
}

/** Force buffer fields (simulating prior edits / a stale saved baseline). */
function patch(path: string, fields: Partial<FileBuffer>) {
  useEditorStore.setState((st) => {
    const c = st.byConv[CONV];
    return {
      byConv: {
        ...st.byConv,
        [CONV]: { ...c, buffers: { ...c.buffers, [path]: { ...c.buffers[path], ...fields } } },
      },
    };
  });
}

beforeEach(() => {
  useEditorStore.setState({ byConv: {} });
});

describe("buffer lifecycle", () => {
  it("opens a file as a clean buffer (content == saved)", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    const b = buffer();
    expect(b.loading).toBe(false);
    expect(b.dirty).toBe(false);
    expect(b.content).toBe(b.saved);
    expect(b.content.length).toBeGreaterThan(0);
  });

  it("marks the buffer dirty on edit and clean again when reverted", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    const saved = buffer().saved;

    s.setContent(CONV, FILE, "changed");
    expect(buffer().dirty).toBe(true);

    s.setContent(CONV, FILE, saved);
    expect(buffer().dirty).toBe(false);
  });

  it("opens markdown in preview by default", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/README.md");
    expect(buffer("/repo/README.md").preview).toBe(true);
  });
});

describe("conflict policy on external change", () => {
  it("live-reloads a CLEAN buffer in place", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    // Stale clean baseline that differs from what's on disk.
    patch(FILE, { content: "OLD", saved: "OLD", dirty: false });

    await s.onExternalChange(CONV, [FILE]);

    const b = buffer();
    expect(b.dirty).toBe(false);
    expect(b.diskChanged).toBe(false);
    expect(b.content).not.toBe("OLD"); // reloaded from disk
    expect(b.content).toBe(b.saved);
  });

  it("PROTECTS a dirty buffer: keeps local edits + flags diskChanged", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    patch(FILE, { content: "LOCAL", saved: "OLD", dirty: true });

    await s.onExternalChange(CONV, [FILE]);

    const b = buffer();
    expect(b.content).toBe("LOCAL"); // untouched
    expect(b.dirty).toBe(true);
    expect(b.diskChanged).toBe(true);
    expect(b.diskContent).not.toBeNull();
  });

  it("reloadFromDisk applies the pending disk content and clears the flag", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    patch(FILE, { content: "LOCAL", saved: "OLD", dirty: true });
    await s.onExternalChange(CONV, [FILE]);
    const disk = buffer().diskContent!;

    s.reloadFromDisk(CONV, FILE);

    const b = buffer();
    expect(b.content).toBe(disk);
    expect(b.saved).toBe(disk);
    expect(b.dirty).toBe(false);
    expect(b.diskChanged).toBe(false);
    expect(b.diskContent).toBeNull();
  });
});

describe("preview (temporary) tabs", () => {
  const conv = () => useEditorStore.getState().byConv[CONV];

  it("single-click opens a reusable preview tab that the next single-click replaces", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt", { preview: true });
    expect(conv().tabs).toEqual(["/repo/a.txt"]);
    expect(conv().previewTab).toBe("/repo/a.txt");

    await s.openFile(CONV, "/repo/b.txt", { preview: true });
    expect(conv().tabs).toEqual(["/repo/b.txt"]); // replaced in place, not piled up
    expect(conv().previewTab).toBe("/repo/b.txt");
  });

  it("double-click pins (appends) and leaves an existing preview alone", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt", { preview: true }); // preview a
    await s.openFile(CONV, "/repo/b.txt", { preview: false }); // pin b → new tab
    expect(conv().tabs).toEqual(["/repo/a.txt", "/repo/b.txt"]);
    expect(conv().previewTab).toBe("/repo/a.txt");

    // A new preview replaces the preview slot (a), not the pinned tab (b).
    await s.openFile(CONV, "/repo/c.txt", { preview: true });
    expect(conv().tabs).toEqual(["/repo/c.txt", "/repo/b.txt"]);
    expect(conv().previewTab).toBe("/repo/c.txt");
  });

  it("pinning the current preview tab keeps it but clears the preview slot", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt", { preview: true });
    await s.openFile(CONV, "/repo/a.txt", { preview: false }); // double-click same file
    expect(conv().tabs).toEqual(["/repo/a.txt"]);
    expect(conv().previewTab).toBeNull();
  });

  it("editing a preview tab pins it", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt", { preview: true });
    s.setContent(CONV, "/repo/a.txt", "edited");
    expect(conv().previewTab).toBeNull();
    expect(conv().buffers["/repo/a.txt"].dirty).toBe(true);
  });
});

describe("error surfacing (no silent failures)", () => {
  const conv = () => useEditorStore.getState().byConv[CONV];

  it("surfaces a directory read error and does not get stuck loading", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.toggleDir(CONV, "/repo/__fail__");
    expect(conv().dirErrors["/repo/__fail__"]).toBeTruthy();
    expect(conv().dirs["/repo/__fail__"]).toBeUndefined();
    expect(conv().loadingDirs["/repo/__fail__"]).toBeFalsy();
  });

  it("catches a THROWN directory read (safeCmd) and surfaces it as an error", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    // Without safeCmd this would reject and leave the dir stuck loading forever.
    await s.toggleDir(CONV, "/repo/__throw__");
    expect(conv().dirErrors["/repo/__throw__"]).toBeTruthy();
    expect(conv().loadingDirs["/repo/__throw__"]).toBeFalsy();
  });

  it("a failed file read marks buffer.error instead of staying stuck loading", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/__fail__.txt", { preview: false });
    const b = conv().buffers["/repo/__fail__.txt"];
    expect(b.loading).toBe(false);
    expect(b.error).toBeTruthy();
  });

  it("a THROWN file read is caught (safeCmd) and surfaced on the buffer", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/__throw__.txt", { preview: false });
    const b = conv().buffers["/repo/__throw__.txt"];
    expect(b.loading).toBe(false);
    expect(b.error).toBeTruthy();
  });
});

describe("tabs", () => {
  it("closing the active tab falls back to a neighbour", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt");
    await s.openFile(CONV, "/repo/b.txt");
    expect(useEditorStore.getState().byConv[CONV].activeTab).toBe("/repo/b.txt");

    s.closeTab(CONV, "/repo/b.txt");
    const c = useEditorStore.getState().byConv[CONV];
    expect(c.tabs).toEqual(["/repo/a.txt"]);
    expect(c.activeTab).toBe("/repo/a.txt");
  });
});
