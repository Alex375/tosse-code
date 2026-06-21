import { useCallback, useEffect, useRef } from "react";
import {
  clampRestoreTop,
  initialTarget,
  nextFollowing,
  readScrollMemo,
  writeScrollMemo,
} from "./scrollMemory";

// After a send, follow new content smoothly for this long (the user message + the
// "thinking" indicator land in this window), then snap instantly so fast token
// streaming tracks the bottom without lag.
const SMOOTH_SEND_MS = 700;
// The initial position is applied across a settle window, not in one jump: a
// conversation's transcript loads into the store asynchronously (disk read + IPC) and
// its height then keeps growing for several frames. We re-apply the target until the
// height has grown past the empty mount value AND then stayed stable for a few frames,
// bounded by a hard cap. Reading the REAL DOM height makes this work on a plain
// history view, where no streaming re-render would otherwise re-pin.
const SETTLE_STABLE_FRAMES = 5;
const SETTLE_MAX_MS = 5000;

export interface StickToBottom {
  /** Attach to the scroll container (the element with `overflow-y: auto`). */
  scrollRef: (node: HTMLDivElement | null) => void;
  /**
   * Call before paint on every thread render (see StreamFollow in ConductorThread).
   * While the open is still settling it applies the remembered/initial position;
   * afterwards it keeps the bottom pinned while the user is following (streaming).
   */
  onRender: () => void;
  /** Engage following and smooth-scroll to the bottom — used on send. */
  scrollToBottom: () => void;
}

export function useStickToBottom(convId: string): StickToBottom {
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const smoothUntil = useRef(0);

  // --- initial-restore state (one window per mount, i.e. per conversation) ---
  const restoring = useRef(true);
  const restoreTop = useRef<number | null>(null); // null → bottom
  const programmaticTop = useRef(0);
  const settleStart = useRef(0);
  const baseHeight = useRef(-1);
  const lastHeight = useRef(-1);
  const stableFrames = useRef(0);
  const grew = useRef(false);
  const inited = useRef(false);

  // Seed following + restore target from this conversation's memory, synchronously on
  // the first render, so the very first layout-effect already positions correctly.
  if (!inited.current) {
    inited.current = true;
    const target = initialTarget(readScrollMemo(convId));
    following.current = target.following;
    restoreTop.current = target.restoreTop;
    restoring.current = true;
    settleStart.current = performance.now();
  }

  const onScroll = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    const top = el.scrollTop;
    // A scroll position we did not just set ourselves = the user took control →
    // abandon the initial restore so we never fight their scrolling.
    if (restoring.current && Math.abs(top - programmaticTop.current) > 2) {
      restoring.current = false;
    }
    following.current = nextFollowing(
      following.current,
      lastTop.current,
      top,
      el.scrollHeight,
      el.clientHeight,
    );
    lastTop.current = top;
    // Remember where this conversation is, so reopening it returns here.
    writeScrollMemo(convId, { top, atBottom: following.current });
  }, [convId]);

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

  // Apply the remembered/initial position and track when the async load has settled.
  const applyRestore = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    if (baseHeight.current < 0) {
      baseHeight.current = el.scrollHeight;
      // Content already present at mount (re-opening a loaded conversation) overflows
      // immediately — treat it as arrived so we settle quickly instead of at the cap.
      if (el.scrollHeight > el.clientHeight + 4) grew.current = true;
    }
    el.scrollTop =
      restoreTop.current == null
        ? el.scrollHeight
        : clampRestoreTop(restoreTop.current, el.scrollHeight, el.clientHeight);
    programmaticTop.current = el.scrollTop;

    const h = el.scrollHeight;
    if (h > baseHeight.current + 4) grew.current = true; // real content has arrived
    if (h === lastHeight.current) {
      stableFrames.current += 1;
    } else {
      stableFrames.current = 0;
      lastHeight.current = h;
    }
    const settled = grew.current && stableFrames.current >= SETTLE_STABLE_FRAMES;
    if (settled || performance.now() - settleStart.current > SETTLE_MAX_MS) {
      restoring.current = false;
    }
  }, []);

  const followIfPinned = useCallback(() => {
    const el = scrollEl.current;
    if (!el || !following.current) return;
    if (performance.now() < smoothUntil.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // Runs before paint on every thread render: position during the restore window,
  // then keep the bottom pinned while following (streaming).
  const onRender = useCallback(() => {
    if (restoring.current) applyRestore();
    else followIfPinned();
  }, [applyRestore, followIfPinned]);

  const scrollToBottom = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    restoring.current = false; // a send overrides any in-flight restore
    following.current = true;
    smoothUntil.current = performance.now() + SMOOTH_SEND_MS;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Drive the restore for frames where nothing re-renders the thread (the async load
  // settling after first paint). `onRender` covers render-triggered frames before
  // paint; this rAF covers the gaps. Both stop the moment the restore is done.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled || !restoring.current) return;
      applyRestore();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [applyRestore]);

  return { scrollRef, onRender, scrollToBottom };
}
