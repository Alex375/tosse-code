// Contextual card actions. EVERY "open" action here opens the conversation in the
// Flight Deck REPLY MODAL, so you can read/answer in place without leaving the deck.
// The card TITLE (in StreamCard) stays the full-screen entry point, so both options
// are always available — even on a calm card. A permission is authorised/refused
// from inside the modal (its context is right there), not blindly on the card. "Vu"
// acknowledges inline (the opposite of opening). When the status says "blocked" but
// no request is actually queued yet (the awaiting vs queue race), we fall through to
// a plain "Ouvrir" (which also opens the modal).
import { Ico } from "../../ui/kit";
import type { AgentStatus } from "../../agent/status";
import { usePendingPermissions } from "../../store/conversationStore";
import { acknowledgeConversation } from "../../store/conversationsStore";
import { questionCount } from "../conversation/QuestionnaireAsk";
import { useFlightdeckModal } from "./flightdeckModalStore";

export function StateActions({
  convId,
  status,
}: {
  convId: string;
  status: AgentStatus;
}) {
  const pending = usePendingPermissions(convId);
  const openModal = useFlightdeckModal((s) => s.open);
  const reply = () => openModal(convId); // open the conversation in the reply modal

  if (status.kind === "needIntervention") {
    const req = pending[0];
    if (req) {
      // A permission request: open the modal to see what's being asked and decide
      // (authorise/refuse) from the thread, with full context.
      return (
        <div className="ag-card-actions">
          <button className="wf-btn prim sm" onClick={reply}>
            <Ico name="arrow" className="sm" />
            Répondre
          </button>
        </div>
      );
    }
    // no live request yet → fall through to "Ouvrir"
  } else if (status.kind === "needInput") {
    if (status.via === "questionnaire") {
      const req = pending[0];
      if (req) {
        const n = questionCount(req.input);
        return (
          <div className="ag-card-actions">
            <button className="wf-btn prim sm" onClick={reply}>
              <Ico name="arrow" className="sm" />
              Répondre{n > 0 ? ` (${n})` : ""}
            </button>
          </div>
        );
      }
      // no live questionnaire request → fall through to "Ouvrir"
    } else {
      // Open question (heuristic) — dismissable inline, or open the modal to reply.
      return (
        <div className="ag-card-actions">
          <button className="wf-btn ghost sm" onClick={() => acknowledgeConversation(convId)}>
            <Ico name="check" className="sm" />
            Vu
          </button>
          <button className="wf-btn prim sm" onClick={reply}>
            <Ico name="send" className="sm" />
            Répondre
          </button>
        </div>
      );
    }
  } else if (status.kind === "error" || status.kind === "review") {
    return (
      <div className="ag-card-actions">
        <button className="wf-btn ghost sm" onClick={() => acknowledgeConversation(convId)}>
          <Ico name="check" className="sm" />
          Vu
        </button>
        <button className="wf-btn prim sm" onClick={reply}>
          Ouvrir
        </button>
      </div>
    );
  }

  // running / idle / off — and the "blocked but no request yet" fall-throughs —
  // nothing to answer, but you can still peek/reply in place. "Ouvrir" opens the
  // modal too; the card TITLE remains the full-screen entry point.
  return (
    <div className="ag-card-actions">
      <button className="wf-btn ghost sm" onClick={reply}>
        Ouvrir
      </button>
    </div>
  );
}
