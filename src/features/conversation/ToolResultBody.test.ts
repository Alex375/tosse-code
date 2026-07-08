import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../ipc/client";
import { imageBlocksFromContent, isEmptyResult } from "./ToolResultBody";

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

  it("treats an image-only result as textually empty (image is shown separately)", () => {
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ] as JsonValue;
    expect(isEmptyResult(content)).toBe(true);
  });
});

describe("imageBlocksFromContent", () => {
  it("extracts a base64 image block (the Read-a-screenshot case)", () => {
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ] as JsonValue;
    expect(imageBlocksFromContent(content)).toEqual([
      { mediaType: "image/png", dataBase64: "AAAA" },
    ]);
  });

  it("keeps text blocks out and preserves image order alongside text", () => {
    const content = [
      { type: "text", text: "Read image below" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "CCCC" } },
    ] as JsonValue;
    expect(imageBlocksFromContent(content)).toEqual([
      { mediaType: "image/jpeg", dataBase64: "BBBB" },
      { mediaType: "image/webp", dataBase64: "CCCC" },
    ]);
  });

  it("returns none for a string, an object, or a malformed image block", () => {
    expect(imageBlocksFromContent("plain text")).toEqual([]);
    expect(imageBlocksFromContent({ type: "image" } as JsonValue)).toEqual([]);
    // Missing / non-string source fields → skipped, never a broken data: URL.
    expect(
      imageBlocksFromContent([
        { type: "image", source: { type: "base64", media_type: "image/png" } },
        { type: "image", source: { type: "url", url: "http://x/y.png" } },
      ] as JsonValue),
    ).toEqual([]);
  });
});
