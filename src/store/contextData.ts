// Shared derivation of a conversation's context-window fill (the number behind the
// context ring AND the FlightDeck card's context bar). Lifts the recipe that used
// to live inline in ConductorComposer so both surfaces compute it identically,
// keyed by the conversation's stable id.
import type { Ctx, PlanInfo } from "../ui/kit";
import { useSessionState } from "./conversationStore";

/** Compact token count: 29756 → "29.8k", 200000 → "200k", 1e6 → "1M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)) + "M";
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    if (k >= 999.95) return "1M"; // avoid "1000.0k" right below the 1M boundary
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + "k";
  }
  return String(n);
}

export interface ContextData {
  /** Tokens used / window, as the ring/bar consume it. */
  ctx: Ctx;
  /** False until the first turn reports usage — render a quiet stub then. */
  ready: boolean;
  /** Subscription rate-limit snapshot, or null when none reported. */
  plan: PlanInfo | null;
}

/**
 * The context fill for a conversation (by stable id). Real usage from the last
 * model call's input tokens over the model's window — both surfaced by the core in
 * SessionStatePayload. Until the first turn reports usage, `ready` is false.
 */
export function useContextData(convId: string): ContextData {
  const state = useSessionState(convId);
  const ctxTokens = state?.context_tokens ?? null;
  const ctxWindow = state?.context_window ?? null;
  const ready = ctxTokens != null && ctxWindow != null && ctxWindow > 0;
  const ctx: Ctx = ready
    ? {
        pct: Math.min(100, Math.round((ctxTokens / ctxWindow) * 100)),
        used: fmtTokens(ctxTokens),
        max: fmtTokens(ctxWindow),
      }
    : { pct: 0, used: "—", max: "—" };
  // Percentage of plan usage is NOT in the stream — only what `rate_limit_event`
  // carries (coarse status + reset time).
  const plan: PlanInfo | null = state?.rate_limit
    ? {
        status: state.rate_limit.status,
        resetsAt: state.rate_limit.resets_at,
        limitType: state.rate_limit.limit_type,
        usingOverage: state.rate_limit.using_overage,
      }
    : null;
  return { ctx, ready, plan };
}
