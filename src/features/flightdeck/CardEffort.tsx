// The card's reasoning-effort control: the SAME EffortGauge slider the conversation
// composer uses, made interactive on a FlightDeck card. Reading order matches the
// composer — LIVE session state while running, else this conversation's persisted
// record, else the product default — so the chip never lies about the tier. Setting
// goes through the shared store setters (which push to the live session when one exists
// and always persist), exactly like the composer, minus the composer's Ultra-code
// full-screen blast (a composer flourish that has no place over the fleet grid).
//
// The gauge is portaled so its popover escapes the swimlane's `overflow` clip.

import { useShallow } from "zustand/react/shallow";
import { EffortGauge, type EffortLevel } from "../conversation/EffortGauge";
import { useSessionState } from "../../store/conversationStore";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  useConversationsStore,
} from "../../store/conversationsStore";

export function CardEffort({ convId }: { convId: string }) {
  const state = useSessionState(convId);
  const ctl = useConversationsStore(
    useShallow((s) => {
      const c = s.conversations.find((cv) => cv.id === convId);
      return {
        model: c?.model ?? null,
        effort: c?.effort ?? null,
        ultracode: c?.ultracode ?? false,
      };
    }),
  );

  // Only surface the control once there's a known effort (live or persisted) — an
  // idle/never-configured card stays clean, matching the read-only chip it replaces.
  const hasEffort =
    state?.effort != null || !!state?.ultracode || ctl.effort != null || ctl.ultracode;
  if (!hasEffort) return null;

  const modelId = state?.model ?? ctl.model ?? DEFAULT_MODEL;
  const effortLevel = (state?.effort ?? ctl.effort ?? DEFAULT_EFFORT) as EffortLevel;
  const ultra = state?.ultracode ?? ctl.ultracode;
  const gaugeValue: EffortLevel = ultra ? "ultracode" : effortLevel;

  const choose = (lvl: EffortLevel) => {
    const store = useConversationsStore.getState();
    // "Ultra code" is not an effort value — it's xhigh + a separate flag.
    if (lvl === "ultracode") store.setConvUltracode(convId);
    else store.setConvEffort(convId, lvl);
  };

  return <EffortGauge portal model={modelId} value={gaugeValue} onChange={choose} />;
}
