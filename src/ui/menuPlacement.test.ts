import { describe, it, expect, beforeEach } from "vitest";
import { menuPortalPlacement } from "./kit";

// A minimal DOMRect for the trigger / popover.
const rect = (left: number, right: number, top = 400, bottom = 414): DOMRect =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect;

const VW = 1440;
const VH = 900;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: VW, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: VH, configurable: true });
});

describe("menuPortalPlacement", () => {
  const POP = rect(0, 320, 0, 200); // a wide (320px) popover, e.g. the goal popover

  it("keeps a right-aligned popover on-screen for a FAR-LEFT trigger (the goal-card bug)", () => {
    // A tiny goal button hugging the left of a far-left card.
    const pos = menuPortalPlacement(rect(30, 44), "right", false, POP);
    expect(typeof pos.left).toBe("number");
    const left = pos.left as number;
    expect(left).toBeGreaterThanOrEqual(8); // never off the left edge
    expect(left + POP.width).toBeLessThanOrEqual(VW - 8); // whole popover fits
  });

  it("keeps a right-aligned popover on-screen for a FAR-RIGHT trigger", () => {
    const pos = menuPortalPlacement(rect(1390, 1404), "right", false, POP);
    const left = pos.left as number;
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + POP.width).toBeLessThanOrEqual(VW - 8);
  });

  it("right-anchors to the trigger's right edge when there is room", () => {
    // Trigger comfortably mid-screen: the popover's right edge sits at the trigger's right edge.
    const pos = menuPortalPlacement(rect(700, 760), "right", false, POP);
    expect(pos.left).toBe(760 - POP.width);
  });
});
