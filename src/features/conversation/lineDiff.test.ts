import { describe, expect, it } from "vitest";
import { diffCounts, lineDiff, type DiffLine } from "./lineDiff";

// Diff logic behind the Edit/MultiEdit file blocks (the `.lines` rows in
// DiffView). Pure LCS, so it's deterministic and worth locking down.

const types = (lines: DiffLine[]) => lines.map((l) => l.type);
const texts = (lines: DiffLine[]) => lines.map((l) => l.text);

describe("lineDiff", () => {
  it("marks every line as context when nothing changed", () => {
    const out = lineDiff("a\nb\nc", "a\nb\nc");
    expect(types(out)).toEqual(["context", "context", "context"]);
    // line numbers advance in lockstep on both sides
    expect(out.map((l) => [l.oldNo, l.newNo])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("emits a single add for an inserted line, keeping surrounding context", () => {
    const out = lineDiff("a\nc", "a\nb\nc");
    expect(types(out)).toEqual(["context", "add", "context"]);
    const added = out.find((l) => l.type === "add")!;
    expect(added.text).toBe("b");
    expect(added.oldNo).toBeNull(); // an addition has no old line number
    expect(added.newNo).toBe(2);
  });

  it("emits a single del for a removed line", () => {
    const out = lineDiff("a\nb\nc", "a\nc");
    expect(types(out)).toEqual(["context", "del", "context"]);
    const removed = out.find((l) => l.type === "del")!;
    expect(removed.text).toBe("b");
    expect(removed.oldNo).toBe(2);
    expect(removed.newNo).toBeNull(); // a deletion has no new line number
  });

  it("renders a replacement as del-then-add", () => {
    const out = lineDiff("a\nX\nc", "a\nY\nc");
    expect(types(out)).toEqual(["context", "del", "add", "context"]);
    expect(texts(out)).toEqual(["a", "X", "Y", "c"]);
  });

  it("handles a fully replaced single line (no common context)", () => {
    const out = lineDiff("old", "new");
    expect(types(out)).toEqual(["del", "add"]);
    expect(texts(out)).toEqual(["old", "new"]);
  });
});

describe("diffCounts", () => {
  it("counts adds and dels, ignoring context", () => {
    const out = lineDiff("a\nX\nc", "a\nY\nc"); // 1 del + 1 add + 2 context
    expect(diffCounts(out)).toEqual({ added: 1, removed: 1 });
  });

  it("is zero for an unchanged block", () => {
    expect(diffCounts(lineDiff("a\nb", "a\nb"))).toEqual({ added: 0, removed: 0 });
  });

  it("counts a pure insertion as added only", () => {
    expect(diffCounts(lineDiff("a\nc", "a\nb\nc"))).toEqual({ added: 1, removed: 0 });
  });
});
