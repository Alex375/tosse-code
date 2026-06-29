import { describe, expect, it } from "vitest";
import { faviconUrl, hostOf, parseWebSearch } from "./webResults";

// A trimmed but structurally faithful WebSearch result string, mirroring a real
// capture (header line + `Links:` JSON array + trailing model summary).
const REAL_WEBSEARCH = `Web search results for query: "pandas latest version 2026"

Links: [{"title":"[2026 Latest] Pandas 3.0 is Here - DEV Community","url":"https://dev.to/serada/pandas-30-is-here"},{"title":"What's new in 3.0.0 (January 21, 2026) — pandas documentation","url":"https://pandas.pydata.org/docs/whatsnew/v3.0.0.html"}]

Based on the search results, pandas 3.0 enforces Copy-on-Write.`;

describe("parseWebSearch", () => {
  it("extracts the query, the link list and the trailing summary", () => {
    const r = parseWebSearch(REAL_WEBSEARCH);
    expect(r.query).toBe("pandas latest version 2026");
    expect(r.links).toEqual([
      {
        title: "[2026 Latest] Pandas 3.0 is Here - DEV Community",
        url: "https://dev.to/serada/pandas-30-is-here",
      },
      {
        title: "What's new in 3.0.0 (January 21, 2026) — pandas documentation",
        url: "https://pandas.pydata.org/docs/whatsnew/v3.0.0.html",
      },
    ]);
    expect(r.summary).toBe("Based on the search results, pandas 3.0 enforces Copy-on-Write.");
  });

  it("handles a brackets-in-title link without ending the array early", () => {
    const text = `Links: [{"title":"Arrays [and] brackets","url":"https://x.test/a"}]`;
    const r = parseWebSearch(text);
    expect(r.links).toEqual([{ title: "Arrays [and] brackets", url: "https://x.test/a" }]);
  });

  it("falls back to the whole text as summary when there is no Links section", () => {
    const r = parseWebSearch("No results found for this query.");
    expect(r.links).toEqual([]);
    expect(r.summary).toBe("No results found for this query.");
  });

  it("keeps the text intact when the Links JSON is malformed (never hides content)", () => {
    const text = `Links: [{"title":"broken"`;
    const r = parseWebSearch(text);
    expect(r.links).toEqual([]);
    expect(r.summary).toBe(text);
  });

  it("falls back to the host (not the raw url) as the title when a link has no title", () => {
    const r = parseWebSearch(`Links: [{"url":"https://www.x.test/some/long/path"}]`);
    expect(r.links).toEqual([{ title: "x.test", url: "https://www.x.test/some/long/path" }]);
  });

  it("handles escaped quotes inside a title", () => {
    const r = parseWebSearch(`Links: [{"title":"He said \\"hi\\"","url":"https://x.test/a"}]`);
    expect(r.links).toEqual([{ title: 'He said "hi"', url: "https://x.test/a" }]);
  });

  it("treats a valid empty array as zero sources, not raw scaffolding", () => {
    const r = parseWebSearch(`Web search results for query: "nope"\n\nLinks: []`);
    expect(r.query).toBe("nope");
    expect(r.links).toEqual([]);
    // The empty array is authoritative: no chips AND no leaked `Links: []` text.
    expect(r.summary).toBe("");
  });
});

describe("hostOf", () => {
  it("strips the www. prefix", () => {
    expect(hostOf("https://www.example.com/path?q=1")).toBe("example.com");
  });
  it("keeps a bare host", () => {
    expect(hostOf("https://pandas.pydata.org/docs")).toBe("pandas.pydata.org");
  });
  it("returns the raw input when it isn't a URL", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("faviconUrl", () => {
  it("builds a Google S2 favicon url for a valid host", () => {
    expect(faviconUrl("https://dev.to/x")).toBe(
      "https://www.google.com/s2/favicons?domain=dev.to&sz=64",
    );
  });
  it("returns null for a non-url", () => {
    expect(faviconUrl("nope")).toBeNull();
  });
});
