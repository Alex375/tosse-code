import { describe, expect, it } from "vitest";
import { looksLikeFile, looksLikePath, segmentPath } from "./pathSegments";

describe("looksLikePath", () => {
  it("treats slash-bearing tokens as paths", () => {
    expect(looksLikePath("src/a/b.ts")).toBe(true);
    expect(looksLikePath("/abs/path")).toBe(true);
  });
  it("leaves bare tokens plain (avoids false positives)", () => {
    expect(looksLikePath("package.json")).toBe(false);
    expect(looksLikePath("array.map")).toBe(false);
    expect(looksLikePath("control_request")).toBe(false);
  });
});

describe("segmentPath", () => {
  it("splits dirs / filename", () => {
    expect(segmentPath("src/features/StreamMarkdown.tsx")).toEqual({
      dirs: ["src", "features"],
      file: "StreamMarkdown.tsx",
      line: "",
    });
  });

  it("peels a trailing :line suffix", () => {
    expect(segmentPath("src/supervisor/assembler.rs:142")).toEqual({
      dirs: ["src", "supervisor"],
      file: "assembler.rs",
      line: ":142",
    });
  });

  it("peels a :line:col suffix", () => {
    expect(segmentPath("a/b.ts:12:5")).toEqual({ dirs: ["a"], file: "b.ts", line: ":12:5" });
  });

  it("keeps a leading empty segment for absolute paths (so the / prefix renders)", () => {
    expect(segmentPath("/Users/x/file.ts")).toEqual({
      dirs: ["", "Users", "x"],
      file: "file.ts",
      line: "",
    });
  });

  it("handles a bare filename (no dirs)", () => {
    expect(segmentPath("README.md")).toEqual({ dirs: [], file: "README.md", line: "" });
  });

  it("does not mistake a dotted version for a line suffix", () => {
    // ':' is required for the line suffix; a plain filename is untouched.
    expect(segmentPath("src/v1.2/x.ts")).toEqual({ dirs: ["src", "v1.2"], file: "x.ts", line: "" });
  });

  it("strips a leading ./ (no bogus '.' directory segment)", () => {
    expect(segmentPath("./src/a.ts")).toEqual({ dirs: ["src"], file: "a.ts", line: "" });
  });
});

describe("looksLikeFile", () => {
  it("true when the last segment has an extension", () => {
    expect(looksLikeFile("StreamMarkdown.tsx")).toBe(true);
    expect(looksLikeFile("assembler.rs")).toBe(true);
  });
  it("false for a directory-shaped last segment", () => {
    expect(looksLikeFile("features")).toBe(false);
    expect(looksLikeFile("conversation")).toBe(false);
  });
});
