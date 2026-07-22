// Shared "open this artifact" action, used by every artifact surface (the inline card, the
// composer chip rows, and the prose link card). It routes to the IN-APP viewer when a local
// file is available to render, and falls back to opening the hosted claude.ai page in the
// browser otherwise (e.g. a link to an artifact from another conversation, or after a reload
// once the ephemeral temp file is gone and we only have the URL).

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEditorStore } from "../editor/editorStore";
import { ARTIFACT_URL_RE } from "./artifacts";

/**
 * {@link ARTIFACT_URL_RE} anchored at the start, compiled ONCE at module load.
 *
 * ⚠️ HOT PATH: `isArtifactUrl` runs for EVERY markdown link StreamMarkdown renders in a thread
 * (see MentionLink), so building a fresh `RegExp` per call would allocate + recompile a pattern
 * on a render path that can fire hundreds of times per streamed turn. Hoisted, not inlined.
 *
 * ⚠️ Deliberate asymmetry: this anchored form is case-INSENSITIVE while `ARTIFACT_URL_RE` (which
 * parses the publish tool_result) is case-SENSITIVE. They read from opposite sides of the trust
 * boundary: the tool_result is text the CLI itself emits in one exact canonical shape, so the
 * parse stays strict (a lookalike in surrounding prose must not be mistaken for the ack's URL);
 * an href, on the other hand, is prose the model (or the user) typed, where scheme/host casing
 * legitimately drifts (`HTTPS://Claude.ai/…` is the SAME resource per RFC 3986). A false negative
 * here silently downgrades a real artifact link to a plain anchor, so recognition is tolerant.
 * The tolerance is safe downstream: a case-drifted URL simply fails the exact `a.url === url`
 * lookup in ArtifactRefCard and degrades to opening the hosted page in the browser.
 *
 * No `g` flag — a shared `/g/` regex carries `lastIndex` between `.test()` calls and would
 * alternate true/false on the same input. Keep it stateless.
 */
const ARTIFACT_URL_ANCHORED_RE = new RegExp(`^${ARTIFACT_URL_RE.source}`, "i");

/** True when `href` is a canonical hosted-artifact URL (anchored at the start). */
export function isArtifactUrl(href: string | undefined | null): boolean {
  return !!href && ARTIFACT_URL_ANCHORED_RE.test(href);
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
