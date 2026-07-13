import { Ico } from "../../ui/kit";
import { useEditorStore } from "../editor/editorStore";

/**
 * Title-bar toggle that opens/closes the integrated terminal in the side region.
 * Mirrors EditorToggle: a `wf-icon-btn` that goes `.on` while open. (Distinct from
 * OpenInTerminalButton, which pops the conversation out into the OS terminal.)
 */
export function TerminalToggle() {
  const terminalOpen = useEditorStore((s) => s.terminalOpen);
  const toggleTerminal = useEditorStore((s) => s.toggleTerminal);

  return (
    <button
      type="button"
      className={"wf-icon-btn" + (terminalOpen ? " on" : "")}
      data-on={terminalOpen ? "" : undefined}
      onClick={toggleTerminal}
      title={terminalOpen ? "Close the terminal" : "Open the integrated terminal"}
      aria-label="Toggle the integrated terminal"
    >
      <Ico name="term" className="sm" />
    </button>
  );
}
