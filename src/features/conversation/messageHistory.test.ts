import { describe, expect, it } from "vitest";
import {
  IDLE_NAV,
  caretOnFirstLine,
  caretOnLastLine,
  recallNext,
  recallPrev,
  type HistoryNav,
} from "./messageHistory";

const HIST = ["first", "second", "third"]; // oldest → newest

describe("recallPrev — ↑ walks toward older messages", () => {
  it("from idle, stashes the draft and jumps to the most recent message", () => {
    const res = recallPrev(HIST, IDLE_NAV, "my draft");
    expect(res).toEqual({ nav: { index: 2, stash: "my draft" }, text: "third" });
  });

  it("steps one message older on each call", () => {
    const a = recallPrev(HIST, { index: 2, stash: "d" }, "third");
    expect(a).toEqual({ nav: { index: 1, stash: "d" }, text: "second" });
    const b = recallPrev(HIST, a!.nav, "second");
    expect(b).toEqual({ nav: { index: 0, stash: "d" }, text: "first" });
  });

  it("returns null at the oldest message (let the caret fall through)", () => {
    expect(recallPrev(HIST, { index: 0, stash: "d" }, "first")).toBeNull();
  });

  it("returns null when there is no history", () => {
    expect(recallPrev([], IDLE_NAV, "draft")).toBeNull();
  });

  it("preserves the original stash across multiple ↑ steps", () => {
    const a = recallPrev(HIST, IDLE_NAV, "keep me");
    const b = recallPrev(HIST, a!.nav, "third");
    expect(b!.nav.stash).toBe("keep me");
  });
});

describe("recallNext — ↓ walks toward newer messages", () => {
  it("returns null when not navigating (idle)", () => {
    expect(recallNext(HIST, IDLE_NAV)).toBeNull();
  });

  it("steps one message newer", () => {
    expect(recallNext(HIST, { index: 0, stash: "d" })).toEqual({
      nav: { index: 1, stash: "d" },
      text: "second",
    });
  });

  it("stepping past the newest restores the stashed draft and returns to idle", () => {
    expect(recallNext(HIST, { index: 2, stash: "my draft" })).toEqual({
      nav: IDLE_NAV,
      text: "my draft",
    });
  });

  it("round trip ↑ then ↓ returns to the original draft", () => {
    const up = recallPrev(HIST, IDLE_NAV, "original");
    const down = recallNext(HIST, up!.nav);
    expect(down).toEqual({ nav: IDLE_NAV, text: "original" });
  });
});

describe("caret-edge guards", () => {
  it("caretOnFirstLine: true on the first line, false below it", () => {
    expect(caretOnFirstLine("abc", 0)).toBe(true);
    expect(caretOnFirstLine("abc", 3)).toBe(true);
    expect(caretOnFirstLine("ab\ncd", 1)).toBe(true); // before the newline
    expect(caretOnFirstLine("ab\ncd", 4)).toBe(false); // on the second line
    expect(caretOnFirstLine("", 0)).toBe(true);
  });

  it("caretOnLastLine: true on the last line, false above it", () => {
    expect(caretOnLastLine("abc", 3)).toBe(true);
    expect(caretOnLastLine("ab\ncd", 4)).toBe(true); // on the second/last line
    expect(caretOnLastLine("ab\ncd", 1)).toBe(false); // on the first line
    expect(caretOnLastLine("", 0)).toBe(true);
  });
});

describe("integration — a full ↑↑↓ navigation", () => {
  it("walks back twice then forward once, draft intact throughout", () => {
    let nav: HistoryNav = IDLE_NAV;
    const r1 = recallPrev(HIST, nav, "draft")!; // → third
    nav = r1.nav;
    const r2 = recallPrev(HIST, nav, r1.text)!; // → second
    nav = r2.nav;
    const r3 = recallNext(HIST, nav)!; // → third
    nav = r3.nav;
    expect([r1.text, r2.text, r3.text]).toEqual(["third", "second", "third"]);
    expect(nav).toEqual({ index: 2, stash: "draft" });
  });
});
