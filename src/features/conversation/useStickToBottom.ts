import { useCallback, useRef } from "react";

// Within this distance from the bottom (px) we consider the view "at the bottom"
// and keep following new content. Matches the Claude Code VS Code extension (50px):
// tight enough that being a little higher up does not auto-scroll, with a small margin.
const AT_BOTTOM_PX = 50;
// After a send, follow new content with a smooth animation for this long (the user
// message + the "thinking" indicator land in this window), then snap instantly so
// fast token streaming tracks the bottom without lag.
const SMOOTH_SEND_MS = 700;

export interface StickToBottom {
  /** Attach to the scroll container (the element with `overflow-y: auto`). */
  scrollRef: (node: HTMLDivElement | null) => void;
  /**
   * Re-pin to the bottom if we're currently following. Meant to be called from a
   * layout effect on every streaming update, i.e. before paint — so there is no
   * visible jump (an after-paint ResizeObserver pin looks like "moved by hand").
   */
  followIfPinned: () => void;
  /** Engage following and smooth-scroll to the bottom — used on send. */
  scrollToBottom: () => void;
}

/**
 * Stick-to-bottom for the chat thread, modelled on the Claude Code VS Code
 * extension (the project's behavioural reference):
 *  - a scroll handler keeps `following` true while within AT_BOTTOM_PX of the
 *    bottom, and turns it off only when the user actively scrolls UP and away
 *    (scrolling down — including our own pins and the smooth send-scroll — never
 *    disengages, which is what let "send from the top then follow" break before);
 *  - the actual follow happens instantly inside a layout effect (see StreamFollow
 *    in ConductorThread) so it tracks streaming smoothly with no jank;
 *  - send uses a real smooth scroll, briefly followed smoothly so the view ends
 *    truly at the bottom — below the freshly written message and thinking dots.
 */
export function useStickToBottom(): StickToBottom {
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const smoothUntil = useRef(0);

  const onScroll = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    const top = el.scrollTop;
    const dist = el.scrollHeight - top - el.clientHeight;
    if (dist < AT_BOTTOM_PX) following.current = true;
    else if (top < lastTop.current) following.current = false; // user scrolled up & away
    lastTop.current = top;
  }, []);

  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollEl.current?.removeEventListener("scroll", onScroll);
      scrollEl.current = node;
      if (node) {
        node.addEventListener("scroll", onScroll, { passive: true });
        lastTop.current = node.scrollTop;
      }
    },
    [onScroll],
  );

  const followIfPinned = useCallback(() => {
    const el = scrollEl.current;
    if (!el || !following.current) return;
    if (performance.now() < smoothUntil.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    following.current = true;
    smoothUntil.current = performance.now() + SMOOTH_SEND_MS;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  return { scrollRef, followIfPinned, scrollToBottom };
}
