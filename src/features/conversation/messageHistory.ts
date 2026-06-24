// Shell-style ↑/↓ history recall for the composer. Pure, testable logic — the
// component owns the textarea/caret side-effects; this file owns the navigation
// state machine and the caret-edge guards.

export interface HistoryNav {
  /** Index into the history array (0 = oldest), or null while editing the live draft. */
  index: number | null;
  /** The live draft, stashed when navigation begins; restored on walking past the newest. */
  stash: string;
}

export const IDLE_NAV: HistoryNav = { index: null, stash: "" };

export interface RecallResult {
  nav: HistoryNav;
  text: string;
}

/**
 * ↑ — recall an older message. From idle, stashes the current draft and jumps to
 * the most recent message; each further call steps one message older. Returns null
 * when there's nothing to recall (empty history, or already at the oldest entry) so
 * the caller can let the keypress fall through to default caret movement.
 */
export function recallPrev(
  history: string[],
  nav: HistoryNav,
  draft: string,
): RecallResult | null {
  if (history.length === 0) return null;
  if (nav.index === null) {
    const index = history.length - 1;
    return { nav: { index, stash: draft }, text: history[index] };
  }
  if (nav.index <= 0) return null; // already at the oldest message
  const index = nav.index - 1;
  return { nav: { ...nav, index }, text: history[index] };
}

/**
 * ↓ — move toward more recent messages. Stepping past the newest restores the
 * stashed draft and returns to idle. Returns null when not navigating, so ↓ keeps
 * its normal caret behaviour outside of history mode.
 */
export function recallNext(history: string[], nav: HistoryNav): RecallResult | null {
  if (nav.index === null) return null;
  const index = nav.index + 1;
  if (index >= history.length) return { nav: IDLE_NAV, text: nav.stash };
  return { nav: { ...nav, index }, text: history[index] };
}

/** True when the caret sits on the first visual line of `value` (no newline before it). */
export function caretOnFirstLine(value: string, caret: number): boolean {
  return value.lastIndexOf("\n", caret - 1) === -1;
}

/** True when the caret sits on the last visual line of `value` (no newline after it). */
export function caretOnLastLine(value: string, caret: number): boolean {
  return value.indexOf("\n", caret) === -1;
}
