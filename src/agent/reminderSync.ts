// Bridges a conversation's LIVE derived status into its PERSISTED reminder. Pulled
// out of the event router (useGlobalSessionEvents) so the "WHEN to persist" glue —
// the feature's trickiest, order-dependent invariant — is unit-testable in
// isolation: it has no React/closure deps, reading both stores only via getState().
import { useConversationStore } from "../store/conversationStore";
import { useConversationsStore } from "../store/conversationsStore";
import { agentStatusForEntry } from "./useAgentStatus";
import { statusReminderKind } from "./status";

/**
 * Mirror a conversation's LIVE derived status into its PERSISTED reminder, so a
 * finished-but-unseen turn (review / error / open question) re-surfaces after the
 * process dies or the app restarts. Writes ONLY while the process is live: a null
 * handle keeps whatever was last persisted, because quitting/stopping must NOT
 * erase the reminder. `setReminder` is idempotent, so calling this on every
 * settling edge is cheap. The arrival order of the `turn_result` message and the
 * `busy → false` state event is not guaranteed by the core, so the event router
 * runs this from BOTH edges; it converges to the right value once both have landed.
 */
export function syncReminderFromLive(convId: string): void {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv?.handle) return; // off: preserve the persisted reminder as-is
  const entry = useConversationStore.getState().sessions[convId];
  const status = agentStatusForEntry(conv.handle, entry);
  useConversationsStore.getState().setReminder(convId, statusReminderKind(status));
}
