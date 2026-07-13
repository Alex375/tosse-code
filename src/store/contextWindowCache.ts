// Per-conversation cache of the AUTHORITATIVE context-window size (e.g. 200000 or
// 1000000), persisted to localStorage. The window is only ever known for sure from
// the live `result.modelUsage` (the model NAME can't tell Opus-200k from Opus-1M);
// the on-disk transcript carries no window. So we remember the last value we learned
// live and use it to seed the context ring the next time the conversation is opened —
// before any new turn streams usage. Same pattern as the slash-command cache.

const KEY = "tosse-context-windows";

type Cache = Record<string, number>;

function read(): Cache {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Cache) : {};
  } catch {
    return {}; // corrupt/absent → empty, never throw
  }
}

/** The last known context window for a conversation, or null if never learned. */
export function getCachedWindow(convId: string): number | null {
  const w = read()[convId];
  return typeof w === "number" && w > 0 ? w : null;
}

/** Remember a conversation's authoritative window (no-op if unchanged). */
export function setCachedWindow(convId: string, window: number): void {
  if (!(window > 0)) return;
  const cache = read();
  if (cache[convId] === window) return;
  cache[convId] = window;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    // Writing the cache is best-effort, but surface a failure rather than hide it.
    console.warn("contextWindowCache: failed to persist", e);
  }
}

/** Forget a conversation's cached window — call when it's deleted so the cache
 *  doesn't accumulate orphan entries. No-op if there's nothing cached for it. */
export function clearCachedWindow(convId: string): void {
  const cache = read();
  if (!(convId in cache)) return;
  delete cache[convId];
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn("contextWindowCache: failed to persist", e);
  }
}

/** Drop every cached window — call on a full data wipe ("Delete all"). */
export function clearAllCachedWindows(): void {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    console.warn("contextWindowCache: failed to clear", e);
  }
}
