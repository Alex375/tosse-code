import { Ico } from "../../ui/kit";
import { useEditorLayout, useEditorStore } from "./editorStore";

/**
 * Title-bar controls for the editor panel: a toggle to open/close it, and — when
 * a region is shown (editor, terminal, OR the Git workspace) — a toggle to switch
 * its placement between side-by-side and stacked. In Git mode the orientation
 * button drives the Git workspace's own orientation (`gitOrientation`); otherwise
 * the editor/terminal region's (`orientation`).
 */
export function EditorToggle() {
  const { open, terminalOpen, gitOpen, orientation, gitOrientation } = useEditorLayout();
  const toggleOpen = useEditorStore((s) => s.toggleOpen);
  const setOrientation = useEditorStore((s) => s.setOrientation);
  const setGitOrientation = useEditorStore((s) => s.setGitOrientation);
  const sideOpen = open || terminalOpen || gitOpen;
  const curOrientation = gitOpen ? gitOrientation : orientation;
  const flipOrientation = () => {
    const next = curOrientation === "row" ? "column" : "row";
    if (gitOpen) setGitOrientation(next);
    else setOrientation(next);
  };

  return (
    <>
      {sideOpen ? (
        <button
          type="button"
          className="wf-icon-btn"
          onClick={flipOrientation}
          title={curOrientation === "row" ? "Disposition empilée (haut/bas)" : "Disposition côte à côte"}
          aria-label="Changer la disposition du panneau"
        >
          <Ico name={curOrientation === "row" ? "splitv" : "splith"} className="sm" />
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
