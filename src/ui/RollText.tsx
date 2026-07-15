import { useEffect, useRef, useState } from "react";
import styles from "./RollText.module.css";

/** Cleared a hair after the CSS animation (220ms) so the outgoing line is removed once settled. */
const ROLL_MS = 240;

/**
 * A single line of text that, WHEN THE TEXT CHANGES, rolls vertically: the old line slides up and
 * out while the new one rolls in from below — a light, classic "carousel". No animation on first
 * mount or while the text is unchanged (so the once-a-second activity re-renders don't animate).
 * Used for the live activity label (Thinking… / the current step / the playful words) so its word
 * changes read smoothly. `key` per change forces the animation to replay; respects
 * prefers-reduced-motion (instant swap).
 */
export function RollText({ text, className }: { text: string; className?: string }) {
  const [s, setS] = useState<{ cur: string; prev: string | null; gen: number }>({
    cur: text,
    prev: null,
    gen: 0,
  });
  const curRef = useRef(text);

  useEffect(() => {
    if (text === curRef.current) return;
    const prev = curRef.current;
    curRef.current = text;
    setS((p) => ({ cur: text, prev, gen: p.gen + 1 }));
    const t = setTimeout(() => setS((p) => ({ ...p, prev: null })), ROLL_MS);
    return () => clearTimeout(t);
  }, [text]);

  const rolling = s.prev !== null;
  return (
    <span className={className ? `${styles.root} ${className}` : styles.root}>
      {rolling && (
        <span key={`o${s.gen}`} className={`${styles.line} ${styles.out}`} aria-hidden="true">
          {s.prev}
        </span>
      )}
      <span key={`i${s.gen}`} className={rolling ? `${styles.line} ${styles.in}` : styles.line}>
        {s.cur}
      </span>
    </span>
  );
}
