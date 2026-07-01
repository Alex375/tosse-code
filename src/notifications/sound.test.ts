import { describe, it, expect, vi, afterEach } from "vitest";

// jsdom doesn't implement the Web Audio API, so this also exercises the
// "no AudioContext available" graceful-degradation path.
describe("sound", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

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

// The reliability fix: a SUSPENDED context (WKWebView backgrounded / pre-gesture)
// must be resume()d BEFORE the notes are scheduled, otherwise they're silently
// dropped. A minimal fake AudioContext lets us assert the ordering under jsdom.
describe("sound — suspended AudioContext is resumed before scheduling", () => {
  const audioParam = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

  /** A fake context whose resume() flips `state` to "running" ASYNCHRONOUSLY (on a
   *  microtask), like the real one — so scheduling before the await would see it
   *  still suspended, which is exactly the bug we guard against. */
  function makeFakeAudio(initial: "suspended" | "running") {
    const oscillators: Array<{ start: ReturnType<typeof vi.fn> }> = [];
    const ctx = {
      state: initial as string,
      currentTime: 0,
      resume: vi.fn(function (this: { state: string }) {
        return Promise.resolve().then(() => {
          this.state = "running";
        });
      }),
      createGain: () => ({ gain: audioParam(), ...node() }),
      createBiquadFilter: () => ({ type: "", frequency: { value: 0 }, Q: { value: 0 }, ...node() }),
      createOscillator: () => {
        const osc = { type: "", frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(), ...node() };
        oscillators.push(osc);
        return osc;
      },
      destination: node(),
    };
    return { ctx, oscillators };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it("resumes first, then lays down the notes once running", async () => {
    vi.resetModules();
    const { ctx, oscillators } = makeFakeAudio("suspended");
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      return ctx;
    };
    const { playChime } = await import("./sound");

    playChime("done");
    expect(ctx.resume).toHaveBeenCalled();
    // Nothing scheduled yet — the context is still suspended synchronously.
    expect(oscillators).toHaveLength(0);

    // Let the resume() microtask (and the chained scheduling) settle.
    await new Promise((r) => setTimeout(r));
    expect(ctx.state).toBe("running");
    expect(oscillators.length).toBeGreaterThan(0);
    for (const osc of oscillators) expect(osc.start).toHaveBeenCalled();
  });

  it("schedules inline (no wait) when the context is already running", async () => {
    vi.resetModules();
    const { ctx, oscillators } = makeFakeAudio("running");
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      return ctx;
    };
    const { playChime } = await import("./sound");

    playChime("attention");
    // Already running → notes are laid down synchronously, no resume-gate needed.
    expect(oscillators.length).toBeGreaterThan(0);
    for (const osc of oscillators) expect(osc.start).toHaveBeenCalled();
  });
});
