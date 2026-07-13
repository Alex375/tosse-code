import { lazy, Suspense, useRef } from "react";
import { EditorPanel } from "../editor/EditorPanel";
import { Splitter } from "../editor/Splitter";
import { clamp, useEditorLayout, useEditorStore } from "../editor/editorStore";

// Lazy: xterm.js + its WebGL/fit addons stay out of the startup bundle (mirrors
// Monaco) — fetched only when the integrated terminal is first opened.
const TerminalView = lazy(() => import("../terminal/TerminalView"));

/**
 * The right-hand side region: the editor and/or the integrated terminal. The
 * region itself is placed by `sideBySide` (true = to the right of the conversation,
 * false = below it) — that outer split is handled by MainArea. Here we lay out the
 * two panes WITHIN the region, splitting along the axis perpendicular to the
 * region's placement so the result reads naturally:
 *
 *  - Region on the right (sideBySide): a tall column → editor on top, terminal at
 *    the BOTTOM (a horizontal divider). "Terminal at the bottom right."
 *  - Region below (stacked): a wide strip → editor on the left, terminal on the
 *    RIGHT (a vertical divider). "Terminal on the right."
 *
 * With only one pane open it fills the region (terminal alone = the whole right
 * side). `terminalFraction` (draggable) sizes the terminal when both are open, so
 * the terminal resizes in both height and width depending on the layout.
 */
export function SidePanel({
  convId,
  cwd,
  sideBySide,
}: {
  convId: string;
  cwd: string;
  sideBySide: boolean;
}) {
  const { open, terminalOpen, terminalFraction } = useEditorLayout();
  const setTerminalFraction = useEditorStore((s) => s.setTerminalFraction);
  const ref = useRef<HTMLDivElement>(null);
  const both = open && terminalOpen;

  // Inner direction is perpendicular to the region's placement: region-on-right
  // (sideBySide) stacks vertically (column); region-below stacks horizontally (row).
  const innerColumn = sideBySide;
  // Both panes carry the same conversation-separator border as the editor would
  // (left when the region is on the right, top when it's below).
  const stacked = !sideBySide;

  const onInnerDrag = (clientX: number, clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    // Terminal fraction = the space past the pointer (terminal is the 2nd pane).
    const frac = innerColumn
      ? 1 - (clientY - rect.top) / rect.height
      : 1 - (clientX - rect.left) / rect.width;
    setTerminalFraction(clamp(frac, 0.15, 0.85));
  };

  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: innerColumn ? "column" : "row",
      }}
    >
      {open ? (
        <div
          style={{
            flex: `${both ? 1 - terminalFraction : 1} 1 0`,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
          }}
        >
          <EditorPanel convId={convId} cwd={cwd} stacked={stacked} />
        </div>
      ) : null}
      {both ? <Splitter axis={innerColumn ? "y" : "x"} onMove={onInnerDrag} /> : null}
      {terminalOpen ? (
        <div
          style={{
            flex: `${both ? terminalFraction : 1} 1 0`,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
          }}
        >
          <Suspense fallback={<div style={{ flex: 1, background: "var(--wf-bg)" }} />}>
            <TerminalView convId={convId} cwd={cwd} stacked={stacked} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
