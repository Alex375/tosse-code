import { lazy, Suspense } from "react";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import { Ico } from "../../ui/kit";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import { baseName, fileBadge, isMarkdownPath } from "./language";
import { fileIconUrl, useFileIcons } from "./fileIcons";
import { useConvEditor, useEditorStore, type FileBuffer } from "./editorStore";
import styles from "./editor.module.css";

// Monaco lives in its own lazily-loaded chunk (see MonacoView's header).
const MonacoView = lazy(() => import("./MonacoView"));

/** Tab bar + the active file's content (Monaco / markdown preview / a guard). */
export function EditorPane({ convId }: { convId: string }) {
  const conv = useConvEditor(convId);
  const selectTab = useEditorStore((s) => s.selectTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const pinTab = useEditorStore((s) => s.pinTab);
  const toggleTree = useEditorStore((s) => s.toggleTree);
  const treeCollapsed = useEditorStore((s) => s.treeCollapsed);
  const iconMap = useFileIcons();

  if (!conv) return null;
  const active = conv.activeTab ? conv.buffers[conv.activeTab] ?? null : null;

  return (
    <div className={styles.editor}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          className={styles.treeToggle}
          data-on={!treeCollapsed ? "" : undefined}
          onClick={toggleTree}
          title={treeCollapsed ? "Afficher l'arborescence" : "Masquer l'arborescence"}
          aria-label="Afficher/masquer l'arborescence"
        >
          <Ico name="sidebar" className="sm" />
        </button>
        {conv.tabs.map((p) => {
          const b = conv.buffers[p];
          const on = conv.activeTab === p;
          const preview = conv.previewTab === p;
          const iconUrl = iconMap ? fileIconUrl(iconMap, p) : null;
          const badge = fileBadge(p);
          return (
            <div
              key={p}
              role="tab"
              aria-selected={on}
              className={
                styles.tab + (on ? " " + styles.tabActive : "") + (preview ? " " + styles.tabPreview : "")
              }
              onClick={() => selectTab(convId, p)}
              onDoubleClick={() => pinTab(convId, p)}
              title={p}
            >
              {iconUrl ? (
                <img src={iconUrl} className={styles.entryIcon} alt="" draggable={false} />
              ) : (
                <span className={styles.tabBadge} style={{ color: badge.color }}>
                  {badge.label}
                </span>
              )}
              <span className={styles.tabName}>{b?.name ?? baseName(p)}</span>
              {b?.dirty ? <span className={styles.tabDirty}>•</span> : null}
              <button
                type="button"
                className={styles.tabClose}
                aria-label="Fermer l'onglet"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(convId, p);
                }}
              >
                <Ico name="x" className="sm" />
              </button>
            </div>
          );
        })}
      </div>

      {active ? (
        <ActiveFile convId={convId} buffer={active} openPaths={conv.tabs} />
      ) : (
        <div className={styles.placeholder}>
          {conv.tabs.length === 0
            ? "Sélectionne un fichier dans l'arborescence pour l'ouvrir."
            : "Aucun onglet sélectionné."}
        </div>
      )}
    </div>
  );
}

function ActiveFile({
  convId,
  buffer,
  openPaths,
}: {
  convId: string;
  buffer: FileBuffer;
  openPaths: string[];
}) {
  const setContent = useEditorStore((s) => s.setContent);
  const saveBuffer = useEditorStore((s) => s.saveBuffer);
  const togglePreview = useEditorStore((s) => s.togglePreview);
  const reloadFromDisk = useEditorStore((s) => s.reloadFromDisk);
  const keepLocal = useEditorStore((s) => s.keepLocal);

  const isMd = isMarkdownPath(buffer.path);
  const editable = !buffer.binary && !buffer.tooLarge && !buffer.loading && !buffer.error;

  return (
    <div className={styles.content}>
      {buffer.diskChanged ? (
        <div className={styles.banner}>
          <Ico name="alert" className="sm" />
          <span className={styles.bannerMsg}>
            Ce fichier a été modifié sur le disque (tu as des modifications non sauvegardées).
          </span>
          <button type="button" className={styles.bannerBtn} onClick={() => reloadFromDisk(convId, buffer.path)}>
            Recharger
          </button>
          <button type="button" className={styles.bannerBtn} onClick={() => keepLocal(convId, buffer.path)}>
            Garder mes modifs
          </button>
        </div>
      ) : null}

      {editable ? (
        <div className={styles.toolbar}>
          {isMd ? (
            <>
              <button
                type="button"
                className={styles.toolBtn + (buffer.preview ? " " + styles.toolBtnOn : "")}
                onClick={() => togglePreview(convId, buffer.path)}
              >
                <Ico name="file" className="sm" />
                Aperçu
              </button>
              <button
                type="button"
                className={styles.toolBtn + (!buffer.preview ? " " + styles.toolBtnOn : "")}
                onClick={() => togglePreview(convId, buffer.path)}
              >
                <Ico name="diff" className="sm" />
                Source
              </button>
            </>
          ) : null}
          <span className={styles.toolbarSpace} />
          <span>{buffer.dirty ? "Modifié…" : "Enregistré"}</span>
        </div>
      ) : null}

      {buffer.loading ? (
        <div className={styles.placeholder}>Chargement…</div>
      ) : buffer.error ? (
        <div className={styles.placeholder}>{buffer.error}</div>
      ) : buffer.tooLarge ? (
        <div className={styles.placeholder}>Fichier trop volumineux pour être affiché (&gt; 16 Mo).</div>
      ) : buffer.binary ? (
        <div className={styles.placeholder}>Fichier binaire — aperçu non disponible.</div>
      ) : isMd && buffer.preview ? (
        <div className={styles.mdPreview}>
          <StreamMarkdown text={buffer.content} />
        </div>
      ) : (
        <EditorErrorBoundary key={buffer.path}>
          <Suspense fallback={<div className={styles.placeholder}>Chargement de l'éditeur…</div>}>
            <MonacoView
              path={buffer.path}
              value={buffer.content}
              language={buffer.language}
              openPaths={openPaths}
              onChange={(v) => setContent(convId, buffer.path, v)}
              onSave={() => void saveBuffer(convId, buffer.path)}
            />
          </Suspense>
        </EditorErrorBoundary>
      )}
    </div>
  );
}
