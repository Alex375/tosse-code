// Pure scroll-position logic for the conversation thread, split out of the React hook
// (`useStickToBottom`) so the decisions are unit-testable. The hook wires these to the
// DOM and to rAF; everything here is pure (no React, no DOM).

// Within this distance from the bottom (px) the view counts as "at the bottom" and
// keeps following new content. Matches the Claude Code VS Code extension (50px): tight
// enough that being a little higher up does not auto-scroll, with a small margin.
export const AT_BOTTOM_PX = 50;

/**
 * Per-conversation scroll memory, keyed by the conversation's STABLE id. The pane is
 * remounted on every conversation switch (it is `key`ed by id), so this module-level
 * cache is what lets a conversation reopen where the user left it. `atBottom` means the
 * user was pinned to the bottom (follow new content); otherwise `top` is the exact
 * offset. Session-scoped (cleared on app restart, which then defaults to the bottom).
 */
export interface ScrollMemo {
  top: number;
  atBottom: boolean;
}

const memory = new Map<string, ScrollMemo>();

export const readScrollMemo = (convId: string): ScrollMemo | undefined => memory.get(convId);

export const writeScrollMemo = (convId: string, memo: ScrollMemo): void => {
  memory.set(convId, memo);
};

/** Test helper: forget every remembered position. */
export const clearScrollMemory = (): void => memory.clear();

export interface InitialTarget {
  /** Whether to auto-follow the bottom from the start. */
  following: boolean;
  /** Exact offset to restore, or null to land at the bottom. */
  restoreTop: number | null;
}

/**
 * Where to position a conversation on open, from its remembered scroll state. The rule
 * mirrors Claude.ai / Claude Code — "if we don't know where the user is, show the
 * latest": no memory yet, or left while pinned to the bottom → follow the bottom;
 * otherwise return to the exact offset the user had scrolled to.
 */
export function initialTarget(memo: ScrollMemo | undefined): InitialTarget {
  if (!memo || memo.atBottom) return { following: true, restoreTop: null };
  return { following: false, restoreTop: memo.top };
}

/**
 * The scroll handler's follow-state transition. Re-engages following within
 * AT_BOTTOM_PX of the bottom; disengages only when the user actively scrolls UP and
 * away (scrolling down — our own pins and the smooth send-scroll included — never
 * disengages, which is what let "send from the top then follow" break before).
 */
export function nextFollowing(
  following: boolean,
  lastTop: number,
  top: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  const dist = scrollHeight - top - clientHeight;
  if (dist < AT_BOTTOM_PX) return true;
  if (top < lastTop) return false; // scrolled up & away
  return following;
}

/** Clamp a remembered offset to the scrollable range for the current content height. */
export function clampRestoreTop(
  restoreTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  return Math.min(Math.max(0, restoreTop), Math.max(0, scrollHeight - clientHeight));
}
