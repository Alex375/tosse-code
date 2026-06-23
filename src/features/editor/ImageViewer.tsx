import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./editor.module.css";

/** Human-readable byte size (B / KB / MB) for the info strip. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Zoom is a multiplier over the "fit" baseline: 1 = the whole image contained in
 *  the viewport (the default), >1 = zoomed in. We never go below fit. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 32;
/** Per-click factor for the +/- buttons. */
const ZOOM_BTN_STEP = 1.4;

interface XY {
  x: number;
  y: number;
}

interface ImageViewerProps {
  src: string;
  size: number | null;
  /** Restored view for this tab (zoom over fit + pan offset); fit if omitted. */
  initialZoom?: number;
  initialOffset?: XY;
  /** Persist the current view (called on unmount, i.e. when the tab is left). */
  onViewChange?: (zoom: number, offset: XY) => void;
}

/**
 * Renders an image buffer with interactive zoom + pan: contained ("fit") by
 * default on a neutral checkerboard, then the wheel / trackpad pinch zooms toward
 * the cursor, dragging pans once zoomed in, +/- buttons and a reset, and an info
 * strip with dimensions, on-disk size and the current zoom %.
 *
 * Identity: this is rendered with `key={buffer.path}` (see EditorPane), so each
 * image tab gets its OWN instance — switching tabs unmounts/mounts, which is how
 * the per-tab zoom is restored: the view is seeded from `initialZoom/Offset` on
 * mount and flushed back via `onViewChange` on unmount. A `src` change WITHOUT a
 * remount only happens on a live-reload of the same file (the agent rewrites it):
 * we keep the zoom and just re-clamp + clear any error.
 *
 * The src is a `data:` URL built from the base64 bytes the core read, so no
 * asset-protocol / CSP plumbing is needed.
 */
export function ImageViewer({ src, size, initialZoom, initialOffset, onViewChange }: ImageViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [failed, setFailed] = useState(false);
  /** Natural pixel size of the image (from onLoad). */
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  /** The contained ("fit") layout size of the <img> at zoom 1 (live-measured). */
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);

  // View transform (translate + scale), seeded from the restored per-tab view.
  // Mirrored into refs so the wheel/drag handlers and unmount flush always read
  // the latest values without re-subscribing.
  const [zoom, setZoom] = useState(() => initialZoom ?? 1);
  const [offset, setOffset] = useState<XY>(() => initialOffset ?? { x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  /** Animate the transform ONLY for discrete actions (buttons / double-click).
   *  Wheel + drag must be instant: a CSS transition there makes every event
   *  restart a tween it never finishes → visible stutter ("saccades"). */
  const [animate, setAnimate] = useState(false);
  const zoomRef = useRef(zoom);
  const offsetRef = useRef<XY>(offset);
  // Drag bookkeeping.
  const lastPtr = useRef<XY | null>(null);
  /** The single pointer that owns the active pan (ignore others, e.g. a 2nd touch). */
  const activePtr = useRef<number | null>(null);

  const applyView = useCallback((z: number, o: XY, withAnim = false) => {
    zoomRef.current = z;
    offsetRef.current = o;
    setZoom(z);
    setOffset(o);
    setAnimate(withAnim);
  }, []);

  /** Clamp the pan offset so the (scaled) image can't be dragged past its edges.
   *  Returns the offset untouched until the image is measurable (clientWidth 0),
   *  so a restored offset isn't zeroed before the image loads. */
  const clampOffset = useCallback((o: XY, z: number): XY => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img || img.clientWidth === 0) return o;
    const maxX = Math.max(0, (img.clientWidth * z - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.clientHeight * z - stage.clientHeight) / 2);
    return { x: clamp(o.x, -maxX, maxX), y: clamp(o.y, -maxY, maxY) };
  }, []);

  /** Zoom by `factor` keeping the screen point (clientX, clientY) fixed.
   *  `withAnim` only for discrete callers (double-click); the wheel passes false. */
  const zoomAround = useCallback(
    (factor: number, clientX: number, clientY: number, withAnim = false) => {
      const z0 = zoomRef.current;
      const z1 = clamp(z0 * factor, ZOOM_MIN, ZOOM_MAX);
      if (z1 === z0) return;
      const stage = stageRef.current;
      const o0 = offsetRef.current;
      if (!stage) {
        applyView(z1, o0, withAnim);
        return;
      }
      const r = stage.getBoundingClientRect();
      const cx = clientX - (r.left + r.width / 2);
      const cy = clientY - (r.top + r.height / 2);
      const k = z1 / z0;
      const o1 = { x: cx * (1 - k) + k * o0.x, y: cy * (1 - k) + k * o0.y };
      applyView(z1, clampOffset(o1, z1), withAnim);
    },
    [applyView, clampOffset],
  );

  /** Zoom toward the viewport centre (used by the +/- buttons; animated). */
  const zoomCentered = useCallback(
    (factor: number) => {
      const z0 = zoomRef.current;
      const z1 = clamp(z0 * factor, ZOOM_MIN, ZOOM_MAX);
      if (z1 === z0) return;
      const k = z1 / z0;
      const o0 = offsetRef.current;
      applyView(z1, clampOffset({ x: k * o0.x, y: k * o0.y }, z1), true);
    },
    [applyView, clampOffset],
  );

  const resetView = useCallback(() => applyView(1, { x: 0, y: 0 }, true), [applyView]);

  // Clamp a restored offset BEFORE the first paint (runs on mount). If the panel
  // was resized while this tab was away, the seeded offset may be out of bounds;
  // for an already-decoded (cached) image clientWidth is available here, so the
  // clamp lands before paint with no out-of-bounds flash. If not yet measurable
  // it's a no-op and onLoad/the ResizeObserver correct it.
  useLayoutEffect(() => {
    applyView(zoomRef.current, clampOffset(offsetRef.current, zoomRef.current));
  }, [applyView, clampOffset]);

  // Flush the current view to the store on unmount (i.e. when the tab is left, or
  // closed/conversation switched), so it can be restored next time the tab opens.
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(
    () => () => {
      onViewChangeRef.current?.(zoomRef.current, offsetRef.current);
    },
    [],
  );

  // A live-reload of the SAME file (key=path, so no remount) swaps `src`. Keep the
  // zoom (same image, just new bytes), but clear any decode error, drop the cached
  // dimensions (onLoad re-measures), re-clamp the offset, and end any drag. The
  // first run (mount) is skipped — mount already seeds from initialZoom/Offset.
  const firstSrc = useRef(true);
  useEffect(() => {
    if (firstSrc.current) {
      firstSrc.current = false;
      return;
    }
    setFailed(false);
    setNat(null);
    setFit(null);
    setPanning(false);
    lastPtr.current = null;
    activePtr.current = null;
    applyView(zoomRef.current, clampOffset(offsetRef.current, zoomRef.current));
  }, [src, applyView, clampOffset]);

  // Keep the view correct when the stage is resized (editor splitter, file-tree
  // toggle, window resize) — none of which re-fire onLoad. Re-measure the fit
  // baseline (so the % readout stays truthful) and re-clamp the offset (so a
  // panned, zoomed image can't be left pushed past its edge with a gutter).
  // `failed` is a dep so this re-attaches to the NEW stage node after a decode
  // error is cleared by a live-reload (the stage div unmounts while `failed`, then
  // remounts) — otherwise the observer would stay bound to the detached old node.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const img = imgRef.current;
      if (img && img.clientWidth > 0) setFit({ w: img.clientWidth, h: img.clientHeight });
      applyView(zoomRef.current, clampOffset(offsetRef.current, zoomRef.current));
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [failed, applyView, clampOffset]);

  // Wheel/pinch zoom. Attached natively (not via React's onWheel) so we can
  // preventDefault — the listener must be non-passive, which React doesn't
  // guarantee. A ref keeps the handler pointed at the latest zoomAround.
  const zoomAroundRef = useRef(zoomAround);
  zoomAroundRef.current = zoomAround;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Exponential so each notch is a constant ratio; trackpad pinch arrives as
      // ctrl+wheel with the same deltaY sign, so it Just Works.
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAroundRef.current(factor, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // `failed` re-runs this so the listener re-binds to the NEW stage node after a
    // decode error is cleared by a live-reload (the stage unmounts then remounts);
    // without it, wheel/pinch zoom would be silently dead on the recovered image.
  }, [failed]);

  // --- Drag to pan (pointer events + capture so a drag survives leaving the box).
  // The drag is pinned to one pointer id so a second touch contact can't hijack
  // the baseline and make the pan jump between fingers.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (zoomRef.current <= 1) return; // nothing to pan at fit
    if (activePtr.current !== null) return; // a drag already owns a pointer
    activePtr.current = e.pointerId;
    lastPtr.current = { x: e.clientX, y: e.clientY };
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePtr.current !== e.pointerId || !lastPtr.current) return;
    const dx = e.clientX - lastPtr.current.x;
    const dy = e.clientY - lastPtr.current.y;
    lastPtr.current = { x: e.clientX, y: e.clientY };
    applyView(
      zoomRef.current,
      clampOffset({ x: offsetRef.current.x + dx, y: offsetRef.current.y + dy }, zoomRef.current),
    );
  };
  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePtr.current !== e.pointerId) return;
    activePtr.current = null;
    lastPtr.current = null;
    setPanning(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // Double-click toggles between fit and 2× (toward the cursor).
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (zoomRef.current > 1.01) resetView();
    else zoomAround(2, e.clientX, e.clientY, true);
  };

  if (failed) {
    return <div className={styles.placeholder}>Impossible d'afficher cette image.</div>;
  }

  // "% of actual size": the fit ratio (fit/natural) times the current zoom. When
  // the natural size is unknown (e.g. an SVG with only a viewBox → naturalWidth 0)
  // fall back to the raw zoom multiplier, so the readout/reset button is always
  // meaningful rather than a stuck "—".
  const pct =
    nat && nat.w > 0 ? Math.round(((fit?.w ?? nat.w) / nat.w) * zoom * 100) : Math.round(zoom * 100);
  const canZoomOut = zoom > ZOOM_MIN + 1e-3;
  const canZoomIn = zoom < ZOOM_MAX - 1e-3;

  return (
    <div className={styles.imageViewer}>
      <div
        ref={stageRef}
        className={styles.imageStage}
        style={{ cursor: zoom > 1 ? (panning ? "grabbing" : "grab") : "default" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={onDoubleClick}
      >
        <img
          ref={imgRef}
          className={styles.imageEl}
          src={src}
          alt=""
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            // Animate ONLY discrete actions; wheel/drag are instant (see `animate`).
            transition: animate ? "transform 0.13s ease-out" : "none",
          }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNat({ w: img.naturalWidth, h: img.naturalHeight });
            setFit({ w: img.clientWidth, h: img.clientHeight });
            // Now the image is measurable: clamp a restored/out-of-bounds offset.
            applyView(zoomRef.current, clampOffset(offsetRef.current, zoomRef.current));
          }}
          onError={() => setFailed(true)}
        />
      </div>
      <div className={styles.imageInfo}>
        {nat && nat.w > 0 ? (
          <span>
            <b>
              {nat.w} × {nat.h}
            </b>{" "}
            px
          </span>
        ) : null}
        {size != null ? <span>{formatBytes(size)}</span> : null}
        <span className={styles.imageInfoSpace} />
        <div className={styles.zoomControls}>
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => zoomCentered(1 / ZOOM_BTN_STEP)}
            disabled={!canZoomOut}
            title="Dézoomer"
            aria-label="Dézoomer"
          >
            −
          </button>
          <button
            type="button"
            className={styles.zoomPct}
            onClick={resetView}
            disabled={zoom <= ZOOM_MIN + 1e-3}
            title="Réinitialiser (ajuster)"
          >
            {pct}%
          </button>
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => zoomCentered(ZOOM_BTN_STEP)}
            disabled={!canZoomIn}
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
