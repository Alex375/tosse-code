import { describe, it, expect } from "vitest";
import { effortLabel, EFFORT_LABELS, runIdFromResult, shortModel } from "./subagentMeta";

describe("effortLabel", () => {
  it("maps each CLI effort level to its display label", () => {
    expect(effortLabel("low")).toBe("Low");
    expect(effortLabel("medium")).toBe("Medium");
    expect(effortLabel("high")).toBe("High");
    expect(effortLabel("xhigh")).toBe("Extra");
  });

  it("returns null when the effort is unknown (no read-back yet)", () => {
    expect(effortLabel(null)).toBeNull();
    expect(effortLabel(undefined)).toBeNull();
    expect(effortLabel("")).toBeNull();
  });

  it("ultracode outranks the raw effort", () => {
    expect(effortLabel("high", true)).toBe("Ultra code");
    expect(effortLabel("xhigh", true)).toBe("Ultra code");
    // ultracode flag is reported even with no separate effort string
    expect(effortLabel(null, true)).toBe("Ultra code");
  });

  it("labels the max tier", () => {
    expect(effortLabel("max")).toBe("Max");
  });

  it("falls through unrecognised effort strings (forward-compat)", () => {
    expect(effortLabel("banana")).toBe("banana");
  });

  it("EFFORT_LABELS covers exactly the gauge's levels", () => {
    expect(Object.keys(EFFORT_LABELS).sort()).toEqual(
      ["high", "low", "max", "medium", "ultracode", "xhigh"],
    );
  });
});

describe("shortModel", () => {
  it("strips the claude- prefix, date suffix and bracket tags", () => {
    expect(shortModel("claude-opus-4-8[1m]")).toBe("opus-4-8");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });
});

describe("runIdFromResult", () => {
  // The real ack the Workflow tool returns (captured verbatim from a live run).
  const ack =
    'Workflow launched in background. Task ID: wenji2gyo\n' +
    'Summary: verify the fixes\n' +
    'Transcript dir: /Users/x/.claude/projects/p/s/subagents/workflows/wf_cb719d53-406\n' +
    'Script file: /Users/x/.claude/projects/p/s/workflows/scripts/verify-wf_cb719d53-406.js\n' +
    'Run ID: wf_cb719d53-406\n';

  it("parses the wf_ run id from the 'Run ID:' line", () => {
    expect(runIdFromResult(ack)).toBe("wf_cb719d53-406");
  });

  it("reads content delivered as an array of text blocks", () => {
    expect(runIdFromResult([{ type: "text", text: ack }] as never)).toBe("wf_cb719d53-406");
  });

  it("prefixes a bare run id with wf_", () => {
    expect(runIdFromResult("Run ID: cb719d53-406")).toBe("wf_cb719d53-406");
  });

  it("falls back to a wf_ token in a path when there is no 'Run ID' line", () => {
    expect(runIdFromResult("Transcript dir: /p/subagents/workflows/wf_abc12-9")).toBe("wf_abc12-9");
  });

  it("returns null when nothing matches", () => {
    expect(runIdFromResult("no id here")).toBeNull();
    expect(runIdFromResult(undefined)).toBeNull();
    expect(runIdFromResult("")).toBeNull();
  });
});
