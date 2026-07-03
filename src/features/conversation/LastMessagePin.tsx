// A floating pin at the TOP of the conversation view showing the "last message you
// sent" — the SAME preview the Flight Deck shows (the message verbatim when short, else
// its ≤6-word Haiku summary). Clicking it scrolls the thread down to that message, so
// after scrolling up in a long conversation you can jump back to your last ask in one
// click. Gated by the `showLastMessagePreview` display pref (on by default).
//
// Text source mirrors the Flight Deck's LastMessagePeek: the live Haiku summary
// (`useLastMessageSummary`, only present after a send THIS run) when available, else an
// instant truncation of the last user message read from the store
// (`useUserMessageHistory`) — the latter persists across reload, so the pin still shows
// on a freshly-reopened conversation.

import { type RefObject } from "react";
import { Ico } from "../../ui/kit";
import { useDisplay } from "../../store/display";
import { useLastMessageSummary, summaryPreview } from "../../store/lastMessageSummary";
import { useUserMessageHistory } from "../../store/conversationStore";

export function LastMessagePin({
  session,
  paneRef,
}: {
  session: string;
  /** The `.cv-pane` element — the query for the target message is scoped to it, since
   *  up to 3 ConversationPanes can be mounted at once (full view + Flight Deck reply
   *  modal + Git workspace) and a global lookup would hit the wrong one. */
  paneRef: RefObject<HTMLDivElement | null>;
}) {
  const enabled = useDisplay((s) => s.showLastMessagePreview);
  const summary = useLastMessageSummary(session);
  const history = useUserMessageHistory(session);
  const last = history.length ? history[history.length - 1] : undefined;
  // Prefer the (nicer) live summary; fall back to a truncation of the persisted last
  // message so the pin survives a reload where the live summary is gone.
  const text = summary ?? (last ? summaryPreview(last) : undefined);

  if (!enabled || !text) return null;

  const scrollToLastUser = () => {
    const thread = paneRef.current?.querySelector(".cv-thread");
    const nodes = thread?.querySelectorAll<HTMLElement>(".cv-msg.cv-user");
    const target = nodes && nodes.length ? nodes[nodes.length - 1] : null;
    // block:"center" clears the pin (which floats over the thread's top edge) rather
    // than tucking the message behind it.
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <button
      type="button"
      className="cv-lastpin"
      title="Aller au dernier message envoyé"
      onClick={(e) => {
        e.stopPropagation(); // don't trigger the pane's background click
        scrollToLastUser();
      }}
    >
      <Ico name="reply" className="sm" />
      <span className="cv-lastpin-txt">{text}</span>
    </button>
  );
}
