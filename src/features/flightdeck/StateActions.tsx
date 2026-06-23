// Contextual card actions — wired to the SAME command hooks the conversation view
// uses (useAnswerPermission / acknowledgeConversation), keyed by stable id. Authorising or
// refusing a permission happens right here; everything else opens the thread. When
// the status says "blocked" but no request is actually queued yet (the awaiting vs
// queue race), we fall through to a plain "Ouvrir" rather than render dead buttons.
import { Ico } from "../../ui/kit";
import type { AgentStatus } from "../../agent/status";
import { useAnswerPermission } from "../../ipc/useCommands";
import { usePendingPermissions } from "../../store/conversationStore";
import { acknowledgeConversation } from "../../store/conversationsStore";
import { questionCount } from "../conversation/QuestionnaireAsk";

export function StateActions({
  convId,
  status,
  onOpen,
}: {
  convId: string;
  status: AgentStatus;
  onOpen: (id: string) => void;
}) {
  const answer = useAnswerPermission(convId);
  const pending = usePendingPermissions(convId);
  const open = () => onOpen(convId);

  if (status.kind === "needIntervention") {
    const req = pending[0];
    if (req) {
      const allow = () =>
        answer.mutate({ requestId: req.request_id, decision: { behavior: "allow", updated_input: null } });
      const deny = () =>
        answer.mutate({ requestId: req.request_id, decision: { behavior: "deny", message: "Refusé." } });
      return (
        <div className="ag-card-actions">
          <button className="wf-btn ghost sm" onClick={deny}>
            Refuser
          </button>
          <button className="wf-btn prim sm" onClick={allow}>
            <Ico name="check" className="sm" />
            Autoriser
          </button>
        </div>
      );
    }
    // no live request yet → fall through to "Ouvrir"
  } else if (status.kind === "needInput") {
    if (status.via === "questionnaire") {
      // The full multi-question widget is too tall for a card — open the thread.
      const req = pending[0];
      if (req) {
        const n = questionCount(req.input);
        return (
          <div className="ag-card-actions">
            <button className="wf-btn prim sm" onClick={open}>
              <Ico name="arrow" className="sm" />
              Répondre{n > 0 ? ` (${n})` : ""}
            </button>
          </div>
        );
      }
      // no live questionnaire request → fall through to "Ouvrir"
    } else {
      // Open question (heuristic) — dismissable, or open the thread to reply.
      return (
        <div className="ag-card-actions">
          <button className="wf-btn ghost sm" onClick={() => acknowledgeConversation(convId)}>
            <Ico name="check" className="sm" />
            Vu
          </button>
          <button className="wf-btn prim sm" onClick={open}>
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
        <button className="wf-btn prim sm" onClick={open}>
          Ouvrir
        </button>
      </div>
    );
  }

  // running / idle / off — and the "blocked but no request yet" fall-throughs —
  // nothing to act on; just open it.
  return (
    <div className="ag-card-actions">
      <button className="wf-btn ghost sm" onClick={open}>
        Ouvrir
      </button>
    </div>
  );
}
