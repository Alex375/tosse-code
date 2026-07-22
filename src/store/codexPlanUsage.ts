// Codex subscription plan-usage (5h + weekly %). The Codex analogue of `planUsage.ts`,
// but fed by a live PUSH (`session_codex_plan_usage`, from the app-server's
// `account/rateLimits/updated`) instead of an HTTP/Keychain pull — Codex exposes ZERO
// credential/endpoint surface for this, so there is nothing to query.
//
// ACCOUNT-global, exactly like the Claude plan store: a single shared snapshot, NEVER
// keyed by conversation and NEVER merged with the Claude one (Max ≠ ChatGPT are two
// different subscriptions). Whichever live Codex conversation surfaces a push updates
// this one store; every Codex conversation's popover reads it (per-conv display of an
// account-global figure — never summed across the fleet).
//
// Pushes are SPARSE: `account/rateLimits/updated` may carry only the window that moved,
// so `set` MERGES onto the last snapshot (a null window keeps the previous value) rather
// than replacing it — otherwise a partial push would blank the other window.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { PlanUsage } from "../ipc/client";

interface CodexPlanUsageStore {
  /** The latest merged snapshot, or null before the first push. */
  usage: PlanUsage | null;
  /** Timestamp (ms) of the last push — drives the popover's "updated …" line. */
  updatedAt: number | null;
  /** Merge a (possibly sparse) push onto the current snapshot. */
  set: (usage: PlanUsage) => void;
  /** Forget the snapshot (wipe-all). */
  clear: () => void;
}

export const useCodexPlanUsageStore = create<CodexPlanUsageStore>((set) => ({
  usage: null,
  updatedAt: null,
  set: (incoming) =>
    set((s) => ({
      // Sparse merge: keep the previous window when the push omits it.
      usage: {
        five_hour: incoming.five_hour ?? s.usage?.five_hour ?? null,
        seven_day: incoming.seven_day ?? s.usage?.seven_day ?? null,
        // Codex reports no model-scoped caps today (the core always sends an empty list),
        // so an empty push keeps whatever was there rather than blanking it — same sparse
        // rule as the windows above.
        scoped: incoming.scoped?.length ? incoming.scoped : (s.usage?.scoped ?? []),
      },
      updatedAt: Date.now(),
    })),
  clear: () => set({ usage: null, updatedAt: null }),
}));

/** The account-global Codex plan usage + its freshness. `useShallow` so the returned
 *  object identity is stable across renders (it packs two fields) — avoids the
 *  `useSyncExternalStore` infinite-render footgun a fresh-object selector triggers. */
export function useCodexPlanUsage(): { usage: PlanUsage | null; updatedAt: number | null } {
  return useCodexPlanUsageStore(
    useShallow((s) => ({ usage: s.usage, updatedAt: s.updatedAt })),
  );
}
