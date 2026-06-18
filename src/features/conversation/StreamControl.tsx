import { useState } from "react";
import {
  restartConversationSession,
  startConversationSession,
  stopConversationSession,
  streamStatus,
  type Conversation,
} from "../../store/conversationsStore";
import { useSessionState } from "../../store/conversationStore";
import { Dot, Ico, Menu, MenuItem, WF_STATUS } from "../../ui/kit";

/**
 * Title-bar control for a conversation's live `claude` stream: shows whether it
 * is on or off (status dot + label) and opens a menu to turn it on ("allumer"),
 * restart it ("relancer"), or turn it off ("éteindre").
 *
 * On/off is driven by the conversation's live `handle`: with the lazy policy the
 * process spawns on the first message, so it is normally off until then; turning
 * it on here pre-spawns it without sending anything. The actions are contextual —
 * "allumer" when off, "relancer"/"éteindre" when on.
 */
export function StreamControl({ conv }: { conv: Conversation }) {
  // State is keyed by the conversation's stable id; the handle (reactive via the
  // prop) is the source of truth for on/off.
  const state = useSessionState(conv.id);
  const live = conv.handle !== null;
  const status = streamStatus(conv.handle, state);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Run an async stream action, guarding against concurrent clicks and
   *  surfacing a failure (e.g. `claude` not found) instead of swallowing it. */
  const run = (fn: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    void fn()
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[stream] action failed:", e);
        setError(msg);
      })
      .finally(() => setPending(false));
  };

  // On failure show an error dot + the reason in the tooltip; the menu still
  // offers the action so the user can retry (which clears the error).
  const shownStatus = error ? "err" : status;

  return (
    <Menu
      align="right"
      trigger={
        <button
          type="button"
          className="wf-streamctl"
          title={error ? `Échec : ${error}` : "Contrôle du stream"}
          aria-label={`Stream ${error ? "échec" : WF_STATUS[status].label}`}
        >
          <Dot s={shownStatus} pulse />
          <span>{error ? "Échec" : WF_STATUS[status].label}</span>
          <Ico name="chev" className="sm wf-streamctl-chev" />
        </button>
      }
    >
      {live ? (
        <>
          <MenuItem
            icon="restart"
            disabled={pending}
            onClick={() => run(() => restartConversationSession(conv.id))}
          >
            Relancer le stream
          </MenuItem>
          <MenuItem
            icon="stop"
            disabled={pending}
            onClick={() => run(() => stopConversationSession(conv.id))}
          >
            Éteindre le stream
          </MenuItem>
        </>
      ) : (
        <MenuItem
          icon="play"
          disabled={pending}
          onClick={() => run(() => startConversationSession(conv.id))}
        >
          Allumer le stream
        </MenuItem>
      )}
    </Menu>
  );
}
