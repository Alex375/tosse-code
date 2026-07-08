import { describe, expect, it } from "vitest";
import { baseName, dirName, isMarkdownPath, isPdfPath, languageForPath } from "./language";

describe("languageForPath", () => {
  it("maps common extensions to Monaco language ids", () => {
    expect(languageForPath("/r/src/main.rs")).toBe("rust");
    expect(languageForPath("/r/App.tsx")).toBe("typescript");
    expect(languageForPath("/r/index.js")).toBe("javascript");
    expect(languageForPath("/r/data.json")).toBe("json");
    expect(languageForPath("/r/notes.md")).toBe("markdown");
    expect(languageForPath("/r/styles.css")).toBe("css");
    expect(languageForPath("/r/config.yaml")).toBe("yaml");
  });

  it("recognises well-known filenames without a useful extension", () => {
    expect(languageForPath("/r/Dockerfile")).toBe("dockerfile");
    expect(languageForPath("/r/Makefile")).toBe("makefile");
    expect(languageForPath("/r/.gitignore")).toBe("ignore");
  });

  it("falls back to plaintext for unknown / extensionless files", () => {
    expect(languageForPath("/r/LICENSE")).toBe("plaintext");
    expect(languageForPath("/r/weird.xyz")).toBe("plaintext");
  });
});

describe("isMarkdownPath", () => {
  it("is true only for markdown extensions", () => {
    expect(isMarkdownPath("/r/README.md")).toBe(true);
    expect(isMarkdownPath("/r/doc.markdown")).toBe(true);
    expect(isMarkdownPath("/r/main.rs")).toBe(false);
  });
});

describe("isPdfPath", () => {
  it("is true only for a .pdf extension (case-insensitive)", () => {
    expect(isPdfPath("/r/report.pdf")).toBe(true);
    expect(isPdfPath("/r/REPORT.PDF")).toBe(true);
    expect(isPdfPath("/r/notes.md")).toBe(false);
    expect(isPdfPath("/r/pdf")).toBe(false);
    expect(isPdfPath("/r/archive.pdf.zip")).toBe(false);
  });
});

describe("baseName / dirName", () => {
  it("splits a path into its last segment and parent", () => {
    expect(baseName("/a/b/c.txt")).toBe("c.txt");
    expect(baseName("/a/b/")).toBe("b");
    expect(dirName("/a/b/c.txt")).toBe("/a/b");
    expect(dirName("/a")).toBe("/");
  });
});
