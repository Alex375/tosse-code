import { useEffect } from "react";
import { commands } from "../../ipc/client";
import { useFleetCounts } from "../../agent/fleet";
import { useRunningCountsByConv } from "../../store/backgroundTasksStore";
import { useAppErrors } from "../../store/appErrors";
import { caffeineDesired, useCaffeinate } from "../../store/caffeinate";

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
    void (async () => {
      const res = await commands.setAwake(desired);
      // Only a hold (desired === true) can fail; a release never does. Surface it so the
      // user knows the Mac may sleep despite the toggle showing "on". Deduped by message.
      if (desired && res.status === "error") {
        useAppErrors
          .getState()
          .pushError("Couldn't keep the Mac awake — it may go to sleep.", res.error);
      }
    })();
  }, [desired]);

  return null;
}
