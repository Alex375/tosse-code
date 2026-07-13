// Pure helpers for the plan card (ExitPlanMode): derive the plan's decision from its
// tool_result, and format the user's annotations into a feedback message sent back to the
// agent on "reject & revise". Kept framework-free so both are unit-testable.

import type { JsonValue } from "../../ipc/client";
import type { PlanAnnotation } from "../../store/planAnnotations";
import { resultContentText } from "./resultText";

/** The plan's outcome as read from its settled tool_result (the live "pending" state is
 *  decided by the presence of an open permission, not here). `unknown` = a result we can't
 *  classify (never mislabel it approved/rejected). */
export type PlanResultDecision = "approved" | "rejected" | "unknown";

/**
 * Classify a settled ExitPlanMode result into approved / rejected / unknown.
 *
 * The CLI returns, on approval: "User has approved your plan. You can now start coding. …".
 * ExitPlanMode is a permission-gated tool that does no work of its own, so the ONLY way it
 * yields an error result is a DENIED permission (the deny carries our feedback message, or the
 * CLI's own rejection phrasing) — hence `isError` is deterministically a rejection here. A
 * NON-error result we recognize as neither an approval nor an explicit rejection stays
 * `unknown`, so the card shows a neutral state rather than a wrong badge.
 */
export function planResultDecision(content: JsonValue, isError: boolean): PlanResultDecision {
  const text = (resultContentText(content) ?? "").toLowerCase();
  if (!isError && /approved your plan|has approved the plan|approved the plan/.test(text))
    return "approved";
  if (isError) return "rejected";
  if (/reject|declin|keep planning|did not approve|didn.?t approve|does ?n.?t want to proceed/.test(text))
    return "rejected";
  return "unknown";
}

/**
 * Build the deny message sent to the agent when the user rejects a plan with feedback. Each
 * annotation becomes a quoted excerpt + the user's note; an optional general note is appended.
 * The agent reads this as the tool_result of the refused ExitPlanMode and revises accordingly.
 * Returns a generic refusal when there is nothing to say, so "reject" always sends something.
 */
export function buildRejectionMessage(
  annotations: ReadonlyArray<PlanAnnotation>,
  generalNote: string,
): string {
  const note = generalNote.trim();
  const withComments = annotations.filter((a) => a.comment.trim() !== "");
  if (withComments.length === 0 && note === "")
    return "The user rejected the plan. Rework your proposal.";

  const lines: string[] = [
    "The user rejected the plan and left feedback to incorporate before proposing a new plan:",
    "",
  ];
  if (note !== "") {
    lines.push(`General feedback: ${note}`, "");
  }
  if (withComments.length > 0) {
    lines.push("Comments on specific parts of the plan:", "");
    for (const a of withComments) {
      const quote = a.quote.trim().replace(/\s+/g, " ");
      lines.push(`> ${quote}`, `  → ${a.comment.trim()}`, "");
    }
  }
  lines.push("Revise the plan taking this feedback into account.");
  return lines.join("\n").trim();
}
