import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP, withArtifactCsp } from "./artifactCsp";

/** Matches the injected element (attribute order/casing is fixed by the module). */
const META_RE = /<meta http-equiv="Content-Security-Policy" content="[^"]+">/;

/** Index of the injected meta, or -1. */
const metaAt = (s: string) => s.search(META_RE);

/** How many times the meta was injected (must always be exactly one). */
const metaCount = (s: string) => s.split('http-equiv="Content-Security-Policy"').length - 1;

describe("ARTIFACT_CSP", () => {
  it("denies everything by default and re-allows only inline / data / blob", () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("script-src 'unsafe-inline'");
    expect(ARTIFACT_CSP).toContain("style-src 'unsafe-inline'");
    expect(ARTIFACT_CSP).toContain("img-src data: blob:");
    expect(ARTIFACT_CSP).toContain("worker-src blob:");
  });

  it("blocks every network channel: no connections, no forms, no base rewrite", () => {
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_CSP).toContain("form-action 'none'");
    expect(ARTIFACT_CSP).toContain("base-uri 'none'");
  });

  it("names no external origin at all (the guarantee we copy from claude.ai)", () => {
    // A host or a network-capable scheme anywhere in the policy would silently re-open the door.
    expect(ARTIFACT_CSP).not.toMatch(/https?:|wss?:|\*|\.com|\.ai\b/);
  });

  it("stays under the 1024-byte charset sniffing window", () => {
    // The meta is spliced BEFORE a document's own <meta charset>; past 1024 bytes the browser
    // would stop looking for it and guess the encoding.
    expect(ARTIFACT_CSP.length).toBeLessThan(700);
  });
});

describe("withArtifactCsp placement", () => {
  it("inserts right after the doctype, AHEAD of the document's own head", () => {
    const src = "<!doctype html><html><head><title>a</title></head><body>x</body></html>";
    const out = withArtifactCsp(src);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(metaAt(out)).toBe("<!doctype html>".length);
    // Ahead of <head> itself, i.e. ahead of ANY token the parser could fetch from.
    expect(metaAt(out)).toBeLessThan(out.indexOf("<head>"));
    expect(metaCount(out)).toBe(1);
    expect(out.replace(META_RE, "")).toBe(src); // the artifact source is otherwise untouched
  });

  it("lands before a subresource the parser reaches BEFORE the explicit <head>", () => {
    // A meta CSP only governs resources requested after it is parsed. Here the parser opens an
    // IMPLIED head, fetches the script, then discards the explicit `<head>` token as a parse error
    // — so anchoring on `<head>` would put the policy behind the very request it must block.
    const out = withArtifactCsp(
      '<!doctype html><script src="https://attacker.example/evil.js"></script><html><head></head></html>',
    );
    expect(metaAt(out)).toBeLessThan(out.indexOf("<script"));
    expect(metaCount(out)).toBe(1);
  });

  it("ignores a <head that is not markup: inside a JS template literal", () => {
    // The Artifact tool tells the model to omit doctype/html/head, so a file is usually a FRAGMENT
    // — commonly one with an "export as HTML" button holding a whole document in a string. A
    // textual match there would emit the meta as inert characters (⇒ NO policy at all) and corrupt
    // the artifact's own code.
    const src = "<h1>Report</h1><script>const doc = `<!doctype html><html><head><meta charset=\"utf-8\">`;</script>";
    const out = withArtifactCsp(src);
    expect(metaAt(out)).toBe(0);
    expect(out.replace(META_RE, "")).toBe(src); // artifact source byte-identical, code intact
    expect(metaCount(out)).toBe(1);
  });

  it("ignores a <head that is not markup: inside an HTML comment", () => {
    const src = "<!-- old layout: <head><title>x</title></head> --><p>body</p>";
    const out = withArtifactCsp(src);
    expect(metaAt(out)).toBe(0);
    expect(out.replace(META_RE, "")).toBe(src);
  });

  it("still injects ahead of everything on uppercase markup", () => {
    const upper = withArtifactCsp("<!DOCTYPE HTML><HTML><HEAD><TITLE>a</TITLE></HEAD></HTML>");
    expect(upper.startsWith("<!DOCTYPE HTML>")).toBe(true);
    expect(metaAt(upper)).toBe("<!DOCTYPE HTML>".length);
    expect(upper).toContain("<HTML><HEAD><TITLE>a</TITLE></HEAD></HTML>");
  });

  it("keeps the doctype first when a licence comment precedes it", () => {
    // A leading comment run is still "first" to the parser, so the doctype after it is honoured —
    // splicing at index 0 would push it out of first position ⇒ quirks mode.
    const out = withArtifactCsp("<!-- (c) me -->\n<!doctype html><html><body>x</body></html>");
    expect(metaAt(out)).toBe("<!-- (c) me -->\n<!doctype html>".length);
    expect(out.startsWith("<!-- (c) me -->\n<!doctype html>")).toBe(true);
  });

  it("inserts after a leading doctype when there is no html tag", () => {
    const out = withArtifactCsp("<!doctype html>\n<p>bare</p>");
    // THE regression this guards: the doctype must still be the very first thing in the
    // document, else the browser drops into quirks mode and the artifact's layout shifts.
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(metaAt(out)).toBe("<!doctype html>".length);
    expect(out).toContain("<p>bare</p>");
  });

  it("tolerates whitespace before the doctype", () => {
    const out = withArtifactCsp("\n  <!doctype html>\n<p>x</p>");
    expect(out.indexOf("<!doctype html>")).toBeLessThan(metaAt(out));
    expect(metaAt(out)).toBe("\n  <!doctype html>".length);
  });

  it("prepends on a bare fragment (nothing to displace)", () => {
    const out = withArtifactCsp("<p>fragment</p>");
    expect(metaAt(out)).toBe(0);
    expect(out.endsWith("<p>fragment</p>")).toBe(true);
  });

  it("prepends on an empty document", () => {
    expect(metaAt(withArtifactCsp(""))).toBe(0);
  });

  it("leaves a document's own CSP meta in place (policies intersect, they don't override)", () => {
    const out = withArtifactCsp(
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>',
    );
    expect(metaCount(out)).toBe(2);
    // Ours comes first, so it is applied whatever the document declares afterwards.
    expect(out.indexOf(ARTIFACT_CSP)).toBeLessThan(out.indexOf("default-src *"));
  });
});
