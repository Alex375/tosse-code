import { Disclosure } from "../../ui/Disclosure";
import { StreamMarkdown } from "./StreamMarkdown";
import styles from "./ThinkingBlock.module.css";

interface ThinkingBlockProps {
  text: string;
  finalized: boolean;
}

/** Collapsible extended-thinking section; body reuses the markdown renderer. */
export function ThinkingBlock({ text, finalized }: ThinkingBlockProps) {
  if (!text.trim()) return null;
  return (
    <Disclosure
      className={styles.block}
      summary={<span className={styles.label}>{finalized ? "Thought process" : "Thinking…"}</span>}
    >
      <div className={styles.body}>
        <StreamMarkdown text={text} streaming={!finalized} />
      </div>
    </Disclosure>
  );
}
