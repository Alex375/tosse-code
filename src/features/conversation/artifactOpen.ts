// Shared "open this artifact" action, used by every artifact surface (the inline card, the
// composer chip rows, and the prose link card). It routes to the IN-APP viewer when a local
// file is available to render, and falls back to opening the hosted claude.ai page in the
// browser otherwise (e.g. a link to an artifact from another conversation, or after a reload
// once the ephemeral temp file is gone and we only have the URL).

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEditorStore } from "../editor/editorStore";
import { ARTIFACT_URL_RE } from "./artifacts";

/** True when `href` is a canonical hosted-artifact URL (anchored at the start). */
export function isArtifactUrl(href: string | undefined | null): boolean {
  return !!href && new RegExp(`^${ARTIFACT_URL_RE.source}`, "i").test(href);
}

/** An artifact renders as Markdown when its file is `.md`/`.markdown`, else as HTML. */
export function artifactKind(filePath: string | null): "html" | "md" {
  return filePath && /\.(md|markdown)$/i.test(filePath) ? "md" : "html";
}

export interface ArtifactOpenMeta {
  convId: string;
  title: string;
  favicon: string | null;
  url: string | null;
  /** Local temp file to render in the viewer, or null. */
  filePath: string | null;
}

/**
 * Open an artifact: render it in the side-region viewer when we have a local file, else open the
 * hosted page in the browser. When neither is available it is a no-op (nothing to show).
 */
export function openArtifactView(meta: ArtifactOpenMeta): void {
  if (meta.filePath) {
    useEditorStore.getState().openArtifact({
      convId: meta.convId,
      title: meta.title,
      favicon: meta.favicon,
      url: meta.url,
      filePath: meta.filePath,
      kind: artifactKind(meta.filePath),
    });
  } else if (meta.url) {
    void openUrl(meta.url);
  }
}
