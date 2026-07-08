import { describe, expect, it } from "vitest";
import { splitLinks } from "./LinkText";

describe("splitLinks", () => {
  it("returns a single text segment when there is no URL", () => {
    expect(splitLinks("just some text")).toEqual([{ text: "just some text" }]);
  });

  it("extracts an http(s) URL as a link segment", () => {
    expect(splitLinks("go to https://example.com now")).toEqual([
      { text: "go to " },
      { text: "https://example.com", url: "https://example.com" },
      { text: " now" },
    ]);
  });

  it("trims trailing sentence punctuation off the URL", () => {
    expect(splitLinks("see https://example.com.")).toEqual([
      { text: "see " },
      { text: "https://example.com", url: "https://example.com" },
      { text: "." },
    ]);
  });

  it("trims an unbalanced trailing paren but keeps balanced ones", () => {
    expect(splitLinks("(https://example.com)")).toEqual([
      { text: "(" },
      { text: "https://example.com", url: "https://example.com" },
      { text: ")" },
    ]);
    // A URL that legitimately ends in a paren is preserved.
    const wiki = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(splitLinks(wiki)).toEqual([{ text: wiki, url: wiki }]);
  });

  it("handles multiple URLs", () => {
    const segs = splitLinks("a http://x.io b https://y.io c");
    expect(segs.filter((s) => s.url).map((s) => s.url)).toEqual([
      "http://x.io",
      "https://y.io",
    ]);
  });

  it("does not treat a bare domain (no scheme) as a link", () => {
    expect(splitLinks("example.com is a site")).toEqual([{ text: "example.com is a site" }]);
  });

  it("parses a Markdown link, showing the label and opening the url", () => {
    expect(splitLinks("voir [Google](https://google.com) ici")).toEqual([
      { text: "voir " },
      { text: "Google", url: "https://google.com" },
      { text: " ici" },
    ]);
  });

  it("handles a Markdown link and a bare URL together", () => {
    const segs = splitLinks("[docs](https://d.io) and https://raw.io/x");
    expect(segs).toEqual([
      { text: "docs", url: "https://d.io" },
      { text: " and " },
      { text: "https://raw.io/x", url: "https://raw.io/x" },
    ]);
  });

  it("does not half-eat a Markdown link as a bare URL", () => {
    // The whole [label](url) is consumed as one link — no leftover ")" text segment.
    expect(splitLinks("[x](https://y.io)")).toEqual([{ text: "x", url: "https://y.io" }]);
  });
});
