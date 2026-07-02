// Shared localStorage persistence for the lightweight, pure-UI Zustand stores (plan
// annotations, work-fold, …) that live OUTSIDE the SQLite core. Every such store used to
// repeat the same try/catch load/save boilerplate; this is the single copy. Best-effort by
// design: a read that can't parse falls back, a write that can't persist (quota / disabled
// storage) is swallowed — UI prefs are never worth throwing over.

/** Read and JSON-parse a localStorage value, returning `fallback` when it is absent,
 *  unparseable, or not a plain object. */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** JSON-serialize and write a value to localStorage, swallowing quota / disabled-storage errors. */
export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}
