// The right-click menu for the file explorer. Unlike the trigger-anchored `Menu`
// in the kit, this is positioned at the cursor (clientX/clientY), clamped into the
// viewport, and rendered through a portal to `document.body` so the tree's
// `overflow:auto` never clips it. It reuses the kit's popover/menu-item classes
// (`wf-pop` / `wf-mi`) for a consistent look. Dismisses on any outside click,
// Escape, scroll, resize or blur.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Ico } from "../../ui/kit";

export interface CtxMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  /** Render in the destructive (red) style — for "Delete". */
  danger?: boolean;
  disabled?: boolean;
  /** A trailing keyboard-shortcut hint (e.g. "⌫"). */
  hint?: string;
}

/** A menu entry: an actionable item, or a thin separator line. */
export type CtxMenuEntry = CtxMenuItem | "sep";

export function FileContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: CtxMenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Once measured, clamp the menu fully on-screen: a click near the right or
  // bottom edge would otherwise paint the menu off the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const m = 6;
    const left = Math.max(m, Math.min(x, window.innerWidth - width - m));
    const top = Math.max(m, Math.min(y, window.innerHeight - height - m));
    setPos({ left, top });
  }, [x, y]);

  // Dismiss on any interaction outside the menu.
  useEffect(() => {
    const close = () => onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // The anchor would drift if the tree scrolled UNDERNEATH → dismiss. But a tall
    // menu may itself scroll (max-height + overflow): scrolling INSIDE it must NOT
    // close it.
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const style: CSSProperties = { position: "fixed", left: pos.left, top: pos.top, margin: 0 };

  return createPortal(
    <div ref={ref} className="wf-pop cv-ctxmenu" style={style} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((entry, i) =>
        entry === "sep" ? (
          <div key={`sep-${i}`} className="wf-pop-sep" />
        ) : (
          <button
            key={entry.label}
            type="button"
            className={"wf-mi" + (entry.danger ? " danger" : "")}
            disabled={entry.disabled}
            onClick={() => {
              if (entry.disabled) return;
              entry.onClick();
              onClose();
            }}
          >
            {entry.icon ? <Ico name={entry.icon} className="sm" /> : <span className="cv-ctxmenu-noicon" />}
            <span className="wf-mi-t">{entry.label}</span>
            {entry.hint ? <span className="wf-mi-h wf-mono">{entry.hint}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
