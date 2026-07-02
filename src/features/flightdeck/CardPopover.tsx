// A small popover anchored to a trigger inside a FlightDeck card — the shared shell
// for the "last message" and "to-do list" peeks. Rendered in a PORTAL, fixed-
// positioned, NOT as an absolute child: a card lives inside the swimlane's
// `overflow:auto` (`.ag-grid`), which would clip an in-flow popover. Same reasoning
// as BackgroundTaskBadge's popover.
//
// Placement is collision-aware so it is NEVER truncated by a screen edge: the left
// edge is anchored to the trigger and clamped into the viewport (a card on the far
// left opens rightward, one on the far right is pulled back in); it opens downward,
// flipping upward when there isn't room below. Width and height are clamped to the
// available space too.
//
// Escape closes and `preventDefault()`s — this popover OWNS the key while open, so a
// window-level Escape listener (the reply modal) that checks `defaultPrevented` won't
// also fire (keydown bubbles document→window). See the Escape convention in CLAUDE.md.

import {
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Ico } from "../../ui/kit";

interface Placement {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

/** Margin kept between the popover and the viewport edges. */
const M = 8;
/** Below-space (px) under which we prefer flipping above (unless above is even tighter). */
const FLIP_THRESHOLD = 160;

export function CardPopover({
  anchorRef,
  open,
  onClose,
  width = 300,
  title,
  icon,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Preferred width; shrunk to fit a narrow viewport. */
  width?: number;
  /** Optional header label. */
  title?: string;
  /** Optional header icon name. */
  icon?: string;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<Placement | null>(null);

  // Compute placement synchronously when opening, from the trigger's live rect.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 2 * M);
    // Anchor the LEFT edge to the trigger, then clamp so neither edge spills off-screen.
    const left = Math.min(Math.max(M, r.left), vw - w - M);
    const belowSpace = vh - r.bottom - 10;
    const aboveSpace = r.top - 10;
    if (belowSpace >= FLIP_THRESHOLD || belowSpace >= aboveSpace) {
      setPos({ left, top: r.bottom + 6, width: w, maxHeight: belowSpace });
    } else {
      setPos({ left, bottom: vh - r.top + 6, width: w, maxHeight: aboveSpace });
    }
  }, [open, anchorRef, width]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !pos) return null;

  return createPortal(
    // Transparent backdrop: catches the click-away without dimming, exactly like the
    // background-tasks popover.
    <div className="ag-pop-backdrop" onClick={onClose}>
      <div
        className="ag-pop"
        style={{
          position: "fixed",
          left: pos.left,
          top: pos.top,
          bottom: pos.bottom,
          width: pos.width,
          maxHeight: pos.maxHeight,
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        {title ? (
          <div className="ag-pop-title">
            {icon ? <Ico name={icon} className="sm" /> : null}
            {title}
          </div>
        ) : null}
        <div className="ag-pop-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
