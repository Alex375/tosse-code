import { describe, expect, it } from "vitest";
import { copyName, isWithin, joinPath, splitName, uniqueDest, validateName } from "./fileOps";

describe("joinPath", () => {
  it("joins with a single slash", () => {
    expect(joinPath("/a/b", "c.txt")).toBe("/a/b/c.txt");
    expect(joinPath("/a/b/", "c.txt")).toBe("/a/b/c.txt");
  });
});

describe("splitName", () => {
  it("splits a normal filename", () => {
    expect(splitName("file.txt")).toEqual({ stem: "file", ext: ".txt" });
    expect(splitName("a.b.c.ts")).toEqual({ stem: "a.b.c", ext: ".ts" });
  });
  it("treats an extensionless name as all stem", () => {
    expect(splitName("Makefile")).toEqual({ stem: "Makefile", ext: "" });
  });
  it("does not split a dotfile at the leading dot", () => {
    expect(splitName(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
  });
});

describe("copyName", () => {
  it("formats VS Code-style duplicate names", () => {
    expect(copyName("file.txt", 1)).toBe("file copy.txt");
    expect(copyName("file.txt", 2)).toBe("file copy 2.txt");
    expect(copyName("folder", 1)).toBe("folder copy");
    expect(copyName(".gitignore", 1)).toBe(".gitignore copy");
  });
});

describe("uniqueDest", () => {
  it("returns the bare path when nothing collides", async () => {
    const dest = await uniqueDest("/d", "a.txt", async () => false);
    expect(dest).toBe("/d/a.txt");
  });
  it("appends ' copy' then ' copy N' on collisions", async () => {
    const taken = new Set(["/d/a.txt", "/d/a copy.txt"]);
    const dest = await uniqueDest("/d", "a.txt", async (p) => taken.has(p));
    expect(dest).toBe("/d/a copy 2.txt");
  });
});

describe("isWithin", () => {
  it("detects a path inside (or equal to) an ancestor", () => {
    expect(isWithin("/a", "/a")).toBe(true);
    expect(isWithin("/a", "/a/b/c")).toBe(true);
    expect(isWithin("/a", "/ab")).toBe(false);
    expect(isWithin("/a", "/b")).toBe(false);
  });
});

describe("validateName", () => {
  it("accepts a normal name", () => {
    expect(validateName("hello.ts")).toBeNull();
  });
  it("rejects empty, reserved and separator-containing names", () => {
    expect(validateName("   ")).not.toBeNull();
    expect(validateName(".")).not.toBeNull();
    expect(validateName("..")).not.toBeNull();
    expect(validateName("a/b")).not.toBeNull();
  });
});
