// Pre-emptive "backend account disconnected" banner, pinned above the composer
// (same visual family as ReviewBar). Shows ONLY when the conversation's OWN backend
// is DEFINITIVELY logged out (`claude auth status` / `account/read` answered
// loggedIn:false) — loading or a failed status probe show nothing, so a transient
// glitch never cries wolf. Without it, the first hint of a logged-out backend would
// be the NEXT message failing; this tells the user before they type, with a direct
// jump to Réglages → Comptes.
import { useConversationsStore, type BackendKind } from "../../store/conversationsStore";
import { useCodexAvailable } from "../../store/codexAvailable";
import { useAccountsLoggedOut } from "../../ipc/useAccounts";
import { useSettingsUi } from "../../store/settingsUi";

export function AuthWarningBar({ session }: { session: string }) {
  const kind = useConversationsStore(
    (s) => (s.conversations.find((c) => c.id === session)?.kind ?? "claude") as BackendKind,
  );
  const codexAvailable = useCodexAvailable();
  const loggedOut = useAccountsLoggedOut(codexAvailable);
  const openSettings = useSettingsUi((s) => s.openSettings);

  const disconnected = kind === "codex" ? loggedOut.codex : loggedOut.claude;
  if (!disconnected) return null;

  const name = kind === "codex" ? "Codex" : "Claude";
  return (
    // Tone "error" (red): a disconnected backend is a hard blocker — the next send WILL
    // fail — not a soft warning.
    <div className="cv-reviewbar" data-tone="error">
      <span className="cv-reviewbar-dot" />
      <span className="cv-reviewbar-label">
        Compte {name} non connecté — les prochains messages échoueront.
      </span>
      <button className="cv-reviewbar-btn" onClick={() => openSettings("accounts")}>
        Se connecter
      </button>
    </div>
  );
}
