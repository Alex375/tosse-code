// Which target the extensions manager is open for, if any. A tiny shared slice so
// both entry points open the same global modal:
//  - the per-conversation chip (composer footer) opens it for the active
//    conversation's cwd + its live session (so live MCP statuses show), à la /mcp;
//  - the per-repo button (sidebar header) opens it for a repo's path, config-only.
import { create } from "zustand";

export interface ExtensionsTarget {
  /**
   * Which lens to show:
   * - `project`: what's INSTALLED/available for the repo, by scope (config scan).
   * - `conversation`: this session's LIVE picture — real MCP status + what's active.
   */
  kind: "project" | "conversation";
  /** Directory to scan for configured extensions (repo root or conversation cwd). */
  path: string;
  /** Header label (repo name or conversation name). */
  title: string;
  /** Stable conversation id for live MCP status lookup (only for `conversation`). */
  session: string | null;
}

interface ExtensionsUiState {
  target: ExtensionsTarget | null;
  openManager: (target: ExtensionsTarget) => void;
  closeManager: () => void;
}

export const useExtensionsUi = create<ExtensionsUiState>((set) => ({
  target: null,
  openManager: (target) => set({ target }),
  closeManager: () => set({ target: null }),
}));
