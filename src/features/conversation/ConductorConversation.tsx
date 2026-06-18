import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import {
  loadConversationHistory,
  type Conversation,
} from "../../store/conversationsStore";
import { ConductorComposer, type ComposerHandle } from "./ConductorComposer";
import { ConductorSidebar } from "./ConductorSidebar";
import { ConductorThread } from "./ConductorThread";

// Interactive elements whose clicks must NOT be hijacked to focus the composer
// (buttons, links, other fields, expandable tool-card headers via role=button…).
const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [role="button"], [role="option"], [role="tab"], [contenteditable="true"]';

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
  const composerRef = useRef<ComposerHandle>(null);

  // On selection, replay the on-disk transcript into the message store (idempotent,
  // at most once per conversation). Covers both the boot-active conversation and
  // any later selection — without spawning anything.
  useEffect(() => {
    if (activeId) void loadConversationHistory(activeId);
  }, [activeId]);

  // Click anywhere in the conversation column → focus the composer, so the whole
  // view is "click to type". Don't steal an active selection (copying a message)
  // and don't hijack clicks landing on interactive elements.
  const focusComposerOnClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!window.getSelection()?.isCollapsed) return;
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
    composerRef.current?.focus();
  };

  return (
    <>
      <ConductorSidebar />
      {active ? (
        // Keyed by the STABLE id so the thread/composer remount per conversation
        // and survive the live handle being (re)bound underneath them.
        <div
          key={active.id}
          className="wf-col"
          style={{ flex: 1, minWidth: 0 }}
          onClick={focusComposerOnClick}
        >
          <ConductorThread session={active.id} />
          <ConductorComposer ref={composerRef} session={active.id} />
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
