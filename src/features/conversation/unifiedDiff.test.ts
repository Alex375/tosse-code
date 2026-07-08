import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../ipc/client";
import { applyPatchChanges, parseUnifiedDiff } from "./unifiedDiff";
import { diffCounts } from "./lineDiff";

describe("parseUnifiedDiff", () => {
  it("parses a modify hunk into add/del/context with correct gutters", () => {
    const diff = ["@@ -1,3 +1,3 @@", " keep", "-old", "+new", " tail"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: "context", text: "keep", oldNo: 1, newNo: 1 },
      { type: "del", text: "old", oldNo: 2, newNo: null },
      { type: "add", text: "new", oldNo: null, newNo: 2 },
      { type: "context", text: "tail", oldNo: 3, newNo: 3 },
    ]);
  });

  it("counts adds and removals", () => {
    const diff = ["@@ -1,2 +1,3 @@", " a", "-b", "+c", "+d"].join("\n");
    expect(diffCounts(parseUnifiedDiff(diff))).toEqual({ added: 2, removed: 1 });
  });

  it("seeds line numbers from the hunk header (not always 1)", () => {
    const diff = ["@@ -40,2 +50,2 @@", " ctx", "+added"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: "context", text: "ctx", oldNo: 40, newNo: 50 },
      { type: "add", text: "added", oldNo: null, newNo: 51 },
    ]);
  });

  it("handles a header with omitted counts (@@ -1 +1 @@)", () => {
    const diff = ["@@ -1 +1 @@", "-x", "+y"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: "del", text: "x", oldNo: 1, newNo: null },
      { type: "add", text: "y", oldNo: null, newNo: 1 },
    ]);
  });

  it("skips git file headers before the first hunk so --- / +++ aren't read as content", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "index 000..111 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-was",
      "+is",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: "del", text: "was", oldNo: 1, newNo: null },
      { type: "add", text: "is", oldNo: null, newNo: 1 },
    ]);
  });

  it("parses a new-file diff (all adds) from a /dev/null hunk", () => {
    const diff = ["@@ -0,0 +1,2 @@", "+line one", "+line two"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: "add", text: "line one", oldNo: null, newNo: 1 },
      { type: "add", text: "line two", oldNo: null, newNo: 2 },
    ]);
  });

  it("spans multiple hunks, re-seeding line numbers each time", () => {
    const diff = ["@@ -1,1 +1,1 @@", "-a", "+A", "@@ -10,1 +10,1 @@", "-b", "+B"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: "del", text: "a", oldNo: 1, newNo: null },
      { type: "add", text: "A", oldNo: null, newNo: 1 },
      { type: "del", text: "b", oldNo: 10, newNo: null },
      { type: "add", text: "B", oldNo: null, newNo: 10 },
    ]);
  });

  it("drops the 'No newline at end of file' marker and a trailing empty line", () => {
    const diff = "@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n";
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: "del", text: "a", oldNo: 1, newNo: null },
      { type: "add", text: "b", oldNo: null, newNo: 1 },
    ]);
  });

  it("preserves an empty context line encoded as a bare space", () => {
    const diff = ["@@ -1,2 +1,2 @@", " ", "+x"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: "context", text: "", oldNo: 1, newNo: 1 },
      { type: "add", text: "x", oldNo: null, newNo: 2 },
    ]);
  });

  it("returns [] for empty or header-only input (never throws)", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x")).toEqual([]);
  });
});

describe("applyPatchChanges", () => {
  const change = (path: string, diff: string): JsonValue => ({ path, kind: { type: "modify" }, diff });

  it("prefers the result's changes over the (possibly frozen-empty) input", () => {
    const input: JsonValue = { changes: [] };
    const result: JsonValue = { status: "completed", changes: [change("a.rs", "@@ -1 +1 @@\n-a\n+b")] };
    expect(applyPatchChanges(input, result)).toEqual([{ path: "a.rs", diff: "@@ -1 +1 @@\n-a\n+b" }]);
  });

  it("falls back to the input when there is no result yet (running card)", () => {
    const input: JsonValue = { changes: [change("b.rs", "@@ -1 +1 @@\n-x\n+y")] };
    expect(applyPatchChanges(input, undefined)).toEqual([{ path: "b.rs", diff: "@@ -1 +1 @@\n-x\n+y" }]);
  });

  it("returns [] for a malformed payload (no changes array anywhere)", () => {
    expect(applyPatchChanges({ foo: 1 } as JsonValue, "oops" as JsonValue)).toEqual([]);
    expect(applyPatchChanges(null as unknown as JsonValue, undefined)).toEqual([]);
  });

  it("tolerates change entries missing path or diff", () => {
    const result: JsonValue = { changes: [{ kind: { type: "add" } }, change("c.rs", "@@ -0,0 +1 @@\n+z")] };
    expect(applyPatchChanges({ changes: [] } as JsonValue, result)).toEqual([
      { path: "", diff: "" },
      { path: "c.rs", diff: "@@ -0,0 +1 @@\n+z" },
    ]);
  });
});
