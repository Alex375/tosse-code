// A few-word summary of the user's LAST message, per conversation — shown on the Flight
// Deck so the fleet's last asks ("what did I tell each agent to do") are legible at a
// glance. Twin of the auto-title (`conversationsStore`): same `generate_session_title`
// wire, Haiku inside the binary, hidden from the Opus context (`persist:false`, no
// transcript). Distinct routing: the title names the whole conversation; this
// summarizes ONLY the latest message, and regenerates on EVERY user send.
//
// LIVE-only, in memory (like `remoteControl` / the background bars): messages aren't
// persisted in SQLite, and re-summarizing is cheap, so there is nothing to persist —
// the line simply (re)appears on the next send. Keyed by the STABLE conversation id.
// Two-stage value: an INSTANT optimistic truncation of the message (0 tokens, works even
// with no live session / before the Haiku returns), REPLACED by the ≤6-word Haiku
// summary when it arrives. A `seq` per message drops a stale (superseded) Haiku response.
//
// Cost discipline (see the brainstorm): the Haiku call fires ONLY when it earns its keep
// — a short single-line message or a slash command is already its own summary, so we
// skip generation and keep just the truncation.

import { create } from "zustand";
import { commands } from "../ipc/client";

/** Max characters for the optimistic truncation shown before/without a Haiku summary. */
const PREVIEW_MAX = 46;

/**
 * The instant, zero-token preview of a message: first line, whitespace-collapsed,
 * truncated. Mirrors `conversationsStore.deriveName`. This is what shows immediately on
 * send and the permanent fallback if generation is skipped or fails.
 */
export function summaryPreview(text: string, max: number = PREVIEW_MAX): string {
  const firstLine = text.split("\n", 1)[0];
  const t = firstLine.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Clean a model-generated summary: trim, collapse whitespace, strip wrapping quotes the
 * small model sometimes adds despite the hint. Deliberately NOT length-capped: the Haiku
 * is already constrained to ≤6 words, and the card wraps a slightly long summary onto a
 * 2nd line rather than ellipsize it (truncating the summary itself is what we're avoiding
 * — a "…" on the last ask reads as broken). The 2-line clamp in CSS is the only safety net.
 */
export function cleanSummary(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  // The model occasionally echoes the summary in quotes despite "no quotes" — peel one
  // symmetric layer.
  if (t.length >= 2 && /^["'“”«»]/.test(t) && /["'“”«»]$/.test(t)) t = t.slice(1, -1).trim();
  return t;
}

/**
 * Whether a message is trivial enough that the truncation IS the summary — so we skip
 * the Haiku call. True for a slash command (show the command as typed) or a short,
 * single-line message that the preview already shows in full. Only genuinely long /
 * multi-line messages, where compression adds value, are worth a generation.
 */
export function isTrivialToSummarize(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("/")) return true; // a slash command — its name is the summary
  const multiLine = /\n/.test(t);
  return !multiLine && t.length <= PREVIEW_MAX;
}

// The seq of each conversation's CURRENT (latest) message. A Haiku summary is applied
// ONLY if its seq still matches — a newer message advances the seq, so any in-flight
// response for a superseded message is dropped. Module-level (non-reactive): it gates
// applies, it isn't rendered.
const currentSeq = new Map<string, number>();

interface LastMessageSummaryStore {
  /** convId → the summary/preview to display. Absent = nothing sent this run. */
  byConv: Record<string, string>;
  /** Apply a Haiku summary if it still matches the conversation's latest message. */
  apply: (convId: string, summary: string, seq: number) => void;
  /** Forget one conversation's summary (teardown: stop / remove / removeRepo). */
  clear: (convId: string) => void;
  /** Forget every conversation's summary (wipe-all). */
  clearAll: () => void;
}

export const useLastMessageSummaryStore = create<LastMessageSummaryStore>((set) => ({
  byConv: {},
  apply: (convId, summary, seq) =>
    set((s) => {
      // Drop a stale response: only the seq of the conversation's latest message wins.
      if (seq !== currentSeq.get(convId)) return s;
      const cleaned = cleanSummary(summary);
      if (!cleaned || s.byConv[convId] === cleaned) return s;
      return { byConv: { ...s.byConv, [convId]: cleaned } };
    }),
  clear: (convId) =>
    set((s) => {
      currentSeq.delete(convId);
      if (!(convId in s.byConv)) return s;
      const next = { ...s.byConv };
      delete next[convId];
      return { byConv: next };
    }),
  clearAll: () => {
    currentSeq.clear();
    set({ byConv: {} });
  },
}));

/**
 * On a user send: show the instant truncation immediately, and — unless the message is
 * trivial or there's no live session — ask the binary for a ≤6-word Haiku summary that
 * replaces it. Fire-and-forget: the summary returns via `SessionSummaryEvent` → `apply`.
 * A failure is non-fatal (the truncation stays) — logged, never surfaced.
 *
 * @param handle the LIVE session handle (from `ensureConversationSession`), or null/undefined
 *               if the send couldn't spawn — then only the truncation shows.
 */
export function triggerLastMessageSummary(
  convId: string,
  handle: string | null | undefined,
  text: string,
): void {
  const seq = (currentSeq.get(convId) ?? 0) + 1;
  currentSeq.set(convId, seq);

  // Optimistic truncation — instant, zero-token, and the fallback if generation is
  // skipped or fails. NOT seq-gated: a newer message always supersedes.
  const preview = summaryPreview(text);
  useLastMessageSummaryStore.setState((s) =>
    s.byConv[convId] === preview ? s : { byConv: { ...s.byConv, [convId]: preview } },
  );

  // Skip the Haiku call when the truncation already IS the summary, or nothing's live.
  if (!handle || isTrivialToSummarize(text)) return;

  void commands
    .generateMessageSummary(handle, text, seq)
    .then((res) => {
      if (res.status === "error")
        console.error("[lastMsgSummary] generateMessageSummary failed:", res.error);
    })
    .catch((e) => console.error("[lastMsgSummary] generateMessageSummary threw:", e));
}

/** Reactive last-message summary for one conversation (`undefined` until a send). */
export function useLastMessageSummary(convId: string): string | undefined {
  return useLastMessageSummaryStore((s) => s.byConv[convId]);
}
