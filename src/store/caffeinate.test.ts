import { describe, expect, it } from "vitest";
import { caffeineDesired } from "./caffeinate";

describe("caffeineDesired", () => {
  it("never holds when disabled, whatever the mode or activity", () => {
    expect(caffeineDesired(false, "light", true)).toBe(false);
    expect(caffeineDesired(false, "hard", true)).toBe(false);
    expect(caffeineDesired(false, "light", false)).toBe(false);
    expect(caffeineDesired(false, "hard", false)).toBe(false);
  });

  it("Light follows fleet activity", () => {
    expect(caffeineDesired(true, "light", true)).toBe(true); // an agent is working
    expect(caffeineDesired(true, "light", false)).toBe(false); // everything idle → sleep
  });

  it("Hard holds permanently while enabled, ignoring activity", () => {
    expect(caffeineDesired(true, "hard", false)).toBe(true); // idle but still awake
    expect(caffeineDesired(true, "hard", true)).toBe(true);
  });
});
