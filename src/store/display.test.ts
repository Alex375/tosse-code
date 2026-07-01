import { describe, it, expect } from "vitest";
import { resolveCleanOutput } from "./display";

describe("resolveCleanOutput — per-conversation tristate", () => {
  it("inherits the global default when there is no override (null)", () => {
    expect(resolveCleanOutput(null, true)).toBe(true);
    expect(resolveCleanOutput(null, false)).toBe(false);
  });

  it("an explicit override wins over the global default", () => {
    // Opt IN even though the default is off…
    expect(resolveCleanOutput(true, false)).toBe(true);
    // …and, crucially, opt OUT even though the default is on.
    expect(resolveCleanOutput(false, true)).toBe(false);
  });
});
