import { describe, it, expect } from "vitest";
import type { JsonValue } from "../../ipc/client";
import { resultContentText } from "./resultText";

describe("resultContentText", () => {
  it("passes a plain string through", () => {
    expect(resultContentText("hello")).toBe("hello");
  });

  it("joins the .text of each text block in a content-block array", () => {
    const content = [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ] as unknown as JsonValue;
    expect(resultContentText(content)).toBe("one\ntwo");
  });

  it("ignores non-text blocks and returns null when none carry text", () => {
    const content = [{ type: "image", source: {} }] as unknown as JsonValue;
    expect(resultContentText(content)).toBeNull();
  });

  it("returns null for an empty array and for non-string/non-array content", () => {
    expect(resultContentText([] as unknown as JsonValue)).toBeNull();
    expect(resultContentText(null)).toBeNull();
    expect(resultContentText(42 as unknown as JsonValue)).toBeNull();
  });
});
