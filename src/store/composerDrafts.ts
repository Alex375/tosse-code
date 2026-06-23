// Per-conversation draft of the message composer (<ConductorComposer>). The text
// the user is typing is keyed by the conversation's STABLE id (conv.id) — never the
// live session handle (`session-N`, remapped on every resume) — so starting a
// message, switching away, and coming back keeps the unsent text in the input bar.
//
// Persisted to localStorage (same lightweight pattern as todoBarUi/commandsStore)
// rather than the Rust core: it's transient UI state, not domain data, so it stays
// out of the SQLite metadata store and survives an app restart for free. Writes are
// synchronous write-through (no debounce window) so an unsaved draft survives even an
// abrupt quit — that's the whole point.
import { create } from "zustand";

const STORAGE_KEY = "tosse:composer-drafts";

/** convId → the unsent draft text. An absent entry means "no draft". */
type DraftMap = Record<string, string>;

function load(): DraftMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Keep only string entries — defends against a malformed/older payload.
    const out: DraftMap = {};
    for (const [convId, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof text === "string") out[convId] = text;
    }
    return out;
  } catch {
    return {};
  }
}

function save(map: DraftMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface ComposerDraftsState {
  /** convId → unsent draft text. An absent entry means "" (see useComposerDraft). */
  drafts: DraftMap;
  /** Persist (or clear, when empty) the draft for one conversation. */
  setDraft: (convId: string, text: string) => void;
}

export const useComposerDrafts = create<ComposerDraftsState>((set) => ({
  drafts: load(),
  setDraft: (convId, text) =>
    set((s) => {
      // An empty draft is the same as no draft — drop the key so the map (and
      // localStorage) doesn't accumulate empty strings for every visited conversation.
      if (text === "") {
        if (!(convId in s.drafts)) return s;
        const next: DraftMap = { ...s.drafts };
        delete next[convId];
        save(next);
        return { drafts: next };
      }
      if (s.drafts[convId] === text) return s;
      const next: DraftMap = { ...s.drafts, [convId]: text };
      save(next);
      return { drafts: next };
    }),
}));

/** This conversation's unsent draft text. Defaults to "" when none is stored. */
export function useComposerDraft(convId: string): string {
  return useComposerDrafts((s) => s.drafts[convId] ?? "");
}

/** Forget one conversation's draft — call when it's deleted so neither localStorage
 *  nor the in-memory map accumulates orphan entries. Mirrors clearTodoBarOpen. */
export function clearComposerDraft(convId: string): void {
  useComposerDrafts.getState().setDraft(convId, "");
}

/** Drop every stored draft — call on a full data wipe ("Tout supprimer").
 *  Mirrors clearAllTodoBarOpen. */
export function clearAllComposerDrafts(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* disabled storage — best-effort, ignore */
  }
  useComposerDrafts.setState({ drafts: {} });
}
