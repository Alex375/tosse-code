import { describe, it, expect } from "vitest";
import { clampEffort, effortLevelsForModel, type EffortLevel } from "./EffortGauge";

describe("effortLevelsForModel", () => {
  it("offers 'max' on the models that accept it (Opus, Sonnet, Fable), not the others", () => {
    // 2.1.187 promoted `max` to a real runtime level — verified live. Per-model:
    // Opus 4.8, Sonnet 4.6 and Fable 5 accept it; Haiku has no effort; the fallback stays lean.
    for (const m of ["opus", "claude-opus-4-8[1m]", "sonnet", "fable", "claude-fable-5"]) {
      expect(effortLevelsForModel(m)).toContain("max" as EffortLevel);
    }
    for (const m of ["haiku", "whatever"]) {
      expect(effortLevelsForModel(m)).not.toContain("max" as EffortLevel);
    }
  });

  it("opus has xhigh+max, sonnet has max but no xhigh, haiku has no effort", () => {
    expect(effortLevelsForModel("opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The live resolved id (with the [1m] suffix) maps to the same family.
    expect(effortLevelsForModel("claude-opus-4-8[1m]")).toContain("xhigh");
    // Sonnet 4.6 accepts `max` but the CLI swallows `xhigh` on it (verified live).
    expect(effortLevelsForModel("sonnet")).toEqual(["low", "medium", "high", "max"]);
    expect(effortLevelsForModel("sonnet")).not.toContain("xhigh");
    expect(effortLevelsForModel("haiku")).toEqual([]); // gauge hidden
  });

  it("fable has the same effort tier as opus (xhigh + max)", () => {
    // Fable 5 is the time-limited preview model; it shares Opus's effort levels.
    expect(effortLevelsForModel("fable")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The resolved id `claude-fable-5` maps to the same family.
    expect(effortLevelsForModel("claude-fable-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsForModel("fable")).toContain("xhigh");
  });
});

describe("clampEffort", () => {
  it("keeps a supported level unchanged", () => {
    expect(clampEffort("high", "opus")).toBe("high");
    expect(clampEffort("max", "opus")).toBe("max");
    expect(clampEffort("max", "sonnet")).toBe("max"); // sonnet supports max
  });

  it("clamps an unsupported xhigh down to high — never jumps UP to max", () => {
    // Sonnet has no xhigh; max ranks ABOVE xhigh in ORDER, so the highest supported
    // level ≤ xhigh is `high`. This is the invariant the max-after-xhigh ordering buys.
    expect(clampEffort("xhigh", "sonnet")).toBe("high");
  });

  it("lands ultracode on the weaker model's top available level", () => {
    // Sonnet has no xhigh (and thus no ultracode); its top rung is `max`.
    expect(clampEffort("ultracode", "sonnet")).toBe("max");
  });

  it("ultracode stays on an xhigh-capable model", () => {
    expect(clampEffort("ultracode", "opus")).toBe("ultracode");
  });

  it("returns the value unchanged for a model with no effort (gauge hidden)", () => {
    expect(clampEffort("high", "haiku")).toBe("high");
  });
});
