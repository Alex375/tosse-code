// Pure decision for WHICH source backs a sub-agent's transcript view: the live
// sub-thread (from the store), the on-disk transcript, or one of the empty/error
// placeholders. Extracted so the inline <SubAgentCard> (conversation thread) and the
// floating <TranscriptPopover> (conversation AgentBar + FlightDeck badge) share ONE
// resolution and never diverge — the FlightDeck drill-down used to read disk only and
// showed "transcript indisponible" while the same agent rendered fine inline from its
// live sub-thread.
//
// Pure & React-free → unit-testable in isolation; the components map the returned kind
// to their own ReactNode (each keeps its own wording).

export type TranscriptSourceKind =
  /** Render the live sub-thread from the store (turn ids in `subThreads`). */
  | "live"
  /** Render the on-disk transcript (`load_subagent_transcript` items). */
  | "disk"
  /** Disk fetch in flight. */
  | "loading"
  /** Disk fetch errored. */
  | "error"
  /** Running, but neither live turns nor disk yet. */
  | "working"
  /** Can't resolve the agent (e.g. resumed conversation: no live ids, no agent_id). */
  | "unavailable"
  /** Finished and resolvable, but nothing was ever written. */
  | "empty";

export interface TranscriptSourceInput {
  /** Is the task still running? Prefer the live sub-thread while it is. */
  running: boolean;
  /** Number of live sub-thread turn ids (from `useSubThread`). */
  liveCount: number;
  /** Number of items loaded from the on-disk transcript (0 when none / not loaded). */
  diskCount: number;
  /** A disk fetch is in flight. */
  loading: boolean;
  /** A disk fetch errored. */
  error: boolean;
  /** Both the durable session id and the sub-agent's agent_id are known (disk readable). */
  resolvable: boolean;
}

/**
 * Mirror of <SubAgentCard>'s resolution, in one place:
 *  1. running with live turns → live (smooth, no mid-run partial disk read),
 *  2. disk transcript present → disk (authoritative once finished),
 *  3. live turns present → live (running with no disk, or finished pre-resume),
 *  4. loading / error placeholders,
 *  5. running with nothing yet → "working",
 *  6. unresolvable → "unavailable" (resumed conversation), else "empty".
 */
export function resolveTranscriptSource(a: TranscriptSourceInput): TranscriptSourceKind {
  if (a.running && a.liveCount > 0) return "live";
  if (a.diskCount > 0) return "disk";
  if (a.liveCount > 0) return "live";
  if (a.loading) return "loading";
  if (a.error) return "error";
  if (a.running) return "working";
  if (!a.resolvable) return "unavailable";
  return "empty";
}
