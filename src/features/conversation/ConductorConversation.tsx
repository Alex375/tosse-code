import type { Conversation } from "../../store/conversationsStore";
import { ConductorComposer } from "./ConductorComposer";
import { ConductorSidebar } from "./ConductorSidebar";
import { ConductorThread } from "./ConductorThread";

/**
 * Conversation view: the sidebar (always present, so a folder can be opened even
 * with nothing selected) plus the thread/composer for the active conversation.
 * `active` is null when no conversation is selected (empty store) and its
 * `handle` is null while a selected conversation is still spawning/resuming.
 */
export function ConductorConversation({ active }: { active: Conversation | null }) {
  return (
    <>
      <ConductorSidebar />
      {active?.handle ? (
        // Keyed by the STABLE id so the thread/composer remount per conversation.
        <div key={active.id} className="wf-col" style={{ flex: 1, minWidth: 0 }}>
          <ConductorThread session={active.handle} />
          <ConductorComposer session={active.handle} />
        </div>
      ) : (
        <div
          className="wf-col"
          style={{ flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center" }}
        >
          <div
            style={{
              color: "var(--wf-tx-lo)",
              fontSize: 13,
              lineHeight: 1.6,
              textAlign: "center",
              maxWidth: 320,
              padding: 24,
            }}
          >
            {active
              ? "Démarrage de la session…"
              : "Aucune conversation. Ouvre un dossier avec ＋ dans la barre latérale pour en démarrer une."}
          </div>
        </div>
      )}
    </>
  );
}
