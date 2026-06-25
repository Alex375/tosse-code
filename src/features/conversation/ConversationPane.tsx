import { type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { TodoBar } from "../todos/TodoBar";
import { ConductorComposer, type ComposerHandle } from "./ConductorComposer";
import { ConductorThread } from "./ConductorThread";
import { FileMentionProvider } from "./FileMention";
import { ReviewBar } from "./ReviewBar";
import { AgentBar } from "./AgentBar";
import { BashBar } from "./BashBar";
import { useStickToBottom } from "./useStickToBottom";

/**
 * The active conversation's column: thread + bars + composer, sharing one
 * stick-to-bottom instance. The thread is the scroll container; the composer snaps
 * it to the bottom on send (`onSent`). Mounted with a per-conversation key so it
 * remounts on switch; the scroll position is remembered per conversation inside
 * the hook (keyed by `session`, the stable id), so reopening returns where the
 * user left off — defaulting to the bottom when there is no memory yet.
 *
 * Extracted from ConductorConversation so it can be reused both in the normal
 * MainArea (full width) and in the Git workspace (a narrow left column).
 */
export function ConversationPane({
  session,
  cwd,
  composerRef,
  onBackgroundClick,
}: {
  session: string;
  cwd: string;
  composerRef: RefObject<ComposerHandle>;
  onBackgroundClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const { scrollRef, onRender, scrollToBottom } = useStickToBottom(session);
  return (
    <div className="wf-col cv-pane" style={{ flex: 1, minWidth: 0 }} onClick={onBackgroundClick}>
      {/* Provide the conversation id + live cwd so file mentions in the thread
          resolve + open in this conversation's editor. */}
      <FileMentionProvider convId={session} cwd={cwd}>
        <ConductorThread session={session} scrollRef={scrollRef} onRender={onRender} />
      </FileMentionProvider>
      <AgentBar session={session} />
      <BashBar session={session} />
      <TodoBar session={session} />
      <ReviewBar session={session} />
      <ConductorComposer ref={composerRef} session={session} onSent={scrollToBottom} />
    </div>
  );
}
