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
    expect(planResultDecision("L'utilisateur a refusé le plan.", true)).toBe("rejected");
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
    expect(msg).toMatch(/refusé le plan/i);
    expect(msg).not.toMatch(/Retour général/);
    expect(msg).not.toMatch(/Commentaires/);
  });

  it("bundles the general note", () => {
    const msg = buildRejectionMessage([], "trop ambitieux");
    expect(msg).toMatch(/Retour général : trop ambitieux/);
  });

  it("bundles per-passage comments as quote → note, skipping empty comments", () => {
    const msg = buildRejectionMessage(
      [ann("Refactorer l'auth", "trop risqué"), ann("Étape 3", "   ")],
      "",
    );
    expect(msg).toMatch(/> Refactorer l'auth/);
    expect(msg).toMatch(/→ trop risqué/);
    // The empty-comment annotation is omitted.
    expect(msg).not.toMatch(/Étape 3/);
  });

  it("collapses whitespace inside a quoted excerpt", () => {
    const msg = buildRejectionMessage([ann("ligne un\n  ligne deux", "revois ça")], "");
    expect(msg).toMatch(/> ligne un ligne deux/);
  });
});
