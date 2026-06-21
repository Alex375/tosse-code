import { beforeEach, describe, expect, it } from "vitest";
import {
  AT_BOTTOM_PX,
  clampRestoreTop,
  clearScrollMemory,
  initialTarget,
  nextFollowing,
  readScrollMemo,
  writeScrollMemo,
} from "./scrollMemory";

describe("initialTarget — where a conversation opens", () => {
  it("no memory yet (first open) → bottom, following", () => {
    expect(initialTarget(undefined)).toEqual({ following: true, restoreTop: null });
  });

  it("left while pinned to the bottom → bottom, following", () => {
    expect(initialTarget({ top: 4200, atBottom: true })).toEqual({
      following: true,
      restoreTop: null,
    });
  });

  it("left scrolled up to a spot → restore that exact offset, not following", () => {
    expect(initialTarget({ top: 1200, atBottom: false })).toEqual({
      following: false,
      restoreTop: 1200,
    });
  });
});

describe("nextFollowing — the scroll handler's follow-state transition", () => {
  // Tall content: scrollHeight 5000, viewport 800 → max scrollTop 4200.
  const H = 5000;
  const VH = 800;

  it("engages following within AT_BOTTOM_PX of the bottom, even if it was off", () => {
    const top = H - VH - (AT_BOTTOM_PX - 1); // dist = 49 < 50
    expect(nextFollowing(false, 0, top, H, VH)).toBe(true);
  });

  it("disengages when the user scrolls UP and away from the bottom", () => {
    // Was at the bottom (lastTop 4200), now scrolled up to 400 (dist 3800).
    expect(nextFollowing(true, 4200, 400, H, VH)).toBe(false);
  });

  it("scrolling DOWN while still above the bottom never disengages", () => {
    // top grew (1000 → 2000) but we're still far from the bottom: keep following.
    expect(nextFollowing(true, 1000, 2000, H, VH)).toBe(true);
  });

  it("staying put above the bottom keeps the previous state", () => {
    expect(nextFollowing(false, 2000, 2000, H, VH)).toBe(false);
    expect(nextFollowing(true, 2000, 2000, H, VH)).toBe(true);
  });

  it("exactly AT_BOTTOM_PX away is NOT 'at the bottom' (strict <)", () => {
    const top = H - VH - AT_BOTTOM_PX; // dist = 50, not < 50
    // Scrolling up to here from below → disengage.
    expect(nextFollowing(true, 4200, top, H, VH)).toBe(false);
  });
});

describe("clampRestoreTop — fit a remembered offset to the current content", () => {
  it("keeps an offset inside the scrollable range", () => {
    expect(clampRestoreTop(1200, 5000, 800)).toBe(1200);
  });

  it("clamps a negative offset to 0", () => {
    expect(clampRestoreTop(-50, 5000, 800)).toBe(0);
  });

  it("clamps past the bottom to the max scrollTop", () => {
    expect(clampRestoreTop(99999, 5000, 800)).toBe(4200);
  });

  it("content shorter than the viewport clamps to 0", () => {
    expect(clampRestoreTop(300, 600, 800)).toBe(0);
  });
});

describe("scroll memory — reopening returns to where the user left off", () => {
  beforeEach(() => clearScrollMemory());

  const H = 5000;
  const VH = 800;

  it("first open is the bottom; after scrolling up, reopening returns to that spot", () => {
    // First open of A: no memory → bottom.
    expect(initialTarget(readScrollMemo("A"))).toEqual({ following: true, restoreTop: null });

    // User scrolls up from the bottom (4200) to 400, and we persist it.
    const following = nextFollowing(true, 4200, 400, H, VH);
    expect(following).toBe(false);
    writeScrollMemo("A", { top: 400, atBottom: following });

    // Reopening A returns to exactly 400.
    expect(initialTarget(readScrollMemo("A"))).toEqual({ following: false, restoreTop: 400 });
  });

  it("each conversation remembers its own position independently", () => {
    writeScrollMemo("A", { top: 400, atBottom: false });
    // B was never opened → still defaults to the bottom.
    expect(initialTarget(readScrollMemo("B"))).toEqual({ following: true, restoreTop: null });
    expect(initialTarget(readScrollMemo("A"))).toEqual({ following: false, restoreTop: 400 });
  });

  it("scrolling back to the bottom makes the next open land at the bottom again", () => {
    writeScrollMemo("A", { top: 400, atBottom: false });
    // Back down to the bottom: following re-engages, persisted as atBottom.
    const following = nextFollowing(false, 400, 4200, H, VH);
    expect(following).toBe(true);
    writeScrollMemo("A", { top: 4200, atBottom: following });
    expect(initialTarget(readScrollMemo("A"))).toEqual({ following: true, restoreTop: null });
  });
});
