// Existence cache for clickable file mentions — the non-React core behind
// <FileMention>. A prose path is clickable only once we've confirmed it resolves to
// a real file under the conversation cwd; this module owns that check, its cache, and
// the subscription that lets a rendered mention re-render when the answer lands.
// Kept React-free (like fileMentions.ts) so it is unit-testable in isolation.
//
// A path is checked at most once (cache + in-flight dedup); subscribers are notified
// when the answer arrives. Keyed by the CANONICAL absolute path (normalizePosix), so
// the same file referenced from many messages — across conversations — costs a single
// `pathExists` syscall.

import { commands, events } from "../../ipc/client";
import { normalizePosix } from "./fileMentions";

export type MentionStatus = "exists" | "missing";

const cache = new Map<string, MentionStatus>();
const inflight = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function notify(abs: string): void {
  listeners.get(abs)?.forEach((l) => l());
}

/** Subscribe to status changes for one absolute path (drives useSyncExternalStore). */
export function subscribeMention(abs: string, cb: () => void): () => void {
  let set = listeners.get(abs);
  if (!set) {
    set = new Set();
    listeners.set(abs, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(abs);
  };
}

/** The cached answer for a path, or undefined if it hasn't been checked yet. */
export function cachedStatus(abs: string): MentionStatus | undefined {
  return cache.get(abs);
}

// A cached answer is only as fresh as the filesystem it was read from: a path
// checked as "missing" before the agent creates it would otherwise stay
// non-clickable for the rest of the session. When the editor's fs watch reports a
// changed path, drop its cached "missing" answer so the next render re-checks it
// (subscribers re-render → status flips → the effect re-runs ensureMentionChecked)
// and the freshly-created file turns clickable.
//
// We ONLY drop "missing" entries, never "exists": re-checking a file that already
// exists on every write to it would be pure churn (a busy `pnpm dev` rewriting a
// watched file), and a deleted-but-still-cached file is handled at click time (the
// editor surfaces a read error) rather than by invalidation.
//
// Best-effort: the OS watch is live only while the side editor panel is open (see
// useFsWatch) — which is exactly when a just-written file is most likely to be
// clicked. Armed lazily on the first check so importing this module is side-effect
// free (mirrors termManager's lazy disposer registration). The single app-lifetime
// listener is intentionally never torn down — re-arming on each wipe would instead
// accumulate listeners, so clearMentionCache leaves it in place.
let fsListenerArmed = false;
function armFsInvalidation(): void {
  if (fsListenerArmed) return;
  fsListenerArmed = true;
  void events.fsChangeEvent.listen((e) => invalidateMentions(e.payload.paths));
}

/** Drop the cached "missing" answer for any changed path (canonicalised to the cache
 *  key shape first) and notify its subscribers so it gets re-checked. Exported for
 *  the fs listener and for tests. */
export function invalidateMentions(paths: string[]): void {
  for (const raw of paths) {
    const abs = normalizePosix(raw);
    if (cache.get(abs) === "missing") {
      cache.delete(abs);
      notify(abs);
    }
  }
}

/** Ensure a path's existence has been (or is being) checked. Idempotent: a cached or
 *  in-flight path is a no-op, so the same path costs one `pathExists` until it is
 *  invalidated. */
export function ensureMentionChecked(abs: string): void {
  armFsInvalidation();
  if (cache.has(abs) || inflight.has(abs)) return;
  inflight.add(abs);
  commands
    .pathExists(abs)
    .then((ok) => cache.set(abs, ok ? "exists" : "missing"))
    .catch(() => cache.set(abs, "missing"))
    .finally(() => {
      inflight.delete(abs);
      notify(abs);
    });
}

/**
 * Drop the whole existence cache. Wired into a full data wipe only — the cache is
 * keyed by ABSOLUTE path and intentionally SHARED across conversations, so it must
 * NOT be cleared when a single conversation is deleted. The fs listener is left armed
 * (see armFsInvalidation).
 */
export function clearMentionCache(): void {
  cache.clear();
  inflight.clear();
}
