import { useState } from "react";
import { commands } from "../../ipc/client";
import { Ico } from "../../ui/kit";

/**
 * Title-bar action: resume the current conversation in an OS terminal
 * (`claude --resume <session_id>`, in the conversation's cwd). Driven by the
 * conversation's PERSISTED session_id — Claude assigns it on the first turn and
 * we keep it across runs — so it works straight from the on-disk transcript,
 * with no live process needed (disabled until a session_id exists). Opens a
 * *separate*, user-driven `claude` outside the app.
 */
export function OpenInTerminalButton({
  sessionId,
  cwd,
}: {
  sessionId: string | null;
  cwd: string;
}) {
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
