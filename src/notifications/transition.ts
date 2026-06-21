// The notification policy for session-state changes, isolated as a pure function
// so it can be unit-tested without the event router, the stores, or any I/O.
import type { SessionStatePayload } from "../ipc/client";

export type AgentEventKind = "done" | "attention";

/**
 * Which agent notification (if any) a state change warrants, comparing the
 * PREVIOUS session state to the NEXT one (edge-triggered, not level):
 *  - awaiting_permission false→true → "attention" (a permission/question is up).
 *  - busy true→false while still alive and not awaiting → "done" (turn finished).
 *
 * Returns null for every other change. Gating "done" on `!ended` keeps a process
 * exit/crash from reading as a completion; gating on `!awaiting_permission` keeps
 * entering a permission wait (which also drops `busy`) from double-firing as both
 * "attention" and "done". Comparing against an already-applied `prev` also means a
 * duplicated (at-least-once) event sees no edge and yields null.
 */
export function agentEventFor(
  prev: SessionStatePayload,
  next: SessionStatePayload,
): AgentEventKind | null {
  if (!prev.awaiting_permission && next.awaiting_permission) return "attention";
  if (prev.busy && !next.busy && !next.awaiting_permission && !next.ended) return "done";
  return null;
}
