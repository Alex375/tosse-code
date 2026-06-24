import { useAgentStatus } from "../../agent/useAgentStatus";
import { isDismissable, type AgentStatus } from "../../agent/status";
import { acknowledgeConversation } from "../../store/conversationsStore";
import { useSendMessage } from "../../ipc/useCommands";
import { Ico } from "../../ui/kit";

/**
 * A clear, contextual acknowledge bar shown above the composer when the active
 * conversation is in a non-blocking "reminder" state — review (turn finished),
 * an error to acknowledge, or an open question the heuristic flagged. It makes
 * the "mark as seen" action discoverable: the small ✓ on the sidebar row is a
 * shortcut, but a first-time user wouldn't know it exists, so the labelled button
 * here ("Marquer comme vu") is the obvious way to clear the conversation back to
 * idle. Not shown for real blocks (questionnaire / permission) — those must be
 * answered in the thread, not dismissed (see `isDismissable`).
 */
function reviewLabel(s: AgentStatus): string {
  switch (s.kind) {
    case "review":
      return "Conversation terminée";
    case "error":
      return s.message;
    case "needInput":
      return "En attente de ta réponse";
    default:
      return "";
  }
}

function reviewTone(s: AgentStatus): "review" | "input" | "error" {
  if (s.kind === "error") return "error";
  if (s.kind === "needInput") return "input";
  return "review";
}

export function ReviewBar({ session }: { session: string }) {
  const status = useAgentStatus(session);
  const send = useSendMessage(session);
  if (!isDismissable(status)) return null;
  // "Continue" makes sense when Claude STOPPED (an execution error, or a finished
  // turn) — send a "continue" message so it resumes. NOT on `needInput`, which needs
  // a real answer, not a blind resume. Sending clears the reminder (addUserTurn), so
  // the bar closes on its own.
  const canContinue = status.kind === "error" || status.kind === "review";
  return (
    <div className="cv-reviewbar" data-tone={reviewTone(status)}>
      <span className="cv-reviewbar-dot" />
      <span className="cv-reviewbar-label">{reviewLabel(status)}</span>
      {canContinue ? (
        <button
          type="button"
          className="cv-reviewbar-btn"
          onClick={() => send.mutate({ text: "continue" })}
          title="Renvoyer « continue » pour que Claude reprenne le travail"
        >
          <Ico name="play" className="sm" />
          Continue
        </button>
      ) : null}
      <button
        type="button"
        className="cv-reviewbar-btn"
        onClick={() => acknowledgeConversation(session)}
        title="Repasser la conversation en gris (inactive)"
      >
        <Ico name="check" className="sm" />
        Marquer comme vu
      </button>
    </div>
  );
}
