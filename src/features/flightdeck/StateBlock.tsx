// The adaptive body of a FlightDeck card — exactly the conversation view's status
// vocabulary, laid out for a card. Driven by the shared AgentStatus + the pending
// permission, so the card and the thread always agree on what an agent is asking.
import { Ico } from "../../ui/kit";
import type { AgentStatus } from "../../agent/status";
import { classifyAsk } from "../../agent/ask";
import { usePendingPermissions } from "../../store/conversationStore";
import { questionCount } from "../conversation/QuestionnaireAsk";
import { ActivityLine } from "./ActivityLine";

export function StateBlock({ convId, status }: { convId: string; status: AgentStatus }) {
  const pending = usePendingPermissions(convId);

  if (status.kind === "running") {
    // A live "what it's doing now" line derived from the stream (see useLiveActivity).
    return <ActivityLine convId={convId} />;
  }

  if (status.kind === "needIntervention") {
    // The status can flip to needIntervention a beat BEFORE the permission request
    // actually lands (or linger a beat AFTER the user answered, until the state
    // event clears awaiting_permission). With no real request queued there's nothing
    // to show — stay quiet instead of flashing a generic "Autoriser outil ?".
    const req = pending[0];
    if (!req) return null;
    const ask = classifyAsk(req);
    return (
      <div className="wf-ask compact">
        <div className="wf-ask-h">
          <Ico name="key" className="sm" />
          Demande une autorisation
        </div>
        <div className="wf-ask-t">{ask.text}</div>
        {ask.cmd ? <code className="wf-ask-cmd wf-mono">$ {ask.cmd}</code> : null}
      </div>
    );
  }

  if (status.kind === "needInput") {
    if (status.via === "questionnaire") {
      const req = pending[0];
      if (!req) return null;
      const n = questionCount(req.input);
      return (
        <div className="wf-ask compact">
          <div className="wf-ask-h">
            <Ico name="form" className="sm" />
            {n > 0 ? `${n} questions à répondre` : "Questionnaire"}
          </div>
        </div>
      );
    }
    // Heuristic open question — show the question text the agent is waiting on.
    return (
      <div className="wf-ask compact">
        <div className="wf-ask-h">
          <Ico name="ask" className="sm" />
          Pose une question
        </div>
        {status.prompt ? <div className="wf-ask-t">{status.prompt}</div> : null}
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div className="wf-ask err compact">
        <div className="wf-ask-h">
          <Ico name="alert" className="sm" />
          Erreur
        </div>
        <div className="wf-ask-t">{status.message}</div>
      </div>
    );
  }

  if (status.kind === "review") {
    return (
      <div className="wf-review compact">
        <div className="wf-review-h">
          <Ico name="check" className="sm" />
          À relire
        </div>
        <div className="wf-review-t">Conversation terminée — prête à relire.</div>
      </div>
    );
  }

  // idle / off — a quiet grey card, no body.
  return null;
}
