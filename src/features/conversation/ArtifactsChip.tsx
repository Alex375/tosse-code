// The composer's "Artifacts (N)" chip: the always-reachable, per-conversation index of every
// artifact Claude published in this conversation, grouped by artifact with its version history.
// Click the chip → a portal popover (fixed-positioned under it, opening upward from the composer)
// listing each artifact newest-first; click a row → open the hosted page on claude.ai.
//
// Rendered ONLY when the conversation has ≥1 artifact (Codex conversations never do — the
// Artifact tool is Claude-only). READ-ONLY toward claude.ai — it only surfaces what was already
// published; it never issues a publish/list call. The portal escapes the composer's overflow the
// same way <BackgroundTaskBadge> does.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dot, Ico } from "../../ui/kit";
import { useArtifacts, type Artifact } from "./artifacts";
import { openArtifactView } from "./artifactOpen";

/** One artifact in the popover: its favicon + title + description + version count, opening the
 *  artifact in the in-app viewer; its versions expand inline (informational — the wire exposes one
 *  canonical URL, not a per-version link, so we never fabricate one). */
function ArtifactRow({ art, session, onOpened }: { art: Artifact; session: string; onOpened: () => void }) {
  const [showVersions, setShowVersions] = useState(false);
  const url = art.url;
  const vcount = art.versions.length;
  const open = () => {
    openArtifactView({
      convId: session,
      title: art.title,
      favicon: art.favicon,
      url,
      filePath: art.latestFilePath,
    });
    onOpened();
  };
  return (
    <div className="cv-artpop-item">
      <div className="cv-artpop-head">
        <button
          type="button"
          className="cv-artpop-open"
          disabled={!url}
          onClick={open}
          title={url ? "Open in Flight Deck" : "Not published yet"}
        >
          <span className="cv-artpop-fav" aria-hidden="true">
            {art.favicon || "🎨"}
          </span>
          <span className="cv-artpop-main">
            <span className="cv-artpop-title">{art.title}</span>
            {art.description ? <span className="cv-artpop-desc">{art.description}</span> : null}
          </span>
          {url ? <Ico name="external" className="sm" /> : <Dot s="off" />}
        </button>
        {vcount > 1 ? (
          <button
            type="button"
            className="cv-artpop-vbtn"
            onClick={() => setShowVersions((v) => !v)}
            aria-expanded={showVersions}
            title={showVersions ? "Hide versions" : "Show versions"}
          >
            <span className="wf-mono">v{vcount}</span>
            <Ico name="chev" className="sm" />
          </button>
        ) : (
          <span className="cv-artpop-v1 wf-mono">v1</span>
        )}
      </div>
      {vcount > 1 && showVersions ? (
        <div className="cv-artpop-versions">
          {art.versions
            .slice()
            .reverse()
            .map((v, i) => (
              <div key={v.toolUseId} className="cv-artpop-vrow">
                <span className="cv-artpop-vn wf-mono">v{vcount - i}</span>
                <span className="cv-artpop-vlabel">{v.label ?? "—"}</span>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}

export function ArtifactsChip({ session }: { session: string }) {
  const artifacts = useArtifacts(session);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on Escape while open. This popover owns Escape while open, so stopPropagation keeps an
  // outer window-level modal (the Flight Deck reply modal) from also closing on the same keypress.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const n = artifacts.length;
  if (n === 0) return null;

  function toggle() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const POP_W = 320;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.min(Math.max(8, r.left), vw - POP_W - 8);
      const belowSpace = vh - r.bottom - 12;
      const aboveSpace = r.top - 12;
      // The chip lives in the composer near the bottom, so there is usually more room ABOVE:
      // open upward unless below genuinely has more space.
      if (belowSpace > aboveSpace && belowSpace >= 220) {
        setPos({ left, top: r.bottom + 6, maxHeight: belowSpace });
      } else {
        setPos({ left, bottom: vh - r.top + 6, maxHeight: aboveSpace });
      }
    }
    setOpen((o) => !o);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="wf-chip"
        data-open={open || undefined}
        onClick={toggle}
        title={`${n} artifact${n === 1 ? "" : "s"} published in this conversation`}
        aria-label="Artifacts"
      >
        <Ico name="artifact" className="sm" />
        <span className="wf-mono">{n}</span>
      </button>

      {open && pos
        ? createPortal(
            <div className="cv-artpop-backdrop" onClick={() => setOpen(false)}>
              <div
                className="cv-artpop"
                style={{
                  position: "fixed",
                  left: pos.left,
                  top: pos.top,
                  bottom: pos.bottom,
                  maxHeight: pos.maxHeight,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="cv-artpop-h">
                  <Ico name="artifact" className="sm" />
                  Artifacts
                  <span className="cv-artpop-count wf-mono">{n}</span>
                </div>
                {artifacts
                  .slice()
                  .reverse()
                  .map((a) => (
                    <ArtifactRow
                      key={a.url ?? a.latestFilePath}
                      art={a}
                      session={session}
                      onOpened={() => setOpen(false)}
                    />
                  ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
