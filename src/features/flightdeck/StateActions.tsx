// Contextual card actions — ONLY the ones that need prominence: "Répondre" (answer a
// permission / question) and "Vu" (acknowledge inline). Opening the conversation is no
// longer a button here: clicking the card BODY opens the reply modal, and the card
// TITLE (in StreamCard) stays the full-screen entry point. A permission is
// authorised/refused from inside that modal (its context is right there), not blindly
// on the card. When the status says "blocked" but no request is actually queued yet
// (the awaiting vs queue race), there's nothing to answer → no action row (the card
// body still opens it).
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
    // no live request yet → no action row (the card body still opens it)
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
      // no live questionnaire request → no action row (the card body still opens it)
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
    // "Vu" acknowledges inline. Opening is now the card BODY's job (it opens the
    // reply modal), so the redundant "Ouvrir" is gone.
    return (
      <div className="ag-card-actions">
        <button className="wf-btn ghost sm" onClick={() => acknowledgeConversation(convId)}>
          <Ico name="check" className="sm" />
          Vu
        </button>
      </div>
    );
  }

  // running / idle / off — and the "blocked but no request yet" fall-throughs —
  // nothing to answer. Opening in place is handled by clicking the card body (reply
  // modal) and the card TITLE remains the full-screen entry point, so there's no
  // action row to render here.
  return null;
}
