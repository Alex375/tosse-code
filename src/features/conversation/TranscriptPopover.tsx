// A floating overlay showing a sub-agent's full transcript, opened from the pinned
// AgentBar (conversation) or the FlightDeck badge. Portal + scrim (same pattern as
// ConfirmDialog) so it floats above every stacking context; Escape or a scrim click
// closes it. The body reuses the read-only <SubAgentTranscript> renderer; the items
// are read from disk via `load_subagent_transcript` when it opens.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConversationItem } from "../../ipc/client";
import { commands } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import { SubAgentTranscript } from "./SubAgentTranscript";
import styles from "./TranscriptPopover.module.css";

export function TranscriptPopover({
  open,
  sessionId,
  agentId,
  label,
  subtitle,
  onClose,
}: {
  open: boolean;
  /** Claude's own session_id (durable) — the key for the on-disk transcript. */
  sessionId: string | null;
  /** The sub-agent's id; null when it can't be resolved (e.g. resumed conversation). */
  agentId: string | null;
  label: ReactNode;
  /** Optional second line in the header (e.g. subagent_type · model). */
  subtitle?: ReactNode;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Open at the BOTTOM (most recent), like the conversation thread: a sub-agent's
  // transcript is read from its latest output, not its opening prompt.
  useLayoutEffect(() => {
    if (items && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [items]);

  const fetchTranscript = useCallback(async () => {
    if (!sessionId || !agentId) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await commands.loadSubagentTranscript(sessionId, agentId);
      if (res.status === "ok") setItems(res.data);
      else setErr(res.error);
    } catch (e) {
      // Never swallow a thrown IPC/transport error: surface it, and the `finally`
      // guarantees we never get stuck on "Chargement…".
      console.error("loadSubagentTranscript threw:", e);
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, agentId]);

  useEffect(() => {
    if (open) void fetchTranscript();
  }, [open, fetchTranscript]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  let body: ReactNode;
  if (items && items.length > 0) {
    body = <SubAgentTranscript items={items} />;
  } else if (loading) {
    body = <div className={styles.note}>Chargement du transcript…</div>;
  } else if (err) {
    body = <div className={styles.note}>Transcript illisible : {err}</div>;
  } else if (!sessionId || !agentId) {
    body = <div className={styles.note}>Transcript indisponible (conversation rouverte).</div>;
  } else {
    body = <div className={styles.note}>Le sous-agent n'a pas encore écrit de transcript.</div>;
  }

  return createPortal(
    <div className={styles.scrim} onClick={onClose}>
      <div
        className={styles.panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className={styles.head}>
          <Ico name="spark" className="sm" />
          <div className={styles.titles}>
            <div className={styles.title}>{label}</div>
            {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Fermer" title="Fermer (Échap)">
            <Ico name="x" className="sm" />
          </button>
        </div>
        <div className={styles.body} ref={bodyRef}>{body}</div>
      </div>
    </div>,
    document.body,
  );
}
