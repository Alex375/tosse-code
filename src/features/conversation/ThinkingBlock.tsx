import { Disclosure } from "../../ui/Disclosure";
import { fmtDuration } from "../../agent/subagentMeta";
import { StreamMarkdown } from "./StreamMarkdown";
import styles from "./ThinkingBlock.module.css";

interface ThinkingBlockProps {
  text: string;
  finalized: boolean;
  /** Reflection time to show next to the label: elapsed (ticking) while live, frozen once
   *  settled. `null`/absent → no time shown (e.g. blocks hydrated from disk). */
  durationMs?: number | null;
}

/** Collapsible extended-thinking section; body reuses the markdown renderer. */
export function ThinkingBlock({ text, finalized, durationMs }: ThinkingBlockProps) {
  if (!text.trim()) return null;
  return (
    <Disclosure
      className={styles.block}
      summary={
        <span className={styles.label}>
          {finalized ? "Thought process" : "Thinking…"}
          {durationMs != null && durationMs > 0 && (
            <span className={styles.dur + " wf-mono"}>{fmtDuration(durationMs)}</span>
          )}
        </span>
      }
    >
      <div className={styles.body}>
        <StreamMarkdown text={text} streaming={!finalized} />
      </div>
    </Disclosure>
  );
}
