// Clickable file mentions in the conversation. A "mention" is any token that
// (a) looks like a path (see fileMentions.ts) AND (b) resolves to a real file
// under the conversation's live cwd. On click it opens that file in the side
// editor with the tree collapsed (focus-on-file), jumping to the line when the
// mention carried a `:line` suffix.
//
// Two render surfaces use this: inline-code paths in prose (StreamMarkdown) and
// the file_path chips on tool cards (ConductorToolCard / DiffView). Both read the
// conversation id + cwd from FileMentionProvider, so the rendered components stay
// prop-light. Off a provider (e.g. a standalone sub-agent transcript), mentions
// degrade to plain, non-clickable text.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useEditorStore } from "../editor/editorStore";
import { parseFileMention, resolveMentionAbs, SCHEME, type FileMention } from "./fileMentions";
import { cachedStatus, ensureMentionChecked, subscribeMention } from "./mentionCache";

// ---- Provider: which conversation/cwd a rendered mention belongs to ----------

interface MentionCtx {
  convId: string;
  cwd: string;
}

const Ctx = createContext<MentionCtx | null>(null);

export function FileMentionProvider({
  convId,
  cwd,
  children,
}: {
  convId: string;
  cwd: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ convId, cwd }), [convId, cwd]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useFileMentionCtx(): MentionCtx | null {
  return useContext(Ctx);
}

// ---- Hook: a token → a clickable target, or null ----------------------------

interface MentionTarget {
  ctx: MentionCtx;
  abs: string;
  mention: FileMention;
}

/**
 * Resolve a candidate token to a clickable target — non-null only when it parses
 * as a path AND that path exists under the conversation cwd. Hooks run
 * unconditionally (rules of hooks); the gating happens in the returned value.
 */
function useMentionTarget(raw: string): MentionTarget | null {
  const ctx = useFileMentionCtx();
  const cwd = ctx?.cwd ?? null;
  const mention = useMemo(() => parseFileMention(raw), [raw]);
  const abs = useMemo(
    () => (mention && cwd ? resolveMentionAbs(cwd, mention.path) : null),
    [mention, cwd],
  );
  const subscribeAbs = useCallback(
    (cb: () => void) => (abs ? subscribeMention(abs, cb) : () => {}),
    [abs],
  );
  const getStatus = useCallback(() => (abs ? cachedStatus(abs) : undefined), [abs]);
  const status = useSyncExternalStore(subscribeAbs, getStatus);
  // Re-check when `abs` changes OR when an fs-change invalidation cleared the
  // cached answer (status → undefined): the path may have just been created.
  useEffect(() => {
    if (abs) ensureMentionChecked(abs);
  }, [abs, status]);

  if (!ctx || !mention || !abs || status !== "exists") return null;
  return { ctx, abs, mention };
}

function openTarget(t: MentionTarget): void {
  useEditorStore
    .getState()
    .revealInEditor(
      t.ctx.convId,
      t.ctx.cwd,
      t.abs,
      t.mention.line != null ? { line: t.mention.line, column: t.mention.column } : undefined,
    );
}

/**
 * A tool-card / diff `file_path` is AUTHORITATIVE: it is a real file the agent
 * just read/edited/wrote, so the chip is always clickable — no heuristic parse,
 * no existence gate. The gate is there for PROSE (to avoid dead links from
 * guessed paths); applying it here would flicker and, worse, leave a file the
 * agent just CREATED non-clickable (it didn't exist at first render). openFile
 * surfaces a read error if the path is truly gone.
 */
function useAuthoritativeTarget(path: string | undefined): MentionTarget | null {
  const ctx = useFileMentionCtx();
  const cwd = ctx?.cwd ?? null;
  return useMemo(() => {
    const trimmed = path?.trim();
    // Guard the one non-filesystem shape that can slip through an authoritative
    // arg: a URL/remote handle (a tool naming its arg `file_path` with a URL).
    if (!ctx || !cwd || !trimmed || SCHEME.test(trimmed)) return null;
    return { ctx, abs: resolveMentionAbs(cwd, trimmed), mention: { path: trimmed } };
  }, [ctx, cwd, path]);
}

// ---- Shared clickable element ------------------------------------------------

/**
 * Render `display` as a clickable link when `target` resolves, else as plain
 * `<Tag className>` text. `role="button"` keeps the background "click to focus
 * composer" handler (and the tool-card expand toggle) from swallowing the click;
 * we also stop propagation so the card doesn't toggle.
 */
function ClickableFile({
  element: Tag,
  className,
  display,
  target,
}: {
  element: "code" | "span";
  className?: string;
  display: ReactNode;
  target: MentionTarget | null;
}) {
  if (!target) {
    return <Tag className={className}>{display}</Tag>;
  }
  const activate = (e: ReactMouseEvent | ReactKeyboardEvent) => {
    // Always stop the event bubbling to the tool-card header toggle / the
    // composer-focus background handler — even when we bail below, so a
    // selection-ending click on the chip never flips a toggleable card.
    e.stopPropagation();
    // Mirror focusComposerOnClick: a click that ENDS a text selection (the user
    // copying the path) must not hijack into opening the editor. Keyboard
    // activation (Enter/Space) always opens.
    if (e.type === "click" && !window.getSelection()?.isCollapsed) return;
    e.preventDefault();
    openTarget(target);
  };
  const suffix = target.mention.line != null ? `:${target.mention.line}` : "";
  return (
    <Tag
      className={className}
      role="button"
      tabIndex={0}
      data-filelink=""
      title={`Ouvrir ${target.abs}${suffix}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") activate(e);
      }}
    >
      {display}
    </Tag>
  );
}

// ---- Public components -------------------------------------------------------

/** Inline-code path in prose: clickable only when it resolves to a real file
 *  (heuristic detection ⇒ existence-gated to avoid dead links). */
export function MentionInlineCode({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const target = useMentionTarget(childrenText(children));
  return <ClickableFile element="code" className={className} display={children} target={target} />;
}

/**
 * A tool-card / diff file chip: `display` (the basename) is clickable, opening
 * the full authoritative `path`. Renders nothing when there is no path.
 */
export function MentionPathChip({
  path,
  className,
  display,
}: {
  path: string | undefined;
  className?: string;
  display: ReactNode;
}) {
  const target = useAuthoritativeTarget(path);
  if (!path) return null;
  return <ClickableFile element="span" className={className} display={display} target={target} />;
}

/** Flatten react-markdown's inline-code children into their plain text. */
function childrenText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenText).join("");
  return "";
}
