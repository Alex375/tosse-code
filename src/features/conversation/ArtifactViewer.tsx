// The side-region ARTIFACT VIEWER: reads an artifact's local file and renders it in place —
// self-contained HTML in a sandboxed (null-origin) iframe under our own CSP, Markdown via the
// thread renderer. The local file is an ephemeral temp path, so when it can't be rendered (gone,
// too large, not text, unreadable) the viewer says WHICH of those happened and degrades to an
// "Open on claude.ai" button (the durable hosted copy). READ-ONLY: it never writes anything, and
// the iframe's scripts can reach neither the app nor the network.

import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import type { ArtifactView } from "../editor/editorStore";
import { withArtifactCsp } from "./artifactCsp";
import { StreamMarkdown } from "./StreamMarkdown";

/**
 * Why the file can't be shown. These stay DISTINCT outcomes on purpose: they used to collapse
 * into one vague "isn't available", which told the user nothing and (for a genuine read failure)
 * swallowed the reason entirely. Each one gets its own honest message — zero silent error.
 */
type LoadFailure =
  /** The artifact carries no local path at all — there is nothing to read. */
  | { status: "nopath" }
  /** `read_file` failed (file swept from /tmp, permissions, I/O). `reason` is surfaced verbatim. */
  | { status: "unreadable"; reason: string }
  /** Over `fs::MAX_FILE_BYTES` — the backend returns EMPTY content, so there is nothing to render. */
  | { status: "tooLarge"; size: number }
  /** A NUL byte was found → not text; `content` is empty and it can never render as HTML/Markdown. */
  | { status: "binary" };

type Load = { status: "loading" } | { status: "ready"; content: string } | LoadFailure;

/** Human-readable byte size, for the "too large" message only. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the user is told for each failure: what happened, and why when we know it. */
function failureMessage(f: LoadFailure): { headline: string; detail: string | null } {
  switch (f.status) {
    case "nopath":
      return {
        headline: "The local copy of this artifact is gone.",
        detail: "No local file was recorded for it (its temp file is ephemeral and doesn’t survive a reload).",
      };
    case "tooLarge":
      return {
        headline: "This artifact is too large to preview here.",
        detail: `${formatBytes(f.size)} — over the app’s 16 MiB read limit.`,
      };
    case "binary":
      return {
        headline: "This artifact isn’t previewable text.",
        detail: "Its file contains binary data, so it can’t be rendered as HTML or Markdown.",
      };
    case "unreadable":
      return { headline: "This artifact’s local file couldn’t be read.", detail: f.reason };
  }
}

/** The failure panel: the reason, plus the hosted copy as a way out whenever we know its URL. */
function ArtifactUnavailable({
  failure,
  favicon,
  url,
}: {
  failure: LoadFailure;
  favicon: string | null;
  url: string | null;
}) {
  const { headline, detail } = failureMessage(failure);
  return (
    <div className="cv-artview-msg">
      <span className="cv-artview-fav cv-artview-msgfav" aria-hidden="true">
        {favicon || "🎨"}
      </span>
      <p>{headline}</p>
      {detail ? <p style={{ opacity: 0.75 }}>{detail}</p> : null}
      {url ? (
        <button type="button" className="cv-artview-open" onClick={() => void openUrl(url)}>
          <Ico name="external" className="sm" /> Open on claude.ai
        </button>
      ) : (
        <p style={{ opacity: 0.75 }}>No hosted link is known for it either.</p>
      )}
    </div>
  );
}

export function ArtifactViewer({ view, onClose }: { view: ArtifactView; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const url = view.url;

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    const path = view.filePath;
    if (!path) {
      setLoad({ status: "nopath" });
      return;
    }
    commands
      .readFile(path)
      .then((res) => {
        if (cancelled) return;
        if (res.status !== "ok") {
          // A failed read is a REAL failure (temp file swept, permissions, I/O): log it and show
          // the underlying reason instead of a generic message that hides what went wrong.
          console.error("ArtifactViewer: readFile failed for", path, "-", res.error);
          setLoad({ status: "unreadable", reason: res.error });
          return;
        }
        const f = res.data;
        // `too_large` and `binary` both come back with EMPTY content — rendering that would show a
        // blank frame and look like a bug, so each is reported as what it is.
        if (f.too_large) setLoad({ status: "tooLarge", size: f.size });
        else if (f.binary) setLoad({ status: "binary" });
        else setLoad({ status: "ready", content: f.content });
      })
      .catch((e: unknown) => {
        // The generated bindings RETHROW genuine `Error`s (only string command errors become error
        // Results). Without this branch a transport failure would leave the viewer stuck on
        // "Loading…" forever, with nothing in the console to explain it.
        if (cancelled) return;
        const reason = e instanceof Error ? e.message : String(e);
        console.error("ArtifactViewer: readFile threw for", path, "-", reason);
        setLoad({ status: "unreadable", reason });
      });
    return () => {
      cancelled = true;
    };
  }, [view.filePath]);

  // Splice the CSP in ONCE per loaded document, not on every render: the artifact's HTML can be
  // megabytes and this component re-renders on any layout change (a splitter drag re-renders
  // MainArea), so doing it inline would re-scan + re-copy that string on every animation frame.
  const frameHtml = useMemo(
    () => (load.status === "ready" && view.kind === "html" ? withArtifactCsp(load.content) : null),
    [load, view.kind],
  );

  return (
    <div className="cv-artview">
      <div className="cv-artview-h">
        <span className="cv-artview-fav" aria-hidden="true">
          {view.favicon || "🎨"}
        </span>
        <span className="cv-artview-title" title={view.title}>
          {view.title}
        </span>
        {url ? (
          <button
            type="button"
            className="cv-artview-btn"
            title="Open on claude.ai"
            aria-label="Open on claude.ai"
            onClick={() => void openUrl(url)}
          >
            <Ico name="external" className="sm" />
          </button>
        ) : null}
        <button type="button" className="cv-artview-btn" title="Close" aria-label="Close artifact viewer" onClick={onClose}>
          <Ico name="x" className="sm" />
        </button>
      </div>
      <div className="cv-artview-body">
        {load.status === "loading" ? (
          <div className="cv-artview-msg">Loading…</div>
        ) : load.status === "ready" ? (
          view.kind === "md" ? (
            <div className="cv-artview-md">
              <StreamMarkdown text={load.content} />
            </div>
          ) : (
            <iframe
              className="cv-artview-frame"
              // Sandboxed to a NULL origin (NO allow-same-origin): the artifact's own scripts run
              // but cannot reach the app / its storage. srcDoc renders the self-contained HTML.
              //
              // `allow-popups` is a DELIBERATE choice, not an oversight: an artifact may
              // legitimately link out (a source, a doc), and a popup opened from a sandboxed frame
              // INHERITS the sandbox — so the escape hatch it grants is a new null-origin window,
              // not a privileged one.
              //
              // The sandbox alone gives isolation but NOT network restriction, and the app's own
              // Tauri CSP is `null` — while on claude.ai the very same page runs behind a strict
              // CSP blocking every external host. `withArtifactCsp` re-creates that guarantee
              // inside the document, so an in-app preview is never more capable than the hosted
              // page. See artifactCsp.ts.
              sandbox="allow-scripts allow-popups"
              srcDoc={frameHtml ?? ""}
              title={view.title}
            />
          )
        ) : (
          <ArtifactUnavailable failure={load} favicon={view.favicon} url={url} />
        )}
      </div>
    </div>
  );
}
