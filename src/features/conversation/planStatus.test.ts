import { describe, expect, it } from "vitest";
import type { PlanAnnotation } from "../../store/planAnnotations";
import { buildRejectionMessage, planResultDecision } from "./planStatus";

const ann = (quote: string, comment: string): PlanAnnotation => ({
  id: quote,
  start: 0,
  end: quote.length,
  quote,
  comment,
});

describe("planResultDecision", () => {
  it("reads the CLI approval phrasing as approved", () => {
    const content =
      "User has approved your plan. You can now start coding. Start with updating your todo list";
    expect(planResultDecision(content, false)).toBe("approved");
  });

  it("treats an error result (denied permission carrying our message) as rejected", () => {
    expect(planResultDecision("The user rejected the plan.", true)).toBe("rejected");
  });

  it("reads explicit rejection phrasing as rejected even without the error flag", () => {
    expect(planResultDecision("The user rejected the plan, keep planning.", false)).toBe("rejected");
  });

  it("flattens a content-block array before matching", () => {
    const content = [{ type: "text", text: "User has approved your plan." }] as never;
    expect(planResultDecision(content, false)).toBe("approved");
  });

  it("stays unknown for an unrecognized, non-error result (never mislabels)", () => {
    expect(planResultDecision("some unrelated output", false)).toBe("unknown");
  });
});

describe("buildRejectionMessage", () => {
  it("returns a generic refusal when there is nothing to say", () => {
    const msg = buildRejectionMessage([], "   ");
    expect(msg).toMatch(/rejected the plan/i);
    expect(msg).not.toMatch(/General feedback/);
    expect(msg).not.toMatch(/Comments/);
  });

  it("bundles the general note", () => {
    const msg = buildRejectionMessage([], "too ambitious");
    expect(msg).toMatch(/General feedback: too ambitious/);
  });

  it("bundles per-passage comments as quote → note, skipping empty comments", () => {
    const msg = buildRejectionMessage(
      [ann("Refactor the auth", "too risky"), ann("Step 3", "   ")],
      "",
    );
    expect(msg).toMatch(/> Refactor the auth/);
    expect(msg).toMatch(/→ too risky/);
    // The empty-comment annotation is omitted.
    expect(msg).not.toMatch(/Step 3/);
  });

  it("collapses whitespace inside a quoted excerpt", () => {
    const msg = buildRejectionMessage([ann("line one\n  line two", "revisit this")], "");
    expect(msg).toMatch(/> line one line two/);
  });
});
