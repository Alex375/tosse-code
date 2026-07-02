// A locally-unique id generator, shared by every client-side store that mints its own ids
// (repos, conversations, plan annotations). Prefers crypto.randomUUID; falls back to a
// timestamp + random suffix only where the Web Crypto API is unavailable (never in the Tauri
// webview in practice). Kept in one place so any future hardening (entropy, collision guard)
// lands once.

/** A locally-unique id: `crypto.randomUUID()` when available, else a timestamp+random fallback. */
export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
