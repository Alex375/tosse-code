import { useEffect, useState } from "react";

/**
 * Re-render every `periodMs` so a derived elapsed/relative-time label stays fresh. Mount
 * it only where a live counter is actually shown (a working indicator, a running tool row)
 * so the interval is torn down as soon as that element unmounts. `Date.now()` is read on
 * each tick — fine on the front-end (this is not a workflow script).
 */
export function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return now;
}
