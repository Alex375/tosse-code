// The Flight Deck reply modal — a conversation opened in place over the dashboard,
// so an agent's question/permission/review can be handled WITHOUT switching to the
// full Conversation view. It mounts the exact same `ConversationPane` the main view
// uses (thread + pinned bars + composer), keyed by the STABLE conversation id, but
// deliberately WITHOUT the editor/terminal side panel — it stays light, for quick
// triage. A "Plein écran" escape hatch promotes it to the real Conversation view.
//
// Store-driven (useFlightdeckModal): the attention actions on the stream cards open
// it; App mounts it once. `onPromote` is the only prop, since promoting needs the
// app-level view switch (openConversation).
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { ConversationPane } from "../conversation/ConversationPane";
import type { ComposerHandle } from "../conversation/ConductorComposer";
import { Dot, Ico } from "../../ui/kit";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { agentStatusToDot } from "../../agent/status";
import { useSessionState } from "../../store/conversationStore";
import {
  loadConversationHistory,
  repoName,
  useConversationRepo,
  useConversations,
} from "../../store/conversationsStore";
import { effectiveCwd } from "../git/worktree";
import { useFlightdeckModal } from "./flightdeckModalStore";
import styles from "./FlightDeckReplyModal.module.css";

// Interactive elements whose clicks must NOT be hijacked to focus the composer —
// same list the full Conversation view uses.
const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [role="button"], [role="option"], [role="tab"], [contenteditable="true"]';

export function FlightDeckReplyModal({ onPromote }: { onPromote: (id: string) => void }) {
  const convId = useFlightdeckModal((s) => s.convId);
  const close = useFlightdeckModal((s) => s.close);
  // Hooks stay above the early return so their order never changes between renders;
  // they no-op harmlessly on the empty id when the modal is closed.
  const conv = useConversations().find((c) => c.id === convId) ?? null;
  const repo = useConversationRepo(convId);
  const liveState = useSessionState(convId ?? "");
  const status = useAgentStatus(convId ?? "");
  const composerRef = useRef<ComposerHandle>(null);

  // Replay the on-disk transcript into the message store (idempotent, at most once
  // per conversation) exactly as the full view does on selection — so the thread is
  // populated even for a conversation never opened this run. Then focus the composer.
  useEffect(() => {
    if (!convId) return;
    void loadConversationHistory(convId);
    const t = setTimeout(() => composerRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [convId]);

  // Escape closes the modal, like the app's other dialogs — but ONLY if a nested
  // overlay inside the mounted ConversationPane (a drill-in TranscriptPopover /
  // TaskOutputPopover / WorkflowDetail) hasn't already consumed it. Those popovers
  // preventDefault() on their own Escape; since keydown bubbles document→window we
  // see that here and bail, so one Escape dismisses only the topmost layer.
  useEffect(() => {
    if (!convId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [convId, close]);

  if (!convId || !conv) return null;

  const cwd = effectiveCwd(conv, liveState);

  // Click anywhere in the pane (but not on a control) → focus the composer: the same
  // "click to type" affordance as the full Conversation view.
  const focusComposerOnClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!window.getSelection()?.isCollapsed) return;
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
    composerRef.current?.focus();
  };

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Dot s={agentStatusToDot(status)} pulse />
          <span className={styles.title} title={conv.name}>
            {conv.name}
          </span>
          {repo ? <span className={styles.repo}>· {repoName(repo.path)}</span> : null}
          <span className={styles.spacer} />
          <button
            className={styles.headBtn}
            onClick={() => onPromote(convId)}
            title="Ouvrir dans la vue conversation"
          >
            <Ico name="external" className="sm" />
            Plein écran
          </button>
          <button
            className={styles.iconBtn}
            onClick={close}
            title="Fermer (Échap)"
            aria-label="Fermer"
          >
            <Ico name="x" className="sm" />
          </button>
        </div>
        <div className={styles.body}>
          {/* The exact conversation column of the main view — no SidePanel (editor/
              terminal), keeping the modal light. Keyed by the stable id. File mentions
              are inert here: there is no editor host to reveal them in. */}
          <ConversationPane
            key={convId}
            session={convId}
            cwd={cwd}
            composerRef={composerRef}
            onBackgroundClick={focusComposerOnClick}
            inertMentions
          />
        </div>
      </div>
    </div>
  );
}
