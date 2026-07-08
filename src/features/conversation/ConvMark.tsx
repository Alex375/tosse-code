// Backend-aware brand marks. A conversation runs on EITHER the Claude backend or the
// Codex backend (fixed at creation); every avatar/logo that used to hardcode
// `<ClaudeMark>` reads the conversation's `kind` through here so a Codex conversation is
// identifiable at a glance in a mixed fleet. Lives in features/conversation (not the pure
// `ui/kit`) precisely because it reads the conversations store.
import { Avatar, ClaudeMark, CodexMark } from "../../ui/kit";
import { useConversationsStore } from "../../store/conversationsStore";

/** True when this conversation runs on Codex. Cheap boolean selector (stable across
 *  renders), keyed by the STABLE conversation id — the same id every thread component
 *  already threads down as `session`. Defaults to Claude for an unknown id. */
function useIsCodex(session: string): boolean {
  return useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.kind === "codex",
  );
}

/** The conversation's brand mark: the OpenAI glyph for a Codex conversation, the Claude
 *  glyph otherwise. `className` passes through (e.g. `wf-spin` on the Flight Deck activity
 *  line), so this is a drop-in replacement for a bare `<ClaudeMark className=… />`. */
export function ConvMark({ session, className }: { session: string; className?: string }) {
  return useIsCodex(session) ? (
    <CodexMark className={className} />
  ) : (
    <ClaudeMark className={className} />
  );
}

/** The assistant-response avatar, backend-aware. Claude keeps its coral disc + Claude
 *  mark; Codex gets a NEUTRAL (monochrome) disc + OpenAI mark — the OpenAI logo is black &
 *  white, and a coral tile would misread as Anthropic branding (Alexandre's call). */
export function AiAvatar({ session }: { session: string }) {
  const isCodex = useIsCodex(session);
  return (
    <Avatar ai codex={isCodex}>
      {isCodex ? <CodexMark /> : <ClaudeMark />}
    </Avatar>
  );
}
