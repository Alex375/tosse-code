import { describe, it, expect } from "vitest";
import { fmtTokens } from "./contextData";

describe("fmtTokens", () => {
  it("renders raw counts below 1k", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(42)).toBe("42");
    expect(fmtTokens(999)).toBe("999");
  });

  it("renders thousands as k — integer with no decimal, otherwise one decimal", () => {
    expect(fmtTokens(1_000)).toBe("1k");
    expect(fmtTokens(29_756)).toBe("29.8k");
    expect(fmtTokens(200_000)).toBe("200k");
    expect(fmtTokens(999_949)).toBe("999.9k");
  });

  it("rounds up to '1M' just under the boundary instead of '1000.0k'", () => {
    // 999_950 / 1000 = 999.95 → the guard kicks in.
    expect(fmtTokens(999_950)).toBe("1M");
    expect(fmtTokens(999_999)).toBe("1M");
  });

  it("renders millions as M — integer with no decimal, otherwise one decimal", () => {
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(1_500_000)).toBe("1.5M");
    expect(fmtTokens(2_000_000)).toBe("2M");
  });
});
