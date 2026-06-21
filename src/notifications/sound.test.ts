import { describe, it, expect, vi, afterEach } from "vitest";

// jsdom doesn't implement the Web Audio API, so this also exercises the
// "no AudioContext available" graceful-degradation path.
describe("sound", () => {
  afterEach(() => vi.restoreAllMocks());

  it("playChime is a no-op (never throws) when Web Audio is unavailable", async () => {
    vi.resetModules();
    const { playChime } = await import("./sound");
    expect(() => playChime("done")).not.toThrow();
    expect(() => playChime("attention")).not.toThrow();
  });

  it("primeAudioUnlock registers gesture listeners exactly once (idempotent)", async () => {
    vi.resetModules();
    const add = vi.spyOn(window, "addEventListener");
    const { primeAudioUnlock } = await import("./sound");
    primeAudioUnlock();
    primeAudioUnlock(); // second call must be a no-op (the `primed` guard)
    const pointer = add.mock.calls.filter((c) => c[0] === "pointerdown");
    const key = add.mock.calls.filter((c) => c[0] === "keydown");
    expect(pointer).toHaveLength(1);
    expect(key).toHaveLength(1);
  });
});
