import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IPC boundary: a controllable pathExists + a no-op fs-change listener.
vi.mock("../../ipc/client", () => ({
  commands: { pathExists: vi.fn() },
  events: { fsChangeEvent: { listen: vi.fn(async () => () => {}) } },
}));

import {
  cachedStatus,
  clearMentionCache,
  ensureMentionChecked,
  invalidateMentions,
  subscribeMention,
} from "./mentionCache";
import { commands, events } from "../../ipc/client";

const pathExists = commands.pathExists as unknown as ReturnType<typeof vi.fn>;
const listen = events.fsChangeEvent.listen as unknown as ReturnType<typeof vi.fn>;

/** Flush the pathExists promise chain (.then/.catch/.finally). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  clearMentionCache();
  pathExists.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureMentionChecked", () => {
  it("checks a path once and caches 'exists'", async () => {
    pathExists.mockResolvedValue(true);
    expect(cachedStatus("/repo/a.ts")).toBeUndefined();

    ensureMentionChecked("/repo/a.ts");
    await tick();

    expect(cachedStatus("/repo/a.ts")).toBe("exists");
    // A second call is a no-op — the path is already cached (one syscall per path).
    ensureMentionChecked("/repo/a.ts");
    await tick();
    expect(pathExists).toHaveBeenCalledTimes(1);
  });

  it("caches 'missing' when the file does not exist", async () => {
    pathExists.mockResolvedValue(false);
    ensureMentionChecked("/repo/ghost.ts");
    await tick();
    expect(cachedStatus("/repo/ghost.ts")).toBe("missing");
  });

  it("caches 'missing' when the existence check throws", async () => {
    pathExists.mockRejectedValue(new Error("io"));
    ensureMentionChecked("/repo/boom.ts");
    await tick();
    expect(cachedStatus("/repo/boom.ts")).toBe("missing");
  });

  it("dedups concurrent in-flight checks of the same path", async () => {
    let resolve!: (v: boolean) => void;
    pathExists.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    ensureMentionChecked("/repo/c.ts");
    ensureMentionChecked("/repo/c.ts"); // in-flight → must not fire a second syscall
    resolve(true);
    await tick();
    expect(pathExists).toHaveBeenCalledTimes(1);
    expect(cachedStatus("/repo/c.ts")).toBe("exists");
  });

  it("arms the fs-change listener exactly once across all checks", async () => {
    pathExists.mockResolvedValue(true);
    ensureMentionChecked("/repo/x.ts");
    ensureMentionChecked("/repo/y.ts");
    await tick();
    // Lazily armed on the first check, never re-armed (singleton listener).
    expect(listen).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateMentions", () => {
  it("drops a cached 'missing' entry and notifies its subscribers", async () => {
    pathExists.mockResolvedValue(false);
    ensureMentionChecked("/repo/late.ts");
    await tick();
    expect(cachedStatus("/repo/late.ts")).toBe("missing");

    const cb = vi.fn();
    const unsub = subscribeMention("/repo/late.ts", cb);

    invalidateMentions(["/repo/late.ts"]);

    expect(cachedStatus("/repo/late.ts")).toBeUndefined(); // re-checkable now
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("canonicalises the watcher path to the cache key before matching", async () => {
    // Cache key is the normalised absolute path; the watcher may report a
    // non-canonical spelling (extra '.'/segments) — it must still match.
    pathExists.mockResolvedValue(false);
    ensureMentionChecked("/repo/src/late.ts");
    await tick();

    invalidateMentions(["/repo/src/./late.ts"]); // un-normalised, same file
    expect(cachedStatus("/repo/src/late.ts")).toBeUndefined();
  });

  it("does NOT drop an 'exists' entry (no re-check churn on every write)", async () => {
    pathExists.mockResolvedValue(true);
    ensureMentionChecked("/repo/live.ts");
    await tick();
    expect(cachedStatus("/repo/live.ts")).toBe("exists");

    const cb = vi.fn();
    const unsub = subscribeMention("/repo/live.ts", cb);
    invalidateMentions(["/repo/live.ts"]);

    expect(cachedStatus("/repo/live.ts")).toBe("exists"); // untouched
    expect(cb).not.toHaveBeenCalled();
    unsub();
  });

  it("ignores changed paths that were never mentioned", () => {
    expect(() => invalidateMentions(["/unrelated/file.ts"])).not.toThrow();
  });
});

describe("subscribeMention", () => {
  it("stops notifying after unsubscribe", async () => {
    pathExists.mockResolvedValue(false);
    ensureMentionChecked("/repo/s.ts");
    await tick();

    const cb = vi.fn();
    const unsub = subscribeMention("/repo/s.ts", cb);
    unsub();
    invalidateMentions(["/repo/s.ts"]);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("clearMentionCache", () => {
  it("empties the cache (full-wipe escape hatch)", async () => {
    pathExists.mockResolvedValue(true);
    ensureMentionChecked("/repo/a.ts");
    await tick();
    expect(cachedStatus("/repo/a.ts")).toBe("exists");

    clearMentionCache();
    expect(cachedStatus("/repo/a.ts")).toBeUndefined();
  });
});
