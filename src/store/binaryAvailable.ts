import { useEffect, useState } from "react";

import { commands } from "../ipc/client";
import type { BackendKind } from "./conversationsStore";

// Whether a usable CLI binary (`claude` / `codex`) is installed on this machine. ONE
// parameterized layer over the twin Rust checks (`claude_available` / `codex_available`,
// cheap PATH / well-known-location file checks, never a spawn). Powers the proactive
// "CLI not detected" surfaces (the composer bar, the Settings → Accounts card) and gates
// the Codex option in the "+" backend selector. Availability can't change mid-session,
// so each backend is resolved ONCE and cached process-wide — every consumer shares that
// single check, no per-component IPC.
const cached: Record<BackendKind, boolean | null> = { claude: null, codex: null };
const inflight: Record<BackendKind, Promise<boolean | null> | null> = { claude: null, codex: null };

function probe(kind: BackendKind): Promise<boolean | null> {
  // Invoke inside the promise chain (NOT before it): if a binding is missing or throws
  // synchronously — e.g. a mock that forgot the twin method — the throw becomes a
  // rejection the `.catch` can trap, instead of a synchronous throw escaping this
  // function (which, called from a useEffect body, would crash the React subtree).
  return Promise.resolve()
    .then(() => (kind === "codex" ? commands.codexAvailable() : commands.claudeAvailable()))
    .then((v) => (cached[kind] = v))
    .catch(() => {
      // A rejected probe is NOT a definitive "not installed" — the twin Rust checks answer
      // Ok(false) for a genuinely absent binary; a rejection here means the IPC itself
      // glitched. Leave `cached` at `null` (still-unknown) and drop the in-flight slot so a
      // later mount re-probes, rather than sticking the scary "CLI not found" surfaces for
      // the whole session on one transient failure (what the fail-safe surfaces promise).
      inflight[kind] = null;
      return null;
    });
}

/**
 * Tri-state availability of a backend's CLI binary: `null` while the one-shot check is
 * still in flight, then the resolved boolean. Use this where a `false` must be
 * DEFINITIVE — e.g. a scary "CLI not installed" warning that must never FLASH before the
 * check resolves. For gating an optional affordance (where an initial `false` is
 * harmless) prefer the plain-boolean [`useBackendAvailable`].
 */
export function useBackendAvailabilityState(kind: BackendKind): boolean | null {
  const [state, setState] = useState<boolean | null>(cached[kind]);
  useEffect(() => {
    if (cached[kind] !== null) {
      setState(cached[kind]);
      return;
    }
    if (!inflight[kind]) inflight[kind] = probe(kind);
    let alive = true;
    void inflight[kind]!.then((v) => {
      if (alive) setState(v);
    });
    return () => {
      alive = false;
    };
  }, [kind]);
  return state;
}

/** Reactive availability of a backend's CLI binary (false until — and if — the one-shot
 *  check resolves to false). Mount it in as many components as needed — the check runs at
 *  most once per backend. Treats "still checking" as `false`; use
 *  [`useBackendAvailabilityState`] when that distinction matters. */
export function useBackendAvailable(kind: BackendKind): boolean {
  return useBackendAvailabilityState(kind) ?? false;
}

/** Reactive `codex` availability. */
export function useCodexAvailable(): boolean {
  return useBackendAvailable("codex");
}

/** Reactive `claude` availability. */
export function useClaudeAvailable(): boolean {
  return useBackendAvailable("claude");
}
