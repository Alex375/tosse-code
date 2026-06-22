import { describe, it, expect } from "vitest";
import { clampEffort, effortLevelsForModel, type EffortLevel } from "./EffortGauge";

describe("effortLevelsForModel", () => {
  it("never offers the phantom 'max' level (the CLI swallows it silently)", () => {
    for (const m of ["opus", "claude-opus-4-8[1m]", "sonnet", "haiku", "whatever"]) {
      expect(effortLevelsForModel(m)).not.toContain("max" as EffortLevel);
    }
  });

  it("opus is xhigh-capable, sonnet is not, haiku has no effort", () => {
    expect(effortLevelsForModel("opus")).toEqual(["low", "medium", "high", "xhigh"]);
    // The live resolved id (with the [1m] suffix) maps to the same family.
    expect(effortLevelsForModel("claude-opus-4-8[1m]")).toContain("xhigh");
    expect(effortLevelsForModel("sonnet")).not.toContain("xhigh");
    expect(effortLevelsForModel("haiku")).toEqual([]); // gauge hidden
  });
});

describe("clampEffort", () => {
  it("keeps a supported level unchanged", () => {
    expect(clampEffort("high", "opus")).toBe("high");
  });

  it("drops ultracode / xhigh to the model's max when switching to a weaker model", () => {
    // Sonnet has no xhigh (and thus no ultracode) → both clamp down to high.
    expect(clampEffort("ultracode", "sonnet")).toBe("high");
    expect(clampEffort("xhigh", "sonnet")).toBe("high");
  });

  it("ultracode stays on an xhigh-capable model", () => {
    expect(clampEffort("ultracode", "opus")).toBe("ultracode");
  });

  it("returns the value unchanged for a model with no effort (gauge hidden)", () => {
    expect(clampEffort("high", "haiku")).toBe("high");
  });
});
