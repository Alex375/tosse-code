import { describe, it, expect } from "vitest";
import {
  agentStatusToDot,
  deriveAgentStatus,
  isDismissable,
  looksLikeQuestion,
  rowAttention,
  type AgentSignals,
} from "./status";

/** A live, idle, fully-consumed session — the neutral baseline to override per test. */
function sig(over: Partial<AgentSignals> = {}): AgentSignals {
  return {
    handle: "session-1",
    busy: false,
    awaitingPermission: false,
    pendingToolName: null,
    pendingPrompt: null,
    activity: null,
    lastTurnSubtype: null,
    lastTurnIsError: false,
    turnSeen: true,
    lastAssistantText: null,
    ...over,
  };
}

describe("deriveAgentStatus", () => {
  it("is off with no live handle (whatever else is set)", () => {
    expect(deriveAgentStatus(sig({ handle: null })).kind).toBe("off");
    // off wins over everything, even a pending permission.
    expect(
      deriveAgentStatus(sig({ handle: null, awaitingPermission: true, busy: true })).kind,
    ).toBe("off");
  });

  it("is idle when live, not busy, and the last turn was consumed", () => {
    expect(deriveAgentStatus(sig()).kind).toBe("idle");
  });

  it("is running while busy", () => {
    expect(deriveAgentStatus(sig({ busy: true, activity: "requesting" }))).toEqual({
      kind: "running",
      activity: "requesting",
    });
  });

  it("a pending permission outranks busy", () => {
    const s = deriveAgentStatus(sig({ busy: true, awaitingPermission: true, pendingToolName: "Bash" }));
    expect(s.kind).toBe("needIntervention");
  });

  it("AskUserQuestion → needInput via questionnaire (carries the prompt)", () => {
    expect(
      deriveAgentStatus(
        sig({
          awaitingPermission: true,
          pendingToolName: "AskUserQuestion",
          pendingPrompt: "Quelle approche ?",
        }),
      ),
    ).toEqual({ kind: "needInput", via: "questionnaire", prompt: "Quelle approche ?" });
  });

  it("any other tool permission → needIntervention (carries the tool)", () => {
    expect(
      deriveAgentStatus(sig({ awaitingPermission: true, pendingToolName: "Edit" })),
    ).toEqual({ kind: "needIntervention", tool: "Edit" });
  });

  it("falls back to a generic tool label when the tool name is missing", () => {
    const s = deriveAgentStatus(sig({ awaitingPermission: true, pendingToolName: null }));
    expect(s).toEqual({ kind: "needIntervention", tool: "outil" });
  });

  describe("when a turn just finished and is unconsumed (turnSeen=false)", () => {
    it("is review for a clean finish that doesn't look like a question", () => {
      expect(
        deriveAgentStatus(
          sig({ turnSeen: false, lastTurnSubtype: "success", lastAssistantText: "C'est fait ✅" }),
        ).kind,
      ).toBe("review");
    });

    it("is needInput via openQuestion when the last text ends on a question", () => {
      expect(
        deriveAgentStatus(
          sig({
            turnSeen: false,
            lastTurnSubtype: "success",
            lastAssistantText: "Je peux commencer ?",
          }),
        ),
      ).toEqual({ kind: "needInput", via: "openQuestion", prompt: "Je peux commencer ?" });
    });

    it("is error when the last turn flagged is_error", () => {
      expect(deriveAgentStatus(sig({ turnSeen: false, lastTurnIsError: true })).kind).toBe("error");
    });

    it("is error when the subtype starts with error_ (even without is_error)", () => {
      expect(
        deriveAgentStatus(sig({ turnSeen: false, lastTurnSubtype: "error_max_turns" })).kind,
      ).toBe("error");
    });

    it("error outranks the open-question heuristic", () => {
      // A failing turn whose text happens to end in "?" is an error, not a question.
      expect(
        deriveAgentStatus(
          sig({ turnSeen: false, lastTurnIsError: true, lastAssistantText: "Pourquoi ?" }),
        ).kind,
      ).toBe("error");
    });
  });

  it("once consumed (turnSeen=true) a finished question/review drops to idle", () => {
    expect(
      deriveAgentStatus(sig({ turnSeen: true, lastAssistantText: "Je peux commencer ?" })).kind,
    ).toBe("idle");
  });
});

describe("looksLikeQuestion", () => {
  it("is false for null/empty", () => {
    expect(looksLikeQuestion(null)).toBe(false);
    expect(looksLikeQuestion("")).toBe(false);
  });

  it("detects a plain trailing question mark", () => {
    expect(looksLikeQuestion("Veux-tu que je continue ?")).toBe(true);
  });

  it("ignores trailing whitespace / markdown emphasis / closers", () => {
    expect(looksLikeQuestion("On part là-dessus ?\n")).toBe(true);
    expect(looksLikeQuestion("**Tu confirmes ?**")).toBe(true);
    expect(looksLikeQuestion("(tu confirmes ?)")).toBe(true);
    expect(looksLikeQuestion("Voici le plan ?\n```")).toBe(true);
  });

  it("is false for a statement (incl. one ending on an emoji)", () => {
    expect(looksLikeQuestion("Build vert ✅")).toBe(false);
    expect(looksLikeQuestion("C'est terminé.")).toBe(false);
    expect(looksLikeQuestion("Done!")).toBe(false);
  });
});

describe("agentStatusToDot (4-colour grouping)", () => {
  it("maps each status onto its dot colour", () => {
    expect(agentStatusToDot({ kind: "off" })).toBe("off");
    expect(agentStatusToDot({ kind: "idle" })).toBe("done");
    expect(agentStatusToDot({ kind: "running", activity: null })).toBe("work");
    expect(agentStatusToDot({ kind: "needInput", via: "questionnaire", prompt: null })).toBe("ask");
    expect(agentStatusToDot({ kind: "needIntervention", tool: "Bash" })).toBe("ask");
    expect(agentStatusToDot({ kind: "review" })).toBe("review");
    expect(agentStatusToDot({ kind: "error", message: "x" })).toBe("err");
  });
});

describe("isDismissable", () => {
  it("is true only for non-blocking reminders", () => {
    expect(isDismissable({ kind: "review" })).toBe(true);
    expect(isDismissable({ kind: "error", message: "x" })).toBe(true);
    expect(isDismissable({ kind: "needInput", via: "openQuestion", prompt: null })).toBe(true);
  });

  it("is false for real blocks and non-attention states", () => {
    // A questionnaire / permission must be ANSWERED, not dismissed.
    expect(isDismissable({ kind: "needInput", via: "questionnaire", prompt: null })).toBe(false);
    expect(isDismissable({ kind: "needIntervention", tool: "Edit" })).toBe(false);
    expect(isDismissable({ kind: "running", activity: null })).toBe(false);
    expect(isDismissable({ kind: "idle" })).toBe(false);
    expect(isDismissable({ kind: "off" })).toBe(false);
  });
});

describe("rowAttention", () => {
  it("buckets need-input/intervention as input, plus review and error", () => {
    expect(rowAttention({ kind: "needInput", via: "questionnaire", prompt: null })).toBe("input");
    expect(rowAttention({ kind: "needIntervention", tool: "Bash" })).toBe("input");
    expect(rowAttention({ kind: "review" })).toBe("review");
    expect(rowAttention({ kind: "error", message: "x" })).toBe("error");
  });

  it("gives no emphasis to running/idle/off", () => {
    expect(rowAttention({ kind: "running", activity: null })).toBeNull();
    expect(rowAttention({ kind: "idle" })).toBeNull();
    expect(rowAttention({ kind: "off" })).toBeNull();
  });
});
