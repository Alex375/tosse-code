import { useState } from "react";
import { commands } from "../../ipc/client";
import type { BackendKind } from "../../store/conversationsStore";
import { useAppErrors } from "../../store/appErrors";
import { Ico } from "../../ui/kit";

/**
 * Title-bar action: resume the current conversation in an OS terminal, in its cwd —
 * `claude --resume <id>` for a Claude conversation, `codex resume <id>` for a Codex one
 * (the core picks the right CLI from `backend`; handing a Codex id to `claude` opens a
 * fresh empty session — the "wrong id" bug). Driven by the conversation's PERSISTED
 * session/thread id, so it works straight from the CLI's on-disk history with no live
 * process (disabled until an id exists). Opens a *separate*, user-driven CLI outside the app.
 */
export function OpenInTerminalButton({
  sessionId,
  cwd,
  backend,
}: {
  sessionId: string | null;
  cwd: string;
  backend: BackendKind;
}) {
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    const res = await commands.openInTerminal(cwd, sessionId, backend);
    setBusy(false);
    if (res.status === "error") {
      // The core builds an actionable French message; surface it instead of burying
      // it in the console where the user never sees why nothing opened.
      console.error("openInTerminal failed:", res.error);
      useAppErrors
        .getState()
        .pushError("Impossible d'ouvrir la conversation dans le terminal du système.", res.error);
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
          ? "Ouvrir la conversation dans le terminal du système"
          : "Disponible une fois la session démarrée"
      }
      aria-label="Ouvrir la conversation dans le terminal du système"
    >
      <Ico name="arrow" className="sm" />
    </button>
  );
}
