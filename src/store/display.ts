// User preferences for how the conversation transcript is displayed. Pure UI prefs,
// persisted to localStorage (same lightweight pattern as notifications.ts) rather
// than the Rust core — they are not domain data, so they don't belong in the SQLite
// metadata store.
import { create } from "zustand";
import { useConversationsStore } from "./conversationsStore";

const STORAGE_KEY = "tosse:display";

/** How Markdown is rendered everywhere it appears (conversation thread, sub-agent
 *  transcripts, and the `.md` file preview — all go through {@link StreamMarkdown}).
 *  - `classic`: the historical GitHub-flavoured look (boxed, full-grid tables).
 *  - `warm`   : soft/on-brand — coral accents, card code blocks, salient filenames.
 *  - `minimal`: neutral/typographic — airy, hairline chrome, uppercase section heads.
 *  A single GLOBAL setting (not per-conversation): one look across the whole app. */
export type MarkdownMode = "classic" | "warm" | "minimal";

export interface DisplayPrefs {
  /** The GLOBAL DEFAULT for "clean output" — folding an assistant response's intermediate
   *  work (tool runs, thinking, in-between narration, sub-agents) into ONE collapsible
   *  "Travail de Claude — N étapes" block, so only the response's CONCLUDING message stays
   *  in clear. Per response, not per app: each response keeps its own block + concluding
   *  message. When a response spans several turns, only its LAST message stays in clear.
   *  See ConductorThread/CleanBlocks.
   *
   *  This is the DEFAULT applied to any conversation that has not set its OWN preference:
   *  clean output is a per-conversation setting (persisted in SQLite as `Conversation.cleanOutput`,
   *  a tristate where null = "inherit this default"). The Settings → Général toggle writes THIS
   *  default; the composer chip writes the current conversation's explicit override. The
   *  effective value for a conversation is resolved by {@link useEffectiveCleanOutput}. */
  cleanOutput: boolean;

  /** The Markdown rendering look, applied globally to every surface that renders
   *  Markdown. See {@link MarkdownMode}. Set from Settings → Conversation. */
  markdownMode: MarkdownMode;

  /** Show the "Fleet readout" banner (the adaptive "N Running · N Review · …" stage
   *  counts across the whole fleet) at the TOP of the FlightDeck. On by default. Set
   *  from Settings → Général. Independent of {@link fleetBannerConversation}. */
  fleetBannerFlightDeck: boolean;

  /** Show the compact "Fleet readout" box at the BOTTOM of the conversation sidebar.
   *  On by default. Set from Settings → Général. Independent of
   *  {@link fleetBannerFlightDeck}. */
  fleetBannerConversation: boolean;

  /** Show the CLI-injected `<task-notification>` messages (a background task/agent
   *  finished) in the conversation thread. OFF by default — they're machine-injected
   *  noise that clutters the transcript, especially on reload / history import. The
   *  clean render (SpecialMessageCard) is kept, just gated: flip this on to see them
   *  again. Read by {@link SpecialMessageCard}. */
  showTaskNotifications: boolean;

  /** Show the floating "last message you sent" pin at the TOP of the conversation view
   *  — the same preview shown on the Flight Deck (the message verbatim when short, else
   *  its ≤6-word Haiku summary). Clicking it scrolls the thread to that message. On by
   *  default. Read by {@link LastMessagePin}. */
  showLastMessagePreview: boolean;

  /** Show the hover controls on conversation messages — "reprendre à partir d'ici" (rewind
   *  the conversation in place) and "forker" (branch a new conversation at this message),
   *  offered on both the user's and Claude's messages. ON by default. Off → messages have no
   *  hover controls. Read by {@link MessageActions} (via the conversation thread). */
  messageControls: boolean;
}

// Off by default: the transcript shows everything inline as before. The user opts in
// (Settings → Général, or the composer chip) when they want the condensed reading view.
// markdownMode defaults to `warm` — the on-brand, cleaner look (the whole point of the
// feature); users can switch to `minimal` or back to `classic` in Settings → Conversation.
const DEFAULTS: DisplayPrefs = {
  cleanOutput: false,
  markdownMode: "warm",
  fleetBannerFlightDeck: true,
  fleetBannerConversation: true,
  showTaskNotifications: false,
  showLastMessagePreview: true,
  messageControls: true,
};

function load(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for users who already
    // have a stored (older, smaller) prefs object.
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DisplayPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: DisplayPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface DisplayState extends DisplayPrefs {
  /** Patch one or more prefs and persist. */
  set: (patch: Partial<DisplayPrefs>) => void;
}

export const useDisplay = create<DisplayState>((set) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: DisplayPrefs = {
        cleanOutput: patch.cleanOutput ?? s.cleanOutput,
        markdownMode: patch.markdownMode ?? s.markdownMode,
        fleetBannerFlightDeck: patch.fleetBannerFlightDeck ?? s.fleetBannerFlightDeck,
        fleetBannerConversation: patch.fleetBannerConversation ?? s.fleetBannerConversation,
        showTaskNotifications: patch.showTaskNotifications ?? s.showTaskNotifications,
        showLastMessagePreview: patch.showLastMessagePreview ?? s.showLastMessagePreview,
        messageControls: patch.messageControls ?? s.messageControls,
      };
      save(next);
      return next;
    }),
}));

/** The global Markdown rendering mode. Read by {@link StreamMarkdown} (which stamps it
 *  as `data-md-mode` on its root and provides it via context to CodeBlock). */
export function useMarkdownMode(): MarkdownMode {
  return useDisplay((s) => s.markdownMode);
}

/**
 * Collapse the per-conversation clean-output tristate onto a concrete boolean: an
 * explicit override (`true`/`false`) wins; `null` inherits the global default. Pure
 * so the semantics are locked in a test — crucially, an explicit `false` override
 * MUST beat a `true` global default (that is the whole point of per-conversation:
 * one conversation can opt OUT even when the default is on).
 */
export function resolveCleanOutput(override: boolean | null, globalDefault: boolean): boolean {
  return override ?? globalDefault;
}

/**
 * The EFFECTIVE "clean output" for a conversation: its own explicit choice when it
 * has one, else the global default. This is the single resolver every renderer reads
 * — the thread ({@link AssistantBlocks}), the composer chip, and the scroll-preserve
 * key ({@link ConversationPane}) — so a per-conversation override and the global
 * default never disagree.
 *
 * `Conversation.cleanOutput` is a tristate: `true`/`false` is an explicit override,
 * `null` means "inherit the global default" (the state every conversation starts in,
 * and the state pre-existing rows migrate to — so behaviour is unchanged until the
 * user flips the chip on a specific conversation).
 */
export function useEffectiveCleanOutput(convId: string): boolean {
  const globalDefault = useDisplay((s) => s.cleanOutput);
  const override = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.cleanOutput ?? null,
  );
  return resolveCleanOutput(override, globalDefault);
}
