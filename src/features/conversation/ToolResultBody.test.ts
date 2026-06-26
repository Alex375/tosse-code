import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../ipc/client";
import { isEmptyResult } from "./ToolResultBody";

describe("isEmptyResult", () => {
  it("treats null / empty / whitespace content as no output", () => {
    expect(isEmptyResult(null)).toBe(true);
    expect(isEmptyResult("")).toBe(true);
    expect(isEmptyResult("   \n  ")).toBe(true);
    // An array of empty text blocks (a command that printed nothing).
    expect(isEmptyResult([{ type: "text", text: "" }] as JsonValue)).toBe(true);
  });

  it("treats real content as output", () => {
    expect(isEmptyResult("done")).toBe(false);
    expect(isEmptyResult([{ type: "text", text: "ok" }] as JsonValue)).toBe(false);
  });
});
