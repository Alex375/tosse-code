import { useEffect, useRef } from "react";
import { FileTree } from "./FileTree";
import { EditorPane } from "./EditorPane";
import { Splitter } from "./Splitter";
import { useFsWatch } from "./useFsWatch";
import { useEditorStore } from "./editorStore";
import styles from "./editor.module.css";

/**
 * The right-hand editor panel: [file tree | resizable splitter | editor]. Rooted
 * at the conversation's current working directory (`cwd`), which can move when the
 * agent enters a worktree — `ensureConv` re-roots the tree, and `useFsWatch`
 * re-points the live watch. Kept mounted across conversation switches (props
 * change instead of remounting) so Monaco isn't torn down and rebuilt each time.
 */
export function EditorPanel({
  convId,
  cwd,
  stacked,
}: {
  convId: string;
  cwd: string;
  stacked: boolean;
}) {
  const treeWidth = useEditorStore((s) => s.treeWidth);
  const setTreeWidth = useEditorStore((s) => s.setTreeWidth);
  const treeCollapsed = useEditorStore((s) => s.treeCollapsed);
  const ensureConv = useEditorStore((s) => s.ensureConv);
  const panelRef = useRef<HTMLDivElement>(null);

  // Initialise / re-root this conversation's tree at the current cwd.
  useEffect(() => {
    ensureConv(convId, cwd);
  }, [convId, cwd, ensureConv]);

  // Live filesystem watch while the panel is shown.
  useFsWatch(convId, cwd, true);

  // Cmd/Ctrl+W closes the active editor tab. This effect only runs while the
  // editor panel is mounted (open), so the shortcut is scoped to "editor is in
  // use". The native "Close Window" Cmd+W binding is removed (see lib.rs), so this
  // never races the OS — it just closes the tab. No-op when there's no active tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "w" || e.key === "W")) {
        const active = useEditorStore.getState().byConv[convId]?.activeTab;
        if (active) {
          e.preventDefault();
          e.stopPropagation();
          useEditorStore.getState().closeTab(convId, active);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [convId]);

  const onTreeDrag = (clientX: number) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (rect) setTreeWidth(clientX - rect.left);
  };

  return (
    <div ref={panelRef} className={styles.panel + (stacked ? " " + styles.panelStacked : "")}>
      {treeCollapsed ? null : (
        <>
          <FileTree convId={convId} root={cwd} width={treeWidth} />
          <Splitter axis="x" onMove={(x) => onTreeDrag(x)} />
        </>
      )}
      <EditorPane convId={convId} />
    </div>
  );
}
