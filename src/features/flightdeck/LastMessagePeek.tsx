// The card's "last message you sent" line, made clickable: the ≤6-word summary is a
// button that opens a popover with the FULL text of your latest message. The summary
// answers "what did I last ask this agent" at a glance; the peek shows the whole
// thing without leaving the deck.
//
// Full text comes from the message store (`useUserMessageHistory`, last entry): the
// summary is live-only — it only appears after a send THIS run, and a send always
// lands a user turn in the store — so the full message is always available. The
// summary is kept as a fallback for the rare case the history is momentarily empty.

import { useRef, useState } from "react";
import { Ico } from "../../ui/kit";
import { useUserMessageHistory } from "../../store/conversationStore";
import { userMessagePreviewText } from "../conversation/userText";
import { LinkText } from "../conversation/LinkText";
import { CardPopover } from "./CardPopover";

export function LastMessagePeek({ convId, summary }: { convId: string; summary: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const history = useUserMessageHistory(convId);
  // Clean the raw last message: a slash-command's `<command-*>` wrapper must not leak
  // into the peek as raw tags.
  const full = history.length ? userMessagePreviewText(history[history.length - 1]) : summary;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ag-lastmsg ag-lastmsg-btn"
        onClick={() => setOpen((o) => !o)}
        title="Voir le message envoyé"
      >
        <Ico name="reply" className="sm" />
        <span className="ag-lastmsg-txt">
          <LinkText text={summary} inButton />
        </span>
      </button>

      <CardPopover
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        width={340}
        title="Dernier message envoyé"
        icon="reply"
      >
        <div className="ag-pop-msg">
          <LinkText text={full} />
        </div>
      </CardPopover>
    </>
  );
}
