import { useEffect } from "react";
import { commands } from "../../ipc/client";
import { useFleetCounts } from "../../agent/fleet";
import { useRunningCountsByConv } from "../../store/backgroundTasksStore";
import { useAppErrors } from "../../store/appErrors";
import { caffeineDesired, useCaffeinate } from "../../store/caffeinate";

/** Slow heartbeat re-asserting the keep-awake hold: if the `caffeinate` child is killed out
 *  from under us while it should stay held, the next tick calls `set_awake(true)` again and the
 *  idempotent Rust `hold()` respawns it. Cheap (a no-op while the child is still alive). */
const REASSERT_MS = 30_000;

// Serialize every `set_awake` IPC so the calls apply in ISSUE ORDER and the last intent wins.
// The heartbeat above can have an in-flight `setAwake(true)` that — without this — could reach
// the Rust mutex AFTER a near-simultaneous release's `setAwake(false)` (Tauri does not guarantee
// cross-invoke ordering) and strand the Mac held awake, with no further heartbeat to self-correct
// while `desired` is false. Chaining makes a later-issued release always win. Same "serialize the
// writes to a shared resource" discipline as the CLI-config writers.
let awakeChain: Promise<unknown> = Promise.resolve();
function setAwakeSerialized(desired: boolean) {
  const call = awakeChain.then(() => commands.setAwake(desired));
  awakeChain = call.catch(() => {}); // keep the chain alive past a rejection
  return call;
}

/**
 * The Caffeinate POLICY, mounted once globally (render-null). Watches the on/off toggle,
 * the Light/Hard mode and live fleet activity, computes whether the Mac should be held
 * awake right now, and pushes that boolean to the Rust `power` service via `set_awake`.
 *
 * Activity source for Light mode = "is ANY agent working". `useFleetCounts().running` folds
 * a running turn and the `backgrounding` state, but it does NOT count a conversation whose
 * main turn settled into an attention state (needInput / error) while a background task is
 * STILL running — that conversation buckets as `needAttention`, not `running`. So we OR it
 * with a DIRECT running-background-task check (`useRunningCountsByConv`), otherwise Light
 * mode would let the Mac sleep and stall a background sub-agent — exactly what the feature
 * exists to prevent.
 *
 * If holding the assertion fails (a `caffeinate` spawn failure), we surface it via the app
 * error banner instead of letting the toggle read "on" while the Mac quietly sleeps — the
 * "zero silent error" rule. Its own component (not folded into App) so this subscription
 * re-renders in isolation on every fleet tick.
 */
export function CaffeinateHost() {
  const enabled = useCaffeinate((s) => s.enabled);
  const mode = useCaffeinate((s) => s.mode);
  const anyBackgroundTask = useRunningCountsByConv();
  const anyAgentActive =
    useFleetCounts().running > 0 || Object.values(anyBackgroundTask).some((n) => n > 0);

  const desired = caffeineDesired(enabled, mode, anyAgentActive);

  useEffect(() => {
    const push = async () => {
      const res = await setAwakeSerialized(desired);
      // Only a hold (desired === true) can fail; a release never does. Surface it so the
      // user knows the Mac may sleep despite the toggle showing "on". Deduped by message.
      if (desired && res.status === "error") {
        useAppErrors
          .getState()
          .pushError("Couldn't keep the Mac awake — it may go to sleep.", res.error);
      }
    };
    void push();
    // While the assertion is meant to be HELD, re-assert it on a slow heartbeat. This effect
    // only re-runs when `desired` flips, so if the `caffeinate` child dies out from under us
    // while `desired` stays true (killall, an OS reap under pressure) nothing else calls
    // set_awake again — the Rust-side liveness prune + respawn in `hold()` only runs when
    // invoked. A cheap idempotent re-assert (a no-op while the child is alive) closes that
    // self-heal gap. Not needed while releasing (desired === false).
    if (!desired) return;
    const id = setInterval(() => void push(), REASSERT_MS);
    return () => clearInterval(id);
  }, [desired]);

  return null;
}
