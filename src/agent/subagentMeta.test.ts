import { describe, it, expect } from "vitest";
import { effortLabel, EFFORT_LABELS, shortModel } from "./subagentMeta";

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
