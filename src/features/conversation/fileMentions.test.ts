import { describe, expect, it } from "vitest";
import { normalizePosix, parseFileMention, resolveMentionAbs } from "./fileMentions";

describe("parseFileMention", () => {
  it("detects a relative path with an extension", () => {
    expect(parseFileMention("src/features/editor/editorStore.ts")).toEqual({
      path: "src/features/editor/editorStore.ts",
    });
  });

  it("detects an absolute path", () => {
    expect(parseFileMention("/Users/a/repo/src/foo.rs")).toEqual({
      path: "/Users/a/repo/src/foo.rs",
    });
  });

  it("detects a bare filename with an extension", () => {
    expect(parseFileMention("package.json")).toEqual({ path: "package.json" });
  });

  it("splits a :line suffix", () => {
    expect(parseFileMention("src/foo.ts:42")).toEqual({ path: "src/foo.ts", line: 42 });
  });

  it("splits a :line:col suffix", () => {
    expect(parseFileMention("src/foo.ts:42:7")).toEqual({
      path: "src/foo.ts",
      line: 42,
      column: 7,
    });
  });

  it("keeps ./ and ../ prefixes", () => {
    expect(parseFileMention("./a.ts")).toEqual({ path: "./a.ts" });
    expect(parseFileMention("../b/c.ts")).toEqual({ path: "../b/c.ts" });
  });

  it("detects bare dotfiles", () => {
    expect(parseFileMention(".gitignore")).toEqual({ path: ".gitignore" });
    expect(parseFileMention(".env")).toEqual({ path: ".env" });
    expect(parseFileMention(".eslintrc")).toEqual({ path: ".eslintrc" });
    expect(parseFileMention("src/.gitignore")).toEqual({ path: "src/.gitignore" });
  });

  it("detects extensionless files when the token is path-shaped (slash or absolute)", () => {
    expect(parseFileMention("src/Makefile")).toEqual({ path: "src/Makefile" });
    expect(parseFileMention(".github/CODEOWNERS")).toEqual({ path: ".github/CODEOWNERS" });
    expect(parseFileMention("/Users/a/repo/Dockerfile")).toEqual({
      path: "/Users/a/repo/Dockerfile",
    });
  });

  it("rejects a bare extensionless word (too ambiguous from prose)", () => {
    expect(parseFileMention("Makefile")).toBeNull();
    expect(parseFileMention("LICENSE")).toBeNull();
  });

  it("rejects ordinary inline-code identifiers", () => {
    expect(parseFileMention("useState")).toBeNull(); // no extension
    expect(parseFileMention("const x = 1")).toBeNull(); // has whitespace
    expect(parseFileMention("toggleTree()")).toBeNull(); // trailing () is not an extension
  });

  it("rejects version numbers (digit-led extension)", () => {
    expect(parseFileMention("1.2.3")).toBeNull();
    expect(parseFileMention("v0.11.0")).toBeNull();
  });

  it("rejects URLs", () => {
    expect(parseFileMention("https://example.com/a.ts")).toBeNull();
    expect(parseFileMention("file:///tmp/x.ts")).toBeNull();
  });

  it("rejects tokens with whitespace", () => {
    expect(parseFileMention("a b.ts")).toBeNull();
    expect(parseFileMention("  ")).toBeNull();
  });

  it("rejects a bare time like 12:30", () => {
    expect(parseFileMention("12:30")).toBeNull();
  });
});

describe("resolveMentionAbs", () => {
  it("returns absolute paths untouched", () => {
    expect(resolveMentionAbs("/repo", "/abs/x.ts")).toBe("/abs/x.ts");
  });

  it("joins a relative path to the cwd", () => {
    expect(resolveMentionAbs("/repo", "src/x.ts")).toBe("/repo/src/x.ts");
  });

  it("drops a leading ./", () => {
    expect(resolveMentionAbs("/repo", "./src/x.ts")).toBe("/repo/src/x.ts");
  });

  it("normalises a trailing slash on the cwd", () => {
    expect(resolveMentionAbs("/repo/", "src/x.ts")).toBe("/repo/src/x.ts");
  });

  it("collapses .. and . segments to one canonical path", () => {
    expect(resolveMentionAbs("/repo/src", "../x.ts")).toBe("/repo/x.ts");
    expect(resolveMentionAbs("/repo", "../b/c.ts")).toBe("/b/c.ts");
    expect(resolveMentionAbs("/repo", "a/./b/../c.ts")).toBe("/repo/a/c.ts");
    expect(resolveMentionAbs("/repo", "/abs/../x.ts")).toBe("/x.ts");
  });
});

// Exported for the mention existence cache: it canonicalises raw fs-watcher paths to
// the SAME key shape used for cache lookups, so invalidation matches (see mentionCache).
describe("normalizePosix", () => {
  it("drops '.' and empty segments", () => {
    expect(normalizePosix("/repo/src/./late.ts")).toBe("/repo/src/late.ts");
    expect(normalizePosix("/a//b")).toBe("/a/b");
    expect(normalizePosix("/a/b/")).toBe("/a/b");
  });

  it("collapses '..' against the preceding segment", () => {
    expect(normalizePosix("/a/b/../c")).toBe("/a/c");
    expect(normalizePosix("/a/b/c/../../d")).toBe("/a/d");
  });

  it("leaves leading '..' in a relative path (can't climb above the root)", () => {
    expect(normalizePosix("../x.ts")).toBe("../x.ts");
    expect(normalizePosix("a/../../x")).toBe("../x");
  });

  it("clamps '..' at an absolute root", () => {
    expect(normalizePosix("/../x")).toBe("/x");
    expect(normalizePosix("/")).toBe("/");
  });

  it("is idempotent on an already-canonical path", () => {
    expect(normalizePosix("/repo/src/late.ts")).toBe("/repo/src/late.ts");
  });
});
