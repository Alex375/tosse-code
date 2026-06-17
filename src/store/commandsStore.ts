// Slash-command catalogue, keyed by working folder (cwd).
//
// The core advertises a session's available commands once, in its `initialize`
// control response (the same source the VS Code extension uses). But our spawn
// is LAZY — no `claude` process exists until the first message — so the composer
// must be able to show the `/` menu *before* a session exists (typing `/pickup`
// as the very first thing is the canonical case). Commands are a function of the
// cwd (built-ins + user/plugin skills are global; only a repo's own
// `.claude/skills` differ), so we cache them per cwd and persist that cache to
// localStorage. After a repo has been opened once, its `/` menu works instantly
// on every later visit and across restarts — no spawn required.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { SlashCommand } from "../ipc/client";

const STORAGE_KEY = "tosse:slash-commands-by-cwd";

type ByCwd = Record<string, SlashCommand[]>;

/** Load the persisted cache; never throws (a corrupt/absent entry → empty). */
function loadCache(): ByCwd {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ByCwd) : {};
  } catch {
    return {};
  }
}

/** Persist best-effort; a storage failure must never break the UI. */
function saveCache(byCwd: ByCwd): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byCwd));
  } catch {
    /* quota / unavailable — the in-memory store still works this run */
  }
}

interface CommandsState {
  byCwd: ByCwd;
  /** The most recently seen non-empty list, used as a fallback for a cwd we have
   *  never spawned (built-ins + global skills are identical across repos). */
  lastSeen: SlashCommand[];
  /** Record the commands a session reported for its cwd. */
  setCommands: (cwd: string, commands: SlashCommand[]) => void;
}

export const useCommandsStore = create<CommandsState>((set) => {
  const initial = loadCache();
  return {
    byCwd: initial,
    lastSeen: Object.values(initial).find((c) => c.length > 0) ?? [],

    setCommands: (cwd, commands) =>
      set((s) => {
        const byCwd = { ...s.byCwd, [cwd]: commands };
        saveCache(byCwd);
        return {
          byCwd,
          lastSeen: commands.length > 0 ? commands : s.lastSeen,
        };
      }),
  };
});

const EMPTY: SlashCommand[] = [];

/**
 * The slash commands to offer for a conversation's cwd. Prefers the exact cwd's
 * catalogue; falls back to the last-seen list so a never-spawned repo still gets
 * a useful (built-ins + global skills) menu. Empty only on a truly cold start.
 */
export function useSlashCommands(cwd: string | null | undefined): SlashCommand[] {
  return useCommandsStore(
    useShallow((s) => (cwd && s.byCwd[cwd]) || s.lastSeen || EMPTY),
  );
}
