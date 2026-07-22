// The side-region ARTIFACT VIEWER: reads an artifact's local file and renders it in place —
// self-contained HTML in a sandboxed (null-origin) iframe, Markdown via the thread renderer.
// The local file is an ephemeral temp path, so when it is gone (e.g. after a reload) the viewer
// degrades to an "Open on claude.ai" button (the durable hosted copy). READ-ONLY: it never
// writes anything, and the iframe's scripts can't reach the app.

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import type { ArtifactView } from "../editor/editorStore";
import { StreamMarkdown } from "./StreamMarkdown";

type Load = { status: "loading" } | { status: "ready"; content: string } | { status: "missing" };

export function ArtifactViewer({ view, onClose }: { view: ArtifactView; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const url = view.url;

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    if (!view.filePath) {
      setLoad({ status: "missing" });
      return;
    }
    commands
      .readFile(view.filePath)
      .then((res) => {
        if (cancelled) return;
        setLoad(
          res.status === "ok" && !res.data.binary && !res.data.too_large
            ? { status: "ready", content: res.data.content }
            : { status: "missing" },
        );
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [view.filePath]);

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
        ) : load.status === "missing" ? (
          <div className="cv-artview-msg">
            <span className="cv-artview-fav cv-artview-msgfav" aria-hidden="true">
              {view.favicon || "🎨"}
            </span>
            <p>
              The local copy of this artifact isn’t available
              {url ? "." : " and no hosted link is known."}
            </p>
            {url ? (
              <button type="button" className="cv-artview-open" onClick={() => void openUrl(url)}>
                <Ico name="external" className="sm" /> Open on claude.ai
              </button>
            ) : null}
          </div>
        ) : view.kind === "md" ? (
          <div className="cv-artview-md">
            <StreamMarkdown text={load.content} />
          </div>
        ) : (
          <iframe
            className="cv-artview-frame"
            // Sandboxed to a NULL origin (NO allow-same-origin): the artifact's own scripts run
            // but cannot reach the app / its storage. srcDoc renders the self-contained HTML.
            sandbox="allow-scripts allow-popups"
            srcDoc={load.content}
            title={view.title}
          />
        )}
      </div>
    </div>
  );
}
