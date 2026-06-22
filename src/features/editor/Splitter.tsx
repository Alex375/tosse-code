import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import styles from "./editor.module.css";

/**
 * A thin draggable divider. Reports the live pointer position (clientX/clientY)
 * during a drag; the parent converts that to a size against its own bounding rect
 * (so resizing stays correct as the window resizes). Uses pointer capture so the
 * drag keeps tracking even when the cursor leaves the 6px hit area.
 */
export function Splitter({
  axis,
  onMove,
}: {
  axis: "x" | "y";
  onMove: (clientX: number, clientY: number) => void;
}) {
  const dragging = useRef(false);

  const onDown = (e: ReactPointerEvent) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    onMove(e.clientX, e.clientY);
  };
  const onUp = (e: ReactPointerEvent) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
  };

  return (
    <div
      className={axis === "x" ? styles.splitterX : styles.splitterY}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={onDown}
      onPointerMove={onPointerMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}
