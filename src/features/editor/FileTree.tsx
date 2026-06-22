import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import type { FsEntry } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import { baseName } from "./language";
import { useEditorStore } from "./editorStore";
import styles from "./editor.module.css";

/** Indentation per tree depth, px. */
const INDENT = 12;

/**
 * The file tree for a conversation, rooted at its working directory. Lazily
 * expands one level per click (`toggleDir` reads exactly that directory), so even
 * a huge repo only reads what the user opens. Selects just the tree-relevant
 * slice (dirs / expanded / errors / activeTab) with a shallow comparison, so
 * typing in an open buffer — which mutates a sibling part of the store — never
 * re-renders it.
 */
export function FileTree({ convId, root, width }: { convId: string; root: string; width: number }) {
  const { dirs, expanded, loadingDirs, dirErrors, activeTab } = useEditorStore(
    useShallow((s) => {
      const c = s.byConv[convId];
      return {
        dirs: c?.dirs ?? EMPTY_DIRS,
        expanded: c?.expanded ?? EMPTY_FLAGS,
        loadingDirs: c?.loadingDirs ?? EMPTY_FLAGS,
        dirErrors: c?.dirErrors ?? EMPTY_ERRORS,
        activeTab: c?.activeTab ?? null,
      };
    }),
  );
  const toggleDir = useEditorStore((s) => s.toggleDir);
  const openFile = useEditorStore((s) => s.openFile);
  const setTreeCollapsed = useEditorStore((s) => s.setTreeCollapsed);

  // Load + expand the root the first time it's shown (or after a root move). The
  // `!dirErrors[root]` guard is essential: without it, a failing read (deleted
  // cwd, permissions) would re-fire this effect forever (read → fail → re-render
  // → read …). A click on the header retries.
  useEffect(() => {
    if (dirs[root] === undefined && !loadingDirs[root] && !dirErrors[root]) {
      void toggleDir(convId, root);
    }
  }, [convId, root, dirs, loadingDirs, dirErrors, toggleDir]);

  const rootEntries = dirs[root];

  return (
    <div className={styles.tree} style={{ width, flex: `0 0 ${width}px` }}>
      <div className={styles.treeHead} title={root}>
        <Ico name="folder" className="sm" />
        <span className={styles.rowName} style={{ flex: 1, minWidth: 0 }}>
          {baseName(root)}
        </span>
        <button
          type="button"
          className={styles.treeClose}
          onClick={() => setTreeCollapsed(true)}
          title="Masquer l'arborescence"
          aria-label="Masquer l'arborescence"
        >
          <Ico name="x" className="sm" />
        </button>
      </div>
      <div className={styles.treeBody}>
        {dirErrors[root] ? (
          <div className={styles.treeError} title={dirErrors[root]}>
            <Ico name="alert" className="sm" />
            Impossible de lire ce dossier.
            <button type="button" className={styles.treeRetry} onClick={() => void toggleDir(convId, root)}>
              Réessayer
            </button>
          </div>
        ) : rootEntries === undefined ? (
          <div className={styles.treeLoading}>Chargement…</div>
        ) : rootEntries.length === 0 ? (
          <div className={styles.treeEmpty}>Dossier vide</div>
        ) : (
          rootEntries.map((e) => (
            <TreeNode
              key={e.path}
              entry={e}
              depth={0}
              dirs={dirs}
              expanded={expanded}
              loadingDirs={loadingDirs}
              dirErrors={dirErrors}
              activeTab={activeTab}
              onToggleDir={(p) => void toggleDir(convId, p)}
              onOpenFile={(p) => void openFile(convId, p, { preview: true })}
              onPinFile={(p) => void openFile(convId, p, { preview: false })}
            />
          ))
        )}
      </div>
    </div>
  );
}

const EMPTY_DIRS: Record<string, FsEntry[]> = {};
const EMPTY_FLAGS: Record<string, boolean> = {};
const EMPTY_ERRORS: Record<string, string> = {};

interface NodeProps {
  entry: FsEntry;
  depth: number;
  dirs: Record<string, FsEntry[]>;
  expanded: Record<string, boolean>;
  loadingDirs: Record<string, boolean>;
  dirErrors: Record<string, string>;
  activeTab: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onPinFile: (path: string) => void;
}

function TreeNode({
  entry,
  depth,
  dirs,
  expanded,
  loadingDirs,
  dirErrors,
  activeTab,
  onToggleDir,
  onOpenFile,
  onPinFile,
}: NodeProps) {
  const isOpen = entry.is_dir && !!expanded[entry.path];
  const children = isOpen ? dirs[entry.path] : undefined;
  const active = !entry.is_dir && activeTab === entry.path;
  const err = entry.is_dir ? dirErrors[entry.path] : undefined;

  return (
    <>
      <button
        type="button"
        className={styles.row + (active ? " " + styles.rowActive : "")}
        style={{ paddingLeft: depth * INDENT + 8 }}
        onClick={() => (entry.is_dir ? onToggleDir(entry.path) : onOpenFile(entry.path))}
        onDoubleClick={() => (entry.is_dir ? undefined : onPinFile(entry.path))}
        title={entry.name}
      >
        {entry.is_dir ? (
          <span className={styles.twisty + (isOpen ? " " + styles.twistyOpen : "")}>
            <Ico name="chev" className="sm" />
          </span>
        ) : (
          <span className={styles.twisty} />
        )}
        <span className={styles.rowIcon + " " + (entry.is_dir ? styles.dirIcon : "")}>
          <Ico name={entry.is_dir ? "folder" : "file"} className="sm" />
        </span>
        <span className={styles.rowName}>{entry.name}</span>
      </button>
      {err ? (
        <div
          className={styles.treeError}
          style={{ paddingLeft: (depth + 1) * INDENT + 22 }}
          title={err}
        >
          <Ico name="alert" className="sm" />
          Lecture impossible.
        </div>
      ) : null}
      {isOpen && children === undefined && loadingDirs[entry.path] ? (
        <div className={styles.treeLoading} style={{ paddingLeft: (depth + 1) * INDENT + 22 }}>
          …
        </div>
      ) : null}
      {isOpen && children
        ? children.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              dirs={dirs}
              expanded={expanded}
              loadingDirs={loadingDirs}
              dirErrors={dirErrors}
              activeTab={activeTab}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onPinFile={onPinFile}
            />
          ))
        : null}
    </>
  );
}
