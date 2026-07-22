import { describe, expect, it } from "vitest";
import { artifactKind, isArtifactUrl } from "./artifactOpen";

describe("isArtifactUrl", () => {
  it("matches a canonical hosted-artifact URL", () => {
    expect(isArtifactUrl("https://claude.ai/code/artifact/acecfb35-f63b-49c3-b835-d0c856695a94")).toBe(true);
  });

  it("rejects other claude.ai URLs and non-artifact links", () => {
    expect(isArtifactUrl("https://claude.ai/code/artifacts")).toBe(false); // the gallery, not one artifact
    expect(isArtifactUrl("https://claude.ai/code/session_01ABC")).toBe(false);
    expect(isArtifactUrl("https://example.com/x")).toBe(false);
    expect(isArtifactUrl("/abs/path.html")).toBe(false);
    expect(isArtifactUrl(undefined)).toBe(false);
    expect(isArtifactUrl(null)).toBe(false);
  });

  it("is anchored — must START with the artifact URL, not merely contain it", () => {
    expect(isArtifactUrl("see https://claude.ai/code/artifact/abc")).toBe(false);
  });
});

describe("artifactKind", () => {
  it("md for .md/.markdown, html otherwise", () => {
    expect(artifactKind("/tmp/x.md")).toBe("md");
    expect(artifactKind("/tmp/x.MARKDOWN")).toBe("md");
    expect(artifactKind("/tmp/x.html")).toBe("html");
    expect(artifactKind("/tmp/x")).toBe("html");
    expect(artifactKind(null)).toBe("html");
  });
});
