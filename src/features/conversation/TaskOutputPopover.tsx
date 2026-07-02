// A floating viewer for a background task's captured output on disk
// (`tasks/<task_id>.output`) — the live sink shared by background `Bash` commands and
// `Monitor` watches. While the task is still running it re-reads on an interval (a live
// tail); once it finishes the `running` flag flips false and the effect does one final
// read. Portal + scrim, reusing the transcript popover's chrome so the read-only overlays
// stay visually identical. `read_task_output` is a one-shot read — the polling here IS
// the tailing.
//
// All the producer-specific wording (the header, the empty/loading placeholders) is
// injected via props, so <BashOutputPopover> and <MonitorBar> reuse the exact same
// tailing engine with their own copy.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { commands } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import { pickOutputView } from "./taskOutputView";
import styles from "./TranscriptPopover.module.css";

/** How often to re-read the output file while the task is still running. */
const POLL_MS = 1500;

export function TaskOutputPopover({
  open,
  outputFile,
  running,
  icon,
  title,
  titleMono = false,
  commandLine,
  subtitle,
  loadingText,
  unreadableText,
  unavailableText,
  emptyRunningText,
  emptyDoneText,
  unloadedText,
  onClose,
}: {
  open: boolean;
  /** ABSOLUTE on-disk path of the task's output (`BackgroundTask.output_file`, taken
   *  verbatim from the wire). The CLI writes it to a temp dir the app can't reconstruct,
   *  so this is the only reliable source. `null` until the path is known (or on a resumed
   *  conversation, where the live task lifecycle is gone). */
  outputFile: string | null;
  /** Whether the task is still running — drives the live polling + the subtitle. */
  running: boolean;
  /** Header glyph (a named {@link Ico}). */
  icon: string;
  /** Header title line — the NAME the agent gave the task (or the command if unnamed). */
  title: ReactNode;
  /** Render the title monospace — true for a real shell command (`$ cmd`); a prose label
   *  (a name / a Monitor's description) stays proportional, like <TranscriptPopover>. */
  titleMono?: boolean;
  /** The raw shell command, shown on its own `$ command` mono line UNDER the title (so
   *  the popover shows both the name and the command). Omitted when there is none. */
  commandLine?: string;
  /** The line under the title (already resolved by the caller, e.g. summary or status). */
  subtitle: string;
  /** Placeholder while the first read is in flight. */
  loadingText: string;
  /** Placeholder when the read failed (gets the error string). */
  unreadableText: (err: string) => string;
  /** Placeholder when the output path is unresolvable (resumed conversation). */
  unavailableText: string;
  /** Placeholder when running but nothing has been written yet. */
  emptyRunningText: string;
  /** Placeholder when finished and the file is present but EMPTY (genuinely no output). */
  emptyDoneText: string;
  /** Placeholder when finished but the output file is absent/unreadable (read returned
   *  null) — we don't have the output, as opposed to it being empty. */
  unloadedText: string;
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
    if (!outputFile) return;
    setLoading(true);
    try {
      const res = await commands.readTaskOutputFile(outputFile);
      if (res.status === "ok") {
        // Keep null distinct from "": null = absent/unreadable file, "" = present but
        // empty (genuinely no output). Coercing null → "" is what made the popover
        // claim "no output" when it had simply failed to load the file.
        setText(res.data);
        setErr(null);
      } else {
        setErr(res.error);
      }
    } catch (e) {
      // Never swallow a thrown IPC/transport error: surface it; `finally` guarantees we
      // never get stuck on "Chargement…".
      console.error("readTaskOutputFile threw:", e);
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [outputFile]);

  // Initial read on open, then poll while the task runs. Depending on `running` means the
  // final read fires automatically when it stops (the interval is cleared and a fresh
  // effect with running=false does the last fetch).
  useEffect(() => {
    if (!open) return;
    void fetchOutput();
    if (!running) return;
    const id = setInterval(() => void fetchOutput(), POLL_MS);
    return () => clearInterval(id);
  }, [open, running, fetchOutput]);

  // Reset the captured text when switching to a different task (avoid flashing the
  // previous task's output before the first read lands).
  useEffect(() => {
    setText(null);
    setErr(null);
  }, [outputFile]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      // This popover is the topmost layer while open, so it OWNS Escape: stopPropagation
      // keeps an outer window-level listener (e.g. the Flight Deck reply modal) from also
      // closing on the same keypress. (Fullscreen is protected globally by App.tsx's
      // capture-phase guard, which preventDefaults Escape.)
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
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

  const view = pickOutputView({
    text,
    loading,
    err,
    hasPath: !!outputFile,
    running,
  });
  let body: ReactNode;
  switch (view) {
    case "output":
      body = <pre className="cv-bashout wf-mono">{text}</pre>;
      break;
    case "loading":
      body = <div className={styles.note}>{loadingText}</div>;
      break;
    case "error":
      body = <div className={styles.note}>{unreadableText(err ?? "")}</div>;
      break;
    case "unavailable":
      body = <div className={styles.note}>{unavailableText}</div>;
      break;
    case "empty-running":
      body = <div className={styles.note}>{emptyRunningText}</div>;
      break;
    case "empty-done":
      body = <div className={styles.note}>{emptyDoneText}</div>;
      break;
    case "unloaded":
      body = <div className={styles.note}>{unloadedText}</div>;
      break;
  }

  return createPortal(
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name={icon} className="sm" />
          <div className={styles.titles}>
            <div className={styles.title + (titleMono ? " wf-mono" : "")}>{title}</div>
            {commandLine ? (
              <div className="cv-taskout-cmd wf-mono">$ {commandLine}</div>
            ) : null}
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
