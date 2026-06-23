import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  loadConversationHistory,
  type Conversation,
} from "../../store/conversationsStore";
import { useSessionState } from "../../store/conversationStore";
import { effectiveCwd } from "../git/worktree";
import { EditorPanel } from "../editor/EditorPanel";
import { Splitter } from "../editor/Splitter";
import { clamp, useEditorLayout, useEditorStore } from "../editor/editorStore";
import { TodoBar } from "../todos/TodoBar";
import { ConductorComposer, type ComposerHandle } from "./ConductorComposer";
import { ConductorSidebar } from "./ConductorSidebar";
import { ConductorThread } from "./ConductorThread";
import { ReviewBar } from "./ReviewBar";
import { useStickToBottom } from "./useStickToBottom";

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
        <MainArea
          conv={active}
          composerRef={composerRef}
          onBackgroundClick={focusComposerOnClick}
        />
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

/**
 * The area to the right of the conversations sidebar: the conversation column
 * and, when the editor panel is open, a resizable editor beside it (side-by-side)
 * or below it (stacked). The split is dragged via the divider; its fraction and
 * orientation are remembered globally (editor store). The editor is rooted at the
 * conversation's LIVE working directory (follows EnterWorktree/ExitWorktree).
 */
function MainArea({
  conv,
  composerRef,
  onBackgroundClick,
}: {
  conv: Conversation;
  composerRef: RefObject<ComposerHandle>;
  onBackgroundClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const { open, orientation, editorFraction } = useEditorLayout();
  const setEditorFraction = useEditorStore((s) => s.setEditorFraction);
  const liveState = useSessionState(conv.id);
  const cwd = effectiveCwd(conv, liveState);
  const areaRef = useRef<HTMLDivElement>(null);
  const sideBySide = orientation === "row";

  const onSplitDrag = (clientX: number, clientY: number) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Fraction the EDITOR occupies = remaining space past the pointer.
    const frac = sideBySide
      ? 1 - (clientX - rect.left) / rect.width
      : 1 - (clientY - rect.top) / rect.height;
    setEditorFraction(clamp(frac, 0.15, 0.85));
  };

  return (
    <div
      ref={areaRef}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: sideBySide ? "row" : "column",
      }}
    >
      <div
        style={{
          // Grow-ratio split (not a rigid basis) so both panes honour their
          // min-size: the conversation never gets crushed below a usable width.
          // When the editor is CLOSED the grow factor must be 1 (not 1-fraction):
          // a single flex child whose grow factors sum to < 1 only fills that
          // fraction of the row, leaving the rest blank. So full width on close.
          flex: `${open ? 1 - editorFraction : 1} 1 0`,
          minWidth: sideBySide ? 320 : 0,
          minHeight: sideBySide ? 0 : 200,
          display: "flex",
        }}
      >
        {/* Keyed by the STABLE id so the pane (thread + composer + its
            stick-to-bottom state) remounts per conversation. */}
        <ConversationPane
          key={conv.id}
          session={conv.id}
          composerRef={composerRef}
          onBackgroundClick={onBackgroundClick}
        />
      </div>
      {open ? (
        <>
          <Splitter axis={sideBySide ? "x" : "y"} onMove={onSplitDrag} />
          <div
            style={{
              flex: `${editorFraction} 1 0`,
              minWidth: sideBySide ? 280 : 0,
              minHeight: sideBySide ? 0 : 160,
              display: "flex",
            }}
          >
            <EditorPanel convId={conv.id} cwd={cwd} stacked={!sideBySide} />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The active conversation's column: thread + todo bar + composer, sharing one
 * stick-to-bottom instance. The thread is the scroll container; the composer snaps it
 * to the bottom on send (`onSent`). Mounted with a per-conversation key so it remounts
 * on switch; the scroll position is remembered per conversation inside the hook (keyed
 * by `session`, the stable id), so reopening returns to where the user left off —
 * defaulting to the bottom when there is no memory yet.
 */
function ConversationPane({
  session,
  composerRef,
  onBackgroundClick,
}: {
  session: string;
  composerRef: RefObject<ComposerHandle>;
  onBackgroundClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const { scrollRef, onRender, scrollToBottom } = useStickToBottom(session);
  return (
    <div className="wf-col cv-pane" style={{ flex: 1, minWidth: 0 }} onClick={onBackgroundClick}>
      <ConductorThread session={session} scrollRef={scrollRef} onRender={onRender} />
      <TodoBar session={session} />
      <ReviewBar session={session} />
      <ConductorComposer ref={composerRef} session={session} onSent={scrollToBottom} />
    </div>
  );
}
