import { describe, it, expect } from "vitest";
import {
  THINKING_TIERS,
  THINKING_ANCHOR,
  ANCHOR_MS,
  ROTATE_MS,
  tierForThinkingMs,
  thinkingWord,
} from "./thinkingWords";

const MIN = 60_000;

describe("tierForThinkingMs", () => {
  it("maps cumulative thinking time to the 4 tiers (40s-2min / 2-6min / 6-15min / 15min+)", () => {
    expect(tierForThinkingMs(ANCHOR_MS)).toBe(1); // 40s
    expect(tierForThinkingMs(119_999)).toBe(1);
    expect(tierForThinkingMs(2 * MIN)).toBe(2);
    expect(tierForThinkingMs(5 * MIN)).toBe(2);
    expect(tierForThinkingMs(6 * MIN)).toBe(3);
    expect(tierForThinkingMs(14 * MIN)).toBe(3);
    expect(tierForThinkingMs(15 * MIN)).toBe(4);
  });

  it("caps at the last tier forever", () => {
    expect(tierForThinkingMs(60 * MIN)).toBe(4);
    expect(tierForThinkingMs(9_999 * MIN)).toBe(THINKING_TIERS.length);
  });
});

describe("thinkingWord", () => {
  const seed = "conv-1";

  it("shows the literal anchor for the first 40s of cumulative thinking", () => {
    expect(thinkingWord(0, 1, seed)).toBe(THINKING_ANCHOR);
    expect(thinkingWord(ANCHOR_MS - 1, 7, seed)).toBe(THINKING_ANCHOR);
    expect(thinkingWord(ANCHOR_MS - 1, 7, "other")).toBe(THINKING_ANCHOR);
  });

  it("past the anchor, never shows the plain 'Thinking' (reserved for the anchor)", () => {
    for (let ms = ANCHOR_MS; ms < 3 * MIN; ms += 7000) {
      for (let t = 1; t <= 5; t++) expect(thinkingWord(ms, t, seed)).not.toBe("Thinking");
    }
  });

  it("draws from the tier matching the cumulative time", () => {
    expect(THINKING_TIERS[0]).toContain(thinkingWord(1 * MIN, 1, seed)); // tier 1
    expect(THINKING_TIERS[1]).toContain(thinkingWord(3 * MIN, 1, seed)); // tier 2
    expect(THINKING_TIERS[2]).toContain(thinkingWord(8 * MIN, 1, seed)); // tier 3
    expect(THINKING_TIERS[3]).toContain(thinkingWord(20 * MIN, 1, seed)); // tier 4
  });

  it("is deterministic and stable WITHIN a 40s bucket + turn (no flicker every render)", () => {
    // 130_000 and 155_000 fall in the same ROTATE_MS bucket (both floor to 3) and same tier.
    expect(Math.floor(130_000 / ROTATE_MS)).toBe(Math.floor(155_000 / ROTATE_MS));
    expect(thinkingWord(130_000, 3, seed)).toBe(thinkingWord(155_000, 3, seed));
  });

  it("re-draws on a new turn (per-turn seed)", () => {
    const words = new Set<string>();
    for (let t = 1; t <= 12; t++) words.add(thinkingWord(3 * MIN, t, seed));
    expect(words.size).toBeGreaterThan(1); // turns yield variety at a fixed time
  });

  it("re-draws every 40s bucket while thinking continues", () => {
    const words = new Set<string>();
    // Six consecutive 40s buckets, all inside tier 2 (2-6min).
    for (let ms = 2 * MIN; ms < 5 * MIN; ms += ROTATE_MS) words.add(thinkingWord(ms, 1, seed));
    expect(words.size).toBeGreaterThan(1);
  });
});

describe("word list sanity", () => {
  const all = THINKING_TIERS.flat();

  it("every word ends in -ing", () => {
    expect(all.filter((w) => !w.toLowerCase().endsWith("ing"))).toEqual([]);
  });

  it("starts with Thinking and has no duplicates across tiers", () => {
    expect(THINKING_TIERS[0][0]).toBe("Thinking");
    expect(new Set(all).size).toBe(all.length);
  });
});
