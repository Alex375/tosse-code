import { Ico } from "../../ui/kit";
import { useEditorLayout, useEditorStore } from "./editorStore";

/**
 * Title-bar controls for the editor panel: a toggle to open/close it, and — when
 * open — a toggle to switch the split between side-by-side (the editor to the
 * right of the conversation) and stacked (below it).
 */
export function EditorToggle() {
  const { open, orientation } = useEditorLayout();
  const toggleOpen = useEditorStore((s) => s.toggleOpen);
  const setOrientation = useEditorStore((s) => s.setOrientation);

  return (
    <>
      {open ? (
        <button
          type="button"
          className="wf-icon-btn"
          onClick={() => setOrientation(orientation === "row" ? "column" : "row")}
          title={orientation === "row" ? "Disposition empilée (haut/bas)" : "Disposition côte à côte"}
          aria-label="Changer la disposition de l'éditeur"
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
