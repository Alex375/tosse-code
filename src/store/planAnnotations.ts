// User annotations on a proposed plan (ExitPlanMode) — a highlighted span of the rendered
// plan text plus a comment, PLUS a per-plan general note, keyed by conversation id → tool_use
// id. Persisted to localStorage with the same lightweight pattern as workFold.ts / display.ts
// (pure UI state, kept out of the SQLite core — no schema migration).
//
// Why a store and not local component state: the conversation pane is remounted per
// conversation (`key={conv.id}`), so an annotation or note typed in a <PlanCard> would reset
// on a switch-away-and-back. A global store survives that remount; localStorage additionally
// carries it across app restarts, so a plan you reviewed keeps its notes.
//
// Offsets are character indices into the plan card's RENDERED text (`.md-body` textContent),
// which is stable because the plan markdown is immutable — so a stored [start,end) re-derives
// the same DOM range on every render (see PlanCard's highlight rebuild). `quote` is the
// captured text: it feeds the "reject & revise" feedback message and is a readable fallback.
//
// Deleting a conversation is UNDOABLE (⌘Z), so removal SNAPSHOTS a conversation's annotations
// + notes and the undo re-seeds them — this is deliberate user content, unlike the transient
// UI caches cleared the same way (see conversationsStore removeConversation/undo).
import { create } from "zustand";

const ANN_KEY = "tosse:planannotations";
const NOTE_KEY = "tosse:plannotes";

export interface PlanAnnotation {
  id: string;
  /** Character offset (inclusive) into the rendered plan text. */
  start: number;
  /** Character offset (exclusive) into the rendered plan text. */
  end: number;
  /** The highlighted text — for the feedback message + a readable fallback. */
  quote: string;
  /** The user's note on that span. */
  comment: string;
}

// convId → toolUseId → annotations. Absent = none, so we only store what the user created.
type AnnMap = Record<string, Record<string, PlanAnnotation[]>>;
// convId → toolUseId → general note text.
type NoteMap = Record<string, Record<string, string>>;

/** A conversation's plan state, captured for undo. */
export interface PlanConvSnapshot {
  ann: Record<string, PlanAnnotation[]>;
  notes: Record<string, string>;
}

function load<T>(key: string): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {} as T;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

function save(key: string, map: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

/** A unique enough id for a local annotation (no collisions within one plan in practice). */
export function newAnnotationId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const EMPTY: PlanAnnotation[] = [];

interface PlanAnnotationsState {
  byConv: AnnMap;
  notes: NoteMap;
  add: (conv: string, toolUseId: string, ann: PlanAnnotation) => void;
  remove: (conv: string, toolUseId: string, id: string) => void;
  setNote: (conv: string, toolUseId: string, note: string) => void;
  clearConversation: (conv: string) => void;
  clearAll: () => void;
}

function withList(
  map: AnnMap,
  conv: string,
  toolUseId: string,
  next: PlanAnnotation[],
): AnnMap {
  const convMap = { ...(map[conv] ?? {}) };
  if (next.length === 0) delete convMap[toolUseId];
  else convMap[toolUseId] = next;
  const out = { ...map };
  if (Object.keys(convMap).length === 0) delete out[conv];
  else out[conv] = convMap;
  return out;
}

function withNote(map: NoteMap, conv: string, toolUseId: string, note: string): NoteMap {
  const convMap = { ...(map[conv] ?? {}) };
  if (note === "") delete convMap[toolUseId];
  else convMap[toolUseId] = note;
  const out = { ...map };
  if (Object.keys(convMap).length === 0) delete out[conv];
  else out[conv] = convMap;
  return out;
}

export const usePlanAnnotationsStore = create<PlanAnnotationsState>((set) => ({
  byConv: load<AnnMap>(ANN_KEY),
  notes: load<NoteMap>(NOTE_KEY),
  add: (conv, toolUseId, ann) =>
    set((s) => {
      const list = s.byConv[conv]?.[toolUseId] ?? EMPTY;
      const next = withList(s.byConv, conv, toolUseId, [...list, ann]);
      save(ANN_KEY, next);
      return { byConv: next };
    }),
  remove: (conv, toolUseId, id) =>
    set((s) => {
      const list = s.byConv[conv]?.[toolUseId];
      if (!list) return s;
      const next = withList(s.byConv, conv, toolUseId, list.filter((a) => a.id !== id));
      save(ANN_KEY, next);
      return { byConv: next };
    }),
  setNote: (conv, toolUseId, note) =>
    set((s) => {
      const next = withNote(s.notes, conv, toolUseId, note);
      save(NOTE_KEY, next);
      return { notes: next };
    }),
  clearConversation: (conv) =>
    set((s) => {
      const hasAnn = conv in s.byConv;
      const hasNote = conv in s.notes;
      if (!hasAnn && !hasNote) return s;
      const byConv = { ...s.byConv };
      const notes = { ...s.notes };
      delete byConv[conv];
      delete notes[conv];
      save(ANN_KEY, byConv);
      save(NOTE_KEY, notes);
      return { byConv, notes };
    }),
  clearAll: () =>
    set(() => {
      save(ANN_KEY, {});
      save(NOTE_KEY, {});
      return { byConv: {}, notes: {} };
    }),
}));

/** Subscribe to one plan's annotations (stable EMPTY ref when none, so no needless renders). */
export const usePlanAnnotations = (conv: string, toolUseId: string): PlanAnnotation[] =>
  usePlanAnnotationsStore((s) => s.byConv[conv]?.[toolUseId] ?? EMPTY);

/** Subscribe to one plan's general note (empty string when none). */
export const usePlanNote = (conv: string, toolUseId: string): string =>
  usePlanAnnotationsStore((s) => s.notes[conv]?.[toolUseId] ?? "");

/** Imperative clears for non-React callers (conversationsStore removal / wipe). */
export function clearPlanAnnotations(conv: string): void {
  usePlanAnnotationsStore.getState().clearConversation(conv);
}
export function clearAllPlanAnnotations(): void {
  usePlanAnnotationsStore.getState().clearAll();
}

/** Snapshot a conversation's plan state before an UNDOABLE delete, or null if it has none. */
export function snapshotPlanAnnotations(conv: string): PlanConvSnapshot | null {
  const s = usePlanAnnotationsStore.getState();
  const ann = s.byConv[conv];
  const notes = s.notes[conv];
  if (!ann && !notes) return null;
  // Deep-ish copy so a later mutation of the live store can't corrupt the snapshot.
  return {
    ann: ann ? structuredClone(ann) : {},
    notes: notes ? { ...notes } : {},
  };
}

/** Re-seed a conversation's plan state when its delete is undone (⌘Z). */
export function restorePlanAnnotations(conv: string, snap: PlanConvSnapshot | null): void {
  if (!snap) return;
  usePlanAnnotationsStore.setState((s) => {
    const byConv = { ...s.byConv };
    const notes = { ...s.notes };
    if (Object.keys(snap.ann).length > 0) byConv[conv] = snap.ann;
    if (Object.keys(snap.notes).length > 0) notes[conv] = snap.notes;
    save(ANN_KEY, byConv);
    save(NOTE_KEY, notes);
    return { byConv, notes };
  });
}
