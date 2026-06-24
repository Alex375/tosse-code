// A floating viewer for a background Bash command's captured output
// (`tasks/<task_id>.output`), opened from the pinned <BashBar>. While the command is
// still running it re-reads on an interval (a live tail); once it finishes the
// `running` flag flips false and the effect does one final read. Portal + scrim,
// reusing the transcript popover's chrome so the two read-only overlays stay visually
// identical. `read_task_output` is a one-shot read — the polling here IS the tailing.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { commands } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import styles from "./TranscriptPopover.module.css";

/** How often to re-read the output file while the command is still running. */
const POLL_MS = 1500;

export function BashOutputPopover({
  open,
  sessionId,
  taskId,
  command,
  running,
  summary,
  onClose,
}: {
  open: boolean;
  /** Claude's own session_id (durable) — the key for the on-disk output file. */
  sessionId: string | null;
  /** The background task's id; null when it can't be resolved (resumed conversation). */
  taskId: string | null;
  /** The shell command (shown in the header). */
  command: string;
  /** Whether the command is still running — drives the live polling + a status line. */
  running: boolean;
  /** End-of-run summary from the core (e.g. "… completed (exit code 0)"). */
  summary?: string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whether the user is scrolled to the bottom — so a live tail keeps following the
  // output, but stops yanking the view if they scrolled up to read.
  const atBottomRef = useRef(true);

  const fetchOutput = useCallback(async () => {
    if (!sessionId || !taskId) return;
    setLoading(true);
    try {
      const res = await commands.readTaskOutput(sessionId, taskId);
      if (res.status === "ok") {
        setText(res.data ?? "");
        setErr(null);
      } else {
        setErr(res.error);
      }
    } catch (e) {
      // Never swallow a thrown IPC/transport error: surface it; `finally` guarantees we
      // never get stuck on "Chargement…".
      console.error("readTaskOutput threw:", e);
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, taskId]);

  // Initial read on open, then poll while the command runs. Depending on `running`
  // means the final read fires automatically when it stops (the interval is cleared
  // and a fresh effect with running=false does the last fetch).
  useEffect(() => {
    if (!open) return;
    void fetchOutput();
    if (!running) return;
    const id = setInterval(() => void fetchOutput(), POLL_MS);
    return () => clearInterval(id);
  }, [open, running, fetchOutput]);

  // Reset the captured text when switching to a different task (avoid flashing the
  // previous command's output before the first read lands).
  useEffect(() => {
    setText(null);
    setErr(null);
  }, [taskId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Follow the tail: keep pinned to the bottom on new output, unless the user scrolled
  // up to read earlier lines.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!open) return null;

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  let body: ReactNode;
  if (text != null && text !== "") {
    body = <pre className="cv-bashout wf-mono">{text}</pre>;
  } else if (loading && text == null) {
    body = <div className={styles.note}>Chargement de la sortie…</div>;
  } else if (err) {
    body = <div className={styles.note}>Sortie illisible : {err}</div>;
  } else if (!sessionId || !taskId) {
    body = <div className={styles.note}>Sortie indisponible (conversation rouverte).</div>;
  } else if (running) {
    body = <div className={styles.note}>La commande tourne — aucune sortie pour l'instant…</div>;
  } else {
    body = <div className={styles.note}>Cette commande n'a produit aucune sortie.</div>;
  }

  const subtitle = running ? "En cours…" : summary ?? "Terminé";

  return createPortal(
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="term" className="sm" />
          <div className={styles.titles}>
            <div className={styles.title + " wf-mono"}>$ {command}</div>
            <div className={styles.subtitle}>{subtitle}</div>
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Fermer" title="Fermer (Échap)">
            <Ico name="x" className="sm" />
          </button>
        </div>
        <div className={styles.body} ref={bodyRef} onScroll={onScroll}>
          {body}
        </div>
      </div>
    </div>,
    document.body,
  );
}
