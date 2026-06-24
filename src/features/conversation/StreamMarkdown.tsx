import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { MentionInlineCode } from "./FileMention";
import styles from "./Markdown.module.css";

/**
 * While a message is still streaming, drop the trailing incomplete block (split on
 * blank lines) so an unclosed ``` fence / table / ** doesn't flicker as half-parsed
 * markdown. Mirrors the extension's partial-trimmer.
 */
function trimPartial(text: string): string {
  const blocks = text.split(/\n\n+/);
  if (blocks.length > 1) blocks.pop();
  return blocks.join("\n\n");
}

const components: Components = {
  // CodeBlock renders its own <pre>, so collapse react-markdown's wrapper.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const isBlock = /language-(\w+)/.test(className ?? "") || text.includes("\n");
    if (isBlock) {
      const lang = /language-(\w+)/.exec(className ?? "")?.[1];
      return <CodeBlock code={text.replace(/\n$/, "")} lang={lang} />;
    }
    // Inline code that resolves to a real file becomes a clickable mention
    // (opens it in the side editor); otherwise it stays plain inline code.
    return <MentionInlineCode className={styles.inlineCode}>{children}</MentionInlineCode>;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Images are Phase 2; render alt text rather than a broken element.
  img: ({ alt }) => <em>{alt || "image"}</em>,
};

interface StreamMarkdownProps {
  text: string;
  streaming?: boolean;
}

export const StreamMarkdown = memo(function StreamMarkdown({
  text,
  streaming = false,
}: StreamMarkdownProps) {
  const content = useMemo(
    () => (streaming ? trimPartial(text) : text),
    [text, streaming],
  );
  return (
    <div className={styles.root}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
