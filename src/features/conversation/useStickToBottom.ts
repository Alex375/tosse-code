import { useCallback, useRef } from "react";

// How close to the bottom (px) still counts as "at the bottom". A little tolerance
// so streaming growth doesn't make the exact bottom impossible to reach/keep.
const AT_BOTTOM_PX = 64;

export interface StickToBottom {
  /** Attach to the scroll container (the element with `overflow-y: auto`). */
  scrollRef: (node: HTMLDivElement | null) => void;
  /** Attach to the growing content inside the scroll container. */
  contentRef: (node: HTMLDivElement | null) => void;
  /** Snap to the bottom and re-engage following (used on send). */
  scrollToBottom: () => void;
}

/**
 * Minimal, robust stick-to-bottom for the chat thread.
 *
 * Rule — exactly what's expected of a chat: while the viewport is at the bottom,
 * new content keeps it pinned there; scroll up and it stops following; scroll back
 * to the bottom and it follows again.
 *
 * Why not `use-stick-to-bottom`: its scroll handler ignores scroll events that
 * overlap a content resize. During streaming the content resizes on every frame,
 * so the user's "scroll back down to re-engage" was permanently swallowed and the
 * lock never came back. Here, following is decided purely from the scroll position
 * and is never gated on resizes, so it re-engages mid-stream.
 */
export function useStickToBottom(): StickToBottom {
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const observer = useRef<ResizeObserver | null>(null);

  const pin = useCallback(() => {
    const el = scrollEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // A scroll event (user wheel/drag, or our own pin) re-evaluates whether we
  // follow: we follow iff the viewport sits at the bottom. Not gated on resizes.
  const onScroll = useCallback(() => {
    const el = scrollEl.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
  }, []);

  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollEl.current?.removeEventListener("scroll", onScroll);
      scrollEl.current = node;
      if (!node) return;
      node.addEventListener("scroll", onScroll, { passive: true });
      following.current = true;
      // Land at the bottom on open, instantly (no animation).
      requestAnimationFrame(pin);
    },
    [onScroll, pin],
  );

  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node) return;
      // Content grew/shrank (streaming, history load, a tool card expanding…):
      // keep pinned to the bottom only if we were following.
      const ro = new ResizeObserver(() => {
        if (following.current) pin();
      });
      ro.observe(node);
      observer.current = ro;
    },
    [pin],
  );

  const scrollToBottom = useCallback(() => {
    following.current = true;
    pin();
  }, [pin]);

  return { scrollRef, contentRef, scrollToBottom };
}
