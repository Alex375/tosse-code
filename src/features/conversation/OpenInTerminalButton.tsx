import { useState } from "react";
import { commands } from "../../ipc/client";
import { useSessionState } from "../../store/conversationStore";
import { Ico } from "../../ui/kit";

/**
 * Title-bar action: resume the current conversation in an OS terminal
 * (`claude --resume <session_id>`, in the conversation's cwd). Disabled until the
 * session has a session_id — Claude assigns it on system/init, and there is
 * nothing to resume before that. Opens a *separate*, user-driven `claude`
 * outside the app.
 */
export function OpenInTerminalButton({ session, cwd }: { session: string; cwd: string }) {
  const state = useSessionState(session);
  const sessionId = state?.session_id ?? null;
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    const res = await commands.openInTerminal(cwd, sessionId);
    setBusy(false);
    if (res.status === "error") {
      console.error("openInTerminal failed:", res.error);
    }
  };

  return (
    <button
      type="button"
      className="wf-icon-btn"
      onClick={open}
      disabled={!sessionId || busy}
      title={
        sessionId
          ? "Ouvrir la conversation dans le terminal"
          : "Disponible une fois la session démarrée"
      }
      aria-label="Ouvrir la conversation dans le terminal"
    >
      <Ico name="term" className="sm" />
    </button>
  );
}
