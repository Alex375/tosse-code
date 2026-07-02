import { Check, Copy } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Expandable } from "../../ui/Expandable";
import { IconButton } from "../../ui/IconButton";
import { useMarkdownModeCtx } from "./markdownMode";
import styles from "./Markdown.module.css";

interface CodeBlockProps {
  code: string;
  lang?: string;
}

/**
 * Fenced code block. In `classic` mode: a plain monospace <pre> with a hover-revealed
 * copy button (the historical look, no syntax colours). In `warm` / `minimal`: a header
 * strip (language + copy) AND syntax highlighting — highlight.js is loaded lazily (its
 * own code-split chunk, so classic never pays for it) and the token colours are themed
 * per mode in conductor-markdown-modes.css (warm = two-tone, minimal = monochrome). We
 * ship NO highlight.js theme stylesheet; only the token classes we style ourselves.
 */
export const CodeBlock = memo(function CodeBlock({ code, lang }: CodeBlockProps) {
  const mode = useMarkdownModeCtx();
  const [copied, setCopied] = useState(false);
  // Highlighted HTML tagged with the exact code it was produced FOR, so a stale result
  // is never shown for changed code (streaming): we only use it when hl.code === code.
  const [hl, setHl] = useState<{ code: string; html: string } | null>(null);

  const headered = mode === "warm" || mode === "minimal";

  // Highlight only in the coloured modes AND only when the fence carries a language we
  // actually know: no highlightAuto (its ~40-grammar auto-detect janks on long transcripts
  // and mis-colours plain output). Unknown/untagged fences stay plain. Lazy-import keeps
  // the highlighter out of the startup bundle.
  useEffect(() => {
    if (!headered || !lang) return;
    let alive = true;
    void import("highlight.js/lib/common")
      .then((mod) => {
        if (!alive) return;
        const hljs = mod.default;
        if (!hljs.getLanguage(lang)) return; // unknown language → leave plain
        try {
          setHl({ code, html: hljs.highlight(code, { language: lang }).value });
        } catch {
          /* highlighter error → leave plain */
        }
      })
      .catch(() => {
        /* chunk load failed → leave plain */
      });
    return () => {
      alive = false;
    };
  }, [headered, code, lang]);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyBtn = (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? "Copied" : "Copy code"}
      size={13}
      className={headered ? "md-cb-copy" : styles.copyBtn}
      onClick={copy}
    />
  );

  const highlighted = headered && hl != null && hl.code === code ? hl.html : null;

  return (
    <div className={`${styles.codeBlockWrapper} md-cb`}>
      {headered ? (
        <div className="md-cb-head">
          <span className="md-cb-lang">{lang || "code"}</span>
          {copyBtn}
        </div>
      ) : (
        copyBtn
      )}
      <Expandable>
        <pre className={styles.pre}>
          {highlighted != null ? (
            <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
          ) : (
            <code>{code}</code>
          )}
        </pre>
      </Expandable>
    </div>
  );
});
