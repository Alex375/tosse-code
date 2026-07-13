import { Ico } from "../../ui/kit";
import { useEditorStore } from "../editor/editorStore";

/**
 * Title-bar toggle that opens/closes the Git panel — the 3rd mode of the side
 * region (next to the editor and terminal). Mirrors EditorToggle/TerminalToggle;
 * goes `.on` while open. While open the Git panel takes over the whole side
 * region, so the editor/terminal split is hidden until it's toggled back off.
 */
export function GitToggle() {
  const gitOpen = useEditorStore((s) => s.gitOpen);
  const toggleGit = useEditorStore((s) => s.toggleGit);

  return (
    <button
      type="button"
      className={"wf-icon-btn" + (gitOpen ? " on" : "")}
      data-on={gitOpen ? "" : undefined}
      onClick={toggleGit}
      title={gitOpen ? "Close the Git panel" : "Open the Git panel"}
      aria-label="Toggle the Git panel"
    >
      <Ico name="branch" className="sm" />
    </button>
  );
}
