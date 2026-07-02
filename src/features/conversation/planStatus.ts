// Pure helpers for the plan card (ExitPlanMode): derive the plan's decision from its
// tool_result, and format the user's annotations into a feedback message sent back to the
// agent on "reject & revise". Kept framework-free so both are unit-testable.

import type { JsonValue } from "../../ipc/client";
import type { PlanAnnotation } from "../../store/planAnnotations";

/** The plan's outcome as read from its settled tool_result (the live "pending" state is
 *  decided by the presence of an open permission, not here). `unknown` = a result we can't
 *  classify (never mislabel it approved/rejected). */
export type PlanResultDecision = "approved" | "rejected" | "unknown";

/** Flatten a tool_result content (string or content-block array) to plain text. */
function flatten(content: JsonValue): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && !Array.isArray(b)) {
        const t = (b as Record<string, JsonValue>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Classify a settled ExitPlanMode result. The CLI returns, on approval:
 *   "User has approved your plan. You can now start coding. …"
 * A denied permission comes back as an ERROR result carrying our deny message (or the CLI's
 * own rejection phrasing). Anything else stays `unknown` so the card shows a neutral state
 * rather than a wrong badge.
 */
export function planResultDecision(content: JsonValue, isError: boolean): PlanResultDecision {
  const text = flatten(content).toLowerCase();
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
    return "L'utilisateur a refusé le plan. Retravaille ta proposition.";

  const lines: string[] = [
    "L'utilisateur a refusé le plan et laissé des retours à intégrer avant de reproposer un plan :",
    "",
  ];
  if (note !== "") {
    lines.push(`Retour général : ${note}`, "");
  }
  if (withComments.length > 0) {
    lines.push("Commentaires sur des passages précis du plan :", "");
    for (const a of withComments) {
      const quote = a.quote.trim().replace(/\s+/g, " ");
      lines.push(`> ${quote}`, `  → ${a.comment.trim()}`, "");
    }
  }
  lines.push("Reprends le plan en tenant compte de ces retours.");
  return lines.join("\n").trim();
}
