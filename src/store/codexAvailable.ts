import { useEffect, useState } from "react";

import { commands } from "../ipc/client";

// Whether a usable `codex` binary is installed — gates the Codex option in the "+"
// backend selector. Availability can't change mid-session, so it's resolved ONCE and
// cached process-wide; every repo row shares that single check (no per-row IPC).
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

/** Reactive `codex` availability (false until the one-shot check resolves). */
export function useCodexAvailable(): boolean {
  const [available, setAvailable] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (cached !== null) {
      setAvailable(cached);
      return;
    }
    if (!inflight) {
      inflight = commands
        .codexAvailable()
        .then((v) => (cached = v))
        .catch(() => (cached = false));
    }
    let alive = true;
    void inflight.then((v) => {
      if (alive) setAvailable(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return available;
}
