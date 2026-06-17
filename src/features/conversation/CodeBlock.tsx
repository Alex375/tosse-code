import { Check, Copy } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { IconButton } from "../../ui/IconButton";
import styles from "./Markdown.module.css";

interface CodeBlockProps {
  code: string;
  lang?: string;
}

/**
 * Fenced code block: plain monospace <pre> (no syntax highlighting — faithful to
 * the VS Code chat, which ships none) with a hover-revealed copy button.
 */
export const CodeBlock = memo(function CodeBlock({ code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.codeBlockWrapper}>
      <IconButton
        icon={copied ? Check : Copy}
        label={copied ? "Copied" : "Copy code"}
        size={13}
        className={styles.copyBtn}
        onClick={copy}
      />
      <pre className={styles.pre}>
        <code>{code}</code>
      </pre>
    </div>
  );
});

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className={styles.inlineCode}>{children}</code>;
}
