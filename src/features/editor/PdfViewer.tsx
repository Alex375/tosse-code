// PDF preview for the file viewer, rendered with pdf.js (pdfjs-dist). Lives in its
// own lazily-loaded chunk (like MonacoView) so pdf.js stays out of the startup
// bundle — it only loads when a .pdf is actually opened.
//
// Why pdf.js and not a native `<embed>`/`<iframe>` of the PDF bytes: pdf.js renders
// to <canvas> identically in every engine (Chromium in dev/Playwright AND the macOS
// WKWebView we ship on), so behaviour verified in dev holds in production. WKWebView's
// native in-frame PDF rendering is version-dependent and can silently fail. The bytes
// come from the local core (read_image → base64), so nothing is fetched over the network.
//
// Interaction mirrors the ImageViewer: pages fit the panel WIDTH by default, then
// Ctrl/Cmd+wheel (or the +/- buttons / double-click) zooms. Crucially the pages are
// sized by LAYOUT (a width per page + CSS aspect-ratio), never a CSS transform — so
// (a) narrowing the panel rescales the page instead of squashing it (aspect-ratio is
// fixed), and (b) vertical scrolling through a multi-page document keeps working (a
// transform wouldn't grow the scroll area). Each zoom re-renders the bitmap at the new
// size (via an offscreen canvas swapped in one paint → no flash) so text stays crisp.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
// The pre-built worker, emitted as a static asset by Vite; pdf.js spawns it to parse
// off the main thread. Set once at module load (idempotent).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import styles from "./editor.module.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;

/** Zoom is a multiplier over the "fit width" baseline: 1 = the page fills the panel
 *  width (the default). Below 1 shrinks to see more of a tall page; above 1 zooms in. */
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 6;
const ZOOM_BTN_STEP = 1.25;
/** Horizontal breathing room (px each side) between a fit-width page and the panel. */
const PAD = 16;
/** Cap on a rendered page's bitmap width (px) so extreme zoom can't blow up memory. */
const MAX_BITMAP_W = 2600;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Decode base64 (no `data:` prefix) to raw bytes for pdf.js. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export default function PdfViewer({ base64 }: { base64: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PdfDoc | null>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Unit (scale-1) size per page, for the CSS aspect-ratio (reserves correct space
   *  before the bitmap paints → no layout jump, no squash). */
  const [pageDims, setPageDims] = useState<{ w: number; h: number }[]>([]);
  /** Content width available at zoom 1 (panel width minus padding), live-measured. */
  const [fitWidth, setFitWidth] = useState(0);
  const [zoom, setZoom] = useState(1);

  // ---- Load the document + collect page sizes (once per file) ----------------
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    setPageDims([]);
    canvasRefs.current = [];
    pdfRef.current = null;

    // Destroying the loading task (in cleanup) tears down the worker transport AND the
    // resolved document — so teardown on remount / a new file needs nothing more.
    const task = pdfjsLib.getDocument({ data: base64ToBytes(base64) });
    (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled) return;
        const dims: { w: number; h: number }[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const v = page.getViewport({ scale: 1 });
          dims.push({ w: v.width, h: v.height });
        }
        if (cancelled) return;
        pdfRef.current = pdf;
        setPageDims(dims);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [base64]);

  // ---- Track the available width (panel resize / tree toggle / window) --------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setFitWidth(Math.max(80, el.clientWidth - PAD * 2));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- Keep the scroll centre stable across a zoom change --------------------
  const prevZoom = useRef(zoom);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const ratio = prevZoom.current > 0 ? zoom / prevZoom.current : 1;
    if (el && ratio !== 1) {
      el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
      el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2;
    }
    prevZoom.current = zoom;
  }, [zoom]);

  // ---- Render (debounced) each page at the current display size --------------
  const pageWidth = Math.max(1, Math.round(fitWidth * zoom));
  const numPages = pageDims.length;
  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf || numPages === 0 || fitWidth <= 0) return;
    let cancelled = false;
    // We only ever cancel these render tasks on teardown; that's all we need typed.
    const tasks: { cancel: () => void }[] = [];
    const dpr = window.devicePixelRatio || 1;
    const timer = setTimeout(async () => {
      for (let i = 0; i < numPages; i++) {
        if (cancelled) return;
        const canvas = canvasRefs.current[i];
        if (!canvas) continue;
        let page;
        try {
          page = await pdf.getPage(i + 1);
        } catch {
          return;
        }
        if (cancelled) return;
        const unit = page.getViewport({ scale: 1 });
        // Fit-width × dpr for crispness, capped so extreme zoom can't explode memory.
        const scale = Math.min((pageWidth / unit.width) * dpr, MAX_BITMAP_W / unit.width);
        const viewport = page.getViewport({ scale });
        // Render to an OFFSCREEN canvas, then blit in one synchronous step: setting the
        // visible canvas's width clears it, so drawing in the same tick avoids a flash.
        const off = document.createElement("canvas");
        off.width = Math.max(1, Math.ceil(viewport.width));
        off.height = Math.max(1, Math.ceil(viewport.height));
        const rt = page.render({ canvas: off, viewport });
        tasks.push(rt);
        try {
          await rt.promise;
        } catch {
          return; // cancelled (superseded pass) or a render error
        }
        if (cancelled) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext("2d")?.drawImage(off, 0, 0);
        page.cleanup();
      }
    }, 110);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const rt of tasks) {
        try {
          rt.cancel();
        } catch {
          /* already settled */
        }
      }
    };
  }, [numPages, pageWidth, fitWidth]);

  // ---- Ctrl/Cmd+wheel (and trackpad pinch) zoom; plain wheel scrolls ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain wheel = natural scroll
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setZoom((z) => clamp(z * factor, ZOOM_MIN, ZOOM_MAX));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (f: number) => setZoom((z) => clamp(z * f, ZOOM_MIN, ZOOM_MAX));
  const reset = () => setZoom(1);
  const onDoubleClick = () => setZoom((z) => (z > 1.01 ? 1 : 2));

  if (error) return <div className={styles.placeholder}>PDF illisible : {error}</div>;

  const canOut = zoom > ZOOM_MIN + 1e-3;
  const canIn = zoom < ZOOM_MAX - 1e-3;

  return (
    <div className={styles.pdfViewer}>
      <div className={styles.pdfScroll} ref={scrollRef} onDoubleClick={onDoubleClick}>
        {loading ? (
          <div className={styles.placeholder}>Chargement du PDF…</div>
        ) : (
          <div className={styles.pdfPages} style={{ width: `${pageWidth}px` }}>
            {pageDims.map((d, i) => (
              <canvas
                key={i}
                ref={(el) => {
                  canvasRefs.current[i] = el;
                }}
                className={styles.pdfPage}
                style={{ aspectRatio: `${d.w} / ${d.h}` }}
              />
            ))}
          </div>
        )}
      </div>
      <div className={styles.imageInfo}>
        {numPages > 0 ? (
          <span>
            {numPages} page{numPages > 1 ? "s" : ""}
          </span>
        ) : null}
        <span className={styles.imageInfoSpace} />
        <div className={styles.zoomControls}>
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => zoomBy(1 / ZOOM_BTN_STEP)}
            disabled={!canOut}
            title="Dézoomer"
            aria-label="Dézoomer"
          >
            −
          </button>
          <button
            type="button"
            className={styles.zoomPct}
            onClick={reset}
            disabled={Math.abs(zoom - 1) < 1e-3}
            title="Réinitialiser (ajuster à la largeur)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => zoomBy(ZOOM_BTN_STEP)}
            disabled={!canIn}
            title="Zoomer"
            aria-label="Zoomer"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
