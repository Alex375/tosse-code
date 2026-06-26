import { describe, expect, it } from "vitest";
import { resolveTranscriptSource, type TranscriptSourceInput } from "./transcriptSource";

// A finished, resolvable agent with nothing else going on — override per case.
const base: TranscriptSourceInput = {
  running: false,
  liveCount: 0,
  diskCount: 0,
  loading: false,
  error: false,
  resolvable: true,
};

describe("resolveTranscriptSource", () => {
  it("prefers the live sub-thread while running (no mid-run partial disk read)", () => {
    expect(
      resolveTranscriptSource({ ...base, running: true, liveCount: 3, diskCount: 2 }),
    ).toBe("live");
  });

  it("prefers the on-disk transcript once finished (authoritative)", () => {
    expect(resolveTranscriptSource({ ...base, liveCount: 3, diskCount: 5 })).toBe("disk");
  });

  it("falls back to live turns when finished with no disk yet (pre-resume)", () => {
    expect(resolveTranscriptSource({ ...base, liveCount: 4, diskCount: 0 })).toBe("live");
  });

  // The regression this task fixes: a running agent whose agent_id is unresolved
  // (so disk is unreadable) but whose live sub-thread exists must show LIVE, not
  // "indisponible". This is exactly the FlightDeck case that used to read disk only.
  it("shows live when disk is unreadable but live turns exist (FlightDeck regression)", () => {
    expect(
      resolveTranscriptSource({
        ...base,
        running: true,
        liveCount: 2,
        diskCount: 0,
        resolvable: false,
      }),
    ).toBe("live");
  });

  it("reports loading while a disk fetch is in flight and nothing is shown yet", () => {
    expect(resolveTranscriptSource({ ...base, loading: true })).toBe("loading");
  });

  it("reports error when the disk fetch failed and there is no live/disk content", () => {
    expect(resolveTranscriptSource({ ...base, error: true })).toBe("error");
  });

  it("reports working when running with neither live turns nor disk", () => {
    expect(resolveTranscriptSource({ ...base, running: true })).toBe("working");
  });

  it("reports unavailable when finished and unresolvable (resumed conversation)", () => {
    expect(resolveTranscriptSource({ ...base, resolvable: false })).toBe("unavailable");
  });

  it("reports empty when finished, resolvable, but nothing was ever written", () => {
    expect(resolveTranscriptSource(base)).toBe("empty");
  });

  it("loading takes precedence over the running/unavailable placeholders", () => {
    expect(
      resolveTranscriptSource({ ...base, running: true, loading: true, resolvable: false }),
    ).toBe("loading");
  });
});
