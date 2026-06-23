import { Ico } from "../../ui/kit";
import { useEditorLayout, useEditorStore } from "./editorStore";

/**
 * Title-bar controls for the editor panel: a toggle to open/close it, and — when
 * the side region is shown (editor OR terminal open) — a toggle to switch its
 * placement between side-by-side (to the right of the conversation) and stacked
 * (below it). Orientation governs the whole side region, so it's available as soon
 * as either pane is open.
 */
export function EditorToggle() {
  const { open, terminalOpen, orientation } = useEditorLayout();
  const toggleOpen = useEditorStore((s) => s.toggleOpen);
  const setOrientation = useEditorStore((s) => s.setOrientation);
  const sideOpen = open || terminalOpen;

  return (
    <>
      {sideOpen ? (
        <button
          type="button"
          className="wf-icon-btn"
          onClick={() => setOrientation(orientation === "row" ? "column" : "row")}
          title={orientation === "row" ? "Disposition empilée (haut/bas)" : "Disposition côte à côte"}
          aria-label="Changer la disposition du panneau latéral"
        >
          <Ico name={orientation === "row" ? "splitv" : "splith"} className="sm" />
        </button>
      ) : null}
      <button
        type="button"
        className={"wf-icon-btn" + (open ? " on" : "")}
        data-on={open ? "" : undefined}
        onClick={toggleOpen}
        title={open ? "Fermer l'éditeur" : "Ouvrir l'éditeur de fichiers"}
        aria-label="Basculer l'éditeur de fichiers"
      >
        <Ico name="code" className="sm" />
      </button>
    </>
  );
}
