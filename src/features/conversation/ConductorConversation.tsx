import { useEffect } from "react";
import {
  loadConversationHistory,
  type Conversation,
} from "../../store/conversationsStore";
import { ConductorComposer } from "./ConductorComposer";
import { ConductorSidebar } from "./ConductorSidebar";
import { ConductorThread } from "./ConductorThread";

/**
 * Conversation view: the sidebar (always present, so a folder can be opened even
 * with nothing selected) plus the thread/composer for the active conversation.
 *
 * Everything is keyed by the conversation's STABLE id. Lazy policy: selecting a
 * conversation loads its transcript history (no `claude` process spawned) and
 * shows it read-only; the live session starts only when the user sends a message
 * (the composer spawns it). `active` is null when nothing is selected.
 */
export function ConductorConversation({ active }: { active: Conversation | null }) {
  const activeId = active?.id ?? null;

  // On selection, replay the on-disk transcript into the message store (idempotent,
  // at most once per conversation). Covers both the boot-active conversation and
  // any later selection — without spawning anything.
  useEffect(() => {
    if (activeId) void loadConversationHistory(activeId);
  }, [activeId]);

  return (
    <>
      <ConductorSidebar />
      {active ? (
        // Keyed by the STABLE id so the thread/composer remount per conversation
        // and survive the live handle being (re)bound underneath them.
        <div key={active.id} className="wf-col" style={{ flex: 1, minWidth: 0 }}>
          <ConductorThread session={active.id} />
          <ConductorComposer session={active.id} />
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
            Aucune conversation. Ouvre un dossier avec ＋ dans la barre latérale pour en démarrer une.
          </div>
        </div>
      )}
    </>
  );
}
